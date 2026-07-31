from __future__ import annotations

import json
from pathlib import Path

import fitz

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
                "markdown": "# Introduction\n\nFaithful visual text.",
                "confidence": 0.96,
                "uncertainties": [],
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
