from __future__ import annotations

import json
import io
from pathlib import Path

import fitz
from PIL import Image, ImageDraw

from p2i_engine.parsing.parser import _remove_repeated_marginal_lines, parse_pdf


def make_pdf(path: Path, pages: int = 2) -> None:
    document = fitz.open()
    for page_number in range(1, pages + 1):
        page = document.new_page()
        page.insert_text((72, 72), "Repeated conference header")
        page.insert_text((72, 110), f"Page body {page_number}.")
        page.insert_text((300, 760), str(page_number))
    document.save(path)
    document.close()


def test_visual_pages_are_cached_without_duplicate_calls(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("P2I_DISABLE_DOCLING", "1")
    source = tmp_path / "paper.pdf"
    make_pdf(source, 1)
    calls: list[dict] = []

    def recognize(params: dict) -> dict:
        calls.append(params)
        return {
            "description": json.dumps({
                "blocks": [
                    {"type": "heading", "text": "Introduction", "level": 1, "confidence": 0.96},
                    {"type": "paragraph", "text": "Faithful visual text.", "confidence": 0.96},
                ],
                "confidence": 0.96,
            }),
            "modelId": "vision-model",
            "usage": {"inputTokens": 10, "outputTokens": 12, "durationMs": 25},
        }

    cache = tmp_path / "cache" / "ocr" / "hash"
    first = parse_pdf(source, tmp_path / "first", "paper-1", "a" * 64, cache, None, recognize, "vision-model")
    second = parse_pdf(source, tmp_path / "second", "paper-1", "a" * 64, cache, None, recognize, "vision-model")

    assert len(calls) == 1
    assert "Faithful visual text" in first.markdown
    assert second.quality_stats["cachedPageCount"] == 1
    assert second.quality_stats["inputTokens"] == 10


def test_repeated_headers_page_numbers_and_false_numeric_headings_are_removed() -> None:
    pages, removed = _remove_repeated_marginal_lines([
        (1, "Repeated header\n\n# Introduction\n\nBody one.\n\n1"),
        (2, "Repeated header\n\n# 15\n\nBody two.\n\n2"),
        (3, "Repeated header\n\n# Results\n\nBody three.\n\n3"),
    ])
    joined = "\n".join(markdown for _, markdown in pages)
    assert "Repeated header" not in joined
    assert "# 15" not in joined
    assert "Body two" in joined
    assert removed >= 6


def test_numbered_formulas_at_page_edges_are_never_removed_as_repeated_footers() -> None:
    pages, removed = _remove_repeated_marginal_lines([
        (1, "Repeated header\n\nBody one.\n\n$$x_1=y_1 \\tag{3}$$\n\n$$x_2=y_2 \\tag{4}$$"),
        (2, "Repeated header\n\nBody two.\n\n$$x_3=y_3 \\tag{12}$$\n\n$$x_4=y_4 \\tag{13}$$"),
    ])
    joined = "\n".join(markdown for _, markdown in pages)
    assert all(f"\\tag{{{number}}}" in joined for number in (3, 4, 12, 13))
    assert "Repeated header" not in joined
    assert removed == 2


def test_full_page_raster_is_not_exported_as_a_figure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("P2I_DISABLE_DOCLING", "1")
    source = tmp_path / "scanned.pdf"
    image = Image.new("RGB", (1224, 1584), "white")
    ImageDraw.Draw(image).text((80, 100), "Scanned paper page", fill="black")
    image_bytes = io.BytesIO()
    image.save(image_bytes, "PNG")
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_image(page.rect, stream=image_bytes.getvalue())
    document.save(source)
    document.close()

    result = parse_pdf(source, tmp_path / "output", "paper-scan", "b" * 64)

    assert result.document.figures == []


def test_scanned_page_caption_produces_a_local_figure_crop(tmp_path: Path) -> None:
    source = tmp_path / "captioned-scan.pdf"
    image = Image.new("RGB", (1224, 1584), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((650, 380, 1080, 760), outline="black", width=4)
    image_bytes = io.BytesIO()
    image.save(image_bytes, "PNG")
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_image(page.rect, stream=image_bytes.getvalue())
    page.insert_text((340, 210), "Happy Sad Neutral Angry", fontsize=9)
    page.insert_text((340, 235), "Weight 0.0 0.5 1.0", fontsize=9)
    page.insert_text((315, 280), "Fig. 2. Model weights for one conversation.", fontsize=9)
    document.save(source)
    document.close()

    from p2i_engine.parsing.parser import _extract_rendered_figures

    figure_dir = tmp_path / "figures"
    figure_dir.mkdir()
    figures = _extract_rendered_figures(source, figure_dir)

    assert len(figures) == 1
    with Image.open(tmp_path / figures[0].relative_path) as cropped:
        assert cropped.width < 1224
        assert cropped.height < 1584


def test_table_region_uses_targeted_visual_reconstruction(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("P2I_DISABLE_DOCLING", "1")
    source = tmp_path / "table.pdf"
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 72), "Table 2. Ablation results.", fontsize=10)
    page.insert_text((72, 100), "Dataset Model Score", fontsize=9)
    page.insert_text((72, 120), "MOSI DSSR 88.9", fontsize=9)
    page.insert_text((72, 140), "MOSEI DSSR 87.9", fontsize=9)
    page.insert_text((72, 190), "3. Experiments", fontsize=11)
    document.save(source)
    document.close()
    calls: list[dict] = []

    def recognize(params: dict) -> dict:
        calls.append(params)
        if params["task"] == "table_chunk":
            payload = {
                "caption": "Table 2. Ablation results.",
                "headers": ["Dataset", "Model", "Score"],
                "rows": [["MOSI", "DSSR", "88.9"], ["MOSEI", "DSSR", "87.9"]],
                "footnotes": [],
                "confidence": 0.96,
            }
        else:
            payload = {
                "blocks": [{"type": "heading", "text": "3. Experiments", "level": 1, "confidence": 0.96}],
                "confidence": 0.96,
            }
        return {
            "description": json.dumps(payload),
            "modelId": "vision-model",
            "usage": {"inputTokens": 4, "outputTokens": 8, "durationMs": 10},
        }

    cache = tmp_path / "cache" / "ocr" / "hash"
    result = parse_pdf(
        source,
        tmp_path / "output",
        "paper-table",
        "c" * 64,
        cache,
        None,
        recognize,
        "vision-model",
    )

    assert any(call["task"] == "table_chunk" for call in calls)
    assert "| Dataset | Model | Score |" in result.markdown
    assert (tmp_path / "output" / "tables" / "table-1.md").is_file()
    assert (tmp_path / "output" / "tables" / "table-1.csv").is_file()


def test_suspicious_formula_uses_region_crop_and_updates_markdown(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("P2I_DISABLE_DOCLING", "1")
    source = tmp_path / "formula.pdf"
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((72, 72), "2. Method", fontsize=12)
    page.insert_text((150, 240), "L task = sum i x i", fontsize=14)
    page.insert_text((287, 240), "(1)", fontsize=10)
    document.save(source)
    document.close()
    calls: list[dict] = []
    crop_sizes: list[tuple[int, int]] = []

    def recognize(params: dict) -> dict:
        calls.append(params)
        if params["task"] == "formula_transcribe":
            with Image.open(params["imagePath"]) as crop:
                crop_sizes.append(crop.size)
            payload = {
                "formulas": [{"number": 1, "latex": r"\mathcal{L}_{task}=\sum_i x_i", "confidence": 0.97}],
                "confidence": 0.97,
            }
        else:
            payload = {
                "blocks": [
                    {"type": "heading", "text": "2. Method", "level": 1, "confidence": 0.96},
                    {"type": "formula", "text": "broken", "number": 1, "confidence": 0.96},
                ],
                "confidence": 0.96,
            }
        return {
            "description": json.dumps(payload),
            "modelId": "vision-model",
            "usage": {"inputTokens": 4, "outputTokens": 8, "durationMs": 10},
        }

    result = parse_pdf(
        source,
        tmp_path / "output",
        "paper-formula",
        "d" * 64,
        tmp_path / "cache" / "ocr" / "hash",
        None,
        recognize,
        "vision-model",
    )

    assert any(call["task"] == "formula_transcribe" for call in calls)
    assert r"\mathcal{L}_{task}=\sum_i x_i" in result.markdown
    assert crop_sizes
    assert crop_sizes[0][0] < 1700
    assert crop_sizes[0][1] < 2200
