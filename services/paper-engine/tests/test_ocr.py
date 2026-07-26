from __future__ import annotations

import threading
import time
from pathlib import Path

from pypdf import PdfWriter

from p2i_engine.parsing import parse_pdf


def make_pdf(path: Path, pages: int = 1) -> None:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    with path.open("wb") as stream:
        writer.write(stream)


def test_qwen_ocr_is_cached_by_page_and_model(tmp_path: Path) -> None:
    source = tmp_path / "paper.pdf"
    make_pdf(source)
    calls: list[dict] = []

    def ocr_page(params: dict) -> dict:
        calls.append(params)
        return {"markdown": "# OCR heading\n\nRecognized content.", "usage": {"inputTokens": 12, "outputTokens": 5}}

    first = parse_pdf(source, tmp_path / "first", "paper-1", "a" * 64, tmp_path / "cache", ocr_page)
    second = parse_pdf(source, tmp_path / "second", "paper-1", "a" * 64, tmp_path / "cache", ocr_page)

    assert len(calls) == 1
    assert "Recognized content" in first.markdown
    assert second.document.ocr is not None
    assert second.document.ocr.cache_hits == 1
    assert second.document.partial is False


def test_qwen_failure_keeps_local_text_and_marks_partial(tmp_path: Path) -> None:
    source = tmp_path / "paper.pdf"
    make_pdf(source)

    result = parse_pdf(
        source,
        tmp_path / "out",
        "paper-1",
        "b" * 64,
        tmp_path / "cache",
        lambda _: (_ for _ in ()).throw(RuntimeError("rate limited")),
    )

    assert result.document.partial is True
    assert result.document.ocr is not None
    assert result.document.ocr.failed_pages == [1]
    assert any("rate limited" in warning for warning in result.document.warnings)


def test_qwen_ocr_uses_at_most_two_parallel_requests(tmp_path: Path) -> None:
    source = tmp_path / "paper.pdf"
    make_pdf(source, pages=4)
    lock = threading.Lock()
    active = 0
    maximum = 0

    def ocr_page(_: dict) -> dict:
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return {"markdown": "Recognized", "usage": {}}

    result = parse_pdf(
        source,
        tmp_path / "out",
        "paper-1",
        "c" * 64,
        tmp_path / "cache",
        ocr_page,
    )

    assert 1 <= maximum <= 2
    assert result.document.ocr is not None
    assert result.document.ocr.request_count == 4
