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


def _parse_with_pypdf(
    source: Path,
    output_dir: Path,
    paper_id: str,
    sha256: str,
) -> ParseResult:
    reader = PdfReader(str(source))
    figure_dir = output_dir / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)
    sections: list[PaperSection] = []
    figures: list[PaperFigure] = []
    markdown_parts: list[str] = []
    title = source.stem.replace("_", " ").replace("-", " ").strip()

    for page_index, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        nonempty_lines = [line.strip() for line in text.splitlines() if line.strip()]
        if page_index == 1 and nonempty_lines:
            candidate = nonempty_lines[0]
            if 5 <= len(candidate) <= 240:
                title = candidate
        section_id = f"section-{page_index}"
        block_id = f"page-{page_index}-block-1"
        anchor = EvidenceAnchor(
            paper_id=paper_id,
            section_id=section_id,
            block_id=block_id,
            page=page_index,
            source_text=text[:500],
        )
        anchor_html = (
            f'<a data-paper-id="{paper_id}" data-page="{page_index}" '
            f'data-block-id="{block_id}"></a>'
        )
        body = text or "_No extractable text was found on this page._"
        section_markdown = f"## Page {page_index}\n\n{anchor_html}\n\n{body}"
        sections.append(
            PaperSection(
                id=section_id,
                title=f"Page {page_index}",
                order=page_index - 1,
                page_start=page_index,
                page_end=page_index,
                markdown=section_markdown,
                anchors=[anchor],
            )
        )
        markdown_parts.append(section_markdown)

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
                markdown_parts.append(
                    f"\n![Figure on page {page_index}](figures/{image_name})\n"
                )
        except Exception:
            # Image extraction varies across PDF encodings; text parsing remains valid.
            pass

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
    raw_text = markdown[:500]
    section = PaperSection(
        id="section-1",
        title="Document",
        order=0,
        page_start=1,
        markdown=markdown,
        anchors=[
            EvidenceAnchor(
                paper_id=paper_id,
                section_id="section-1",
                block_id="document-block-1",
                page=1,
                source_text=raw_text,
            )
        ],
    )
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
        sections=[section],
        figures=figures,
        tables=tables,
        parser=ParserInfo(
            name="docling", version=importlib.metadata.version("docling")
        ),
    )
    (output_dir / "docling-native.json").write_text(
        json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    anchored = (
        f'<a data-paper-id="{paper_id}" data-page="1" '
        'data-block-id="document-block-1"></a>\n\n'
    )
    return ParseResult(document=document, markdown=anchored + markdown)


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
    sections: list[PaperSection] = []
    markdown_parts: list[str] = []
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
            confidence = float(response.get("alignmentConfidence", 0))
            section_id = f"section-{page_number}"
            block_id = f"page-{page_number}-ocr"
            anchor = EvidenceAnchor(
                paper_id=paper_id,
                section_id=section_id,
                block_id=block_id,
                page=page_number,
                source_text=text[:500],
            )
            anchor_html = (
                f'<a data-paper-id="{paper_id}" data-page="{page_number}" '
                f'data-block-id="{block_id}" data-alignment-confidence="{confidence:.3f}"></a>'
            )
            markdown = f"## Page {page_number}\n\n{anchor_html}\n\n{text}"
            section = PaperSection(
                id=section_id,
                title=f"Page {page_number}",
                order=page_number - 1,
                page_start=page_number,
                page_end=page_number,
                markdown=markdown,
                anchors=[anchor],
            )
            return {
                "section": section,
                "markdown": markdown,
                "request_count": request_count,
                "cache_hits": cache_hits,
                "input_tokens": int(usage_data.get("inputTokens", 0)),
                "output_tokens": int(usage_data.get("outputTokens", 0)),
                "failed": False,
            }
        except Exception as error:
            warning = f"Qwen OCR page {page_number}: {type(error).__name__}: {error}"
            fallback = next(
                (section for section in result.document.sections if section.page_start == page_number),
                None,
            )
            if fallback is None:
                block_id = f"page-{page_number}-ocr-failed"
                fallback_markdown = (
                    f"## Page {page_number}\n\n"
                    f'<a data-paper-id="{paper_id}" data-page="{page_number}" '
                    f'data-block-id="{block_id}"></a>\n\n'
                    "_OCR failed for this page._"
                )
                fallback = PaperSection(
                    id=f"section-{page_number}",
                    title=f"Page {page_number}",
                    order=page_number - 1,
                    page_start=page_number,
                    page_end=page_number,
                    markdown=fallback_markdown,
                    anchors=[
                        EvidenceAnchor(
                            paper_id=paper_id,
                            section_id=f"section-{page_number}",
                            block_id=block_id,
                            page=page_number,
                            source_text="OCR failed for this page.",
                        )
                    ],
                )
            return {
                "section": fallback,
                "markdown": fallback.markdown,
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
        sections.append(page_result["section"])
        markdown_parts.append(page_result["markdown"])
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
    if sections:
        result.document.sections = sections
        frontmatter = (
            "---\n"
            f"paper_id: {paper_id}\n"
            f"source_sha256: {sha256}\n"
            "ocr: qwen3.5-ocr\n"
            "---\n\n"
            f"# {result.document.title}\n\n"
        )
        result.markdown = frontmatter + "\n\n".join(markdown_parts)
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
