from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import fitz
from PIL import Image


VisionCallback = Callable[[dict[str, Any]], dict[str, Any]]

PROMPTS = {
    "body": "body-transcription-v3",
    "table": "table-structure-v3",
    "formula": "formula-structure-v3",
    "references": "references-structure-v3",
}


def _bbox(rect: fitz.Rect, page: fitz.Rect) -> dict[str, float]:
    return {
        "left": max(0.0, rect.x0 / page.width),
        "top": max(0.0, rect.y0 / page.height),
        "right": min(1.0, rect.x1 / page.width),
        "bottom": min(1.0, rect.y1 / page.height),
    }


def _rect(value: dict[str, Any], page: fitz.Rect) -> fitz.Rect:
    return fitz.Rect(
        float(value["left"]) * page.width,
        float(value["top"]) * page.height,
        float(value["right"]) * page.width,
        float(value["bottom"]) * page.height,
    )


def _overlap_ratio(left: fitz.Rect, right: fitz.Rect) -> float:
    intersection = left & right
    return 0.0 if left.is_empty or intersection.is_empty else intersection.get_area() / left.get_area()


def _clean_json(value: str) -> dict[str, Any]:
    cleaned = value.strip()
    cleaned = re.sub(r"^```(?:json|markdown)?\s*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    parsed = json.loads(cleaned)
    if not isinstance(parsed, dict):
        raise ValueError("视觉模型响应不是 JSON 对象")
    return parsed


def _response_payload(response: dict[str, Any]) -> dict[str, Any]:
    return _clean_json(str(response.get("description") or ""))


def _crop(page: fitz.Page, rect: fitz.Rect, target: Path, scale: float = 2.5) -> tuple[int, int, str]:
    page_rect = page.rect
    clip = fitz.Rect(
        max(page_rect.x0, rect.x0 - 5),
        max(page_rect.y0, rect.y0 - 5),
        min(page_rect.x1, rect.x1 + 5),
        min(page_rect.y1, rect.y1 + 5),
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
    pixmap.save(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    return pixmap.width, pixmap.height, digest


def _cluster_rects(items: list[tuple[fitz.Rect, str]], page: fitz.Rect) -> list[tuple[fitz.Rect, str]]:
    clusters: list[tuple[fitz.Rect, list[str]]] = []
    for rect, text in sorted(items, key=lambda item: (item[0].y0, item[0].x0)):
        if not clusters:
            clusters.append((fitz.Rect(rect), [text]))
            continue
        current, texts = clusters[-1]
        gap = rect.y0 - current.y1
        if gap <= 24 and max(current.y1, rect.y1) - current.y0 <= page.height * 0.48:
            clusters[-1] = (current | rect, texts)
            texts.append(text)
        else:
            clusters.append((fitz.Rect(rect), [text]))
    return [(rect, "\n".join(texts)) for rect, texts in clusters]


def _is_marginal_block(rect: fitz.Rect, text: str, page: fitz.Rect) -> bool:
    if rect.y1 < page.height * 0.07 or rect.y0 > page.height * 0.925:
        return True
    if rect.height > page.height * 0.55 and rect.width < page.width * 0.08:
        return True
    return bool(re.fullmatch(r"(?:page\s*)?\d{1,5}", text, re.I))


def _lane_clusters(
    items: list[tuple[fitz.Rect, str]],
    page: fitz.Rect,
    *,
    max_height_ratio: float = 0.43,
) -> list[tuple[fitz.Rect, str]]:
    """Merge nearby text blocks into stable, bounded column crops."""

    clusters: list[tuple[fitz.Rect, list[str]]] = []
    for rect, text in sorted(items, key=lambda item: (item[0].y0, item[0].x0)):
        if not clusters:
            clusters.append((fitz.Rect(rect), [text]))
            continue
        current, texts = clusters[-1]
        gap = rect.y0 - current.y1
        merged_height = max(current.y1, rect.y1) - min(current.y0, rect.y0)
        if gap <= 38 and merged_height <= page.height * max_height_ratio:
            clusters[-1] = (current | rect, texts)
            texts.append(text)
        else:
            clusters.append((fitz.Rect(rect), [text]))
    return [(rect, "\n".join(texts)) for rect, texts in clusters]


def _formula_regions(page: fitz.Page, page_number: int) -> list[tuple[fitz.Rect, list[int]]]:
    """Locate numbered display equations from their right-aligned equation labels."""

    page_rect = page.rect
    center = page_rect.width / 2
    lanes: dict[int, list[tuple[fitz.Rect, int]]] = {0: [], 1: []}
    for number in range(1, 100):
        for hit in page.search_for(f"({number})"):
            lane = 0 if hit.x0 < center else 1
            lane_right = center - 8 if lane == 0 else page_rect.x1 - 48
            if hit.x0 < lane_right - 24:
                continue
            lanes[lane].append((fitz.Rect(hit), number))

    regions: list[tuple[fitz.Rect, list[int]]] = []
    for lane, hits in lanes.items():
        if not hits:
            continue
        left = page_rect.x0 + 28 if lane == 0 else center + 8
        right = center - 8 if lane == 0 else page_rect.x1 - 28
        top = max(page_rect.y0 + 28, min(hit.y0 for hit, _ in hits) - 34)
        bottom = min(page_rect.height * 0.925, max(hit.y1 for hit, _ in hits) + 18)
        regions.append((fitz.Rect(left, top, right, bottom), sorted({number for _, number in hits})))
    return regions


def _safe_relative(path: Path, root: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"视觉区域产物越过修订目录: {resolved}") from error


def _expected_table_columns(source_text: str) -> int | None:
    metric_columns = len(re.findall(r"A\s*\(%\)\s*/\s*F\s*\(%\)", source_text, re.I))
    if metric_columns >= 2 and re.search(r"\bDataset\b", source_text, re.I) and re.search(r"\bModels?\b", source_text, re.I):
        return metric_columns + 2
    return None


def _formula_number(text: str) -> int | None:
    matches = re.findall(r"\(\s*(\d{1,3})\s*\)", text)
    return int(matches[-1]) if matches else None


def plan_visual_regions(
    source: Path,
    output_dir: Path,
    cache_dir: Path,
    tables: list[dict[str, Any]],
    figures: list[Any],
) -> list[dict[str, Any]]:
    """Build deterministic reading regions using only production PyMuPDF geometry."""

    regions: list[dict[str, Any]] = []
    region_dir = cache_dir / "regions"
    region_dir.mkdir(parents=True, exist_ok=True)
    table_by_page: dict[int, list[dict[str, Any]]] = {}
    for table in tables:
        table_by_page.setdefault(int(table.get("page") or 0), []).append(table)
    figure_by_page: dict[int, list[Any]] = {}
    for figure in figures:
        if getattr(figure, "page", None):
            figure_by_page.setdefault(int(figure.page), []).append(figure)

    with fitz.open(source) as document:
        for page_number, page in enumerate(document, start=1):
            page_rect = page.rect
            raw_blocks = page.get_text("blocks", sort=True)
            blocks: list[tuple[fitz.Rect, str]] = []
            for block in raw_blocks:
                rect = fitz.Rect(block[:4])
                text = re.sub(r"[ \t]+", " ", str(block[4])).strip()
                if not text or _is_marginal_block(rect, text, page_rect):
                    continue
                blocks.append((rect, text))

            exclusions: list[fitz.Rect] = []
            for table in table_by_page.get(page_number, []):
                if isinstance(table.get("bbox"), dict):
                    exclusions.append(_rect(table["bbox"], page_rect))
            for figure in figure_by_page.get(page_number, []):
                bbox = getattr(figure, "bbox", None)
                if bbox:
                    exclusions.append(
                        fitz.Rect(
                            bbox.left * page_rect.width,
                            bbox.top * page_rect.height,
                            bbox.right * page_rect.width,
                            bbox.bottom * page_rect.height,
                        )
                    )

            reference_heading = next(
                (
                    rect
                    for rect, text in blocks
                    if re.fullmatch(r"(?:\d+\.?\s+)?(?:references|bibliography)", text, re.I)
                ),
                None,
            )
            sequence = page_number * 100
            looks_like_references = len(
                [text for _, text in blocks if re.match(r"^\[\d+\]", text)]
            ) >= 3
            if reference_heading or looks_like_references:
                top = max(reference_heading.y1 if reference_heading else page_rect.height * 0.07, page_rect.height * 0.06)
                for lane, (left, right) in enumerate(
                    ((page_rect.x0 + 28, page_rect.width / 2 - 8), (page_rect.width / 2 + 8, page_rect.x1 - 28))
                ):
                    rect = fitz.Rect(left, top, right, page_rect.height * 0.94)
                    target = region_dir / f"page-{page_number}-references-{lane + 1}.png"
                    width, height, image_hash = _crop(page, rect, target)
                    sequence += 1
                    regions.append(
                        {
                            "region_key": f"p{page_number}:references:{lane + 1}",
                            "page": page_number,
                            "kind": "references",
                            "sequence": sequence,
                            "bbox": _bbox(rect, page_rect),
                            "image_path": str(target),
                            "image_width": width,
                            "image_height": height,
                            "image_hash": image_hash,
                            "source_text": page.get_textbox(rect),
                            "required": True,
                            "prompt_version": PROMPTS["references"],
                        }
                    )
                continue

            usable = [
                (rect, text)
                for rect, text in blocks
                if not any(_overlap_ratio(rect, exclusion) > 0.28 for exclusion in exclusions)
            ]
            center = page_rect.width / 2
            full = [
                (rect, text)
                for rect, text in usable
                if rect.x0 < page_rect.width * 0.25 and rect.x1 > page_rect.width * 0.75
            ]
            left = [(rect, text) for rect, text in usable if (rect, text) not in full and rect.x0 < center]
            right = [(rect, text) for rect, text in usable if (rect, text) not in full and rect.x0 >= center]

            ordered_clusters: list[tuple[fitz.Rect, str]] = []
            top_columns = min((rect.y0 for rect, _ in left + right), default=page_rect.height)
            ordered_clusters.extend(_lane_clusters([(r, t) for r, t in full if r.y0 <= top_columns + 12], page_rect))
            ordered_clusters.extend(_lane_clusters(left, page_rect))
            ordered_clusters.extend(_lane_clusters(right, page_rect))
            ordered_clusters.extend(_lane_clusters([(r, t) for r, t in full if r.y0 > top_columns + 12], page_rect))

            seen: set[tuple[int, int, int, int]] = set()
            for rect, text in ordered_clusters:
                key = tuple(round(value) for value in (rect.x0, rect.y0, rect.x1, rect.y1))
                if key in seen or rect.width < 40 or rect.height < 12:
                    continue
                seen.add(key)
                sequence += 1
                target = region_dir / f"page-{page_number}-body-{sequence % 100:02d}.png"
                width, height, image_hash = _crop(page, rect, target)
                regions.append(
                    {
                        "region_key": f"p{page_number}:body:{sequence % 100}",
                        "page": page_number,
                        "kind": "body",
                        "sequence": sequence,
                        "bbox": _bbox(rect, page_rect),
                        "image_path": str(target),
                        "image_width": width,
                        "image_height": height,
                        "image_hash": image_hash,
                        "source_text": text,
                        "required": True,
                        "prompt_version": PROMPTS["body"],
                    }
                )

            for formula_index, (rect, numbers) in enumerate(_formula_regions(page, page_number), start=1):
                sequence += 1
                target = region_dir / f"page-{page_number}-formula-{formula_index}.png"
                width, height, image_hash = _crop(page, rect, target, 3.0)
                regions.append(
                    {
                        "region_key": f"p{page_number}:formula:{'-'.join(map(str, numbers))}",
                        "page": page_number,
                        "kind": "formula",
                        "sequence": sequence,
                        "bbox": _bbox(rect, page_rect),
                        "image_path": str(target),
                        "image_width": width,
                        "image_height": height,
                        "image_hash": image_hash,
                        "source_text": page.get_textbox(rect),
                        "required": False,
                        "prompt_version": PROMPTS["formula"],
                        "formula_numbers": numbers,
                    }
                )

            for table in table_by_page.get(page_number, []):
                image_relative = str(table.get("image_path") or "")
                image_path = (output_dir / image_relative).resolve() if image_relative else None
                if not image_path or not image_path.is_file():
                    continue
                table_sequence = page_number * 100 + (
                    0 if float((table.get("bbox") or {}).get("top", 1.0)) < 0.4 else 90
                )
                regions.append(
                    {
                        "region_key": f"p{page_number}:table:{table.get('id')}",
                        "page": page_number,
                        "kind": "table",
                        "sequence": table_sequence,
                        "bbox": table.get("bbox") or {},
                        "image_path": str(image_path),
                        "image_width": 0,
                        "image_height": 0,
                        "image_hash": hashlib.sha256(image_path.read_bytes()).hexdigest(),
                        "source_text": str(table.get("source_text") or ""),
                        "caption": str(table.get("caption") or ""),
                        "table_id": str(table.get("id")),
                        "expected_columns": _expected_table_columns(str(table.get("source_text") or "")),
                        "required": False,
                        "prompt_version": PROMPTS["table"],
                    }
                )
    return sorted(regions, key=lambda item: (item["page"], item["sequence"]))


def _formula_valid(value: str) -> bool:
    text = value.strip().strip("$")
    if not text or any(character in text for character in ("�", "□", "\x00")):
        return False
    pairs = (("{", "}"), ("(", ")"), ("[", "]"))
    return all(text.count(left) == text.count(right) for left, right in pairs)


def _render_blocks(payload: dict[str, Any], formulas: dict[int, str] | None = None) -> tuple[str, float]:
    blocks = payload.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("正文区域没有返回结构化 blocks")
    rendered: list[str] = []
    confidences: list[float] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "paragraph")
        text = re.sub(r"[ \t]+", " ", str(block.get("text") or "")).strip()
        confidence = max(0.0, min(1.0, float(block.get("confidence") or payload.get("confidence") or 0.0)))
        if not text and kind != "formula":
            continue
        confidences.append(confidence)
        if kind == "heading":
            level = max(1, min(4, int(block.get("level") or 2)))
            rendered.append(f"{'#' * level} {text.lstrip('#').strip()}")
        elif kind == "list":
            rendered.extend(f"- {line.strip().lstrip('-•').strip()}" for line in text.splitlines() if line.strip())
        elif kind == "quote":
            rendered.append("\n".join(f"> {line}" for line in text.splitlines()))
        elif kind == "formula":
            number = block.get("number")
            latex = formulas.get(int(number)) if formulas and str(number).isdigit() else text
            if not _formula_valid(latex or ""):
                raise ValueError(f"公式 {number or ''} 未通过 LaTeX 结构校验")
            latex = str(latex).strip().strip("$")
            tag = f" \\tag{{{int(number)}}}" if str(number).isdigit() and "\\tag" not in latex else ""
            rendered.append(f"$${latex}{tag}$$")
        else:
            rendered.append(re.sub(r"\s*\n\s*", " ", text))
    if not rendered:
        raise ValueError("正文区域没有可发布内容")
    confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return "\n\n".join(rendered), confidence


def _parse_formulas(payload: dict[str, Any]) -> tuple[dict[int, str], float]:
    items = payload.get("formulas")
    if not isinstance(items, list) or not items:
        raise ValueError("公式区域没有返回 formulas")
    formulas: dict[int, str] = {}
    confidences: list[float] = []
    for item in items:
        if not isinstance(item, dict) or not str(item.get("number") or "").isdigit():
            continue
        number = int(item["number"])
        latex = str(item.get("latex") or "").strip().strip("$")
        confidence = max(0.0, min(1.0, float(item.get("confidence") or 0.0)))
        if confidence < 0.85 or not _formula_valid(latex):
            raise ValueError(f"公式 ({number}) 置信度或结构无效")
        formulas[number] = latex
        confidences.append(confidence)
    if not formulas:
        raise ValueError("公式区域没有可靠结果")
    return formulas, sum(confidences) / len(confidences)


def _markdown_table_rows(markdown: str) -> tuple[list[str], list[list[str]]]:
    lines = [line.strip() for line in markdown.splitlines() if line.strip().startswith("|")]
    if len(lines) < 3:
        raise ValueError("Markdown 表格不足三行")
    cells = [[cell.strip() for cell in line.strip("|").split("|")] for line in lines]
    if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells[1]):
        raise ValueError("Markdown 表格缺少表头分隔线")
    return cells[0], cells[2:]


def _parse_table(
    payload: dict[str, Any], expected_columns: int | None = None
) -> tuple[str, list[str], list[list[str]], list[str], float]:
    if isinstance(payload.get("markdown"), str):
        headers, rows = _markdown_table_rows(str(payload["markdown"]))
        if expected_columns and len(headers) != expected_columns:
            raise ValueError(f"表格应为 {expected_columns} 列，实际为 {len(headers)} 列")
        return "", headers, rows, [], float(payload.get("confidence") or 0.9)
    caption = re.sub(r"\s+", " ", str(payload.get("caption") or "")).strip()
    headers = [str(value).strip() for value in payload.get("headers", [])]
    rows = [[str(value).strip() for value in row] for row in payload.get("rows", []) if isinstance(row, list)]
    footnotes = [str(value).strip() for value in payload.get("footnotes", []) if str(value).strip()]
    confidence = max(0.0, min(1.0, float(payload.get("confidence") or 0.0)))
    if len(headers) < 2 or not rows or confidence < 0.8:
        raise ValueError("表格结构或置信度无效")
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("表格行列数不一致")
    if expected_columns and len(headers) != expected_columns:
        raise ValueError(f"表格应为 {expected_columns} 列，实际为 {len(headers)} 列")
    return caption, headers, rows, footnotes, confidence


def _table_markdown(caption: str, headers: list[str], rows: list[list[str]], footnotes: list[str]) -> str:
    escape = lambda value: value.replace("|", r"\|").replace("\n", "<br>")
    lines = []
    if caption:
        lines.append(caption)
        lines.append("")
    lines.append("| " + " | ".join(escape(value) for value in headers) + " |")
    lines.append("| " + " | ".join("---" for _ in headers) + " |")
    lines.extend("| " + " | ".join(escape(value) for value in row) + " |" for row in rows)
    if footnotes:
        lines.extend(["", *[f"> {note}" for note in footnotes]])
    return "\n".join(lines)


def _table_chunks(region: dict[str, Any], cache_dir: Path) -> list[dict[str, Any]]:
    image_path = Path(region["image_path"])
    with Image.open(image_path) as image:
        width, height = image.size
        count = 2 if len(region.get("source_text", "")) > 1800 or height > 1100 else 1
        if count == 1:
            return [{**region, "chunk": 1, "chunk_count": 1}]
        header_height = max(80, min(int(height * 0.24), 260))
        body_height = height - header_height
        chunk_height = math.ceil(body_height / count)
        chunks = []
        for index in range(count):
            top = header_height + index * chunk_height
            bottom = min(height, header_height + (index + 1) * chunk_height + (18 if index + 1 < count else 0))
            header = image.crop((0, 0, width, header_height)).convert("RGB")
            body = image.crop((0, top, width, bottom)).convert("RGB")
            combined = Image.new("RGB", (width, header.height + body.height), "white")
            combined.paste(header, (0, 0))
            combined.paste(body, (0, header.height))
            target = cache_dir / f"{region['region_key'].replace(':', '-')}-chunk-{index + 1}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            combined.save(target, "PNG")
            chunks.append(
                {
                    **region,
                    "source_image_path": region["image_path"],
                    "region_key": f"{region['region_key']}:chunk:{index + 1}",
                    "image_path": str(target),
                    "image_hash": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "chunk": index + 1,
                    "chunk_count": count,
                }
            )
        return chunks


def _classify_error(error: Exception) -> tuple[str, str]:
    message = str(error)
    lowered = message.casefold()
    if "timeout_unknown" in lowered or "timed out" in lowered or "timeout" in lowered:
        return "timeout_unknown", "请求超时，费用状态未知；不会自动重试"
    if "connect:" in lowered or "dns" in lowered or "connection" in lowered:
        return "connect", "无法连接视觉模型服务"
    if "http" in lowered:
        return "http", message[:500]
    if isinstance(error, (json.JSONDecodeError, ValueError)):
        return "validation", message[:500]
    return "invalid_response", message[:500]


def _legacy_table_cache(
    regions: list[dict[str, Any]], cache_dir: Path
) -> dict[str, dict[str, Any]]:
    cached: dict[str, dict[str, Any]] = {}
    legacy_tables = cache_dir / "tables"
    for region in regions:
        if region["kind"] != "table":
            continue
        table_id = region.get("table_id")
        for candidate in sorted(legacy_tables.glob(f"{table_id}-*.json"), reverse=True):
            try:
                response = json.loads(candidate.read_text(encoding="utf-8"))
                _parse_table(_response_payload(response), region.get("expected_columns"))
                cached[str(table_id)] = {"response": response, "path": candidate}
                break
            except (OSError, ValueError, json.JSONDecodeError):
                continue
    return cached


def estimate_visual_calls(
    regions: list[dict[str, Any]],
    cache_dir: Path,
    source_hash: str,
    model_id: str,
) -> dict[str, int]:
    cached_legacy = _legacy_table_cache(regions, cache_dir)
    units: list[dict[str, Any]] = []
    for region in regions:
        if region["kind"] == "table" and str(region.get("table_id")) not in cached_legacy:
            units.extend(_table_chunks(region, cache_dir / "table-chunks"))
        else:
            units.append(region)
    cached = 0
    for unit in units:
        if unit["kind"] == "table" and str(unit.get("table_id")) in cached_legacy:
            cached += 1
            continue
        cache_key = hashlib.sha256(
            f"{source_hash}:{unit['region_key']}:{unit['image_hash']}:{model_id}:{unit['prompt_version']}".encode()
        ).hexdigest()
        if (cache_dir / "region-responses" / f"{cache_key}.json").is_file():
            cached += 1
    return {"total": len(units), "cached": cached, "uncached": len(units) - cached}


def reconstruct_visual_regions(
    regions: list[dict[str, Any]],
    cache_dir: Path,
    output_dir: Path,
    paper_id: str,
    title: str,
    source_hash: str,
    model_id: str,
    vision: VisionCallback,
    call_limit: int | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    cached_legacy = _legacy_table_cache(regions, cache_dir)

    units: list[dict[str, Any]] = []
    for region in regions:
        if region["kind"] == "table" and str(region.get("table_id")) not in cached_legacy:
            units.extend(_table_chunks(region, cache_dir / "table-chunks"))
        else:
            units.append(region)

    billable_units = [
        unit
        for unit in units
        if not (unit["kind"] == "table" and str(unit.get("table_id")) in cached_legacy)
    ]
    if call_limit is not None and len(billable_units) > call_limit:
        raise RuntimeError(f"区域计划需要 {len(billable_units)} 次视觉调用，超过已确认的 {call_limit} 次上限")

    response_dir = cache_dir / "region-responses"
    response_dir.mkdir(parents=True, exist_ok=True)

    def recognize(unit: dict[str, Any]) -> dict[str, Any]:
        cache_key = hashlib.sha256(
            f"{source_hash}:{unit['region_key']}:{unit['image_hash']}:{model_id}:{unit['prompt_version']}".encode()
        ).hexdigest()
        response_path = response_dir / f"{cache_key}.json"
        cache_hit = response_path.is_file()
        try:
            if cache_hit:
                response = json.loads(response_path.read_text(encoding="utf-8"))
            elif unit["kind"] == "table" and str(unit.get("table_id")) in cached_legacy:
                legacy = cached_legacy[str(unit["table_id"])]
                response = legacy["response"]
                response_path = legacy["path"]
                cache_hit = True
            else:
                task = {
                    "body": "body_transcribe",
                    "table": "table_chunk",
                    "formula": "formula_transcribe",
                    "references": "references_transcribe",
                }[unit["kind"]]
                timeout = {"body": 180, "table": 240, "formula": 120, "references": 180}[unit["kind"]]
                response = vision(
                    {
                        "paperId": paper_id,
                        "page": unit["page"],
                        "imagePath": str(Path(unit["image_path"]).resolve()),
                        "imageWidth": unit.get("image_width", 0),
                        "imageHeight": unit.get("image_height", 0),
                        "figureId": unit["region_key"],
                        "paperTitle": title,
                        "caption": unit.get("caption", ""),
                        "task": task,
                        "sourceText": str(unit.get("source_text") or "")[:30_000],
                        "promptVersion": unit["prompt_version"],
                        "timeoutSeconds": timeout,
                        "chunk": unit.get("chunk"),
                        "chunkCount": unit.get("chunk_count"),
                        "expectedColumns": unit.get("expected_columns"),
                        "formulaNumbers": unit.get("formula_numbers", []),
                    }
                )
                temporary = response_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(response_path)
            payload = _response_payload(response)
            usage = response.get("usage") or {}
            confidence = float(payload.get("confidence") or 0.0)
            return {
                **unit,
                "status": "completed",
                "cache_key": cache_key,
                "cache_hit": cache_hit,
                "artifact_path": str(response_path),
                "model_id": str(response.get("modelId") or model_id),
                "payload": payload,
                "confidence": confidence,
                "input_tokens": int(usage.get("inputTokens", 0)),
                "output_tokens": int(usage.get("outputTokens", 0)),
                "duration_ms": int(usage.get("durationMs", 0)),
                "attempt": 1,
                "error_kind": None,
                "error": None,
            }
        except Exception as error:  # noqa: BLE001 - persist precise region failure
            error_kind, message = _classify_error(error)
            return {
                **unit,
                "status": "unknown" if error_kind == "timeout_unknown" else "failed",
                "cache_key": cache_key,
                "cache_hit": False,
                "artifact_path": str(response_path) if response_path.is_file() else "",
                "model_id": model_id,
                "payload": None,
                "confidence": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "duration_ms": 0,
                "attempt": 1,
                "error_kind": error_kind,
                "error": message,
            }

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="visual-regions") as executor:
        results = list(executor.map(recognize, units))

    def discard_invalid_cache(item: dict[str, Any]) -> None:
        artifact = Path(str(item.get("artifact_path") or ""))
        if artifact.is_file() and artifact.parent.resolve() == response_dir.resolve():
            artifact.unlink(missing_ok=True)
            item["artifact_path"] = ""

    formulas: dict[int, str] = {}
    for item in results:
        if item["kind"] != "formula" or item["status"] != "completed":
            continue
        try:
            parsed, confidence = _parse_formulas(item["payload"])
            expected = {int(value) for value in item.get("formula_numbers", [])}
            if expected and not expected.issubset(parsed):
                missing = ", ".join(map(str, sorted(expected - set(parsed))))
                raise ValueError(f"公式区域缺少编号: {missing}")
            formulas.update(parsed)
            item["confidence"] = confidence
        except ValueError as error:
            item["status"] = "failed"
            item["error_kind"] = "validation"
            item["error"] = str(error)
            discard_invalid_cache(item)

    page_parts: dict[int, list[tuple[int, str]]] = {}
    reference_items: dict[int, tuple[str, float, int]] = {}
    table_groups: dict[str, list[dict[str, Any]]] = {}
    for item in results:
        if item["kind"] == "table":
            table_groups.setdefault(str(item.get("table_id")), []).append(item)
            continue
        if item["status"] != "completed":
            continue
        try:
            if item["kind"] == "body":
                markdown, confidence = _render_blocks(item["payload"], formulas)
                source_length = len(re.sub(r"\s+", "", str(item.get("source_text") or "")))
                rendered_length = len(re.sub(r"[#>*`$\s]+", "", markdown))
                if source_length >= 120 and rendered_length < source_length * 0.45:
                    raise ValueError("正文区域返回内容明显少于本地几何草稿")
            elif item["kind"] == "references":
                entries = item["payload"].get("entries")
                if not isinstance(entries, list) or not entries:
                    raise ValueError("参考文献区域没有返回 entries")
                valid = [
                    (int(entry["number"]), re.sub(r"\s+", " ", str(entry["text"])).strip(), float(entry.get("confidence") or 0.0))
                    for entry in entries
                    if isinstance(entry, dict) and str(entry.get("number") or "").isdigit() and str(entry.get("text") or "").strip()
                ]
                if not valid:
                    raise ValueError("参考文献区域没有有效条目")
                confidence = sum(value for _, _, value in valid) / len(valid)
                for number, text, item_confidence in valid:
                    existing = reference_items.get(number)
                    if existing and existing[0] != text:
                        raise ValueError(f"参考文献编号 [{number}] 在多个区域内容不一致")
                    reference_items[number] = (text, item_confidence, item["page"])
                markdown = ""
            else:
                continue
            item["confidence"] = confidence
            if markdown:
                page_parts.setdefault(item["page"], []).append((item["sequence"], markdown))
        except ValueError as error:
            item["status"] = "failed"
            item["error_kind"] = "validation"
            item["error"] = str(error)
            discard_invalid_cache(item)

    table_artifacts: list[dict[str, Any]] = []
    for table_id, items in table_groups.items():
        region = items[0]
        completed = [item for item in items if item["status"] == "completed"]
        table_markdown = ""
        if len(completed) == len(items):
            try:
                captions: list[str] = []
                headers: list[str] | None = None
                rows: list[list[str]] = []
                footnotes: list[str] = []
                confidence_values: list[float] = []
                for item in sorted(completed, key=lambda value: int(value.get("chunk") or 1)):
                    caption, item_headers, item_rows, item_footnotes, confidence = _parse_table(
                        item["payload"], region.get("expected_columns")
                    )
                    if headers is None:
                        headers = item_headers
                    elif len(headers) != len(item_headers):
                        raise ValueError("表格分片列数不一致")
                    captions.append(caption)
                    footnotes.extend(item_footnotes)
                    confidence_values.append(confidence)
                    for row in item_rows:
                        normalized = tuple(re.sub(r"\s+", " ", cell).strip().casefold() for cell in row)
                        if normalized not in {tuple(re.sub(r"\s+", " ", cell).strip().casefold() for cell in existing) for existing in rows}:
                            rows.append(row)
                if not headers or not rows:
                    raise ValueError("表格合并后为空")
                caption = next((value for value in captions if value), str(region.get("caption") or ""))
                table_markdown = _table_markdown(caption, headers, rows, list(dict.fromkeys(footnotes)))
                table_dir = output_dir / "tables"
                table_dir.mkdir(parents=True, exist_ok=True)
                markdown_path = table_dir / f"{table_id}.md"
                csv_path = table_dir / f"{table_id}.csv"
                markdown_path.write_text(table_markdown, encoding="utf-8")
                with csv_path.open("w", newline="", encoding="utf-8-sig") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(headers)
                    writer.writerows(rows)
                table_artifacts.append(
                    {
                        "id": table_id,
                        "caption": caption,
                        "page": region["page"],
                        "bbox": region["bbox"],
                        "image_path": _safe_relative(Path(region.get("source_image_path") or region["image_path"]), output_dir),
                        "markdown": table_markdown,
                        "markdown_path": f"tables/{markdown_path.name}",
                        "csv_path": f"tables/{csv_path.name}",
                    }
                )
                page_parts.setdefault(region["page"], []).append((region["sequence"], table_markdown))
            except ValueError as error:
                for item in completed:
                    item["status"] = "failed"
                    item["error_kind"] = "validation"
                    item["error"] = str(error)
                    discard_invalid_cache(item)
        if not table_markdown:
            relative = _safe_relative(Path(region.get("source_image_path") or region["image_path"]), output_dir)
            fallback = f"{region.get('caption') or '表格'}\n\n![表格视觉重建待重试]({relative})"
            page_parts.setdefault(region["page"], []).append((region["sequence"], fallback))

    reference_results = [item for item in results if item["kind"] == "references"]
    if reference_results and all(item["status"] == "completed" for item in reference_results):
        numbers = sorted(reference_items)
        if not numbers or numbers != list(range(numbers[0], numbers[-1] + 1)):
            for item in reference_results:
                item["status"] = "failed"
                item["error_kind"] = "validation"
                item["error"] = "参考文献编号不连续"
                discard_invalid_cache(item)
        else:
            page = min(value[2] for value in reference_items.values())
            sequence = min(item["sequence"] for item in reference_results)
            markdown = "\n\n".join(f"[{number}] {reference_items[number][0]}" for number in numbers)
            page_parts.setdefault(page, []).append((sequence, markdown))

    for item in results:
        if item["kind"] != "formula" or item["status"] != "completed":
            continue
        existing = "\n".join(value for _, value in page_parts.get(item["page"], []))
        missing: list[str] = []
        for number in item.get("formula_numbers", []):
            latex = formulas.get(int(number))
            if not latex:
                continue
            tagged = re.search(rf"\\tag\{{\s*{int(number)}\s*\}}", existing)
            if not tagged:
                missing.append(f"$${latex} \\tag{{{int(number)}}}$$")
        if missing:
            page_parts.setdefault(item["page"], []).append((item["sequence"], "\n\n".join(missing)))

    fallback_dir = output_dir / "regions"
    for item in results:
        if item["kind"] != "formula" or item["status"] == "completed":
            continue
        fallback_dir.mkdir(parents=True, exist_ok=True)
        source_image = Path(item["image_path"])
        target = fallback_dir / f"{item['region_key'].replace(':', '-')}.png"
        if source_image.is_file():
            target.write_bytes(source_image.read_bytes())
            numbers = "、".join(f"({number})" for number in item.get("formula_numbers", []))
            fallback = (
                f"> 公式 {numbers or '区域'} 尚未可靠转写，请对照 PDF 第 {item['page']} 页。\n\n"
                f"![公式原图]({_safe_relative(target, output_dir)})"
            )
            page_parts.setdefault(item["page"], []).append((item["sequence"], fallback))

    required_failures = [item for item in results if item.get("required") and item["status"] != "completed"]
    pages_with_required = {item["page"] for item in results if item.get("required")}
    failed_required_pages = {item["page"] for item in required_failures}
    successful_pages = pages_with_required - failed_required_pages
    optional_failures = [item for item in results if not item.get("required") and item["status"] != "completed"]
    page_markdown = [
        (page, "\n\n".join(value for _, value in sorted(parts, key=lambda item: item[0])))
        for page, parts in sorted(page_parts.items())
        if page not in failed_required_pages
    ]
    return {
        "page_markdown": page_markdown,
        "regions": results,
        "tables": table_artifacts,
        "publishable": not required_failures and len(successful_pages) == len(pages_with_required),
        "partial": bool(optional_failures),
        "successful_pages": len(successful_pages),
        "failed_pages": sorted(failed_required_pages),
        "estimated_calls": len(billable_units),
        "input_tokens": sum(item["input_tokens"] for item in results),
        "output_tokens": sum(item["output_tokens"] for item in results),
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
