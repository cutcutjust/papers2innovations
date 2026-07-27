from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from threading import Lock
from typing import Any, Iterable

import fitz

from .database import Database
from .ingestion import FileEventQueue
from .models import CancelledError, JobStatus, ProgressEvent, utc_now
from .parsing import parse_pdf
from .zotero import ZoteroImporter, ZoteroLockedError

ProgressCallback = Callable[[ProgressEvent], None]


class Library:
    def __init__(self, root: str | Path, ocr_page: Callable[[dict], dict] | None = None):
        self.root = Path(root).expanduser().resolve()
        self.papers_dir = self.root / "Papers"
        self.exports_dir = self.root / "Exports"
        self.internal_dir = self.root / ".p2i"
        self.generated_dir = self.internal_dir / "generated"
        self.db = Database(self.internal_dir / "library.sqlite")
        self._stability: dict[str, tuple[int, int, float]] = {}
        self._initialized = False
        self._recovered_jobs: list[dict[str, str]] = []
        self._queue_lock = Lock()
        self.ocr_page = ocr_page

    def initialize(self, resume_recovered: bool = True) -> dict[str, str]:
        for directory in (
            self.papers_dir,
            self.exports_dir / "bibtex",
            self.exports_dir / "markdown",
            self.generated_dir,
            self.internal_dir / "cache",
            self.internal_dir / "logs",
            self.internal_dir / "components",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self.db.migrate()
        if not self._initialized:
            recovered = self._recover_interrupted_jobs()
            self._initialized = True
            self._recovered_jobs = recovered
            if resume_recovered:
                self.run_queued_jobs(
                    [job["id"] for job in recovered],
                    callback=None,
                    request_id=None,
                )
                self._recovered_jobs = []
        return {
            "root": str(self.root),
            "papersDir": str(self.papers_dir),
            "database": str(self.db.path),
        }

    def take_recovered_job_ids(self) -> list[str]:
        job_ids = [job["id"] for job in self._recovered_jobs]
        self._recovered_jobs = []
        return job_ids

    def _recover_interrupted_jobs(self) -> list[dict]:
        transient = tuple(
            status.value
            for status in (
                JobStatus.HASHING,
                JobStatus.DISCOVERED,
                JobStatus.QUEUED,
                JobStatus.PARSING_LAYOUT,
                JobStatus.EXTRACTING_FIGURES,
                JobStatus.PARSING_REFERENCES,
                JobStatus.RESOLVING_METADATA,
                JobStatus.INDEXING,
            )
        )
        placeholders = ",".join("?" for _ in transient)
        now = utc_now()
        with self.db.connect() as connection:
            recovered = [
                dict(row)
                for row in connection.execute(
                    f"SELECT j.id, j.paper_id, pf.absolute_path, pf.sha256 FROM jobs j "
                    f"JOIN paper_files pf ON pf.id = j.paper_file_id "
                    f"WHERE j.status IN ({placeholders}) AND j.finished_at IS NULL "
                    "ORDER BY j.created_at",
                    transient,
                )
            ]
            connection.execute(
                f"UPDATE jobs SET status = ?, message = 'Recovered after engine restart', updated_at = ? "
                f"WHERE status IN ({placeholders}) AND finished_at IS NULL",
                (JobStatus.QUEUED.value, now, *transient),
            )
            connection.execute(
                f"UPDATE job_stages SET status = ?, updated_at = ? WHERE status IN ({placeholders})",
                (JobStatus.QUEUED.value, now, *transient),
            )
        return recovered

    @staticmethod
    def _stage_for_status(status: JobStatus) -> str | None:
        return {
            JobStatus.HASHING: "hash",
            JobStatus.QUEUED: "hash",
            JobStatus.PARSING_LAYOUT: "layout",
            JobStatus.EXTRACTING_FIGURES: "figures",
            JobStatus.PARSING_REFERENCES: "tables",
            JobStatus.RESOLVING_METADATA: "ocr",
            JobStatus.INDEXING: "index",
            JobStatus.READY: "index",
            JobStatus.PARTIAL: "index",
        }.get(status)

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _cancelled(self, job_id: str) -> bool:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            return bool(row and row["cancel_requested"])

    def _progress(
        self,
        callback: ProgressCallback | None,
        job_id: str,
        paper_id: str,
        status: JobStatus,
        progress: float,
        message: str,
        request_id: str | int | None,
    ) -> None:
        if self._cancelled(job_id):
            raise CancelledError()
        now = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "UPDATE jobs SET status = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?",
                (status.value, progress, message, now, job_id),
            )
            connection.execute(
                "UPDATE papers SET status = ?, updated_at = ? WHERE id = ?",
                (status.value, now, paper_id),
            )
            stage = self._stage_for_status(status)
            if stage:
                stage_progress = 1.0 if status in (JobStatus.READY, JobStatus.PARTIAL) else progress
                connection.execute(
                    "INSERT INTO job_stages(id, job_id, stage, status, progress, started_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(job_id, stage) DO UPDATE SET status = excluded.status, "
                    "progress = excluded.progress, started_at = COALESCE(job_stages.started_at, excluded.started_at), "
                    "updated_at = excluded.updated_at",
                    (str(uuid.uuid4()), job_id, stage, status.value, stage_progress, now, now),
                )
        if callback:
            callback(
                ProgressEvent(
                    request_id=request_id,
                    job_id=job_id,
                    paper_id=paper_id,
                    status=status,
                    progress=progress,
                    message=message,
                )
            )

    def _create_paper_and_file(self, path: Path, sha256: str) -> tuple[str, str, str]:
        paper_id = str(uuid.uuid4())
        paper_file_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        now = utc_now()
        stat = path.stat()
        relative_path = path.relative_to(self.papers_dir).as_posix()
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO papers(id, canonical_sha256, title, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (paper_id, sha256, path.stem, JobStatus.DISCOVERED.value, now, now),
            )
            connection.execute(
                "INSERT INTO paper_files(id, paper_id, absolute_path, relative_path, sha256, "
                "size_bytes, modified_at_ns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    paper_file_id,
                    paper_id,
                    str(path),
                    relative_path,
                    sha256,
                    stat.st_size,
                    stat.st_mtime_ns,
                    now,
                    now,
                ),
            )
            connection.execute(
                "INSERT INTO jobs(id, paper_id, paper_file_id, kind, status, progress, message, "
                "created_at, updated_at) VALUES (?, ?, ?, 'PARSE_PDF', ?, 0, ?, ?, ?)",
                (
                    job_id,
                    paper_id,
                    paper_file_id,
                    JobStatus.DISCOVERED.value,
                    "PDF discovered",
                    now,
                    now,
                ),
            )
            connection.execute(
                "INSERT INTO job_stages(id, job_id, stage, status, progress, updated_at) "
                "VALUES (?, ?, 'hash', ?, 0, ?)",
                (str(uuid.uuid4()), job_id, JobStatus.DISCOVERED.value, now),
            )
        return paper_id, paper_file_id, job_id

    def _attach_duplicate_or_move(self, path: Path, sha256: str) -> str | None:
        now = utc_now()
        stat = path.stat()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM paper_files WHERE sha256 = ? ORDER BY created_at", (sha256,)
            ).fetchall()
            if not rows:
                return None
            paper_id = rows[0]["paper_id"]
            movable = next(
                (row for row in rows if row["is_missing"] or not Path(row["absolute_path"]).exists()),
                None,
            )
            if movable:
                connection.execute(
                    "UPDATE paper_files SET absolute_path = ?, relative_path = ?, size_bytes = ?, "
                    "modified_at_ns = ?, is_missing = 0, updated_at = ? WHERE id = ?",
                    (
                        str(path),
                        path.relative_to(self.papers_dir).as_posix(),
                        stat.st_size,
                        stat.st_mtime_ns,
                        now,
                        movable["id"],
                    ),
                )
            else:
                connection.execute(
                    "INSERT INTO paper_files(id, paper_id, absolute_path, relative_path, sha256, "
                    "size_bytes, modified_at_ns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(uuid.uuid4()),
                        paper_id,
                        str(path),
                        path.relative_to(self.papers_dir).as_posix(),
                        sha256,
                        stat.st_size,
                        stat.st_mtime_ns,
                        now,
                        now,
                    ),
                )
            connection.execute(
                "UPDATE papers SET status = CASE WHEN status = ? THEN ? ELSE status END, updated_at = ? WHERE id = ?",
                (JobStatus.MISSING.value, JobStatus.READY.value, now, paper_id),
            )
            return paper_id

    def _parse(
        self,
        path: Path,
        sha256: str,
        paper_id: str,
        job_id: str,
        callback: ProgressCallback | None,
        request_id: str | int | None,
    ) -> None:
        run_id = str(uuid.uuid4())
        started = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO parse_runs(id, paper_id, job_id, parser_name, parser_version, status, started_at) "
                "VALUES (?, ?, ?, 'pending', 'pending', ?, ?)",
                (run_id, paper_id, job_id, JobStatus.QUEUED.value, started),
            )
        try:
            self._progress(callback, job_id, paper_id, JobStatus.HASHING, 0.12, "SHA-256 verified", request_id)
            self._progress(callback, job_id, paper_id, JobStatus.QUEUED, 0.2, "Parse job queued", request_id)
            self._progress(callback, job_id, paper_id, JobStatus.PARSING_LAYOUT, 0.35, "Parsing document layout", request_id)
            output_dir = self.generated_dir / paper_id
            result = parse_pdf(
                path,
                output_dir,
                paper_id,
                sha256,
                cache_dir=self.internal_dir / "cache" / "ocr" / sha256,
                ocr_page=self.ocr_page,
            )
            self._progress(callback, job_id, paper_id, JobStatus.EXTRACTING_FIGURES, 0.68, "Extracting figures", request_id)
            markdown_path = output_dir / "paper.md"
            document_path = output_dir / "document.json"
            metadata_path = output_dir / "metadata.json"
            references_path = output_dir / "references.json"
            markdown_path.write_text(result.markdown, encoding="utf-8")
            document_path.write_text(
                result.document.model_dump_json(indent=2, by_alias=True), encoding="utf-8"
            )
            metadata_path.write_text(
                json.dumps(
                    {
                        "title": result.document.title,
                        "authors": result.document.authors,
                        "source": "embedded",
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            references_path.write_text("[]\n", encoding="utf-8")
            self._progress(callback, job_id, paper_id, JobStatus.PARSING_REFERENCES, 0.77, "Reference stage recorded", request_id)
            self._progress(callback, job_id, paper_id, JobStatus.RESOLVING_METADATA, 0.84, "Embedded metadata saved", request_id)
            self._progress(callback, job_id, paper_id, JobStatus.INDEXING, 0.92, "Indexing sections", request_id)
            now = utc_now()
            final_status = JobStatus.PARTIAL if result.document.partial else JobStatus.READY
            with self.db.connect() as connection:
                connection.execute("DELETE FROM sections WHERE paper_id = ?", (paper_id,))
                connection.execute("DELETE FROM figures WHERE paper_id = ?", (paper_id,))
                connection.execute("DELETE FROM tables WHERE paper_id = ?", (paper_id,))
                connection.execute("DELETE FROM page_maps WHERE paper_id = ?", (paper_id,))
                connection.executemany(
                    "INSERT INTO sections(id, paper_id, title, level, sort_order, page_start, page_end, markdown, anchors_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        (
                            section.id,
                            paper_id,
                            section.title,
                            section.level,
                            section.order,
                            section.page_start,
                            section.page_end,
                            section.markdown,
                            json.dumps([anchor.model_dump() for anchor in section.anchors]),
                        )
                        for section in result.document.sections
                    ],
                )
                connection.executemany(
                    "INSERT INTO figures(id, paper_id, caption, relative_path, thumbnail_path, page, bbox_json, mime_type) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        (
                            f"{paper_id}:{figure.id}",
                            paper_id,
                            figure.caption,
                            figure.relative_path,
                            figure.thumbnail_path,
                            figure.page,
                            figure.bbox.model_dump_json() if figure.bbox else None,
                            figure.mime_type,
                        )
                        for figure in result.document.figures
                    ],
                )
                connection.executemany(
                    "INSERT INTO tables(id, paper_id, caption, markdown_path, csv_path, page, bbox_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [
                        (
                            table["id"],
                            paper_id,
                            table.get("caption"),
                            str(output_dir / table["markdown_path"])
                            if table.get("markdown_path")
                            else None,
                            str(output_dir / table["csv_path"])
                            if table.get("csv_path")
                            else None,
                            table.get("page"),
                            json.dumps(table.get("bbox")) if table.get("bbox") else None,
                        )
                        for table in result.document.tables
                    ],
                )
                with fitz.open(path) as pdf:
                    failed_pages = set(
                        result.document.ocr.failed_pages if result.document.ocr else []
                    )
                    page_rows = []
                    for page_number, page in enumerate(pdf, start=1):
                        response_files = sorted(
                            (self.internal_dir / "cache" / "ocr" / sha256).glob(
                                f"{page_number:04d}-*.json"
                            )
                        )
                        cache_key = response_files[0].stem.split("-", 1)[-1] if response_files else None
                        confidence = None
                        if response_files:
                            response = json.loads(response_files[0].read_text(encoding="utf-8"))
                            confidence = float(response.get("alignmentConfidence", 0))
                        page_rows.append(
                            (
                                str(uuid.uuid4()),
                                paper_id,
                                page_number,
                                page.rect.width,
                                page.rect.height,
                                "qwen" if result.document.ocr and page_number not in failed_pages else "docling",
                                confidence,
                                cache_key,
                                "{}",
                            )
                        )
                    connection.executemany(
                        "INSERT INTO page_maps(id, paper_id, page, width, height, text_source, "
                        "alignment_confidence, ocr_cache_key, bbox_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        page_rows,
                    )
                connection.execute(
                    "UPDATE papers SET title = ?, status = ?, page_count = ?, markdown_path = ?, "
                    "document_path = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
                    (
                        result.document.title,
                        final_status.value,
                        result.document.page_count,
                        str(markdown_path),
                        str(document_path),
                        metadata_path.read_text(encoding="utf-8"),
                        now,
                        paper_id,
                    ),
                )
                connection.execute(
                    "UPDATE parse_runs SET parser_name = ?, parser_version = ?, status = ?, finished_at = ? WHERE id = ?",
                    (
                        result.document.parser.name,
                        result.document.parser.version,
                        final_status.value,
                        now,
                        run_id,
                    ),
                )
                connection.execute(
                    "UPDATE jobs SET status = ?, progress = 1, message = 'Ready', updated_at = ?, finished_at = ? WHERE id = ?",
                    (final_status.value, now, now, job_id),
                )
                connection.execute(
                    "UPDATE job_stages SET status = ?, progress = 1, artifact_json = ?, finished_at = ?, updated_at = ? "
                    "WHERE job_id = ? AND stage = 'index'",
                    (
                        final_status.value,
                        json.dumps(
                            {
                                "markdownPath": str(markdown_path),
                                "documentPath": str(document_path),
                                "warnings": result.document.warnings,
                            }
                        ),
                        now,
                        now,
                        job_id,
                    ),
                )
            if callback:
                callback(
                    ProgressEvent(
                        request_id=request_id,
                        job_id=job_id,
                        paper_id=paper_id,
                        status=final_status,
                        progress=1,
                        message="Paper is ready" if final_status is JobStatus.READY else "Paper is partially ready",
                    )
                )
        except CancelledError:
            now = utc_now()
            with self.db.connect() as connection:
                connection.execute(
                    "UPDATE jobs SET status = ?, message = 'Cancelled', updated_at = ?, finished_at = ? WHERE id = ?",
                    (JobStatus.CANCELLED.value, now, now, job_id),
                )
                connection.execute(
                    "UPDATE parse_runs SET status = ?, finished_at = ? WHERE id = ?",
                    (JobStatus.CANCELLED.value, now, run_id),
                )
                connection.execute(
                    "UPDATE job_stages SET status = ?, error = 'Cancelled', finished_at = ?, updated_at = ? "
                    "WHERE job_id = ? AND finished_at IS NULL",
                    (JobStatus.CANCELLED.value, now, now, job_id),
                )
        except Exception as error:
            now = utc_now()
            message = f"{type(error).__name__}: {error}"
            with self.db.connect() as connection:
                connection.execute(
                    "UPDATE papers SET status = ?, updated_at = ? WHERE id = ?",
                    (JobStatus.FAILED.value, now, paper_id),
                )
                connection.execute(
                    "UPDATE jobs SET status = ?, error = ?, message = 'Parse failed', updated_at = ?, finished_at = ? WHERE id = ?",
                    (JobStatus.FAILED.value, message, now, now, job_id),
                )
                connection.execute(
                    "UPDATE parse_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?",
                    (JobStatus.FAILED.value, message, now, run_id),
                )
                connection.execute(
                    "UPDATE job_stages SET status = ?, error = ?, finished_at = ?, updated_at = ? "
                    "WHERE job_id = ? AND finished_at IS NULL",
                    (JobStatus.FAILED.value, message, now, now, job_id),
                )
            if callback:
                callback(
                    ProgressEvent(
                        request_id=request_id,
                        job_id=job_id,
                        paper_id=paper_id,
                        status=JobStatus.FAILED,
                        progress=1,
                        message=message,
                    )
                )

    def scan(
        self,
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
        require_stable: bool = False,
    ) -> dict[str, int]:
        self.initialize()
        discovered = 0
        parsed = 0
        deduplicated = 0
        current_paths = {
            str(path.resolve()): path.resolve()
            for path in self.papers_dir.rglob("*")
            if path.is_file() and path.suffix.lower() == ".pdf"
        }
        for absolute, path in sorted(current_paths.items()):
            with self.db.connect() as connection:
                existing = connection.execute(
                    "SELECT * FROM paper_files WHERE absolute_path = ?", (absolute,)
                ).fetchone()
            stat = path.stat()
            if (
                existing
                and existing["size_bytes"] == stat.st_size
                and existing["modified_at_ns"] == stat.st_mtime_ns
            ):
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET is_missing = 0, updated_at = ? WHERE id = ?",
                        (utc_now(), existing["id"]),
                    )
                continue
            if require_stable:
                observed = self._stability.get(absolute)
                fingerprint = (stat.st_size, stat.st_mtime_ns)
                if not observed or observed[:2] != fingerprint:
                    self._stability[absolute] = (*fingerprint, time.monotonic())
                    continue
                if time.monotonic() - observed[2] < 2.0:
                    continue
                self._stability.pop(absolute, None)
            sha256 = self._sha256(path)
            if existing and existing["sha256"] == sha256:
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET is_missing = 0, updated_at = ? WHERE id = ?",
                        (utc_now(), existing["id"]),
                    )
                continue
            discovered += 1
            if existing and existing["sha256"] != sha256:
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET absolute_path = ? WHERE id = ?",
                        (f"{absolute}.superseded.{existing['sha256'][:8]}", existing["id"]),
                    )
            attached_paper = self._attach_duplicate_or_move(path, sha256)
            if attached_paper:
                deduplicated += 1
                continue
            paper_id, _, job_id = self._create_paper_and_file(path, sha256)
            self._parse(path, sha256, paper_id, job_id, callback, request_id)
            parsed += 1

        now = utc_now()
        with self.db.connect() as connection:
            known = connection.execute(
                "SELECT id, paper_id, absolute_path FROM paper_files WHERE is_missing = 0"
            ).fetchall()
            for row in known:
                if row["absolute_path"] in current_paths:
                    continue
                connection.execute(
                    "UPDATE paper_files SET is_missing = 1, updated_at = ? WHERE id = ?",
                    (now, row["id"]),
                )
                remaining = connection.execute(
                    "SELECT COUNT(*) AS count FROM paper_files WHERE paper_id = ? AND is_missing = 0",
                    (row["paper_id"],),
                ).fetchone()["count"]
                if remaining == 0:
                    connection.execute(
                        "UPDATE papers SET status = ?, updated_at = ? WHERE id = ?",
                        (JobStatus.MISSING.value, now, row["paper_id"]),
                    )
        return {"discovered": discovered, "parsed": parsed, "deduplicated": deduplicated}

    def enqueue_paths(self, paths: Iterable[Path]) -> dict[str, Any]:
        """Register trusted PDFs without blocking the import RPC on document parsing."""
        self.initialize()
        discovered = 0
        deduplicated = 0
        job_ids: list[str] = []
        current_paths: dict[str, Path] = {}
        for value in paths:
            path = Path(value).resolve()
            if path.suffix.lower() != ".pdf" or not path.is_file():
                raise FileNotFoundError(path)
            try:
                path.relative_to(self.papers_dir)
            except ValueError as error:
                raise ValueError(f"Imported path is outside Papers: {path}") from error
            current_paths[str(path)] = path

        for absolute, path in sorted(current_paths.items()):
            with self.db.connect() as connection:
                existing = connection.execute(
                    "SELECT * FROM paper_files WHERE absolute_path = ?", (absolute,)
                ).fetchone()
            stat = path.stat()
            if existing and existing["size_bytes"] == stat.st_size and existing["modified_at_ns"] == stat.st_mtime_ns:
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET is_missing = 0, updated_at = ? WHERE id = ?",
                        (utc_now(), existing["id"]),
                    )
                continue

            sha256 = self._sha256(path)
            if existing and existing["sha256"] == sha256:
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET is_missing = 0, updated_at = ? WHERE id = ?",
                        (utc_now(), existing["id"]),
                    )
                continue
            discovered += 1
            if existing and existing["sha256"] != sha256:
                with self.db.connect() as connection:
                    connection.execute(
                        "UPDATE paper_files SET absolute_path = ? WHERE id = ?",
                        (f"{absolute}.superseded.{existing['sha256'][:8]}", existing["id"]),
                    )
            if self._attach_duplicate_or_move(path, sha256):
                deduplicated += 1
                continue
            _, _, job_id = self._create_paper_and_file(path, sha256)
            job_ids.append(job_id)

        return {
            "discovered": discovered,
            "deduplicated": deduplicated,
            "enqueued": len(job_ids),
            "jobIds": job_ids,
        }

    def run_queued_jobs(
        self,
        job_ids: Iterable[str],
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
    ) -> dict[str, int]:
        completed = 0
        skipped = 0
        with self._queue_lock:
            for job_id in job_ids:
                with self.db.connect() as connection:
                    row = connection.execute(
                        "SELECT j.id, j.paper_id, j.status, j.finished_at, pf.absolute_path, pf.sha256 "
                        "FROM jobs j JOIN paper_files pf ON pf.id = j.paper_file_id WHERE j.id = ?",
                        (job_id,),
                    ).fetchone()
                if not row or row["finished_at"] or row["status"] not in {
                    JobStatus.DISCOVERED.value,
                    JobStatus.QUEUED.value,
                }:
                    skipped += 1
                    continue
                path = Path(row["absolute_path"])
                if not path.is_file():
                    skipped += 1
                    continue
                self._parse(path, row["sha256"], row["paper_id"], row["id"], callback, request_id)
                completed += 1
        return {"completed": completed, "skipped": skipped}

    def list_papers(self) -> list[dict]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT p.*, COALESCE(j.progress, CASE WHEN p.status = 'READY' THEN 1 ELSE 0 END) AS progress, "
                "j.error, pf.absolute_path AS source_path "
                "FROM papers p "
                "LEFT JOIN jobs j ON j.id = (SELECT id FROM jobs WHERE paper_id = p.id ORDER BY created_at DESC LIMIT 1) "
                "LEFT JOIN paper_files pf ON pf.id = (SELECT id FROM paper_files WHERE paper_id = p.id ORDER BY is_missing, created_at LIMIT 1) "
                "ORDER BY p.updated_at DESC"
            ).fetchall()
            papers = []
            for row in rows:
                figures = [
                    dict(figure)
                    for figure in connection.execute(
                        "SELECT id, caption, relative_path, thumbnail_path, page, bbox_json, mime_type FROM figures WHERE paper_id = ? ORDER BY page, id",
                        (row["id"],),
                    )
                ]
                papers.append(
                    {
                        "id": row["id"],
                        "title": row["title"],
                        "sourcePath": row["source_path"],
                        "status": row["status"],
                        "progress": row["progress"],
                        "pageCount": row["page_count"],
                        "markdownPath": row["markdown_path"],
                        "documentPath": row["document_path"],
                        "figures": [
                            {
                                "id": figure["id"],
                                "caption": figure["caption"],
                                "relativePath": figure["relative_path"],
                                "thumbnailPath": figure["thumbnail_path"],
                                "page": figure["page"],
                                "bbox": json.loads(figure["bbox_json"]) if figure["bbox_json"] else None,
                                "mimeType": figure["mime_type"],
                            }
                            for figure in figures
                        ],
                        "updatedAt": row["updated_at"],
                        "error": row["error"],
                    }
                )
            return papers

    def list_jobs(self) -> list[dict]:
        self.initialize()
        with self.db.connect() as connection:
            jobs = [dict(row) for row in connection.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200")]
            for job in jobs:
                job["stages"] = [
                    {
                        "id": row["id"],
                        "jobId": row["job_id"],
                        "stage": row["stage"],
                        "status": row["status"],
                        "progress": row["progress"],
                        "attempt": row["attempt"],
                        "artifact": json.loads(row["artifact_json"] or "{}"),
                        "error": row["error"],
                        "updatedAt": row["updated_at"],
                    }
                    for row in connection.execute(
                        "SELECT * FROM job_stages WHERE job_id = ? ORDER BY rowid", (job["id"],)
                    )
                ]
            return jobs

    def cancel_job(self, job_id: str) -> bool:
        with self.db.connect() as connection:
            result = connection.execute(
                "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND finished_at IS NULL",
                (utc_now(), job_id),
            )
            return result.rowcount > 0

    def retry_job(
        self,
        job_id: str,
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
    ) -> dict[str, str]:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT j.paper_id, j.paper_file_id, pf.absolute_path, pf.sha256 "
                "FROM jobs j JOIN paper_files pf ON pf.id = j.paper_file_id WHERE j.id = ?",
                (job_id,),
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown job: {job_id}")
        path = Path(row["absolute_path"])
        if not path.exists():
            raise FileNotFoundError(path)
        new_job_id = str(uuid.uuid4())
        now = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO jobs(id, paper_id, paper_file_id, kind, status, progress, message, created_at, updated_at) "
                "VALUES (?, ?, ?, 'RETRY_PARSE', ?, 0, 'Retry queued', ?, ?)",
                (new_job_id, row["paper_id"], row["paper_file_id"], JobStatus.QUEUED.value, now, now),
            )
        self._parse(path, row["sha256"], row["paper_id"], new_job_id, callback, request_id)
        return {"jobId": new_job_id, "paperId": row["paper_id"]}

    def reparse_paper(
        self,
        paper_id: str,
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
    ) -> dict[str, str]:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT id FROM jobs WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1", (paper_id,)
            ).fetchone()
        if not row:
            raise KeyError(f"No parse job exists for paper: {paper_id}")
        return self.retry_job(row["id"], callback, request_id)

    def apply_file_events(
        self,
        events: list[dict],
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
    ) -> dict[str, int]:
        self.initialize()
        queue = FileEventQueue(self.db, self.papers_dir)
        accepted = queue.enqueue_many(events)
        try:
            result = self.scan(callback, request_id, require_stable=True)
            processed = queue.mark_all("PROCESSED")
            return {"accepted": accepted, "processed": processed, **result}
        except Exception as error:
            queue.mark_all("FAILED", f"{type(error).__name__}: {error}")
            raise

    def import_zotero(
        self,
        candidates: list[dict],
        data_dir: str | Path | None = None,
        callback: ProgressCallback | None = None,
        request_id: str | int | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        importer = ZoteroImporter(data_dir)
        if reason := importer.lock_reason():
            raise ZoteroLockedError(reason)
        selected_keys = {
            candidate.get("attachmentKey")
            for candidate in candidates
            if candidate.get("selected") and isinstance(candidate.get("attachmentKey"), str)
        }
        if not selected_keys:
            return {"selected": 0, "copied": 0, "enqueued": 0, "deduplicated": 0, "jobIds": []}
        selected = importer.candidates(selected_keys)
        found_keys = {candidate["attachmentKey"] for candidate in selected}
        missing_keys = selected_keys - found_keys
        if missing_keys:
            raise ValueError(
                "Selected Zotero attachments are unavailable: " + ", ".join(sorted(missing_keys))
            )
        copied: list[tuple[dict, Path]] = []
        for candidate in selected:
            copied.append((candidate, importer.copy_candidate(candidate, self.papers_dir)))
        enqueue_result = self.enqueue_paths(target for _, target in copied)
        now = utc_now()
        with self.db.connect() as connection:
            for candidate, target in copied:
                paper = connection.execute(
                    "SELECT id FROM papers WHERE canonical_sha256 = ?", (candidate["sha256"],)
                ).fetchone()
                if not paper:
                    continue
                connection.execute(
                    "INSERT INTO paper_sources(id, paper_id, source_type, source_item_key, source_attachment_key, "
                    "source_collection, source_path, source_modified_at, metadata_json, imported_at) "
                    "VALUES (?, ?, 'zotero', ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(source_type, source_attachment_key) DO UPDATE SET paper_id = excluded.paper_id, "
                    "source_collection = excluded.source_collection, source_path = excluded.source_path, "
                    "source_modified_at = excluded.source_modified_at, metadata_json = excluded.metadata_json",
                    (
                        str(uuid.uuid4()),
                        paper["id"],
                        candidate["itemKey"],
                        candidate["attachmentKey"],
                        candidate["collections"][0] if candidate["collections"] else None,
                        str(target),
                        candidate.get("sourceModifiedAt"),
                        json.dumps(
                            {
                                "title": candidate["title"],
                                "authors": candidate["authors"],
                                "year": candidate.get("year"),
                                "DOI": candidate.get("doi"),
                            },
                            ensure_ascii=False,
                        ),
                        now,
                    ),
                )
        manifest = {
            "schemaVersion": 1,
            "source": str(importer.data_dir),
            "importedAt": now,
            "papers": [
                {
                    "attachmentKey": candidate["attachmentKey"],
                    "itemKey": candidate["itemKey"],
                    "sha256": candidate["sha256"],
                    "title": candidate["title"],
                    "category": candidate["category"],
                    "pageCount": candidate["pageCount"],
                    "targetPath": str(target),
                }
                for candidate, target in copied
            ],
        }
        manifest_path = self.internal_dir / "zotero-import-manifest.local.json"
        temporary_manifest = manifest_path.with_suffix(".tmp")
        temporary_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary_manifest.replace(manifest_path)
        return {"selected": len(selected), "copied": len(copied), **enqueue_result}

    def read_markdown(self, paper_id: str) -> str:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT markdown_path FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
        if not row or not row["markdown_path"]:
            raise FileNotFoundError(f"No Markdown exists for paper {paper_id}")
        return Path(row["markdown_path"]).read_text(encoding="utf-8")

    def read_document(self, paper_id: str) -> dict[str, Any]:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT document_path FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
        if not row or not row["document_path"]:
            raise FileNotFoundError(f"No structured document exists for paper {paper_id}")
        return json.loads(Path(row["document_path"]).read_text(encoding="utf-8"))

    def list_translations(self, paper_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT t.* FROM translations t "
                "JOIN (SELECT block_id, target_language, MAX(revision) AS revision "
                "FROM translations WHERE paper_id = ? GROUP BY block_id, target_language) latest "
                "ON latest.block_id = t.block_id AND latest.target_language = t.target_language "
                "AND latest.revision = t.revision WHERE t.paper_id = ? ORDER BY t.updated_at",
                (paper_id, paper_id),
            ).fetchall()
        return [self._translation_contract(dict(row)) for row in rows]

    def save_translation(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        required = (
            "paperId", "sectionId", "blockId", "sourceText", "translatedText",
            "targetLanguage", "modelId", "promptVersion",
        )
        missing = [key for key in required if not str(payload.get(key, "")).strip()]
        if missing:
            raise ValueError("Missing translation fields: " + ", ".join(missing))
        paper_id = str(payload["paperId"])
        now = utc_now()
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT canonical_sha256 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
            if not paper:
                raise KeyError(f"Unknown paper: {paper_id}")
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM translations "
                "WHERE paper_id = ? AND block_id = ? AND target_language = ?",
                (paper_id, payload["blockId"], payload["targetLanguage"]),
            ).fetchone()[0]
            record = {
                "id": str(uuid.uuid4()),
                "paper_id": paper_id,
                "section_id": str(payload["sectionId"]),
                "block_id": str(payload["blockId"]),
                "source_hash": paper["canonical_sha256"],
                "source_text": str(payload["sourceText"]),
                "translated_text": str(payload["translatedText"]),
                "target_language": str(payload["targetLanguage"]),
                "model_id": str(payload["modelId"]),
                "prompt_version": str(payload["promptVersion"]),
                "revision": revision,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO translations(id, paper_id, section_id, block_id, source_hash, "
                "source_text, translated_text, target_language, model_id, prompt_version, "
                "revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tuple(record.values()),
            )
        return self._translation_contract(record)

    @staticmethod
    def _estimate_context_tokens(text: str) -> int:
        return max(1, (len(text.encode("utf-8")) + 3) // 4)

    def get_context_draft(self) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT ci.*, p.title FROM context_items ci "
                "JOIN papers p ON p.id = ci.paper_id ORDER BY ci.created_at, ci.id"
            ).fetchall()
        items = [
            {
                "id": row["id"],
                "paperId": row["paper_id"],
                "paperTitle": row["title"],
                "sectionId": row["section_id"] or None,
                "blockId": row["block_id"] or None,
                "mode": row["mode"],
                "sourceHash": row["source_hash"],
                "sourcePreview": row["source_text"][:240],
                "estimatedTokens": row["estimated_tokens"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]
        paper_tokens = sum(item["estimatedTokens"] for item in items)
        return {
            "items": items,
            "tokenBreakdown": {
                "systemPrompt": 4200,
                "tools": 7800,
                "conversation": 0,
                "papers": paper_tokens,
                "figures": 0,
                "outputReserve": 16000,
                "safetyBuffer": 8000,
            },
            "updatedAt": max((item["updatedAt"] for item in items), default=None),
        }

    def add_paper_to_context(self, paper_id: str, mode: str = "full") -> dict[str, Any]:
        self.initialize()
        if mode not in {"full", "structured"}:
            raise ValueError("Context mode must be full or structured")
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT title, canonical_sha256, document_path FROM papers WHERE id = ?",
                (paper_id,),
            ).fetchone()
        if not paper:
            raise KeyError(f"Unknown paper: {paper_id}")
        if not paper["document_path"]:
            raise FileNotFoundError(f"No structured document exists for paper {paper_id}")
        document = json.loads(Path(paper["document_path"]).read_text(encoding="utf-8"))
        sections = sorted(document.get("sections", []), key=lambda item: item.get("order", 0))
        source_text = "\n\n".join(
            str(section.get("markdown", "")).strip() for section in sections
            if str(section.get("markdown", "")).strip()
        )
        return self._upsert_context_item(
            paper_id=paper_id,
            section_id="",
            block_id="",
            source_text=source_text,
            mode=mode,
            source_hash=paper["canonical_sha256"],
        )

    def add_selection_to_context(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        paper_id = str(payload.get("paperId", "")).strip()
        section_id = str(payload.get("sectionId", "")).strip()
        block_id = str(payload.get("blockId", "")).strip()
        source_text = str(payload.get("sourceText", "")).strip()
        if not paper_id or not section_id or not source_text:
            raise ValueError("paperId, sectionId and sourceText are required")
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT canonical_sha256 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
        if not paper:
            raise KeyError(f"Unknown paper: {paper_id}")
        return self._upsert_context_item(
            paper_id=paper_id,
            section_id=section_id,
            block_id=block_id,
            source_text=source_text,
            mode="sections",
            source_hash=paper["canonical_sha256"],
        )

    def _upsert_context_item(
        self,
        *,
        paper_id: str,
        section_id: str,
        block_id: str,
        source_text: str,
        mode: str,
        source_hash: str,
    ) -> dict[str, Any]:
        if not source_text:
            raise ValueError("Context source text is empty")
        now = utc_now()
        item_id = str(uuid.uuid4())
        estimated_tokens = self._estimate_context_tokens(source_text)
        with self.db.connect() as connection:
            existing = connection.execute(
                "SELECT id, created_at FROM context_items "
                "WHERE paper_id = ? AND section_id = ? AND block_id = ?",
                (paper_id, section_id, block_id),
            ).fetchone()
            if existing:
                item_id = existing["id"]
                created_at = existing["created_at"]
            else:
                created_at = now
            connection.execute(
                "INSERT INTO context_items(id, paper_id, section_id, block_id, mode, source_hash, "
                "source_text, estimated_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(paper_id, section_id, block_id) DO UPDATE SET mode = excluded.mode, "
                "source_hash = excluded.source_hash, source_text = excluded.source_text, "
                "estimated_tokens = excluded.estimated_tokens, updated_at = excluded.updated_at",
                (item_id, paper_id, section_id, block_id, mode, source_hash, source_text,
                 estimated_tokens, created_at, now),
            )
        return self.get_context_draft()

    def remove_paper_from_context(self, paper_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            connection.execute("DELETE FROM context_items WHERE paper_id = ?", (paper_id,))
        return self.get_context_draft()

    def clear_context(self) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            connection.execute("DELETE FROM context_items")
        return self.get_context_draft()

    @staticmethod
    def _translation_contract(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "paperId": record["paper_id"],
            "sectionId": record["section_id"],
            "blockId": record["block_id"],
            "sourceHash": record["source_hash"],
            "sourceText": record["source_text"],
            "translatedText": record["translated_text"],
            "targetLanguage": record["target_language"],
            "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "revision": record["revision"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }


def watch_library(root: str | Path, interval: float = 2.0) -> None:
    library = Library(root)
    library.initialize()
    while True:
        library.scan(require_stable=True)
        time.sleep(interval)
