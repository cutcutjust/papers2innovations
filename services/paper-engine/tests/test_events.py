from __future__ import annotations

from pathlib import Path

import pytest

from p2i_engine.ingestion import FileEventQueue
from p2i_engine.library import Library


def test_file_events_are_coalesced_and_persisted(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = library.papers_dir / "paper.pdf"
    queue = FileEventQueue(library.db, library.papers_dir)

    accepted = queue.enqueue_many([
        {"eventType": "created", "path": str(source)},
        {"eventType": "modified", "path": str(source)},
    ])

    assert accepted == 1
    pending = queue.pending()
    assert len(pending) == 1
    assert pending[0]["event_type"] == "modified"
    assert queue.mark_all("PROCESSED") == 1
    assert queue.pending() == []


def test_file_event_rejects_paths_outside_papers(tmp_path: Path) -> None:
    library = Library(tmp_path / "library")
    library.initialize()
    queue = FileEventQueue(library.db, library.papers_dir)

    with pytest.raises(ValueError, match="outside Papers"):
        queue.enqueue_many([{"eventType": "created", "path": str(tmp_path / "private.pdf")}])


def test_interrupted_jobs_are_recovered_once(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    now = "2026-07-26T00:00:00+00:00"
    with library.db.connect() as connection:
        connection.execute(
            "INSERT INTO jobs(id, kind, status, progress, message, created_at, updated_at) "
            "VALUES ('job-1', 'PARSE_PDF', 'PARSING_LAYOUT', 0.4, 'working', ?, ?)",
            (now, now),
        )

    Library(tmp_path).initialize()

    with library.db.connect() as connection:
        row = connection.execute("SELECT status, message FROM jobs WHERE id = 'job-1'").fetchone()
    assert row["status"] == "QUEUED"
    assert "Recovered" in row["message"]

