from __future__ import annotations

import importlib.metadata
import hashlib
import io
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Any

from pypdf import PdfReader

from ..models import BoundingBox, EvidenceAnchor, OcrUsage, PaperDocument, PaperFigure, PaperSection, ParserInfo


@dataclass
class ParseResult:
    document: PaperDocument
    markdown: str


OcrPageCallback = Callable[[dict[str, Any]], dict[str, Any]]


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
    figures: list[PaperFigure] = []
    title = source.stem.replace("_", " ").replace("-", " ").strip()

    for page_index, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        nonempty_lines = [line.strip() for line in text.splitlines() if line.strip()]
        if page_index == 1 and nonempty_lines:
            candidate = nonempty_lines[0]
            if 5 <= len(candidate) <= 240:
                title = candidate
        body = text or "_No extractable text was found on this page._"
        page_markdown = body

        try:
            for image_index, image in enumerate(page.images, start=1):
                image_name = _safe_image_name(image.name, len(figures) + image_index)
                image_path = figure_dir / image_name
                image_path.write_bytes(image.data)
                thumbnail_name = _thumbnail(
                    image.data, figure_dir / f"{Path(image_name).stem}-thumb.webp"
                )
                mime = "image/png" if image_name.lower().endswith(".png") else "image/jpeg"
                figures.append(
                    PaperFigure(
                        id=f"figure-{len(figures) + 1}",
                        relative_path=f"figures/{image_name}",
                        page=page_index,
                        mime_type=mime,
                        thumbnail_path=f"figures/{thumbnail_name}" if thumbnail_name else None,
                    )
                )
                page_markdown += f"\n\n![Figure on page {page_index}](figures/{image_name})"
        except Exception:
            # Image extraction varies across PDF encodings; text parsing remains valid.
            pass
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
    markdown = conversion.document.export_to_markdown()
    exported = conversion.document.export_to_dict()
    sections = _semantic_sections([(1, markdown)], paper_id)
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
            fallback_text = next(
                (
                    anchor.source_text
                    for section in result.document.sections
                    for anchor in section.anchors
                    if anchor.page == page_number
                ),
                "_OCR failed for this page._",
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
        page_markdown.append((page_number, page_result["markdown"]))
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


def parse_pdf(
    source: Path,
    output_dir: Path,
    paper_id: str,
    sha256: str,
    cache_dir: Path | None = None,
    ocr_page: OcrPageCallback | None = None,
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
    if ocr_page and cache_dir:
        try:
            result = _apply_qwen_ocr(result, source, cache_dir, paper_id, sha256, ocr_page)
        except Exception as error:
            result.document.partial = True
            result.document.warnings.append(f"Qwen OCR unavailable: {type(error).__name__}: {error}")
    return result
