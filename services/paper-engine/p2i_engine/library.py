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
from .citations import GRAPH_SCHEMA_VERSION, build_two_level_graph, extract_references
from .ingestion import FileEventQueue
from .models import CancelledError, JobStatus, ProgressEvent, utc_now
from .parsing import parse_pdf
from .zotero import ZoteroImporter, ZoteroLockedError

ProgressCallback = Callable[[ProgressEvent], None]

AGENT_TOOLS = {
    "search_library",
    "read_paper",
    "read_section",
    "read_figure",
    "find_evidence",
    "get_references",
    "get_related_papers",
    "count_context_tokens",
    "create_note",
    "update_context",
}

DEFAULT_AGENT_PROFILES = (
    {
        "id": "paper-analyst",
        "name": "Paper Analyst",
        "description": "Explain passages and ground every claim in local evidence.",
        "color": "#4f6bed",
        "modelId": "custom-chat-model",
        "allowedTools": ["read_paper", "read_section", "find_evidence"],
        "networkPolicy": "none",
        "systemPrompt": "You are a scientific paper analyst. Answer from the supplied local context only. Cite paper, section, block, and page anchors for factual claims. State clearly when evidence is missing.",
    },
    {
        "id": "translation-agent",
        "name": "Translation Agent",
        "description": "Translate scientific prose while preserving structure and terminology.",
        "color": "#3984d8",
        "modelId": "custom-fast-model",
        "allowedTools": ["read_paper", "read_section"],
        "networkPolicy": "none",
        "systemPrompt": "Translate scientific text faithfully. Preserve Markdown, LaTeX, terminology, citations, numbers, and uncertainty. Do not add unsupported explanations.",
    },
    {
        "id": "figure-analyst",
        "name": "Figure Analyst",
        "description": "Interpret diagrams, charts, captions, and linked paper evidence.",
        "color": "#7357d8",
        "modelId": "custom-chat-model",
        "allowedTools": ["read_paper", "read_figure", "find_evidence"],
        "networkPolicy": "none",
        "systemPrompt": "Analyze scientific figures using their captions and surrounding paper context. Separate direct observations from interpretation and cite the source page.",
    },
    {
        "id": "citation-agent",
        "name": "Citation Agent",
        "description": "Resolve references and explain shared citation paths.",
        "color": "#28a06a",
        "modelId": "custom-long-context-model",
        "allowedTools": ["get_references", "get_related_papers", "find_evidence"],
        "networkPolicy": "academic",
        "systemPrompt": "Analyze citation relationships without inventing metadata. Distinguish resolved local papers from unresolved references and cite graph provenance.",
    },
    {
        "id": "innovation-agent",
        "name": "Innovation Agent",
        "description": "Synthesize testable research directions from grounded context.",
        "color": "#d98916",
        "modelId": "custom-reasoning-model",
        "allowedTools": ["search_library", "read_paper", "find_evidence", "create_note"],
        "networkPolicy": "academic",
        "systemPrompt": "Generate testable research ideas from supplied evidence. For every factual premise cite its paper anchor. Include a falsifiable hypothesis, minimum experiment, and novelty risks.",
    },
    {
        "id": "novelty-critic",
        "name": "Novelty Critic",
        "description": "Challenge novelty and expose unsupported assumptions.",
        "color": "#d64545",
        "modelId": "custom-reasoning-model",
        "allowedTools": ["search_library", "get_related_papers", "find_evidence"],
        "networkPolicy": "academic",
        "systemPrompt": "Act as a rigorous novelty critic. Identify closest prior work, unsupported assumptions, confounders, and decisive falsification tests. Never fabricate evidence.",
    },
)


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
            self._ensure_default_agent_profiles()
            self._recover_interrupted_agent_runs()
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
            references = extract_references(result.document.model_dump(by_alias=True))
            references_path.write_text(
                json.dumps(references, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self._progress(
                callback,
                job_id,
                paper_id,
                JobStatus.PARSING_REFERENCES,
                0.77,
                f"Extracted {len(references)} references",
                request_id,
            )
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

    def read_references(self, paper_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT document_path FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown paper: {paper_id}")
        document_path = Path(row["document_path"]) if row["document_path"] else None
        references_path = document_path.with_name("references.json") if document_path else None
        if references_path and references_path.is_file():
            references = json.loads(references_path.read_text(encoding="utf-8"))
            if references:
                return references
        if not document_path:
            return []
        if not document_path.is_file():
            return []
        references = extract_references(json.loads(document_path.read_text(encoding="utf-8")))
        if references_path:
            temporary = references_path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(references, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            temporary.replace(references_path)
        return references

    def build_citation_graph(
        self, paper_id: str, max_depth: int = 2, force: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            papers = [
                dict(row)
                for row in connection.execute(
                    "SELECT id, title, canonical_sha256, updated_at, document_path "
                    "FROM papers ORDER BY id"
                )
            ]
        fingerprint = hashlib.sha256(
            json.dumps(
                [
                    (paper["id"], paper["canonical_sha256"], paper["updated_at"])
                    for paper in papers
                ],
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        cache_dir = self.internal_dir / "cache" / "graphs"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"{paper_id}-depth-{max_depth}.json"
        if not force and cache_path.is_file():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                cached.get("schemaVersion") == GRAPH_SCHEMA_VERSION
                and cached.get("libraryFingerprint") == fingerprint
            ):
                return {**cached, "cacheHit": True}
        graph = build_two_level_graph(paper_id, papers, self.read_references, max_depth)
        graph.update(
            {
                "libraryFingerprint": fingerprint,
                "generatedAt": utc_now(),
                "cacheHit": False,
            }
        )
        temporary = cache_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(cache_path)
        return graph

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
            compression_rows = connection.execute(
                "SELECT cc.* FROM context_compressions cc "
                "JOIN context_items ci ON ci.active_compression_id = cc.id"
            ).fetchall()
        compressions = {
            row["context_item_id"]: self._context_compression_summary(row)
            for row in compression_rows
        }
        items = []
        for row in rows:
            item = {
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
            compression = compressions.get(row["id"])
            if compression and row["mode"] == "compressed":
                item["compression"] = compression
            items.append(item)
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

    def read_context_item(self, item_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT ci.*, p.title FROM context_items ci "
                "JOIN papers p ON p.id = ci.paper_id WHERE ci.id = ?",
                (item_id,),
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown context item: {item_id}")
        return {
            "id": row["id"],
            "paperId": row["paper_id"],
            "paperTitle": row["title"],
            "sectionId": row["section_id"] or None,
            "blockId": row["block_id"] or None,
            "sourceHash": row["source_hash"],
            "sourceText": row["source_text"],
            "estimatedTokens": self._estimate_context_tokens(row["source_text"]),
        }

    def get_context_compression(
        self, item_id: str, model_id: str, prompt_version: str
    ) -> dict[str, Any] | None:
        self.initialize()
        with self.db.connect() as connection:
            item = connection.execute(
                "SELECT source_hash FROM context_items WHERE id = ?", (item_id,)
            ).fetchone()
            if not item:
                raise KeyError(f"Unknown context item: {item_id}")
            row = connection.execute(
                "SELECT * FROM context_compressions WHERE context_item_id = ? "
                "AND source_hash = ? AND model_id = ? AND prompt_version = ? "
                "ORDER BY revision DESC LIMIT 1",
                (item_id, item["source_hash"], model_id, prompt_version),
            ).fetchone()
        return self._context_compression_contract(row) if row else None

    def activate_context_compression(
        self, item_id: str, model_id: str, prompt_version: str
    ) -> dict[str, Any]:
        compression = self.get_context_compression(item_id, model_id, prompt_version)
        if not compression:
            raise KeyError("No cached compression matches the current source and model")
        with self.db.connect() as connection:
            connection.execute(
                "UPDATE context_items SET mode = 'compressed', estimated_tokens = ?, "
                "active_compression_id = ?, updated_at = ? WHERE id = ?",
                (compression["estimatedTokens"], compression["id"], utc_now(), item_id),
            )
        return self.get_context_draft()

    def save_context_compression(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        required = ("itemId", "sourceHash", "compressedText", "modelId", "promptVersion")
        missing = [key for key in required if not str(payload.get(key, "")).strip()]
        if missing:
            raise ValueError("Missing context compression fields: " + ", ".join(missing))
        item_id = str(payload["itemId"])
        source_hash = str(payload["sourceHash"])
        compressed_text = str(payload["compressedText"]).strip()
        model_id = str(payload["modelId"])
        prompt_version = str(payload["promptVersion"])
        input_tokens = max(0, int(payload.get("inputTokens", 0)))
        output_tokens = max(0, int(payload.get("outputTokens", 0)))
        duration_ms = max(0, int(payload.get("durationMs", 0)))
        now = utc_now()
        estimated_tokens = self._estimate_context_tokens(compressed_text)
        with self.db.connect() as connection:
            item = connection.execute(
                "SELECT source_hash FROM context_items WHERE id = ?", (item_id,)
            ).fetchone()
            if not item:
                raise KeyError(f"Unknown context item: {item_id}")
            if item["source_hash"] != source_hash:
                raise ValueError("Context source changed while compression was running")
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM context_compressions "
                "WHERE context_item_id = ? AND source_hash = ? AND model_id = ? "
                "AND prompt_version = ?",
                (item_id, source_hash, model_id, prompt_version),
            ).fetchone()[0]
            record = {
                "id": str(uuid.uuid4()),
                "context_item_id": item_id,
                "source_hash": source_hash,
                "compressed_text": compressed_text,
                "estimated_tokens": estimated_tokens,
                "model_id": model_id,
                "prompt_version": prompt_version,
                "revision": revision,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "duration_ms": duration_ms,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO context_compressions(id, context_item_id, source_hash, "
                "compressed_text, estimated_tokens, model_id, prompt_version, revision, "
                "input_tokens, output_tokens, duration_ms, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tuple(record.values()),
            )
            connection.execute(
                "UPDATE context_items SET mode = 'compressed', estimated_tokens = ?, "
                "active_compression_id = ?, updated_at = ? WHERE id = ?",
                (estimated_tokens, record["id"], now, item_id),
            )
        return self._context_compression_contract(record)

    @staticmethod
    def _context_compression_summary(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "revision": record["revision"],
            "estimatedTokens": record["estimated_tokens"],
            "usage": {
                "inputTokens": record["input_tokens"],
                "outputTokens": record["output_tokens"],
                "durationMs": record["duration_ms"],
            },
            "preview": record["compressed_text"][:240],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    @classmethod
    def _context_compression_contract(cls, record: Any) -> dict[str, Any]:
        return {
            **cls._context_compression_summary(record),
            "itemId": record["context_item_id"],
            "sourceHash": record["source_hash"],
            "compressedText": record["compressed_text"],
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
                "estimated_tokens = excluded.estimated_tokens, active_compression_id = NULL, "
                "updated_at = excluded.updated_at",
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
    def _normalize_agent_profile(
        payload: dict[str, Any], created_at: str | None = None
    ) -> dict[str, Any]:
        profile_id = str(payload.get("id") or uuid.uuid4()).strip()
        name = str(payload.get("name", "")).strip()
        description = str(payload.get("description", "")).strip()
        provider_id = str(payload.get("providerId", "")).strip()
        model_id = str(payload.get("modelId", "")).strip()
        credential_id = str(payload.get("credentialId", "")).strip()
        system_prompt = str(payload.get("systemPrompt", "")).strip()
        if not all((profile_id, name, provider_id, model_id, credential_id, system_prompt)):
            raise ValueError(
                "Agent id, name, provider, model, credential, and system prompt are required"
            )
        if len(profile_id) > 120 or len(name) > 160 or len(system_prompt) > 50000:
            raise ValueError("Agent profile fields exceed their size limit")

        allowed_tools = list(dict.fromkeys(str(item) for item in payload.get("allowedTools", [])))
        unknown_tools = sorted(set(allowed_tools) - AGENT_TOOLS)
        if unknown_tools:
            raise ValueError("Unknown agent tools: " + ", ".join(unknown_tools))
        network_policy = str(payload.get("networkPolicy", "none"))
        write_policy = str(payload.get("writePolicy", "read-only"))
        if network_policy not in {"none", "academic", "full"}:
            raise ValueError("Invalid agent network policy")
        if write_policy not in {"read-only", "confirm-write", "trusted-write"}:
            raise ValueError("Invalid agent write policy")

        context_safety_ratio = float(payload.get("contextSafetyRatio", 0.85))
        temperature = float(payload.get("temperature", 0.2))
        max_context_tokens = int(payload.get("maxContextTokens", 128000))
        max_output_tokens = int(payload.get("maxOutputTokens", 4096))
        timeout_seconds = int(payload.get("timeoutSeconds", 90))
        max_retries = int(payload.get("maxRetries", 2))
        if not 0 < context_safety_ratio <= 1:
            raise ValueError("Agent context safety ratio must be in (0, 1]")
        if not 0 <= temperature <= 2:
            raise ValueError("Agent temperature must be between 0 and 2")
        if min(max_context_tokens, max_output_tokens, timeout_seconds) < 1 or max_retries < 0:
            raise ValueError("Agent token, timeout, and retry limits are invalid")

        color = str(payload.get("color", "#4f6bed")).strip().lower()
        if len(color) != 7 or not color.startswith("#") or any(
            character not in "0123456789abcdef" for character in color[1:]
        ):
            color = "#4f6bed"
        now = utc_now()
        return {
            "id": profile_id,
            "name": name,
            "description": description,
            "color": color,
            "enabled": 1 if bool(payload.get("enabled", True)) else 0,
            "provider_id": provider_id,
            "model_id": model_id,
            "credential_id": credential_id,
            "max_context_tokens": max_context_tokens,
            "max_output_tokens": max_output_tokens,
            "context_safety_ratio": context_safety_ratio,
            "temperature": temperature,
            "reasoning_effort": str(payload.get("reasoningEffort", "")).strip() or None,
            "timeout_seconds": timeout_seconds,
            "max_retries": max_retries,
            "max_cost_per_run": payload.get("maxCostPerRun"),
            "max_cost_per_day": payload.get("maxCostPerDay"),
            "allowed_tools_json": json.dumps(allowed_tools, separators=(",", ":")),
            "network_policy": network_policy,
            "write_policy": write_policy,
            "system_prompt_id": str(
                payload.get("systemPromptId") or f"system:{profile_id}"
            ),
            "system_prompt": system_prompt,
            "prompt_version": str(payload.get("promptVersion") or "agent-v1"),
            "created_at": created_at or now,
            "updated_at": now,
        }

    @staticmethod
    def _write_agent_profile(connection: Any, record: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO agent_profiles(id, name, description, color, enabled, provider_id, "
            "model_id, credential_id, max_context_tokens, max_output_tokens, "
            "context_safety_ratio, temperature, reasoning_effort, timeout_seconds, max_retries, "
            "max_cost_per_run, max_cost_per_day, allowed_tools_json, network_policy, write_policy, "
            "system_prompt_id, system_prompt, prompt_version, created_at, updated_at) "
            "VALUES (:id, :name, :description, :color, :enabled, :provider_id, :model_id, "
            ":credential_id, :max_context_tokens, :max_output_tokens, :context_safety_ratio, "
            ":temperature, :reasoning_effort, :timeout_seconds, :max_retries, :max_cost_per_run, "
            ":max_cost_per_day, :allowed_tools_json, :network_policy, :write_policy, "
            ":system_prompt_id, :system_prompt, :prompt_version, :created_at, :updated_at) "
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, "
            "color = excluded.color, enabled = excluded.enabled, provider_id = excluded.provider_id, "
            "model_id = excluded.model_id, credential_id = excluded.credential_id, "
            "max_context_tokens = excluded.max_context_tokens, "
            "max_output_tokens = excluded.max_output_tokens, "
            "context_safety_ratio = excluded.context_safety_ratio, temperature = excluded.temperature, "
            "reasoning_effort = excluded.reasoning_effort, timeout_seconds = excluded.timeout_seconds, "
            "max_retries = excluded.max_retries, max_cost_per_run = excluded.max_cost_per_run, "
            "max_cost_per_day = excluded.max_cost_per_day, "
            "allowed_tools_json = excluded.allowed_tools_json, network_policy = excluded.network_policy, "
            "write_policy = excluded.write_policy, system_prompt_id = excluded.system_prompt_id, "
            "system_prompt = excluded.system_prompt, prompt_version = excluded.prompt_version, "
            "updated_at = excluded.updated_at",
            record,
        )

    def _ensure_default_agent_profiles(self) -> None:
        with self.db.connect() as connection:
            if connection.execute("SELECT COUNT(*) FROM agent_profiles").fetchone()[0]:
                return
            for default in DEFAULT_AGENT_PROFILES:
                provider_id = (
                    "provider-anthropic-demo"
                    if default["modelId"] == "custom-long-context-model"
                    else "provider-openai-demo"
                )
                payload = {
                    **default,
                    "enabled": True,
                    "providerId": provider_id,
                    "credentialId": provider_id,
                    "maxContextTokens": 128000,
                    "maxOutputTokens": 4096,
                    "contextSafetyRatio": 0.85,
                    "temperature": 0.2,
                    "timeoutSeconds": 90,
                    "maxRetries": 2,
                    "writePolicy": "confirm-write",
                    "systemPromptId": f"system:{default['id']}",
                    "promptVersion": "agent-v1",
                }
                self._write_agent_profile(
                    connection, self._normalize_agent_profile(payload)
                )

    def _recover_interrupted_agent_runs(self) -> None:
        now = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "UPDATE agent_runs SET status = 'interrupted', "
                "error = COALESCE(error, 'Model stream interrupted by engine restart'), "
                "finished_at = ?, updated_at = ? WHERE status = 'running'",
                (now, now),
            )

    @classmethod
    def _agent_profile_contract(
        cls, record: Any, latest_run: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        profile = {
            "id": record["id"],
            "name": record["name"],
            "description": record["description"],
            "color": record["color"],
            "enabled": bool(record["enabled"]),
            "providerId": record["provider_id"],
            "modelId": record["model_id"],
            "credentialId": record["credential_id"],
            "maxContextTokens": record["max_context_tokens"],
            "maxOutputTokens": record["max_output_tokens"],
            "contextSafetyRatio": record["context_safety_ratio"],
            "temperature": record["temperature"],
            "reasoningEffort": record["reasoning_effort"],
            "timeoutSeconds": record["timeout_seconds"],
            "maxRetries": record["max_retries"],
            "maxCostPerRun": record["max_cost_per_run"],
            "maxCostPerDay": record["max_cost_per_day"],
            "allowedTools": json.loads(record["allowed_tools_json"]),
            "networkPolicy": record["network_policy"],
            "writePolicy": record["write_policy"],
            "systemPromptId": record["system_prompt_id"],
            "systemPrompt": record["system_prompt"],
            "promptVersion": record["prompt_version"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }
        if latest_run:
            profile["latestRun"] = latest_run
        return profile

    def list_agent_profiles(self) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            profiles = connection.execute(
                "SELECT * FROM agent_profiles ORDER BY created_at, id"
            ).fetchall()
            latest_runs = {
                row["agent_profile_id"]: self._agent_run_contract(row)
                for row in connection.execute(
                    "SELECT ar.* FROM agent_runs ar JOIN (SELECT agent_profile_id, MAX(created_at) "
                    "created_at FROM agent_runs GROUP BY agent_profile_id) latest "
                    "ON latest.agent_profile_id = ar.agent_profile_id "
                    "AND latest.created_at = ar.created_at"
                )
            }
        return [
            self._agent_profile_contract(row, latest_runs.get(row["id"]))
            for row in profiles
        ]

    def upsert_agent_profile(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        profile_id = str(payload.get("id") or uuid.uuid4())
        with self.db.connect() as connection:
            existing = connection.execute(
                "SELECT created_at FROM agent_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
            record = self._normalize_agent_profile(
                {**payload, "id": profile_id}, existing["created_at"] if existing else None
            )
            self._write_agent_profile(connection, record)
        return self._agent_profile_contract(record)

    def delete_agent_profile(self, profile_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            if connection.execute(
                "SELECT 1 FROM agent_runs WHERE agent_profile_id = ? LIMIT 1", (profile_id,)
            ).fetchone():
                raise ValueError("Agent profiles with run history cannot be deleted; disable it instead")
            cursor = connection.execute("DELETE FROM agent_profiles WHERE id = ?", (profile_id,))
        return bool(cursor.rowcount)

    @staticmethod
    def _agent_run_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "agentProfileId": record["agent_profile_id"],
            "retryOf": record["retry_of"],
            "status": record["status"],
            "providerId": record["provider_id"],
            "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "userPrompt": record["user_prompt"],
            "contextSnapshot": json.loads(record["context_snapshot_json"]),
            "outputText": record["output_text"],
            "usage": {
                "inputTokens": record["input_tokens"],
                "outputTokens": record["output_tokens"],
                "durationMs": record["duration_ms"],
            },
            "error": record["error"],
            "cancelRequested": bool(record["cancel_requested"]),
            "startedAt": record["started_at"],
            "finishedAt": record["finished_at"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    def list_agent_runs(
        self, profile_id: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        self.initialize()
        limit = max(1, min(int(limit), 200))
        with self.db.connect() as connection:
            if profile_id:
                rows = connection.execute(
                    "SELECT * FROM agent_runs WHERE agent_profile_id = ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (profile_id, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._agent_run_contract(row) for row in rows]

    def _insert_agent_run(
        self,
        connection: Any,
        profile: Any,
        user_prompt: str,
        context_snapshot: dict[str, Any],
        retry_of: str | None = None,
    ) -> dict[str, Any]:
        if not bool(profile["enabled"]):
            raise ValueError("Agent profile is disabled")
        user_prompt = user_prompt.strip()
        if not user_prompt or len(user_prompt) > 100000:
            raise ValueError("Agent run prompt is empty or too large")
        snapshot_json = json.dumps(context_snapshot, ensure_ascii=False, separators=(",", ":"))
        if len(snapshot_json.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("Agent context snapshot exceeds 2 MB")
        now = utc_now()
        record = {
            "id": str(uuid.uuid4()),
            "agent_profile_id": profile["id"],
            "retry_of": retry_of,
            "status": "running",
            "provider_id": profile["provider_id"],
            "model_id": profile["model_id"],
            "prompt_version": profile["prompt_version"],
            "user_prompt": user_prompt,
            "context_snapshot_json": snapshot_json,
            "output_text": "",
            "input_tokens": 0,
            "output_tokens": 0,
            "duration_ms": 0,
            "error": None,
            "cancel_requested": 0,
            "started_at": now,
            "finished_at": None,
            "created_at": now,
            "updated_at": now,
        }
        connection.execute(
            "INSERT INTO agent_runs(id, agent_profile_id, retry_of, status, provider_id, "
            "model_id, prompt_version, user_prompt, context_snapshot_json, output_text, "
            "input_tokens, output_tokens, duration_ms, error, cancel_requested, started_at, "
            "finished_at, created_at, updated_at) VALUES (:id, :agent_profile_id, :retry_of, "
            ":status, :provider_id, :model_id, :prompt_version, :user_prompt, "
            ":context_snapshot_json, :output_text, :input_tokens, :output_tokens, :duration_ms, "
            ":error, :cancel_requested, :started_at, :finished_at, :created_at, :updated_at)",
            record,
        )
        return record

    def start_agent_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        profile_id = str(payload.get("agentProfileId", ""))
        context_snapshot = payload.get("contextSnapshot") or {}
        if not isinstance(context_snapshot, dict):
            raise ValueError("Agent context snapshot must be an object")
        with self.db.connect() as connection:
            profile = connection.execute(
                "SELECT * FROM agent_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
            if not profile:
                raise KeyError(f"Unknown agent profile: {profile_id}")
            record = self._insert_agent_run(
                connection, profile, str(payload.get("userPrompt", "")), context_snapshot
            )
        return self._agent_run_contract(record)

    def update_agent_run(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        status = str(payload.get("status", "running"))
        if status not in {"running", "completed", "failed", "cancelled"}:
            raise ValueError("Invalid agent run status update")
        output_text = str(payload.get("outputText", ""))
        if len(output_text) > 2_000_000:
            raise ValueError("Agent run output exceeds 2 million characters")
        now = utc_now()
        finished_at = now if status in {"completed", "failed", "cancelled"} else None
        error = str(payload.get("error", ""))[:4000] or None
        with self.db.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if not existing:
                raise KeyError(f"Unknown agent run: {run_id}")
            if existing["status"] not in {"running", "interrupted"}:
                if existing["status"] == status:
                    return self._agent_run_contract(existing)
                raise ValueError("Agent run is already terminal")
            connection.execute(
                "UPDATE agent_runs SET status = ?, output_text = ?, input_tokens = ?, "
                "output_tokens = ?, duration_ms = ?, error = ?, cancel_requested = ?, "
                "finished_at = COALESCE(?, finished_at), updated_at = ? WHERE id = ?",
                (
                    status,
                    output_text,
                    max(0, int(payload.get("inputTokens", existing["input_tokens"]))),
                    max(0, int(payload.get("outputTokens", existing["output_tokens"]))),
                    max(0, int(payload.get("durationMs", existing["duration_ms"]))),
                    error,
                    1 if status == "cancelled" else existing["cancel_requested"],
                    finished_at,
                    now,
                    run_id,
                ),
            )
            record = connection.execute(
                "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
            ).fetchone()
        return self._agent_run_contract(record)

    def cancel_agent_run(self, run_id: str) -> dict[str, Any]:
        return self.update_agent_run(run_id, {"status": "cancelled"})

    def retry_agent_run(self, run_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            previous = connection.execute(
                "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if not previous:
                raise KeyError(f"Unknown agent run: {run_id}")
            if previous["status"] == "running":
                raise ValueError("Cannot retry an active agent run")
            profile = connection.execute(
                "SELECT * FROM agent_profiles WHERE id = ?",
                (previous["agent_profile_id"],),
            ).fetchone()
            record = self._insert_agent_run(
                connection,
                profile,
                previous["user_prompt"],
                json.loads(previous["context_snapshot_json"]),
                retry_of=run_id,
            )
        return self._agent_run_contract(record)

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
