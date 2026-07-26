from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from pypdf import PdfWriter

from p2i_engine.library import Library


@pytest.fixture(autouse=True)
def disable_docling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("P2I_DISABLE_DOCLING", "1")


def make_pdf(path: Path, pages: int = 1) -> None:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as stream:
        writer.write(stream)


def test_initializes_versioned_library_layout(tmp_path: Path) -> None:
    library = Library(tmp_path)
    result = library.initialize()

    assert Path(result["papersDir"]).is_dir()
    assert (tmp_path / "Exports" / "markdown").is_dir()
    assert (tmp_path / ".p2i" / "generated").is_dir()
    assert (tmp_path / ".p2i" / "library.sqlite").is_file()

    with sqlite3.connect(result["database"]) as connection:
        version = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
    assert version == 2


def test_scan_parses_and_persists_generated_artifacts(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "evidence-paper.pdf", pages=2)

    summary = library.scan()
    papers = Library(tmp_path).list_papers()

    assert summary == {"discovered": 1, "parsed": 1, "deduplicated": 0}
    assert len(papers) == 1
    assert papers[0]["status"] == "PARTIAL"
    assert papers[0]["pageCount"] == 2
    markdown_path = Path(papers[0]["markdownPath"])
    document_path = Path(papers[0]["documentPath"])
    assert markdown_path.is_file()
    assert document_path.is_file()
    assert "data-paper-id" in markdown_path.read_text(encoding="utf-8")
    document = json.loads(document_path.read_text(encoding="utf-8"))
    assert document["schema_version"] == "1.0"
    assert document["partial"] is True
    assert document["warnings"] == ["Docling disabled; pypdf fallback was used"]
    assert len(document["sections"]) == 2
    with library.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM page_maps").fetchone()[0] == 2


def test_duplicate_bytes_share_one_paper(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    first = library.papers_dir / "collection-a" / "paper.pdf"
    second = library.papers_dir / "collection-b" / "copy.pdf"
    make_pdf(first)
    library.scan()
    second.parent.mkdir(parents=True)
    shutil.copyfile(first, second)

    summary = library.scan()

    assert summary["deduplicated"] == 1
    assert len(library.list_papers()) == 1
    with library.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM paper_files").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM parse_runs").fetchone()[0] == 1


def test_move_updates_path_without_reparse(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    original = library.papers_dir / "before.pdf"
    moved = library.papers_dir / "topic" / "after.pdf"
    make_pdf(original)
    library.scan()
    moved.parent.mkdir(parents=True)
    original.rename(moved)

    summary = library.scan()
    papers = library.list_papers()

    assert summary["parsed"] == 0
    assert summary["deduplicated"] == 1
    assert len(papers) == 1
    assert Path(papers[0]["sourcePath"]) == moved.resolve()
    with library.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM parse_runs").fetchone()[0] == 1


def test_delete_marks_missing_but_keeps_output(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = library.papers_dir / "paper.pdf"
    make_pdf(source)
    library.scan()
    generated = Path(library.list_papers()[0]["markdownPath"])
    source.unlink()

    library.scan()
    papers = library.list_papers()

    assert papers[0]["status"] == "MISSING"
    assert generated.is_file()


def test_content_change_creates_new_version(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = library.papers_dir / "paper.pdf"
    make_pdf(source, pages=1)
    library.scan()
    make_pdf(source, pages=3)

    summary = library.scan()
    papers = library.list_papers()

    assert summary["parsed"] == 1
    assert len(papers) == 2
    assert {paper["status"] for paper in papers} == {"PARTIAL", "MISSING"}


def test_watcher_waits_for_a_stable_file(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = library.papers_dir / "copying.pdf"
    make_pdf(source)

    first = library.scan(require_stable=True)
    stat = source.stat()
    library._stability[str(source.resolve())] = (stat.st_size, stat.st_mtime_ns, 0.0)
    second = library.scan(require_stable=True)

    assert first["parsed"] == 0
    assert second["parsed"] == 1


def test_engine_restart_resumes_interrupted_job(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = library.papers_dir / "interrupted.pdf"
    make_pdf(source)
    library.scan()
    with library.db.connect() as connection:
        job = connection.execute("SELECT id, paper_id FROM jobs").fetchone()
        connection.execute(
            "UPDATE jobs SET status = 'PARSING_LAYOUT', finished_at = NULL WHERE id = ?",
            (job["id"],),
        )
        connection.execute(
            "UPDATE papers SET status = 'PARSING_LAYOUT' WHERE id = ?", (job["paper_id"],)
        )

    restarted = Library(tmp_path)
    restarted.initialize()

    assert restarted.list_papers()[0]["status"] == "PARTIAL"
    with restarted.db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM parse_runs").fetchone()[0] == 2
