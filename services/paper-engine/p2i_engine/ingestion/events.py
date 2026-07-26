from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from ..database import Database
from ..models import utc_now


class FileEventQueue:
    """Durable boundary between OS notifications and library reconciliation."""

    def __init__(self, database: Database, papers_dir: Path):
        self.database = database
        self.papers_dir = papers_dir.resolve()

    def _validate_path(self, value: str | Path) -> Path:
        path = Path(value).resolve()
        try:
            path.relative_to(self.papers_dir)
        except ValueError as error:
            raise ValueError(f"File event is outside Papers/: {path}") from error
        return path

    def enqueue_many(self, events: list[dict[str, Any]]) -> int:
        now = utc_now()
        normalized: dict[str, dict[str, Any]] = {}
        for event in events:
            path = self._validate_path(event["path"])
            if path.suffix.lower() != ".pdf":
                continue
            previous = event.get("previousPath")
            previous_path = str(self._validate_path(previous)) if previous else None
            normalized[str(path)] = {
                "event_type": str(event.get("eventType", "modified")).lower(),
                "path": str(path),
                "previous_path": previous_path,
                "payload": event.get("payload", {}),
            }
        with self.database.connect() as connection:
            for event in normalized.values():
                existing = connection.execute(
                    "SELECT id FROM file_events WHERE absolute_path = ? AND status = 'PENDING'",
                    (event["path"],),
                ).fetchone()
                if existing:
                    connection.execute(
                        "UPDATE file_events SET event_type = ?, previous_path = COALESCE(?, previous_path), "
                        "payload_json = ?, created_at = ?, error = NULL WHERE id = ?",
                        (
                            event["event_type"],
                            event["previous_path"],
                            json.dumps(event["payload"]),
                            now,
                            existing["id"],
                        ),
                    )
                else:
                    connection.execute(
                        "INSERT INTO file_events(id, event_type, absolute_path, previous_path, payload_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            str(uuid.uuid4()),
                            event["event_type"],
                            event["path"],
                            event["previous_path"],
                            json.dumps(event["payload"]),
                            now,
                        ),
                    )
        return len(normalized)

    def pending(self) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM file_events WHERE status = 'PENDING' ORDER BY created_at, id"
                )
            ]

    def mark_all(self, status: str, error: str | None = None) -> int:
        now = utc_now()
        with self.database.connect() as connection:
            result = connection.execute(
                "UPDATE file_events SET status = ?, processed_at = ?, error = ? WHERE status = 'PENDING'",
                (status, now, error),
            )
            return result.rowcount

