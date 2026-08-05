from __future__ import annotations

import importlib.metadata
import csv
import hashlib
import io
import json
import os
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Any

from pypdf import PdfReader

from ..models import BoundingBox, EvidenceAnchor, OcrUsage, PaperDocument, PaperFigure, PaperSection, ParserInfo
from .visual_regions import plan_visual_regions, reconstruct_visual_regions


@dataclass
class ParseResult:
    document: PaperDocument
    markdown: str
    page_recognitions: list[dict[str, Any]] = field(default_factory=list)
    visual_regions: list[dict[str, Any]] = field(default_factory=list)
    uncertainties: list[dict[str, Any]] = field(default_factory=list)
    quality_stats: dict[str, Any] = field(default_factory=dict)


OcrPageCallback = Callable[[dict[str, Any]], dict[str, Any]]
VisionPageCallback = Callable[[dict[str, Any]], dict[str, Any]]


def _thumbnail(image_bytes: bytes, target: Path) -> str | None:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as image:
            image.thumbnail((320, 320))
            target.parent.mkdir(parents=True, exist_ok=True)
            image.convert("RGB").save(target, "WEBP", quality=82)
        return target.name
    except Exception:
        return None


def _safe_image_name(name: str, index: int) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip(".-")
    return cleaned or f"figure-{index}.bin"


_PDF_CONTROL_GLYPHS = str.maketrans(
    {
        "\x00": "(",
        "\x01": ")",
        "\x10": "(",
        "\x11": ")",
    }
)
_WRAPPED_WORD = re.compile(r"\b(?P<left>[A-Za-z]{2,})-\r?\n(?P<right>[a-z]{2,})\b")
_PRESERVED_HYPHEN_LEFT = {
    "cross",
    "feed",
    "high",
    "large",
    "low",
    "real",
    "self",
    "small",
    "spatio",
    "state",
    "task",
}
_FIGURE_CAPTION = re.compile(
    r"^\s*(?:fig(?:ure)?\.?)\s*(?P<number>\d+[A-Za-z]?)\s*[:.]\s*(?P<caption>.+)",
    re.I | re.S,
)
_TABLE_CAPTION = re.compile(
    r"^\s*(?:table|tab\.)\s*(?P<number>\d+[A-Za-z]?)\s*[:.]\s*(?P<caption>.+)",
    re.I | re.S,
)
_PAGE_ANCHOR = re.compile(
    r'<a\b[^>]*\bdata-page=["\'](?P<page>\d+)["\'][^>]*>\s*</a>', re.I
)


def _normalize_extracted_text(value: str) -> str:
    """Remove PDF font control glyphs without flattening meaningful Unicode math."""

    normalized = unicodedata.normalize("NFC", value.translate(_PDF_CONTROL_GLYPHS))
    normalized = "".join(
        character
        if character in "\n\r\t" or ord(character) >= 32
        else " "
        for character in normalized
    )

    def join_wrapped_word(match: re.Match[str]) -> str:
        left = match.group("left")
        right = match.group("right")
        separator = "-" if left.casefold() in _PRESERVED_HYPHEN_LEFT else ""
        return f"{left}{separator}{right}"

    return _WRAPPED_WORD.sub(join_wrapped_word, normalized)


def _markdown_figure(figure: PaperFigure) -> str:
    caption = re.sub(
        r"[\[\]\r\n]+", " ", figure.caption or f"Figure on page {figure.page}"
    )
    caption_match = _FIGURE_CAPTION.match(caption)
    alt = (
        f"Figure {caption_match.group('number')}: {caption_match.group('caption')}"
        if caption_match
        else caption
    )
    alt = re.sub(r"\s+", " ", alt).strip()
    if len(alt) > 180:
        alt = f"{alt[:177].rstrip()}..."
    return f"![{alt}]({figure.relative_path})"


def _embed_figures(markdown: str, figures: list[PaperFigure]) -> str:
    result = markdown
    for figure in figures:
        image = _markdown_figure(figure)
        if image in result:
            continue
        inserted = False
        caption = _FIGURE_CAPTION.match(figure.caption or "")
        if caption:
            number = re.escape(caption.group("number"))
            marker = re.compile(
                rf"(?im)^(?=\s*(?:fig(?:ure)?\.?)\s*{number}\s*[:.])"
            )
            result, count = marker.subn(f"{image}\n\n", result, count=1)
            inserted = count == 1
        if not inserted:
            result = f"{result.rstrip()}\n\n{image}"
    return result


def _looks_like_full_page_raster(
    image_bytes: bytes, page_width_points: float, page_height_points: float
) -> bool:
    """Reject scanned/page-sized image resources before they become figures."""

    try:
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as image:
            width, height = image.size
    except Exception:
        return False
    if width < 1 or height < 1 or page_width_points <= 0 or page_height_points <= 0:
        return False
    expected_width = page_width_points * 200 / 72
    expected_height = page_height_points * 200 / 72
    area_ratio = (width * height) / (expected_width * expected_height)
    image_aspect = width / height
    page_aspect = page_width_points / page_height_points
    same_aspect = abs(image_aspect - page_aspect) / page_aspect < 0.035
    covers_page = width >= expected_width * 0.72 and height >= expected_height * 0.72
    return same_aspect and (covers_page or area_ratio >= 0.62)


def _normalize_reference_layout(markdown: str) -> str:
    """Keep body citations untouched while separating bibliography entries."""

    heading = re.search(r"(?im)^\s*#{0,6}\s*(?:references|bibliography)\s*$", markdown)
    if not heading:
        return markdown
    prefix = markdown[: heading.end()]
    references = markdown[heading.end() :]
    references = re.sub(r"[ \t]+(?=\[\d{1,3}\]\s+)", "\n\n", references)
    references = re.sub(r"\n(?=\[\d{1,3}\]\s+)", "\n\n", references)
    references = re.sub(r"\n{3,}", "\n\n", references)
    return f"{prefix}{references}"


def _sanitize_visual_markdown(markdown: str) -> str:
    # Page transcription describes image locations through regions; only locally
    # extracted and validated files may become Markdown images.
    cleaned = re.sub(r"(?m)^\s*!\[[^\]]*\]\([^)]+\)\s*$", "", markdown)
    cleaned = _normalize_reference_layout(cleaned)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _markdown_quality_issues(markdown: str) -> list[dict[str, Any]]:
    """Detect structural failures that require another visual comparison."""

    issues: list[dict[str, Any]] = []
    formula_like = re.search(
        r"\{[^{}\n]{0,90}(?:=|\\(?:sum|frac|mathcal)|[ℓl](?:task|cons|rec)|[_^])[^{}\n]{1,160}\}",
        markdown,
        re.I,
    )
    if formula_like:
        issues.append(
            {
                "kind": "formula",
                "sourceText": formula_like.group(0),
                "candidateText": "",
                "confidence": 0.45,
            }
        )

    for caption in re.finditer(r"(?im)^\s*(?:table|tab\.)\s*\d+[A-Za-z]?\s*[:.]?.*$", markdown):
        next_heading = re.search(r"(?m)^#{1,6}\s+|^\d+(?:\.\d+)*[.)]?\s+[A-Z]", markdown[caption.end() :])
        end = caption.end() + (next_heading.start() if next_heading else min(1800, len(markdown) - caption.end()))
        table_region = markdown[caption.start() : end]
        has_gfm_table = bool(re.search(r"(?m)^\s*\|.+\|\s*$\n\s*\|?\s*:?-{3,}", table_region))
        numeric_cells = len(re.findall(r"(?<!\w)[+-]?\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?", table_region))
        if not has_gfm_table and numeric_cells >= 6:
            issues.append(
                {
                    "kind": "table",
                    "sourceText": table_region[:1200],
                    "candidateText": "",
                    "confidence": 0.35,
                }
            )

    heading = re.search(r"(?im)^\s*#{0,6}\s*(?:references|bibliography)\s*$", markdown)
    if heading:
        for line in markdown[heading.end() :].splitlines():
            if len(re.findall(r"\[\d{1,3}\]", line)) >= 2:
                issues.append(
                    {
                        "kind": "reading_order",
                        "sourceText": line[:1200],
                        "candidateText": "",
                        "confidence": 0.45,
                    }
                )
                break
    return issues


def _page_markdown_from_sections(document: PaperDocument) -> dict[int, str]:
    pages: dict[int, list[str]] = {}
    for section in document.sections:
        matches = list(_PAGE_ANCHOR.finditer(section.markdown))
        if not matches:
            page = section.page_start or 1
            pages.setdefault(page, []).append(section.markdown)
            continue
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(section.markdown)
            body = section.markdown[match.end() : end].strip()
            if body:
                pages.setdefault(int(match.group("page")), []).append(body)
    return {page: "\n\n".join(parts) for page, parts in pages.items()}


def _extract_rendered_figures(source: Path, figure_dir: Path) -> list[PaperFigure]:
    """Render caption-linked regions so vector diagrams survive the compact parser."""

    try:
        import fitz
    except ImportError:
        return []

    figures: list[PaperFigure] = []
    try:
        with fitz.open(source) as document:
            for page_index, page in enumerate(document, start=1):
                page_rect = page.rect
                page_area = page_rect.width * page_rect.height
                blocks = page.get_text("blocks", sort=True)
                captions: list[tuple[Any, str]] = []
                for block in blocks:
                    text = re.sub(r"\s+", " ", str(block[4])).strip()
                    if _FIGURE_CAPTION.match(text):
                        captions.append((fitz.Rect(block[:4]), text))
                if not captions:
                    continue

                drawing_rects = [
                    fitz.Rect(drawing["rect"])
                    for drawing in page.get_drawings()
                    if drawing.get("rect")
                ]
                image_rects = [
                    fitz.Rect(block["bbox"])
                    for block in page.get_text("dict").get("blocks", [])
                    if block.get("type") == 1 and block.get("bbox")
                ]
                previous_caption_bottom = page_rect.y0
                for caption_rect, caption in captions:
                    window_top = max(
                        previous_caption_bottom,
                        caption_rect.y0 - page_rect.height * 0.45,
                    )
                    wide_caption = caption_rect.width >= page_rect.width * 0.55

                    def overlaps_caption_column(rect: Any) -> bool:
                        overlap = min(rect.x1, caption_rect.x1) - max(rect.x0, caption_rect.x0)
                        return wide_caption or overlap > min(rect.width, caption_rect.width) * 0.2

                    candidates = []
                    for rect in [*drawing_rects, *image_rects]:
                        if rect.is_empty or rect.width < 3 or rect.height < 3:
                            continue
                        if rect.get_area() > page_area * 0.28:
                            continue
                        if rect.y0 < window_top or rect.y1 > caption_rect.y0 + 2:
                            continue
                        if overlaps_caption_column(rect):
                            candidates.append(rect)
                    if not candidates:
                        # Scanned PDFs often expose one full-page image plus a text
                        # layer. Walk upward from the caption and crop the compact
                        # visual cluster instead of storing the whole page.
                        column_width = page_rect.width / 2
                        if wide_caption:
                            column_left, column_right = page_rect.x0, page_rect.x1
                        elif caption_rect.x0 >= page_rect.width / 2:
                            column_left, column_right = page_rect.width / 2, page_rect.x1
                        else:
                            column_left, column_right = page_rect.x0, page_rect.width / 2
                        prior_blocks: list[tuple[Any, str]] = []
                        for block in blocks:
                            rect = fitz.Rect(block[:4])
                            text = re.sub(r"\s+", " ", str(block[4])).strip()
                            overlap = min(rect.x1, column_right) - max(rect.x0, column_left)
                            if (
                                rect.y1 <= caption_rect.y0 + 2
                                and rect.y0 >= caption_rect.y0 - page_rect.height * 0.28
                                and overlap > min(rect.width, column_width) * 0.2
                                and text
                            ):
                                prior_blocks.append((rect, text))
                        cursor = caption_rect.y0
                        for rect, text in sorted(prior_blocks, key=lambda item: item[0].y1, reverse=True):
                            gap = cursor - rect.y1
                            if candidates and gap > 24:
                                break
                            if len(text) > 260 and rect.width > column_width * 0.72:
                                break
                            candidates.append(rect)
                            cursor = min(cursor, rect.y0)
                    if not candidates:
                        previous_caption_bottom = caption_rect.y1
                        continue

                    clip = fitz.Rect(candidates[0])
                    for rect in candidates[1:]:
                        clip |= rect
                    for block in blocks:
                        rect = fitz.Rect(block[:4])
                        if (
                            rect.y0 >= clip.y0 - 12
                            and rect.y1 <= caption_rect.y0 + 2
                            and min(rect.x1, clip.x1) - max(rect.x0, clip.x0) > 0
                        ):
                            clip |= rect
                    clip = fitz.Rect(
                        max(page_rect.x0, clip.x0 - 6),
                        max(page_rect.y0, clip.y0 - 6),
                        min(page_rect.x1, clip.x1 + 6),
                        min(page_rect.y1, clip.y1 + 6),
                    )
                    if clip.width < 72 or clip.height < 40:
                        previous_caption_bottom = caption_rect.y1
                        continue

                    figure_number = len(figures) + 1
                    image_path = figure_dir / f"figure-{figure_number}.png"
                    pixmap = page.get_pixmap(
                        matrix=fitz.Matrix(2, 2), clip=clip, alpha=False
                    )
                    pixmap.save(image_path)
                    image_bytes = image_path.read_bytes()
                    thumbnail_name = _thumbnail(
                        image_bytes,
                        figure_dir / f"figure-{figure_number}-thumb.webp",
                    )
                    figures.append(
                        PaperFigure(
                            id=f"figure-{figure_number}",
                            caption=caption,
                            relative_path=f"figures/{image_path.name}",
                            thumbnail_path=(
                                f"figures/{thumbnail_name}" if thumbnail_name else None
                            ),
                            page=page_index,
                            bbox=BoundingBox(
                                left=max(0.0, clip.x0 / page_rect.width),
                                top=max(0.0, clip.y0 / page_rect.height),
                                right=min(1.0, clip.x1 / page_rect.width),
                                bottom=min(1.0, clip.y1 / page_rect.height),
                            ),
                            mime_type="image/png",
                        )
                    )
                    previous_caption_bottom = caption_rect.y1
    except Exception:
        return []
    return figures


def _extract_rendered_tables(source: Path, table_dir: Path) -> list[dict[str, Any]]:
    """Crop caption-linked tables for targeted visual reconstruction."""

    try:
        import fitz
    except ImportError:
        return []
    table_dir.mkdir(parents=True, exist_ok=True)
    tables: list[dict[str, Any]] = []
    try:
        with fitz.open(source) as document:
            for page_number, page in enumerate(document, start=1):
                page_rect = page.rect
                blocks = page.get_text("blocks", sort=True)
                for block in blocks:
                    caption_text = re.sub(r"\s+", " ", str(block[4])).strip()
                    caption_match = _TABLE_CAPTION.match(caption_text)
                    if not caption_match:
                        continue
                    caption_rect = fitz.Rect(block[:4])
                    content: list[tuple[Any, str]] = []
                    for candidate in blocks:
                        rect = fitz.Rect(candidate[:4])
                        text = re.sub(r"\s+", " ", str(candidate[4])).strip()
                        if rect.y0 < caption_rect.y1 - 2 or rect.y0 > caption_rect.y1 + page_rect.height * 0.34:
                            continue
                        if rect == caption_rect or not text:
                            continue
                        if _heading_candidate(text) and content:
                            break
                        horizontal_overlap = min(rect.x1, caption_rect.x1) - max(rect.x0, caption_rect.x0)
                        if horizontal_overlap > min(rect.width, caption_rect.width) * 0.15:
                            content.append((rect, text))
                    if not content:
                        continue
                    clip = fitz.Rect(caption_rect)
                    for rect, _ in content:
                        clip |= rect
                    clip = fitz.Rect(
                        max(page_rect.x0, clip.x0 - 5),
                        max(page_rect.y0, clip.y0 - 4),
                        min(page_rect.x1, clip.x1 + 5),
                        min(page_rect.y1, clip.y1 + 5),
                    )
                    if clip.width < 120 or clip.height < 45 or clip.get_area() > page_rect.get_area() * 0.48:
                        continue
                    table_index = len(tables) + 1
                    image_path = table_dir / f"table-{table_index}-source.png"
                    page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), clip=clip, alpha=False).save(image_path)
                    tables.append(
                        {
                            "id": f"table-{table_index}",
                            "caption": caption_text,
                            "page": page_number,
                            "bbox": {
                                "left": clip.x0 / page_rect.width,
                                "top": clip.y0 / page_rect.height,
                                "right": clip.x1 / page_rect.width,
                                "bottom": clip.y1 / page_rect.height,
                            },
                            "image_path": f"tables/{image_path.name}",
                            "source_text": "\n".join(text for _, text in content),
                        }
                    )
    except Exception:
        return []
    return tables


def _is_gfm_table(markdown: str) -> bool:
    return bool(
        re.search(
            r"(?m)^\s*\|.+\|\s*$\n\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$",
            markdown,
        )
    )


def _write_table_csv(markdown: str, target: Path) -> bool:
    lines = [line.strip() for line in markdown.splitlines() if line.strip().startswith("|")]
    if len(lines) < 3:
        return False
    rows = [[cell.strip() for cell in line.strip("|").split("|")] for line in lines]
    if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in rows[1]):
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.writer(output)
        writer.writerow(rows[0])
        writer.writerows(rows[2:])
    return True


def _insert_reconstructed_table(markdown: str, caption: str, table_markdown: str) -> str:
    if _is_gfm_table(markdown):
        return markdown
    number = _TABLE_CAPTION.match(caption or "")
    if not number:
        return f"{markdown.rstrip()}\n\n{table_markdown.strip()}"
    marker = re.search(
        rf"(?im)^.*(?:table|tab\.)\s*{re.escape(number.group('number'))}\s*[:.]?.*$",
        markdown,
    )
    if not marker:
        return f"{markdown.rstrip()}\n\n{table_markdown.strip()}"
    tail = markdown[marker.end() :]
    next_heading = re.search(
        r"(?m)^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[.)]?\s+[A-Z][A-Za-z])",
        tail,
    )
    if next_heading:
        flattened = tail[: next_heading.start()]
        if len(re.findall(r"\d+(?:\.\d+)?", flattened)) >= 8:
            tail = tail[next_heading.start() :]
    return f"{markdown[:marker.end()].rstrip()}\n\n{table_markdown.strip()}\n\n{tail.lstrip()}"


_KNOWN_SECTION_NAMES = {
    "abstract",
    "keywords",
    "key words",
    "introduction",
    "background",
    "related work",
    "literature review",
    "method",
    "methods",
    "methodology",
    "materials and methods",
    "approach",
    "model",
    "experiments",
    "experimental setup",
    "results",
    "discussion",
    "results and discussion",
    "limitations",
    "conclusion",
    "conclusions",
    "future work",
    "acknowledgements",
    "acknowledgments",
    "references",
    "bibliography",
    "appendix",
}
_INTERNAL_ANCHOR = re.compile(
    r"<a\b[^>]*\bdata-block-id=(?:\"[^\"]+\"|'[^']+')[^>]*>\s*</a>", re.I
)
_NUMBERED_HEADING = re.compile(
    r"^(?P<number>(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?)\s+(?P<title>[A-Za-z][^\n]{1,100})$",
    re.I,
)


def _clean_heading_title(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().strip("#*_` ").rstrip(":")).strip()


def _heading_candidate(line: str) -> tuple[str, int, bool] | None:
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return None
    if stripped.startswith(("|", ">", "- ", "* ", "+ ", "```", "$$")):
        return None
    markdown = re.match(r"^(#{1,6})\s+(.+?)\s*$", stripped)
    if markdown:
        title = _clean_heading_title(markdown.group(2))
        if not title or re.fullmatch(r"page\s+\d+", title, re.I):
            return None
        return title, min(len(markdown.group(1)), 3), True

    title = _clean_heading_title(stripped)
    normalized = title.casefold()
    if normalized in _KNOWN_SECTION_NAMES:
        return title, 1, True
    numbered = _NUMBERED_HEADING.match(title)
    if numbered:
        heading_title = _clean_heading_title(numbered.group("title"))
        if heading_title.endswith(".") or len(heading_title.split()) > 12:
            return None
        level = min(numbered.group("number").count(".") + 1, 3)
        return title, level, True
    if (
        2 <= len(title.split()) <= 8
        and len(title) >= 4
        and title.upper() == title
        and any(character.isalpha() for character in title)
    ):
        return title.title(), 1, False
    return None


def _section_slug(title: str, used: dict[str, int]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-") or "section"
    used[base] = used.get(base, 0) + 1
    return base if used[base] == 1 else f"{base}-{used[base]}"


def _semantic_sections(
    pages: list[tuple[int, str]], paper_id: str
) -> list[PaperSection]:
    """Build reader sections while retaining page-level evidence provenance."""
    cleaned_pages: list[tuple[int, list[str]]] = []
    weak_heading_pages: dict[str, set[int]] = {}
    for page, markdown in pages:
        cleaned = _INTERNAL_ANCHOR.sub("", markdown)
        lines = cleaned.splitlines()
        cleaned_pages.append((page, lines))
        for line in lines:
            candidate = _heading_candidate(line)
            if candidate and not candidate[2]:
                weak_heading_pages.setdefault(candidate[0].casefold(), set()).add(page)

    repeated_weak_headings = {
        title for title, page_numbers in weak_heading_pages.items() if len(page_numbers) > 1
    }
    drafts: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    heading_count = 0

    def ensure_current() -> dict[str, Any]:
        nonlocal current
        if current is None:
            current = {"title": "Overview", "level": 1, "chunks": []}
            drafts.append(current)
        return current

    def append_chunk(draft: dict[str, Any], page: int, lines: list[str]) -> None:
        body = "\n".join(lines).strip()
        if not body:
            return
        chunks: list[tuple[int, str]] = draft["chunks"]
        if chunks and chunks[-1][0] == page:
            chunks[-1] = (page, f"{chunks[-1][1]}\n{body}".strip())
        else:
            chunks.append((page, body))

    for page, lines in cleaned_pages:
        pending: list[str] = []
        for line in lines:
            candidate = _heading_candidate(line)
            if candidate and not candidate[2] and candidate[0].casefold() in repeated_weak_headings:
                continue
            if candidate:
                append_chunk(ensure_current(), page, pending)
                pending = []
                title, level, _ = candidate
                if current and current["title"].casefold() == title.casefold():
                    continue
                current = {"title": title, "level": level, "chunks": []}
                drafts.append(current)
                heading_count += 1
            else:
                pending.append(line)
        append_chunk(ensure_current(), page, pending)

    drafts = [draft for draft in drafts if draft["chunks"]]
    if heading_count == 0:
        all_chunks = [chunk for draft in drafts for chunk in draft["chunks"]]
        drafts = [{"title": "Document", "level": 1, "chunks": all_chunks}]

    used_slugs: dict[str, int] = {}
    sections: list[PaperSection] = []
    for order, draft in enumerate(drafts):
        section_id = _section_slug(str(draft["title"]), used_slugs)
        anchors: list[EvidenceAnchor] = []
        markdown_chunks: list[str] = []
        for chunk_index, (page, body) in enumerate(draft["chunks"], start=1):
            block_id = f"{section_id}-page-{page}-{chunk_index}"
            anchors.append(
                EvidenceAnchor(
                    paper_id=paper_id,
                    section_id=section_id,
                    block_id=block_id,
                    page=page,
                    source_text=body[:500],
                )
            )
            markdown_chunks.append(
                f'<a data-paper-id="{paper_id}" data-page="{page}" '
                f'data-block-id="{block_id}"></a>\n\n{body}'
            )
        page_numbers = [anchor.page for anchor in anchors]
        sections.append(
            PaperSection(
                id=section_id,
                title=str(draft["title"]),
                level=int(draft["level"]),
                order=order,
                page_start=min(page_numbers),
                page_end=max(page_numbers),
                markdown="\n\n".join(markdown_chunks),
                anchors=anchors,
            )
        )
    return sections


def _parse_with_pypdf(
    source: Path,
    output_dir: Path,
    paper_id: str,
    sha256: str,
) -> ParseResult:
    reader = PdfReader(str(source))
    figure_dir = output_dir / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)
    page_contents: list[tuple[int, str]] = []
    figures = _extract_rendered_figures(source, figure_dir)
    tables = _extract_rendered_tables(source, output_dir / "tables")
    figures_by_page: dict[int, list[PaperFigure]] = {}
    for figure in figures:
        if figure.page is not None:
            figures_by_page.setdefault(figure.page, []).append(figure)
    title = source.stem.replace("_", " ").replace("-", " ").strip()

    for page_index, page in enumerate(reader.pages, start=1):
        text = _normalize_extracted_text(page.extract_text() or "").strip()
        nonempty_lines = [line.strip() for line in text.splitlines() if line.strip()]
        if page_index == 1 and nonempty_lines:
            candidate = nonempty_lines[0]
            if 5 <= len(candidate) <= 240:
                title = candidate
        body = text or "_No extractable text was found on this page._"
        page_figures = list(figures_by_page.get(page_index, []))

        if not page_figures:
            try:
                for image in page.images:
                    image_name = _safe_image_name(image.name, len(figures) + 1)
                    image_bytes = image.data
                    if _looks_like_full_page_raster(
                        image_bytes, float(page.mediabox.width), float(page.mediabox.height)
                    ):
                        continue
                    image_path = figure_dir / image_name
                    image_path.write_bytes(image_bytes)
                    thumbnail_name = _thumbnail(
                        image_bytes, figure_dir / f"{Path(image_name).stem}-thumb.webp"
                    )
                    mime = (
                        "image/png"
                        if image_name.lower().endswith(".png")
                        else "image/jpeg"
                    )
                    figure = PaperFigure(
                        id=f"figure-{len(figures) + 1}",
                        relative_path=f"figures/{image_name}",
                        page=page_index,
                        mime_type=mime,
                        thumbnail_path=(
                            f"figures/{thumbnail_name}" if thumbnail_name else None
                        ),
                    )
                    figures.append(figure)
                    page_figures.append(figure)
            except Exception:
                # Image extraction varies across PDF encodings; text parsing remains valid.
                pass
        page_markdown = _embed_figures(body, page_figures)
        page_contents.append((page_index, page_markdown))

    sections = _semantic_sections(page_contents, paper_id)
    markdown_parts = [section.markdown for section in sections]

    parser_version = importlib.metadata.version("pypdf")
    document = PaperDocument(
        paper_id=paper_id,
        source_sha256=sha256,
        title=title or source.name,
        page_count=len(reader.pages),
        sections=sections,
        figures=figures,
        tables=tables,
        parser=ParserInfo(name="pypdf-fallback", version=parser_version),
    )
    frontmatter = (
        "---\n"
        f"paper_id: {paper_id}\n"
        f"source_sha256: {sha256}\n"
        f"parser: {document.parser.name}@{document.parser.version}\n"
        "---\n\n"
        f"# {document.title}\n\n"
    )
    return ParseResult(document=document, markdown=frontmatter + "\n\n".join(markdown_parts))


def _parse_with_docling(
    source: Path,
    output_dir: Path,
    paper_id: str,
    sha256: str,
) -> ParseResult:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False
    pipeline_options.generate_page_images = True
    pipeline_options.generate_picture_images = True
    pipeline_options.images_scale = 2
    conversion = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    ).convert(str(source))
    markdown = _normalize_extracted_text(conversion.document.export_to_markdown())
    exported = conversion.document.export_to_dict()
    title = source.stem.replace("_", " ").replace("-", " ")
    figures: list[PaperFigure] = []
    figure_dir = output_dir / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)

    def normalized_bbox(item: Any) -> BoundingBox | None:
        provenance = getattr(item, "prov", None)
        if not provenance:
            return None
        page = conversion.document.pages.get(provenance[0].page_no)
        if page is None:
            return None
        box = provenance[0].bbox.to_top_left_origin(page.size.height).normalized(page.size)
        return BoundingBox(
            left=max(0.0, min(1.0, box.l)),
            top=max(0.0, min(1.0, box.t)),
            right=max(0.0, min(1.0, box.r)),
            bottom=max(0.0, min(1.0, box.b)),
        )

    for index, picture in enumerate(getattr(conversion.document, "pictures", []), start=1):
        try:
            image = picture.get_image(conversion.document)
            if image is None:
                continue
            image_path = figure_dir / f"figure-{index}.png"
            image.save(image_path, "PNG")
            image_bytes = image_path.read_bytes()
            thumbnail_name = _thumbnail(image_bytes, figure_dir / f"figure-{index}-thumb.webp")
            caption = picture.caption_text(conversion.document) or None
            page = picture.prov[0].page_no if getattr(picture, "prov", None) else None
            figures.append(
                PaperFigure(
                    id=f"figure-{index}",
                    caption=caption,
                    relative_path=f"figures/{image_path.name}",
                    thumbnail_path=f"figures/{thumbnail_name}" if thumbnail_name else None,
                    page=page,
                    bbox=normalized_bbox(picture),
                    mime_type="image/png",
                )
            )
        except Exception:
            continue

    tables: list[dict[str, Any]] = []
    table_dir = output_dir / "tables"
    table_dir.mkdir(parents=True, exist_ok=True)
    for index, table in enumerate(getattr(conversion.document, "tables", []), start=1):
        entry: dict[str, Any] = {"id": f"table-{index}"}
        try:
            markdown_value = table.export_to_markdown(conversion.document)
            markdown_path = table_dir / f"table-{index}.md"
            markdown_path.write_text(markdown_value, encoding="utf-8")
            entry["markdown"] = markdown_value
            entry["markdown_path"] = f"tables/{markdown_path.name}"
        except Exception:
            entry["markdown"] = ""
        try:
            dataframe = table.export_to_dataframe(conversion.document)
            csv_path = table_dir / f"table-{index}.csv"
            dataframe.to_csv(csv_path, index=False)
            entry["csv_path"] = f"tables/{csv_path.name}"
        except Exception:
            pass
        if getattr(table, "prov", None):
            entry["page"] = table.prov[0].page_no
            bbox = normalized_bbox(table)
            if bbox:
                entry["bbox"] = bbox.model_dump()
        try:
            entry["caption"] = table.caption_text(conversion.document) or None
        except Exception:
            pass
        tables.append(entry)

    markdown = _embed_figures(markdown, figures)
    sections = _semantic_sections([(1, markdown)], paper_id)

    document = PaperDocument(
        paper_id=paper_id,
        source_sha256=sha256,
        title=title,
        page_count=max(1, len(conversion.document.pages)),
        sections=sections,
        figures=figures,
        tables=tables,
        parser=ParserInfo(
            name="docling", version=importlib.metadata.version("docling")
        ),
    )
    (output_dir / "docling-native.json").write_text(
        json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return ParseResult(
        document=document,
        markdown="\n\n".join(section.markdown for section in sections),
    )


def _render_page(source: Path, page_index: int, target: Path) -> tuple[int, int]:
    import fitz

    target.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open(source) as document:
        page = document.load_page(page_index)
        scale = 200 / 72
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        if max(pixmap.width, pixmap.height) > 4096:
            scale *= 4096 / max(pixmap.width, pixmap.height)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        pixmap.save(target)
        return pixmap.width, pixmap.height


def _crop_page_body(source: Path, target: Path) -> None:
    """Create a tighter verification crop while retaining all likely paper content."""
    from PIL import Image

    with Image.open(source) as image:
        width, height = image.size
        left, right = int(width * 0.025), int(width * 0.975)
        top, bottom = int(height * 0.035), int(height * 0.965)
        image.crop((left, top, right, bottom)).convert("RGB").save(target, "JPEG", quality=94)


def _crop_normalized_region(
    source: Path,
    bbox: dict[str, Any],
    target: Path,
    *,
    padding_ratio: float = 0.018,
) -> tuple[int, int]:
    """Crop a model-provided top-left normalized bbox with a small context margin."""

    from PIL import Image

    with Image.open(source) as image:
        width, height = image.size
        left = max(0, int((float(bbox["left"]) - padding_ratio) * width))
        top = max(0, int((float(bbox["top"]) - padding_ratio) * height))
        right = min(width, int((float(bbox["right"]) + padding_ratio) * width))
        bottom = min(height, int((float(bbox["bottom"]) + padding_ratio) * height))
        if right - left < 24 or bottom - top < 16:
            raise ValueError("视觉模型返回的公式区域过小")
        target.parent.mkdir(parents=True, exist_ok=True)
        crop = image.crop((left, top, right, bottom)).convert("RGB")
        crop.save(target, "PNG")
        return crop.size


def _parse_formula_repair_response(response: dict[str, Any]) -> tuple[str, float]:
    raw = str(response.get("description") or "").strip()
    cleaned = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ValueError("视觉模型没有返回合法的公式修复 JSON") from error
    repaired = str(parsed.get("repairedLatex") or "").strip()
    confidence = max(0.0, min(1.0, float(parsed.get("confidence") or 0.0)))
    if not repaired or repaired.count("$") % 2 or "�" in repaired or "□" in repaired:
        raise ValueError("视觉模型返回的公式定界符或字符无效")
    if not (
        (repaired.startswith("$") and repaired.endswith("$"))
        or (repaired.startswith(r"\[") and repaired.endswith(r"\]"))
    ):
        raise ValueError("公式修复结果缺少 Markdown 数学定界符")
    return repaired, confidence


def _replace_unique_whitespace_equivalent(
    markdown: str, source_text: str, replacement: str
) -> tuple[str, bool]:
    """Replace one formula only when its non-whitespace text maps unambiguously."""

    if source_text and markdown.count(source_text) == 1:
        return markdown.replace(source_text, replacement, 1), True
    compact = re.sub(r"\s+", "", source_text)
    if not compact:
        return markdown, False
    pattern = r"\s*".join(re.escape(character) for character in compact)
    matches = list(re.finditer(pattern, markdown))
    if len(matches) != 1:
        return markdown, False
    match = matches[0]
    return f"{markdown[:match.start()]}{replacement}{markdown[match.end():]}", True


def _parse_vision_page_response(response: dict[str, Any]) -> dict[str, Any]:
    raw = str(response.get("description") or response.get("markdown") or "").strip()
    cleaned = raw.removeprefix("```json").removeprefix("```markdown").removeprefix("```")
    cleaned = cleaned.removesuffix("```").strip()
    parsed: dict[str, Any]
    try:
        value = json.loads(cleaned)
        parsed = value if isinstance(value, dict) else {"markdown": cleaned}
    except json.JSONDecodeError:
        parsed = {"markdown": cleaned, "confidence": 0.72, "uncertainties": []}
    markdown = _sanitize_visual_markdown(
        _normalize_extracted_text(str(parsed.get("markdown", ""))).strip()
    )
    confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.72))))
    uncertainties = parsed.get("uncertainties")
    if not isinstance(uncertainties, list):
        uncertainties = []
    regions = parsed.get("regions")
    if not isinstance(regions, list):
        regions = []
    valid_regions: list[dict[str, Any]] = []
    for item in regions:
        if not isinstance(item, dict) or item.get("kind") not in {"figure", "table", "formula"}:
            continue
        bbox = item.get("bbox")
        if not isinstance(bbox, dict):
            continue
        try:
            coordinates = {key: float(bbox[key]) for key in ("left", "top", "right", "bottom")}
        except (KeyError, TypeError, ValueError):
            continue
        if not (
            0 <= coordinates["left"] < coordinates["right"] <= 1
            and 0 <= coordinates["top"] < coordinates["bottom"] <= 1
        ):
            continue
        valid_regions.append({**item, "bbox": coordinates})
    return {
        "markdown": markdown,
        "confidence": confidence,
        "uncertainties": [item for item in uncertainties if isinstance(item, dict)],
        "regions": valid_regions,
    }


def _marginal_line_key(line: str) -> str:
    value = re.sub(r"^#{1,6}\s+", "", line.strip()).casefold()
    value = re.sub(r"\d+", "#", value)
    return re.sub(r"\s+", " ", value)


def _is_marginal_text_candidate(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 160:
        return False
    return not (
        "$" in stripped
        or stripped.startswith(("|", "![", ">", "```", "<"))
        or re.search(r"\[[^\]]+\]\([^)]+\)", stripped)
    )


def _remove_repeated_marginal_lines(pages: list[tuple[int, str]]) -> tuple[list[tuple[int, str]], int]:
    if len(pages) < 2:
        return pages, 0
    occurrences: dict[str, set[int]] = {}
    candidates_by_page: dict[int, set[str]] = {}
    for page, markdown in pages:
        lines = [line for line in markdown.splitlines() if line.strip()]
        candidates = lines[:2] + lines[-2:]
        keys = {_marginal_line_key(line) for line in candidates if _is_marginal_text_candidate(line)}
        candidates_by_page[page] = keys
        for key in keys:
            if key:
                occurrences.setdefault(key, set()).add(page)
    threshold = max(2, int(len(pages) * 0.4 + 0.999))
    repeated = {key for key, page_numbers in occurrences.items() if len(page_numbers) >= threshold}
    removed = 0
    cleaned_pages: list[tuple[int, str]] = []
    for page, markdown in pages:
        lines = markdown.splitlines()
        nonempty = [index for index, line in enumerate(lines) if line.strip()]
        marginal_indexes = set(nonempty[:2] + nonempty[-2:])
        kept: list[str] = []
        for index, line in enumerate(lines):
            stripped = re.sub(r"^#{1,6}\s+", "", line.strip())
            page_number = bool(re.fullmatch(r"(?:page\s*)?\d{1,4}", stripped, re.I))
            if index in marginal_indexes and _is_marginal_text_candidate(line) and (
                _marginal_line_key(line) in repeated or page_number
            ):
                removed += 1
                continue
            if re.fullmatch(r"#{1,6}\s+\d{1,4}\s*", line.strip()):
                kept.append(stripped)
            else:
                kept.append(line)
        cleaned_pages.append((page, "\n".join(kept).strip()))
    return cleaned_pages, removed


def _apply_vision_reconstruction(
    result: ParseResult,
    source: Path,
    output_dir: Path,
    cache_dir: Path,
    paper_id: str,
    sha256: str,
    model_id: str,
    vision_page: VisionPageCallback,
) -> ParseResult:
    started = time.monotonic()
    cache_dir.mkdir(parents=True, exist_ok=True)
    fallback_pages = _page_markdown_from_sections(result.document)
    figures_by_page: dict[int, list[PaperFigure]] = {}
    for figure in result.document.figures:
        if figure.page is not None:
            figures_by_page.setdefault(figure.page, []).append(figure)

    prompt_version = "page-reconstruction-v2"

    def recognize(page_number: int) -> dict[str, Any]:
        cache_key = hashlib.sha256(
            f"{sha256}:{page_number}:{model_id}:{prompt_version}:200dpi:4096".encode()
        ).hexdigest()
        response_path = cache_dir / f"{page_number:04d}-{cache_key[:16]}.json"
        image_path = cache_dir / f"{page_number:04d}-{cache_key[:16]}.jpg"
        cache_hit = response_path.is_file()
        try:
            if cache_hit:
                response = json.loads(response_path.read_text(encoding="utf-8"))
            else:
                width, height = _render_page(source, page_number - 1, image_path)
                response = vision_page({
                    "paperId": paper_id,
                    "page": page_number,
                    "imagePath": str(image_path.resolve()),
                    "imageWidth": width,
                    "imageHeight": height,
                    "figureId": f"page:{page_number}",
                    "paperTitle": result.document.title,
                    "task": "page_transcribe",
                    "sourceText": fallback_pages.get(page_number, "")[:30_000],
                    "promptVersion": prompt_version,
                })
                temporary = response_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(response_path)
            parsed = _parse_vision_page_response(response)
            if not parsed["markdown"]:
                raise ValueError("视觉模型没有返回页面 Markdown")
            quality_issues = _markdown_quality_issues(parsed["markdown"])
            if quality_issues:
                parsed["uncertainties"].extend(quality_issues)
                parsed["confidence"] = min(parsed["confidence"], 0.78)
            verified = False
            if parsed["confidence"] < 0.85 or parsed["uncertainties"]:
                if not image_path.is_file():
                    _render_page(source, page_number - 1, image_path)
                crop_path = cache_dir / f"{page_number:04d}-{cache_key[:16]}-verify.jpg"
                _crop_page_body(image_path, crop_path)
                verify_response = vision_page({
                    "paperId": paper_id,
                    "page": page_number,
                    "imagePath": str(crop_path.resolve()),
                    "figureId": f"page:{page_number}:verification",
                    "paperTitle": result.document.title,
                    "task": "region_verify",
                    "sourceText": parsed["markdown"][:30_000],
                    "promptVersion": "region-verification-v1",
                })
                verified_page = _parse_vision_page_response(verify_response)
                if verified_page["markdown"] and verified_page["confidence"] >= parsed["confidence"]:
                    # Verification prompts intentionally focus on corrected text. Keep
                    # the first pass geometry so later formula/table crops stay local.
                    if not verified_page["regions"]:
                        verified_page["regions"] = parsed["regions"]
                    parsed = verified_page
                    verified = True
            remaining_issues = _markdown_quality_issues(parsed["markdown"])
            if remaining_issues:
                parsed["uncertainties"].extend(remaining_issues)
                parsed["confidence"] = min(parsed["confidence"], 0.78)
            usage = response.get("usage") or {}
            return {
                **parsed,
                "page": page_number,
                "task": "page_transcribe",
                "prompt_version": prompt_version,
                "cache_key": cache_key,
                "cache_hit": cache_hit,
                "artifact_path": str(response_path),
                "image_path": str(image_path),
                "model_id": str(response.get("modelId") or model_id),
                "input_tokens": int(usage.get("inputTokens", 0)),
                "output_tokens": int(usage.get("outputTokens", 0)),
                "duration_ms": int(usage.get("durationMs", 0)),
                "verified": verified,
                "failed": False,
            }
        except Exception as error:  # noqa: BLE001 - page failure must preserve the local fallback
            return {
                "page": page_number,
                "markdown": fallback_pages.get(page_number, "_此页视觉识别失败，请对照 PDF。_"),
                "confidence": 0.0,
                "uncertainties": [{"kind": "text", "sourceText": "", "candidateText": ""}],
                "regions": [],
                "task": "page_transcribe",
                "prompt_version": prompt_version,
                "cache_key": cache_key,
                "cache_hit": False,
                "artifact_path": "",
                "model_id": model_id,
                "input_tokens": 0,
                "output_tokens": 0,
                "duration_ms": 0,
                "verified": False,
                "failed": True,
                "error": f"{type(error).__name__}: {error}",
            }

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="vision-pages") as executor:
        page_results = list(executor.map(recognize, range(1, result.document.page_count + 1)))

    page_result_by_number = {item["page"]: item for item in page_results}
    formula_cache_dir = cache_dir / "formulas"
    formula_cache_dir.mkdir(parents=True, exist_ok=True)
    for page_item in list(page_results):
        if page_item["task"] != "page_transcribe" or page_item["failed"]:
            continue
        formula_issues = [
            issue
            for issue in page_item.get("uncertainties", [])
            if issue.get("kind") == "formula"
        ]
        formula_regions = [
            region
            for region in page_item.get("regions", [])
            if region.get("kind") == "formula"
        ]
        if not formula_issues or not formula_regions:
            continue
        for index, issue in enumerate(formula_issues):
            source_text = str(issue.get("sourceText") or issue.get("candidateText") or "").strip()
            if not source_text:
                continue
            region = next(
                (
                    candidate
                    for candidate in formula_regions
                    if str(candidate.get("sourceText") or candidate.get("caption") or "").strip()
                    == source_text
                ),
                formula_regions[0] if len(formula_issues) == len(formula_regions) == 1 else None,
            )
            if not region:
                continue
            bbox = region.get("bbox")
            image_source = Path(str(page_item.get("image_path") or ""))
            if not isinstance(bbox, dict) or not image_source.is_file():
                continue
            prompt_version_formula = "formula-repair-v2"
            cache_key = hashlib.sha256(
                f"{sha256}:{page_item['page']}:{bbox}:{source_text}:{model_id}:{prompt_version_formula}".encode()
            ).hexdigest()
            response_path = formula_cache_dir / f"page-{page_item['page']}-{index + 1}-{cache_key[:16]}.json"
            crop_path = formula_cache_dir / f"page-{page_item['page']}-{index + 1}-{cache_key[:16]}.png"
            cache_hit = response_path.is_file()
            try:
                if cache_hit:
                    response = json.loads(response_path.read_text(encoding="utf-8"))
                else:
                    width, height = _crop_normalized_region(image_source, bbox, crop_path)
                    response = vision_page(
                        {
                            "paperId": paper_id,
                            "page": page_item["page"],
                            "imagePath": str(crop_path.resolve()),
                            "imageWidth": width,
                            "imageHeight": height,
                            "figureId": f"formula:page-{page_item['page']}:{index + 1}",
                            "paperTitle": result.document.title,
                            "task": "formula_repair",
                            "sourceText": source_text,
                            "promptVersion": prompt_version_formula,
                        }
                    )
                    temporary = response_path.with_suffix(".tmp")
                    temporary.write_text(
                        json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                    temporary.replace(response_path)
                repaired, confidence = _parse_formula_repair_response(response)
                if confidence < 0.85:
                    raise ValueError("公式区域置信度不足，已保留原始文本")
                repaired_markdown, replaced = _replace_unique_whitespace_equivalent(
                    page_item["markdown"], source_text, repaired
                )
                if not replaced:
                    raise ValueError("公式文本无法唯一映射到页面 Markdown")
                page_item["markdown"] = repaired_markdown
                page_item["uncertainties"] = [
                    candidate
                    for candidate in page_item.get("uncertainties", [])
                    if candidate is not issue
                ]
                usage = response.get("usage") or {}
                page_results.append(
                    {
                        "page": page_item["page"],
                        "task": "formula_repair",
                        "prompt_version": prompt_version_formula,
                        "cache_key": cache_key,
                        "cache_hit": cache_hit,
                        "artifact_path": str(response_path),
                        "model_id": str(response.get("modelId") or model_id),
                        "confidence": confidence,
                        "input_tokens": int(usage.get("inputTokens", 0)),
                        "output_tokens": int(usage.get("outputTokens", 0)),
                        "duration_ms": int(usage.get("durationMs", 0)),
                        "failed": False,
                    }
                )
            except Exception as error:  # noqa: BLE001 - unresolved formula remains reviewable
                page_results.append(
                    {
                        "page": page_item["page"],
                        "task": "formula_repair",
                        "prompt_version": prompt_version_formula,
                        "cache_key": cache_key,
                        "cache_hit": cache_hit,
                        "artifact_path": str(response_path) if response_path.is_file() else "",
                        "model_id": model_id,
                        "confidence": 0.0,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "duration_ms": 0,
                        "failed": True,
                        "error": f"{type(error).__name__}: {error}",
                    }
                )

    table_cache_dir = cache_dir / "tables"
    table_cache_dir.mkdir(parents=True, exist_ok=True)
    for table in result.document.tables:
        image_relative = str(table.get("image_path") or "")
        page_number = int(table.get("page") or 0)
        image_path = (output_dir / image_relative).resolve() if image_relative else None
        if not image_path or not image_path.is_file() or page_number not in page_result_by_number:
            continue
        prompt_version_table = "table-reconstruction-v2"
        cache_key = hashlib.sha256(
            f"{sha256}:{page_number}:{table.get('bbox')}:{model_id}:{prompt_version_table}".encode()
        ).hexdigest()
        response_path = table_cache_dir / f"{table['id']}-{cache_key[:16]}.json"
        cache_hit = response_path.is_file()
        try:
            if cache_hit:
                response = json.loads(response_path.read_text(encoding="utf-8"))
            else:
                response = vision_page(
                    {
                        "paperId": paper_id,
                        "page": page_number,
                        "imagePath": str(image_path),
                        "figureId": f"table:{table['id']}",
                        "paperTitle": result.document.title,
                        "caption": str(table.get("caption") or ""),
                        "task": "table_reconstruct",
                        "sourceText": str(table.get("source_text") or "")[:30_000],
                        "promptVersion": prompt_version_table,
                    }
                )
                temporary = response_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(response_path)
            parsed_table = _parse_vision_page_response(response)
            if not _is_gfm_table(parsed_table["markdown"]):
                raise ValueError("视觉模型没有返回合法的 Markdown 表格")
            markdown_path = output_dir / "tables" / f"{table['id']}.md"
            markdown_path.write_text(parsed_table["markdown"], encoding="utf-8")
            csv_path = output_dir / "tables" / f"{table['id']}.csv"
            table["markdown"] = parsed_table["markdown"]
            table["markdown_path"] = f"tables/{markdown_path.name}"
            if _write_table_csv(parsed_table["markdown"], csv_path):
                table["csv_path"] = f"tables/{csv_path.name}"
            page_item = page_result_by_number[page_number]
            page_item["markdown"] = _insert_reconstructed_table(
                page_item["markdown"], str(table.get("caption") or ""), parsed_table["markdown"]
            )
            page_item["uncertainties"] = [
                uncertainty
                for uncertainty in page_item.get("uncertainties", [])
                if uncertainty.get("kind") != "table"
            ]
            usage = response.get("usage") or {}
            page_results.append(
                {
                    "page": page_number,
                    "task": "table_reconstruct",
                    "prompt_version": prompt_version_table,
                    "cache_key": cache_key,
                    "cache_hit": cache_hit,
                    "artifact_path": str(response_path),
                    "model_id": str(response.get("modelId") or model_id),
                    "confidence": parsed_table["confidence"],
                    "input_tokens": int(usage.get("inputTokens", 0)),
                    "output_tokens": int(usage.get("outputTokens", 0)),
                    "duration_ms": int(usage.get("durationMs", 0)),
                    "failed": False,
                }
            )
        except Exception as error:  # noqa: BLE001 - keep readable page content on a table failure
            result.uncertainties.append(
                {
                    "page": page_number,
                    "kind": "table",
                    "bbox": table.get("bbox"),
                    "sourceText": str(table.get("source_text") or ""),
                    "candidateText": "",
                    "confidence": 0.0,
                    "resolutionStatus": "unresolved",
                }
            )
            page_results.append(
                {
                    "page": page_number,
                    "task": "table_reconstruct",
                    "prompt_version": prompt_version_table,
                    "cache_key": cache_key,
                    "cache_hit": cache_hit,
                    "artifact_path": str(response_path) if response_path.is_file() else "",
                    "model_id": model_id,
                    "confidence": 0.0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "duration_ms": 0,
                    "failed": True,
                    "error": f"{type(error).__name__}: {error}",
                }
            )

    page_markdown = [
        (
            item["page"],
            _normalize_reference_layout(
                _embed_figures(item["markdown"], figures_by_page.get(item["page"], []))
            ),
        )
        for item in page_results
        if item["task"] == "page_transcribe"
    ]
    page_markdown, removed = _remove_repeated_marginal_lines(page_markdown)
    result.document.sections = _semantic_sections(page_markdown, paper_id)
    result.markdown = "\n\n".join(section.markdown for section in result.document.sections)
    result.page_recognitions = page_results
    for item in page_results:
        for uncertainty in item.get("uncertainties", []):
            result.uncertainties.append({
                "page": item["page"],
                "kind": str(uncertainty.get("kind", "text")),
                "bbox": uncertainty.get("bbox"),
                "sourceText": str(uncertainty.get("sourceText", "")),
                "candidateText": str(uncertainty.get("candidateText", "")),
                "confidence": float(uncertainty.get("confidence", item["confidence"])),
                "resolutionStatus": "unresolved" if item["confidence"] < 0.85 else "resolved",
            })
    failed_pages = [
        item["page"]
        for item in page_results
        if item["task"] == "page_transcribe" and item["failed"]
    ]
    unresolved = [item for item in result.uncertainties if item["resolutionStatus"] == "unresolved"]
    result.document.partial = False
    result.document.warnings = [
        warning
        for warning in result.document.warnings
        if "pypdf fallback was used" not in warning
    ]
    if failed_pages or unresolved:
        result.document.partial = True
    if failed_pages:
        result.document.warnings.append(f"视觉识别失败页面：{', '.join(map(str, failed_pages))}")
    result.quality_stats = {
        "recognizedPageCount": sum(1 for item in page_results if item["task"] == "page_transcribe" and not item["failed"]),
        "cachedPageCount": sum(1 for item in page_results if item["cache_hit"]),
        "failedPageCount": len(failed_pages),
        "uncertainRegionCount": len(unresolved),
        "removedHeaderFooterCount": removed,
        "inputTokens": sum(item["input_tokens"] for item in page_results),
        "outputTokens": sum(item["output_tokens"] for item in page_results),
        "durationMs": int((time.monotonic() - started) * 1000),
    }
    return result


def _apply_qwen_ocr(
    result: ParseResult,
    source: Path,
    cache_dir: Path,
    paper_id: str,
    sha256: str,
    ocr_page: OcrPageCallback,
) -> ParseResult:
    started = time.monotonic()
    usage = OcrUsage(page_count=result.document.page_count)
    page_markdown: list[tuple[int, str]] = []
    warnings: list[str] = []
    fallback_pages = _page_markdown_from_sections(result.document)
    figures_by_page: dict[int, list[PaperFigure]] = {}
    for figure in result.document.figures:
        if figure.page is not None:
            figures_by_page.setdefault(figure.page, []).append(figure)

    def process_page(page_number: int) -> dict[str, Any]:
        cache_key = hashlib.sha256(
            f"{sha256}:{page_number}:qwen3.5-ocr:page-markdown-v1:200dpi:4096".encode()
        ).hexdigest()
        response_path = cache_dir / f"{page_number:04d}-{cache_key[:12]}.json"
        image_path = cache_dir / f"{page_number:04d}-{cache_key[:12]}.jpg"
        request_count = 0
        cache_hits = 0
        try:
            if response_path.exists():
                response = json.loads(response_path.read_text(encoding="utf-8"))
                cache_hits = 1
            else:
                width, height = _render_page(source, page_number - 1, image_path)
                response = ocr_page(
                    {
                        "paperId": paper_id,
                        "page": page_number,
                        "imagePath": str(image_path),
                        "imageWidth": width,
                        "imageHeight": height,
                        "model": "qwen3.5-ocr",
                        "promptVersion": "page-markdown-v1",
                    }
                )
                request_count = 1
                temporary = response_path.with_suffix(".tmp")
                temporary.write_text(
                    json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                temporary.replace(response_path)
            usage_data = response.get("usage", {})
            text = str(response.get("markdown", "")).strip()
            if not text:
                raise ValueError("Qwen OCR returned empty Markdown")
            return {
                "markdown": text,
                "request_count": request_count,
                "cache_hits": cache_hits,
                "input_tokens": int(usage_data.get("inputTokens", 0)),
                "output_tokens": int(usage_data.get("outputTokens", 0)),
                "failed": False,
            }
        except Exception as error:
            warning = f"Qwen OCR page {page_number}: {type(error).__name__}: {error}"
            fallback_text = fallback_pages.get(
                page_number, "_OCR failed for this page._"
            )
            return {
                "markdown": fallback_text,
                "request_count": request_count,
                "cache_hits": cache_hits,
                "input_tokens": 0,
                "output_tokens": 0,
                "failed": True,
                "warning": warning,
            }

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="qwen-ocr") as executor:
        page_results = list(
            executor.map(process_page, range(1, result.document.page_count + 1))
        )
    for page_number, page_result in enumerate(page_results, start=1):
        cleaned_markdown = _normalize_extracted_text(page_result["markdown"])
        page_markdown.append(
            (
                page_number,
                _embed_figures(
                    cleaned_markdown, figures_by_page.get(page_number, [])
                ),
            )
        )
        usage.request_count += page_result["request_count"]
        usage.cache_hits += page_result["cache_hits"]
        usage.input_tokens += page_result["input_tokens"]
        usage.output_tokens += page_result["output_tokens"]
        if page_result["failed"]:
            usage.failed_pages.append(page_number)
            warnings.append(page_result["warning"])
    usage.duration_ms = int((time.monotonic() - started) * 1000)
    result.document.ocr = usage
    result.document.partial = bool(usage.failed_pages)
    result.document.warnings.extend(warnings)
    if page_markdown:
        sections = _semantic_sections(page_markdown, paper_id)
        result.document.sections = sections
        frontmatter = (
            "---\n"
            f"paper_id: {paper_id}\n"
            f"source_sha256: {sha256}\n"
            "ocr: qwen3.5-ocr\n"
            "---\n\n"
            f"# {result.document.title}\n\n"
        )
        result.markdown = frontmatter + "\n\n".join(
            section.markdown for section in sections
        )
    return result


def _apply_region_visual_reconstruction(
    result: ParseResult,
    source: Path,
    output_dir: Path,
    cache_dir: Path,
    paper_id: str,
    sha256: str,
    model_id: str,
    vision_page: VisionPageCallback,
    vision_call_limit: int | None = None,
) -> ParseResult:
    regions = plan_visual_regions(
        source,
        output_dir,
        cache_dir,
        result.document.tables,
        result.document.figures,
    )
    if not any(region["kind"] in {"body", "references"} for region in regions):
        raise RuntimeError("未能从 PDF 几何版面生成正文视觉区域")
    reconstruction = reconstruct_visual_regions(
        regions,
        cache_dir,
        output_dir,
        paper_id,
        result.document.title,
        sha256,
        model_id,
        vision_page,
        vision_call_limit,
    )
    figures_by_page: dict[int, list[PaperFigure]] = {}
    for figure in result.document.figures:
        if figure.page is not None:
            figures_by_page.setdefault(figure.page, []).append(figure)
    page_markdown = [
        (
            page,
            _normalize_reference_layout(
                _embed_figures(markdown, figures_by_page.get(page, []))
            ),
        )
        for page, markdown in reconstruction["page_markdown"]
    ]
    page_markdown, removed = _remove_repeated_marginal_lines(page_markdown)
    result.document.sections = _semantic_sections(page_markdown, paper_id)
    result.markdown = "\n\n".join(section.markdown for section in result.document.sections)
    result.visual_regions = reconstruction["regions"]
    result.page_recognitions = []

    successful_tables = {table["id"]: table for table in reconstruction["tables"]}
    result.document.tables = [
        successful_tables.get(str(table.get("id")), table)
        for table in result.document.tables
    ]
    required_failures = [
        region
        for region in result.visual_regions
        if region.get("required") and region.get("status") != "completed"
    ]
    optional_failures = [
        region
        for region in result.visual_regions
        if not region.get("required") and region.get("status") != "completed"
    ]
    result.uncertainties = [
        {
            "page": int(region["page"]),
            "kind": "table" if region["kind"] == "table" else "formula" if region["kind"] == "formula" else "text",
            "bbox": region.get("bbox"),
            "sourceText": str(region.get("source_text") or ""),
            "candidateText": "",
            "confidence": float(region.get("confidence") or 0.0),
            "resolutionStatus": "unresolved",
        }
        for region in [*required_failures, *optional_failures]
    ]
    result.document.warnings = [
        warning
        for warning in result.document.warnings
        if "pypdf fallback was used" not in warning
    ]
    result.document.partial = bool(optional_failures or required_failures)
    if required_failures:
        failed_pages = ", ".join(map(str, reconstruction["failed_pages"]))
        result.document.warnings.append(f"正文视觉区域失败页面：{failed_pages}")
    if optional_failures:
        result.document.warnings.append(f"{len(optional_failures)} 个公式或表格区域使用原图降级")
    result.quality_stats = {
        "pipelineVersion": "visual-document-v3",
        "publishable": bool(reconstruction["publishable"]),
        "recognizedPageCount": int(reconstruction["successful_pages"]),
        "cachedPageCount": len([region for region in result.visual_regions if region.get("cache_hit")]),
        "failedPageCount": len(reconstruction["failed_pages"]),
        "uncertainRegionCount": len(result.uncertainties),
        "removedHeaderFooterCount": removed,
        "totalRegionCount": len(result.visual_regions),
        "completedRegionCount": len([region for region in result.visual_regions if region.get("status") == "completed"]),
        "failedRegionCount": len([region for region in result.visual_regions if region.get("status") == "failed"]),
        "unknownRegionCount": len([region for region in result.visual_regions if region.get("status") == "unknown"]),
        "estimatedVisionCalls": int(reconstruction["estimated_calls"]),
        "visionModelId": model_id,
        "inputTokens": int(reconstruction["input_tokens"]),
        "outputTokens": int(reconstruction["output_tokens"]),
        "durationMs": int(reconstruction["duration_ms"]),
    }
    return result


def _failed_visual_result(result: ParseResult, error: Exception, model_id: str) -> ParseResult:
    result.document.sections = []
    result.markdown = ""
    result.document.partial = True
    result.document.warnings = [f"区域化视觉重建失败：{type(error).__name__}: {error}"]
    result.quality_stats = {
        "pipelineVersion": "visual-document-v3",
        "publishable": False,
        "recognizedPageCount": 0,
        "cachedPageCount": 0,
        "failedPageCount": result.document.page_count,
        "uncertainRegionCount": 0,
        "removedHeaderFooterCount": 0,
        "totalRegionCount": 0,
        "completedRegionCount": 0,
        "failedRegionCount": 0,
        "unknownRegionCount": 0,
        "estimatedVisionCalls": 0,
        "visionModelId": model_id,
        "inputTokens": 0,
        "outputTokens": 0,
        "durationMs": 0,
    }
    return result


def parse_pdf(
    source: Path,
    output_dir: Path,
    paper_id: str,
    sha256: str,
    cache_dir: Path | None = None,
    ocr_page: OcrPageCallback | None = None,
    vision_page: VisionPageCallback | None = None,
    vision_model_id: str | None = None,
    vision_call_limit: int | None = None,
) -> ParseResult:
    output_dir.mkdir(parents=True, exist_ok=True)
    docling_disabled = os.environ.get("P2I_DISABLE_DOCLING") == "1"
    try:
        if docling_disabled:
            raise importlib.metadata.PackageNotFoundError("disabled by P2I_DISABLE_DOCLING")
        importlib.metadata.version("docling")
    except importlib.metadata.PackageNotFoundError:
        result = _parse_with_pypdf(source, output_dir, paper_id, sha256)
        result.document.partial = True
        reason = "Docling disabled; pypdf fallback was used" if docling_disabled else "Docling unavailable; pypdf fallback was used"
        result.document.warnings.append(reason)
        if vision_page and vision_model_id and cache_dir:
            try:
                return _apply_region_visual_reconstruction(
                    result, source, output_dir, cache_dir.parents[1] / "vision" / sha256, paper_id, sha256,
                    vision_model_id, vision_page, vision_call_limit,
                )
            except Exception as error:
                return _failed_visual_result(result, error, vision_model_id)
        if ocr_page and cache_dir:
            try:
                return _apply_qwen_ocr(result, source, cache_dir, paper_id, sha256, ocr_page)
            except Exception as error:
                result.document.partial = True
                result.document.warnings.append(f"Qwen OCR unavailable: {type(error).__name__}: {error}")
        return result
    try:
        result = _parse_with_docling(source, output_dir, paper_id, sha256)
    except Exception:
        result = _parse_with_pypdf(source, output_dir, paper_id, sha256)
        result.document.partial = True
        result.document.warnings.append("Docling failed; pypdf fallback was used")
    if vision_page and vision_model_id and cache_dir:
        try:
            return _apply_region_visual_reconstruction(
                result, source, output_dir, cache_dir.parents[1] / "vision" / sha256, paper_id, sha256,
                vision_model_id, vision_page, vision_call_limit,
            )
        except Exception as error:
            return _failed_visual_result(result, error, vision_model_id)
    if ocr_page and cache_dir:
        try:
            result = _apply_qwen_ocr(result, source, cache_dir, paper_id, sha256, ocr_page)
        except Exception as error:
            result.document.partial = True
            result.document.warnings.append(f"Qwen OCR unavailable: {type(error).__name__}: {error}")
    return result
