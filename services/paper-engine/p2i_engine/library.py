from __future__ import annotations

import hashlib
import json
import re
import sqlite3
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
from .models import CancelledError, JobStatus, PaperDocument, ProgressEvent, utc_now
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

AGENT_TOOL_DEFINITIONS: dict[str, dict[str, Any]] = {
    "search_library": {
        "name": "search_library",
        "description": "Search titles in the local Papers2Innovations library.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, "required": ["query"], "additionalProperties": False},
    },
    "read_paper": {
        "name": "read_paper",
        "description": "Read the parsed Markdown for one local paper.",
        "inputSchema": {"type": "object", "properties": {"paperId": {"type": "string"}, "maxCharacters": {"type": "integer", "minimum": 1000, "maximum": 100000}}, "required": ["paperId"], "additionalProperties": False},
    },
    "read_section": {
        "name": "read_section",
        "description": "Read a structured section from one local paper.",
        "inputSchema": {"type": "object", "properties": {"paperId": {"type": "string"}, "sectionId": {"type": "string"}}, "required": ["paperId", "sectionId"], "additionalProperties": False},
    },
    "read_figure": {
        "name": "read_figure",
        "description": "Read extracted figure metadata, caption, page, and bounding box.",
        "inputSchema": {"type": "object", "properties": {"paperId": {"type": "string"}, "figureId": {"type": "string"}}, "required": ["paperId"], "additionalProperties": False},
    },
    "find_evidence": {
        "name": "find_evidence",
        "description": "Find grounded snippets in parsed local paper sections.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "paperId": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, "required": ["query"], "additionalProperties": False},
    },
    "get_references": {
        "name": "get_references",
        "description": "Read structured references extracted from a local paper.",
        "inputSchema": {"type": "object", "properties": {"paperId": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}}, "required": ["paperId"], "additionalProperties": False},
    },
}

DEFAULT_AGENT_PROFILES = (
    {
        "id": "paper-analyst",
        "name": "论文分析助手",
        "description": "解释论文内容，并让每条论断都有本地证据支持。",
        "color": "#4f6bed",
        "modelId": "custom-chat-model",
        "allowedTools": ["read_paper", "read_section", "find_evidence"],
        "networkPolicy": "none",
        "systemPrompt": "你是科研论文分析助手。请默认使用中文，只根据提供的本地上下文回答。所有事实性陈述都要引用论文、章节、文本块和页码锚点；证据不足时必须明确说明。",
    },
    {
        "id": "translation-agent",
        "name": "翻译助手",
        "description": "在保留结构和术语的前提下翻译科研文本。",
        "color": "#3984d8",
        "modelId": "custom-fast-model",
        "allowedTools": ["read_paper", "read_section"],
        "networkPolicy": "none",
        "systemPrompt": "请将科研文本忠实翻译为简体中文，保留 Markdown、LaTeX、专业术语、引用、数字和不确定性，不得添加无证据支持的解释。",
    },
    {
        "id": "figure-analyst",
        "name": "图表分析助手",
        "description": "解读图表、说明文字及关联的论文证据。",
        "color": "#7357d8",
        "modelId": "custom-chat-model",
        "allowedTools": ["read_paper", "read_figure", "find_evidence"],
        "networkPolicy": "none",
        "systemPrompt": "请默认使用中文，结合说明文字和相邻论文上下文分析科研图表。区分直接观察与解释，并引用来源页码。",
    },
    {
        "id": "citation-agent",
        "name": "引用分析助手",
        "description": "解析参考文献并说明共同引用路径。",
        "color": "#28a06a",
        "modelId": "custom-long-context-model",
        "allowedTools": ["get_references", "get_related_papers", "find_evidence"],
        "networkPolicy": "academic",
        "systemPrompt": "请默认使用中文分析引用关系，不得编造元数据。区分已解析的本地论文和未解析引用，并说明图谱来源。",
    },
    {
        "id": "innovation-agent",
        "name": "创新研究助手",
        "description": "根据有据可查的上下文生成可验证的研究方向。",
        "color": "#d98916",
        "modelId": "custom-reasoning-model",
        "allowedTools": ["search_library", "read_paper", "find_evidence", "create_note"],
        "networkPolicy": "academic",
        "systemPrompt": "请默认使用中文，根据给定证据生成可验证的研究想法。每项事实前提都要引用论文锚点，并包含可证伪假设、最小实验和创新性风险。",
    },
    {
        "id": "novelty-critic",
        "name": "创新性审查助手",
        "description": "审查创新性并揭示缺乏证据的假设。",
        "color": "#d64545",
        "modelId": "custom-reasoning-model",
        "allowedTools": ["search_library", "get_related_papers", "find_evidence"],
        "networkPolicy": "academic",
        "systemPrompt": "请默认使用中文，以严谨的创新性审查者身份识别最接近的既有工作、无证据假设、混杂因素和决定性证伪实验，绝不编造证据。",
    },
)

INNOVATION_STAGES = ("compression", "evidence", "ideas", "novelty", "critique")


class Library:
    def __init__(
        self,
        root: str | Path,
        ocr_page: Callable[[dict], dict] | None = None,
        vision_config: Callable[[], dict] | None = None,
        vision_analyze: Callable[[dict], dict] | None = None,
    ):
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
        self.vision_config = vision_config
        self.vision_analyze = vision_analyze

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
            self._recover_interrupted_innovation_runs()
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

    @staticmethod
    def _suspicious_formulas(document: Any) -> tuple[list[tuple[Any, str, int]], int]:
        formulas: list[tuple[Any, str, int]] = []
        structural_issues = 0
        for section in document.sections:
            text = section.markdown
            page = section.page_start or (section.anchors[0].page if section.anchors else 1)
            for match in re.finditer(r"\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]", text):
                formula = match.group(0)
                if "�" in formula or "□" in formula or chr(0) in formula:
                    formulas.append((section, formula, max(1, int(page))))
            if text.count("$$") % 2:
                structural_issues += 1
            if text.count("\\[") != text.count("\\]"):
                structural_issues += 1
            if text.count("\\begin{equation") != text.count("\\end{equation"):
                structural_issues += 1
        return formulas, structural_issues

    def _preprocess_visual_artifacts(
        self, paper_id: str, source_hash: str, title: str, source_pdf: Path,
        output_dir: Path, document: Any
    ) -> dict[str, Any]:
        suspicious_formulas, structural_formula_issues = self._suspicious_formulas(document)
        formula_issues = len(suspicious_formulas) + structural_formula_issues
        repaired_formulas = 0
        warnings: list[str] = []
        analyzed = 0
        failed = 0
        model_config: dict[str, Any] | None = None
        if document.figures or formula_issues:
            if not self.vision_config or not self.vision_analyze:
                warnings.append("图片解读模型不可用，插图已保留，可在模型设置完成后重试")
                failed = len(document.figures)
            else:
                try:
                    model_config = self.vision_config()
                except Exception as error:  # noqa: BLE001 - host errors become partial artifacts
                    warnings.append(str(error))
                    failed = len(document.figures)
        if model_config and self.vision_analyze and suspicious_formulas:
            formula_dir = output_dir / "formula-pages"
            formula_dir.mkdir(parents=True, exist_ok=True)
            rendered_pages: dict[int, Path] = {}
            with fitz.open(source_pdf) as pdf:
                for section, original, page_number in suspicious_formulas:
                    page_index = min(max(page_number - 1, 0), len(pdf) - 1)
                    image_path = rendered_pages.get(page_number)
                    if not image_path:
                        image_path = formula_dir / f"page-{page_number}.png"
                        pixmap = pdf[page_index].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                        pixmap.save(image_path)
                        rendered_pages[page_number] = image_path
                    prompt_version = "formula-repair-v1"
                    cache_key = hashlib.sha256(
                        f"{source_hash}:{section.id}:{original}:{model_config['modelId']}:{prompt_version}".encode()
                    ).hexdigest()
                    with self.db.connect() as connection:
                        cached = connection.execute(
                            "SELECT * FROM formula_repairs WHERE cache_key = ?", (cache_key,)
                        ).fetchone()
                    repaired = None
                    confidence = 0.0
                    if cached:
                        repaired = cached["repaired_latex"]
                        confidence = float(cached["confidence"])
                    else:
                        try:
                            response = self.vision_analyze({
                                "imagePath": str(image_path.resolve()), "figureId": f"formula:{section.id}",
                                "caption": original, "paperTitle": title, "promptVersion": prompt_version,
                                "task": "formula", "sourceText": original,
                            })
                            raw = str(response.get("description", "")).strip().removeprefix("```json").removesuffix("```").strip()
                            parsed = json.loads(raw)
                            repaired = str(parsed.get("repairedLatex", "")).strip()
                            confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0))))
                            if repaired:
                                now = utc_now()
                                with self.db.connect() as connection:
                                    connection.execute(
                                        "INSERT INTO formula_repairs(id, paper_id, section_id, block_id, page, "
                                        "source_hash, original_text, repaired_latex, confidence, model_id, prompt_version, "
                                        "cache_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                        (str(uuid.uuid4()), paper_id, section.id, section.id, page_number, source_hash,
                                         original, repaired, confidence, model_config["modelId"], prompt_version,
                                         cache_key, now, now),
                                    )
                        except Exception as error:  # noqa: BLE001
                            warnings.append(f"第 {page_number} 页公式修复失败：{error}")
                    if repaired and confidence >= 0.8:
                        section.markdown = section.markdown.replace(original, repaired, 1)
                        repaired_formulas += 1
        if model_config and self.vision_analyze:
            for figure in document.figures:
                image_path = (output_dir / figure.relative_path).resolve()
                if not image_path.is_file():
                    failed += 1
                    continue
                content_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
                prompt_version = "figure-analysis-v1"
                cache_key = hashlib.sha256(
                    f"{content_hash}:{model_config['modelId']}:{prompt_version}".encode()
                ).hexdigest()
                with self.db.connect() as connection:
                    cached = connection.execute(
                        "SELECT status FROM figure_analyses WHERE cache_key = ?", (cache_key,)
                    ).fetchone()
                if cached and cached["status"] == "completed":
                    analyzed += 1
                    continue
                started = time.perf_counter()
                now = utc_now()
                full_figure_id = f"{paper_id}:{figure.id}"
                try:
                    response = self.vision_analyze({
                        "imagePath": str(image_path),
                        "figureId": full_figure_id,
                        "caption": figure.caption or "",
                        "paperTitle": title,
                        "promptVersion": prompt_version,
                    })
                    description = str(response.get("description", "")).strip()
                    if not description:
                        raise ValueError("图片解读模型返回了空内容")
                    usage = response.get("usage") or {}
                    record = {
                        "id": str(uuid.uuid4()), "paper_id": paper_id,
                        "figure_id": full_figure_id, "source_hash": source_hash,
                        "content_hash": content_hash, "model_id": str(response.get("modelId") or model_config["modelId"]),
                        "prompt_version": prompt_version, "status": "completed",
                        "description": description,
                        "input_tokens": max(0, int(usage.get("inputTokens", 0))),
                        "output_tokens": max(0, int(usage.get("outputTokens", 0))),
                        "duration_ms": max(0, int(usage.get("durationMs", (time.perf_counter() - started) * 1000))),
                        "error": None, "cache_key": cache_key,
                        "created_at": now, "updated_at": now,
                    }
                    analyzed += 1
                except Exception as error:  # noqa: BLE001
                    record = {
                        "id": str(uuid.uuid4()), "paper_id": paper_id,
                        "figure_id": full_figure_id, "source_hash": source_hash,
                        "content_hash": content_hash, "model_id": str(model_config["modelId"]),
                        "prompt_version": prompt_version, "status": "failed", "description": "",
                        "input_tokens": 0, "output_tokens": 0,
                        "duration_ms": int((time.perf_counter() - started) * 1000),
                        "error": str(error)[:4000], "cache_key": cache_key,
                        "created_at": now, "updated_at": now,
                    }
                    failed += 1
                with self.db.connect() as connection:
                    connection.execute(
                        "INSERT INTO figure_analyses(id, paper_id, figure_id, source_hash, content_hash, "
                        "model_id, prompt_version, status, description, input_tokens, output_tokens, "
                        "duration_ms, error, cache_key, created_at, updated_at) VALUES (:id, :paper_id, "
                        ":figure_id, :source_hash, :content_hash, :model_id, :prompt_version, :status, "
                        ":description, :input_tokens, :output_tokens, :duration_ms, :error, :cache_key, "
                        ":created_at, :updated_at) ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, "
                        "description = excluded.description, input_tokens = excluded.input_tokens, "
                        "output_tokens = excluded.output_tokens, duration_ms = excluded.duration_ms, "
                        "error = excluded.error, updated_at = excluded.updated_at",
                        record,
                    )
        now = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO preprocess_quality(paper_id, source_hash, formula_issue_count, "
                "repaired_formula_count, figure_count, analyzed_figure_count, failed_figure_count, "
                "warnings_json, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?) "
                "ON CONFLICT(paper_id) DO UPDATE SET source_hash = excluded.source_hash, "
                "formula_issue_count = excluded.formula_issue_count, figure_count = excluded.figure_count, "
                "analyzed_figure_count = excluded.analyzed_figure_count, "
                "failed_figure_count = excluded.failed_figure_count, warnings_json = excluded.warnings_json, "
                "updated_at = excluded.updated_at",
                (paper_id, source_hash, formula_issues, len(document.figures), analyzed, failed,
                 json.dumps(warnings, ensure_ascii=False), now),
            )
            connection.execute(
                "UPDATE preprocess_quality SET repaired_formula_count = ? WHERE paper_id = ?",
                (repaired_formulas, paper_id),
            )
        return {"formulaIssues": formula_issues, "repairedFormulas": repaired_formulas, "analyzed": analyzed, "failed": failed, "warnings": warnings}

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
            quality = self._preprocess_visual_artifacts(
                paper_id, sha256, result.document.title, path, output_dir, result.document
            )
            if quality["warnings"]:
                result.document.warnings.extend(quality["warnings"])
                result.document.partial = True
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
                collection_ids = [
                    item["collection_id"]
                    for item in connection.execute(
                        "SELECT collection_id FROM paper_collections WHERE paper_id = ? ORDER BY assigned_at",
                        (row["id"],),
                    )
                ]
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
                        "collectionIds": collection_ids,
                    }
                )
            return papers

    @staticmethod
    def _validate_collection_name(name: Any) -> str:
        normalized = " ".join(str(name or "").split())
        if not normalized or len(normalized) > 120:
            raise ValueError("Collection name must contain 1 to 120 characters")
        if any(character in normalized for character in "\\/\0"):
            raise ValueError("Collection name cannot contain path separators")
        return normalized

    @staticmethod
    def _validate_collection_color(color: Any) -> str:
        normalized = str(color or "#4f6bed").lower()
        if len(normalized) != 7 or not normalized.startswith("#"):
            raise ValueError("Collection color must use #RRGGBB")
        try:
            int(normalized[1:], 16)
        except ValueError as error:
            raise ValueError("Collection color must use #RRGGBB") from error
        return normalized

    def list_collections(self) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT c.*, COUNT(pc.paper_id) AS paper_count "
                "FROM library_collections c "
                "LEFT JOIN paper_collections pc ON pc.collection_id = c.id "
                "GROUP BY c.id ORDER BY c.parent_id IS NOT NULL, c.sort_order, c.name COLLATE NOCASE"
            ).fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "parentId": row["parent_id"],
                "color": row["color"],
                "sortOrder": row["sort_order"],
                "paperCount": row["paper_count"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def create_collection(
        self, name: Any, parent_id: str | None = None, color: Any = "#4f6bed"
    ) -> dict[str, Any]:
        self.initialize()
        normalized_name = self._validate_collection_name(name)
        normalized_color = self._validate_collection_color(color)
        collection_id = str(uuid.uuid4())
        now = utc_now()
        with self.db.connect() as connection:
            if parent_id and not connection.execute(
                "SELECT 1 FROM library_collections WHERE id = ?", (parent_id,)
            ).fetchone():
                raise KeyError(f"Unknown parent collection: {parent_id}")
            sort_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM library_collections "
                "WHERE COALESCE(parent_id, '') = COALESCE(?, '')",
                (parent_id,),
            ).fetchone()[0]
            try:
                connection.execute(
                    "INSERT INTO library_collections(id, name, parent_id, color, sort_order, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (collection_id, normalized_name, parent_id, normalized_color, sort_order, now, now),
                )
            except Exception as error:
                if "UNIQUE" in str(error).upper():
                    raise ValueError("A collection with this name already exists here") from error
                raise
        return next(item for item in self.list_collections() if item["id"] == collection_id)

    def update_collection(self, collection_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            current = connection.execute(
                "SELECT * FROM library_collections WHERE id = ?", (collection_id,)
            ).fetchone()
            if not current:
                raise KeyError(f"Unknown collection: {collection_id}")
            name = self._validate_collection_name(patch.get("name", current["name"]))
            color = self._validate_collection_color(patch.get("color", current["color"]))
            parent_id = patch.get("parentId", current["parent_id"])
            if parent_id == collection_id:
                raise ValueError("A collection cannot be its own parent")
            if parent_id:
                parent = connection.execute(
                    "SELECT id FROM library_collections WHERE id = ?", (parent_id,)
                ).fetchone()
                if not parent:
                    raise KeyError(f"Unknown parent collection: {parent_id}")
                descendant = connection.execute(
                    "WITH RECURSIVE descendants(id) AS ("
                    "SELECT id FROM library_collections WHERE parent_id = ? "
                    "UNION ALL SELECT c.id FROM library_collections c JOIN descendants d ON c.parent_id = d.id"
                    ") SELECT 1 FROM descendants WHERE id = ?",
                    (collection_id, parent_id),
                ).fetchone()
                if descendant:
                    raise ValueError("A collection cannot be moved into its own descendant")
            sort_order = int(patch.get("sortOrder", current["sort_order"]))
            now = utc_now()
            try:
                connection.execute(
                    "UPDATE library_collections SET name = ?, parent_id = ?, color = ?, sort_order = ?, updated_at = ? "
                    "WHERE id = ?",
                    (name, parent_id, color, sort_order, now, collection_id),
                )
            except Exception as error:
                if "UNIQUE" in str(error).upper():
                    raise ValueError("A collection with this name already exists here") from error
                raise
        return next(item for item in self.list_collections() if item["id"] == collection_id)

    def delete_collection(self, collection_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM library_collections WHERE id = ?", (collection_id,)
            )
            return cursor.rowcount > 0

    def move_paper_to_collection(self, paper_id: str, collection_id: str | None) -> dict[str, Any]:
        self.initialize()
        now = utc_now()
        with self.db.connect() as connection:
            if not connection.execute("SELECT 1 FROM papers WHERE id = ?", (paper_id,)).fetchone():
                raise KeyError(f"Unknown paper: {paper_id}")
            if collection_id and not connection.execute(
                "SELECT 1 FROM library_collections WHERE id = ?", (collection_id,)
            ).fetchone():
                raise KeyError(f"Unknown collection: {collection_id}")
            connection.execute("DELETE FROM paper_collections WHERE paper_id = ?", (paper_id,))
            if collection_id:
                connection.execute(
                    "INSERT INTO paper_collections(paper_id, collection_id, assigned_at) VALUES (?, ?, ?)",
                    (paper_id, collection_id, now),
                )
        return {"paperId": paper_id, "collectionId": collection_id, "assignedAt": now}

    @staticmethod
    def _ensure_zotero_collection(
        connection: Any, collection_name: str, paper_id: str, now: str
    ) -> None:
        root = connection.execute(
            "SELECT id FROM library_collections WHERE id = 'source-zotero'"
        ).fetchone()
        if not root:
            connection.execute(
                "INSERT INTO library_collections(id, name, parent_id, color, sort_order, created_at, updated_at) "
                "VALUES ('source-zotero', 'Zotero', NULL, '#3984d8', 0, ?, ?)",
                (now, now),
            )
        child = connection.execute(
            "SELECT id FROM library_collections WHERE parent_id = 'source-zotero' AND name = ? COLLATE NOCASE",
            (collection_name,),
        ).fetchone()
        if not child:
            child_id = str(uuid.uuid4())
            sort_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM library_collections WHERE parent_id = 'source-zotero'"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO library_collections(id, name, parent_id, color, sort_order, created_at, updated_at) "
                "VALUES (?, ?, 'source-zotero', '#4f6bed', ?, ?, ?)",
                (child_id, collection_name, sort_order, now, now),
            )
        else:
            child_id = child["id"]
        connection.execute("DELETE FROM paper_collections WHERE paper_id = ?", (paper_id,))
        connection.execute(
            "INSERT INTO paper_collections(paper_id, collection_id, assigned_at) VALUES (?, ?, ?)",
            (paper_id, child_id, now),
        )

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
                source_collection = candidate["collections"][0] if candidate["collections"] else None
                if source_collection:
                    self._ensure_zotero_collection(
                        connection, source_collection, paper["id"], now
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

    def save_formatted_document(
        self,
        paper_id: str,
        sections: list[dict[str, Any]],
        model_id: str,
        prompt_version: str,
        source_sha256: str,
    ) -> dict[str, Any]:
        if not model_id.strip() or not prompt_version.strip():
            raise ValueError("Formatting model and prompt version are required")
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT canonical_sha256, markdown_path, document_path FROM papers WHERE id = ?",
                (paper_id,),
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown paper: {paper_id}")
        if row["canonical_sha256"] != source_sha256:
            raise ValueError("Paper content changed while Markdown was being formatted")
        if not row["markdown_path"] or not row["document_path"]:
            raise FileNotFoundError(f"No parsed document exists for paper {paper_id}")

        document_path = Path(row["document_path"])
        markdown_path = Path(row["markdown_path"])
        document = json.loads(document_path.read_text(encoding="utf-8"))
        current_sections = document.get("sections", [])
        supplied = {str(section.get("id", "")): str(section.get("markdown", "")).strip() for section in sections}
        expected_ids = {str(section.get("id", "")) for section in current_sections}
        if set(supplied) != expected_ids or not expected_ids:
            raise ValueError("Formatted Markdown must include every document section exactly once")
        if sum(len(markdown) for markdown in supplied.values()) > 20_000_000:
            raise ValueError("Formatted Markdown exceeds the document size limit")

        for section in current_sections:
            section_id = str(section.get("id", ""))
            formatted = supplied[section_id]
            if not formatted:
                raise ValueError(f"Formatted section is empty: {section_id}")
            for anchor in section.get("anchors", []):
                block_id = str(anchor.get("block_id", ""))
                if block_id and f'data-block-id="{block_id}"' not in formatted:
                    raise ValueError(f"Formatted section lost evidence anchor: {block_id}")
            section["markdown"] = formatted

        now = utc_now()
        document["formatting"] = {
            "model_id": model_id,
            "prompt_version": prompt_version,
            "source_sha256": source_sha256,
            "updated_at": now,
        }
        document["generated_at"] = now
        frontmatter = (
            "---\n"
            f"paper_id: {paper_id}\n"
            f"source_sha256: {source_sha256}\n"
            f"formatter: {model_id}@{prompt_version}\n"
            "---\n\n"
            f"# {document.get('title', 'Paper')}\n\n"
        )
        full_markdown = frontmatter + "\n\n".join(
            str(section["markdown"]) for section in current_sections
        )
        document_temp = document_path.with_suffix(".json.tmp")
        markdown_temp = markdown_path.with_suffix(".md.tmp")
        document_temp.write_text(
            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        markdown_temp.write_text(full_markdown, encoding="utf-8")
        document_temp.replace(document_path)
        markdown_temp.replace(markdown_path)
        with self.db.connect() as connection:
            connection.executemany(
                "UPDATE sections SET markdown = ? WHERE paper_id = ? AND id = ?",
                [(supplied[section_id], paper_id, section_id) for section_id in expected_ids],
            )
            connection.execute(
                "UPDATE papers SET updated_at = ? WHERE id = ?", (now, paper_id)
            )
        return document

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

    def list_figure_analyses(self, paper_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM figure_analyses WHERE paper_id = ? ORDER BY figure_id, updated_at DESC",
                (paper_id,),
            ).fetchall()
        latest: dict[str, Any] = {}
        for row in rows:
            latest.setdefault(row["figure_id"], row)
        return [self._figure_analysis_contract(row) for row in latest.values()]

    def preprocess_status(self, paper_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT * FROM preprocess_quality WHERE paper_id = ?", (paper_id,)
            ).fetchone()
        if not row:
            return {
                "paperId": paper_id, "sourceHash": "", "formulaIssueCount": 0,
                "repairedFormulaCount": 0, "figureCount": 0, "analyzedFigureCount": 0,
                "failedFigureCount": 0, "warnings": [], "updatedAt": None,
            }
        return {
            "paperId": row["paper_id"], "sourceHash": row["source_hash"],
            "formulaIssueCount": row["formula_issue_count"],
            "repairedFormulaCount": row["repaired_formula_count"],
            "figureCount": row["figure_count"], "analyzedFigureCount": row["analyzed_figure_count"],
            "failedFigureCount": row["failed_figure_count"],
            "warnings": json.loads(row["warnings_json"] or "[]"), "updatedAt": row["updated_at"],
        }

    def retry_figure_analysis(self, paper_id: str, figure_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT p.title, p.canonical_sha256, p.document_path, pf.absolute_path AS source_path "
                "FROM papers p JOIN paper_files pf ON pf.paper_id = p.id AND pf.is_missing = 0 "
                "WHERE p.id = ? ORDER BY pf.updated_at DESC LIMIT 1", (paper_id,)
            ).fetchone()
        if not paper or not paper["document_path"]:
            raise KeyError(f"Unknown parsed paper: {paper_id}")
        document = PaperDocument.model_validate_json(
            Path(paper["document_path"]).read_text(encoding="utf-8")
        )
        if not any(f"{paper_id}:{figure.id}" == figure_id for figure in document.figures):
            raise KeyError(f"Unknown figure: {figure_id}")
        self._preprocess_visual_artifacts(
            paper_id, paper["canonical_sha256"], paper["title"], Path(paper["source_path"]),
            Path(paper["document_path"]).parent, document,
        )
        return self.list_figure_analyses(paper_id)

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
                "source_start": max(0, int(payload.get("sourceStart", 0))),
                "source_end": int(payload.get("sourceEnd", -1)),
                "segments_json": json.dumps(payload.get("segments", []), ensure_ascii=False),
                "terms_json": json.dumps(payload.get("terms", []), ensure_ascii=False),
                "target_language": str(payload["targetLanguage"]),
                "model_id": str(payload["modelId"]),
                "prompt_version": str(payload["promptVersion"]),
                "revision": revision,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO translations(id, paper_id, section_id, block_id, source_hash, "
                "source_text, translated_text, source_start, source_end, segments_json, terms_json, "
                "target_language, model_id, prompt_version, revision, created_at, updated_at) "
                "VALUES (:id, :paper_id, :section_id, :block_id, :source_hash, :source_text, "
                ":translated_text, :source_start, :source_end, :segments_json, :terms_json, "
                ":target_language, :model_id, :prompt_version, :revision, :created_at, :updated_at)",
                record,
            )
        return self._translation_contract(record)

    def list_reader_annotations(self, paper_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM reader_annotations WHERE paper_id = ? ORDER BY created_at, id",
                (paper_id,),
            ).fetchall()
        return [self._reader_annotation_contract(row) for row in rows]

    def save_reader_annotation(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        paper_id = str(payload.get("paperId", "")).strip()
        section_id = str(payload.get("sectionId", "")).strip()
        block_id = str(payload.get("blockId", "")).strip()
        annotation_type = str(payload.get("annotationType", "")).strip()
        source_start = max(0, int(payload.get("sourceStart", 0)))
        source_end = int(payload.get("sourceEnd", -1))
        if not paper_id or not section_id or not block_id or annotation_type not in {"translation", "chat"}:
            raise ValueError("paperId, sectionId, blockId and a valid annotationType are required")
        if source_end < source_start:
            raise ValueError("Reader annotation range is invalid")
        now = utc_now()
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT canonical_sha256 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
            if not paper:
                raise KeyError(f"Unknown paper: {paper_id}")
            record = {
                "id": str(payload.get("id") or uuid.uuid4()),
                "paper_id": paper_id,
                "section_id": section_id,
                "block_id": block_id,
                "source_hash": paper["canonical_sha256"],
                "source_start": source_start,
                "source_end": source_end,
                "annotation_type": annotation_type,
                "related_id": str(payload.get("relatedId", "")).strip() or None,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO reader_annotations(id, paper_id, section_id, block_id, source_hash, "
                "source_start, source_end, annotation_type, related_id, created_at, updated_at) "
                "VALUES (:id, :paper_id, :section_id, :block_id, :source_hash, :source_start, "
                ":source_end, :annotation_type, :related_id, :created_at, :updated_at) "
                "ON CONFLICT(paper_id, block_id, source_start, source_end, annotation_type, related_id) "
                "DO UPDATE SET updated_at = excluded.updated_at",
                record,
            )
            row = connection.execute(
                "SELECT * FROM reader_annotations WHERE paper_id = ? AND block_id = ? "
                "AND source_start = ? AND source_end = ? AND annotation_type = ? "
                "AND related_id IS ?",
                (paper_id, block_id, source_start, source_end, annotation_type, record["related_id"]),
            ).fetchone()
        return self._reader_annotation_contract(row)

    def delete_reader_annotation(self, annotation_id: str, paper_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM reader_annotations WHERE id = ? AND paper_id = ?",
                (annotation_id, paper_id),
            )
        return bool(cursor.rowcount)

    def list_reader_analyses(self, paper_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT ra.* FROM reader_analyses ra JOIN (SELECT block_id, analysis_type, "
                "MAX(revision) revision FROM reader_analyses WHERE paper_id = ? "
                "GROUP BY block_id, analysis_type) latest ON latest.block_id = ra.block_id "
                "AND latest.analysis_type = ra.analysis_type AND latest.revision = ra.revision "
                "WHERE ra.paper_id = ? ORDER BY ra.updated_at",
                (paper_id, paper_id),
            ).fetchall()
        return [self._reader_analysis_contract(row) for row in rows]

    def save_reader_analysis(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        required = (
            "paperId",
            "sectionId",
            "blockId",
            "analysisType",
            "sourceText",
            "resultText",
            "modelId",
            "promptVersion",
        )
        missing = [key for key in required if not str(payload.get(key, "")).strip()]
        if missing:
            raise ValueError("Missing reader analysis fields: " + ", ".join(missing))
        analysis_type = str(payload["analysisType"])
        if analysis_type not in {"formula", "theorem"}:
            raise ValueError("Reader analysis type must be formula or theorem")
        paper_id = str(payload["paperId"])
        result_text = str(payload["resultText"])
        if len(result_text) > 1_000_000:
            raise ValueError("Reader analysis result exceeds 1 million characters")
        now = utc_now()
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT canonical_sha256 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
            if not paper:
                raise KeyError(f"Unknown paper: {paper_id}")
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM reader_analyses "
                "WHERE paper_id = ? AND block_id = ? AND analysis_type = ?",
                (paper_id, payload["blockId"], analysis_type),
            ).fetchone()[0]
            record = {
                "id": str(uuid.uuid4()),
                "paper_id": paper_id,
                "section_id": str(payload["sectionId"]),
                "block_id": str(payload["blockId"]),
                "analysis_type": analysis_type,
                "source_hash": paper["canonical_sha256"],
                "source_text": str(payload["sourceText"]),
                "adjacent_context": str(payload.get("adjacentContext", "")),
                "result_text": result_text,
                "model_id": str(payload["modelId"]),
                "prompt_version": str(payload["promptVersion"]),
                "revision": revision,
                "input_tokens": max(0, int(payload.get("inputTokens", 0))),
                "output_tokens": max(0, int(payload.get("outputTokens", 0))),
                "duration_ms": max(0, int(payload.get("durationMs", 0))),
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO reader_analyses(id, paper_id, section_id, block_id, analysis_type, "
                "source_hash, source_text, adjacent_context, result_text, model_id, prompt_version, "
                "revision, input_tokens, output_tokens, duration_ms, created_at, updated_at) "
                "VALUES (:id, :paper_id, :section_id, :block_id, :analysis_type, :source_hash, "
                ":source_text, :adjacent_context, :result_text, :model_id, :prompt_version, "
                ":revision, :input_tokens, :output_tokens, :duration_ms, :created_at, :updated_at)",
                record,
            )
        return self._reader_analysis_contract(record)

    def get_reader_conversation(self, paper_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            paper = connection.execute(
                "SELECT id FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
            if not paper:
                raise KeyError(f"Unknown paper: {paper_id}")
            conversation = connection.execute(
                "SELECT * FROM reader_conversations WHERE paper_id = ?", (paper_id,)
            ).fetchone()
            if not conversation:
                return {"id": "", "paperId": paper_id, "turns": []}
            turns = connection.execute(
                "SELECT * FROM reader_chat_turns WHERE conversation_id = ? ORDER BY turn_index",
                (conversation["id"],),
            ).fetchall()
            contracts = []
            for turn in turns:
                response = connection.execute(
                    "SELECT * FROM reader_chat_responses WHERE turn_id = ? "
                    "ORDER BY revision DESC LIMIT 1",
                    (turn["id"],),
                ).fetchone()
                contracts.append(self._reader_chat_turn_contract(turn, response))
        return {
            "id": conversation["id"],
            "paperId": paper_id,
            "turns": contracts,
            "createdAt": conversation["created_at"],
            "updatedAt": conversation["updated_at"],
        }

    def save_reader_chat_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        required = (
            "paperId",
            "userMessage",
            "modelId",
            "promptVersion",
            "status",
        )
        missing = [key for key in required if not str(payload.get(key, "")).strip()]
        if missing:
            raise ValueError("Missing reader chat fields: " + ", ".join(missing))
        status = str(payload["status"])
        if status not in {"completed", "cancelled", "failed"}:
            raise ValueError("Invalid reader chat response status")
        assistant_text = str(payload.get("assistantText", ""))
        if status == "completed" and not assistant_text.strip():
            raise ValueError("Completed reader chat responses require assistantText")
        user_message = str(payload["userMessage"]).strip()
        if len(user_message) > 100000 or len(assistant_text) > 1_000_000:
            raise ValueError("Reader chat turn exceeds its size limit")
        snapshot = payload.get("contextSnapshot") or {}
        if not isinstance(snapshot, dict):
            raise ValueError("Reader chat context snapshot must be an object")
        snapshot_json = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        if len(snapshot_json.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("Reader chat context snapshot exceeds 2 MB")
        paper_id = str(payload["paperId"])
        now = utc_now()
        with self.db.connect() as connection:
            if not connection.execute(
                "SELECT 1 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone():
                raise KeyError(f"Unknown paper: {paper_id}")
            conversation = connection.execute(
                "SELECT * FROM reader_conversations WHERE paper_id = ?", (paper_id,)
            ).fetchone()
            if not conversation:
                conversation_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO reader_conversations(id, paper_id, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    (conversation_id, paper_id, now, now),
                )
            else:
                conversation_id = conversation["id"]
            turn_id = str(payload.get("turnId", "")).strip()
            turn = None
            if turn_id:
                turn = connection.execute(
                    "SELECT t.* FROM reader_chat_turns t JOIN reader_conversations c "
                    "ON c.id = t.conversation_id WHERE t.id = ? AND c.paper_id = ?",
                    (turn_id, paper_id),
                ).fetchone()
                if not turn:
                    raise KeyError(f"Unknown reader chat turn: {turn_id}")
            else:
                turn_id = str(uuid.uuid4())
                turn_index = connection.execute(
                    "SELECT COALESCE(MAX(turn_index), 0) + 1 FROM reader_chat_turns "
                    "WHERE conversation_id = ?",
                    (conversation_id,),
                ).fetchone()[0]
                connection.execute(
                    "INSERT INTO reader_chat_turns(id, conversation_id, turn_index, user_message, "
                    "context_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (turn_id, conversation_id, turn_index, user_message, snapshot_json, now),
                )
                turn = connection.execute(
                    "SELECT * FROM reader_chat_turns WHERE id = ?", (turn_id,)
                ).fetchone()
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM reader_chat_responses "
                "WHERE turn_id = ?",
                (turn_id,),
            ).fetchone()[0]
            response = {
                "id": str(uuid.uuid4()),
                "turn_id": turn_id,
                "assistant_text": assistant_text,
                "model_id": str(payload["modelId"]),
                "prompt_version": str(payload["promptVersion"]),
                "revision": revision,
                "status": status,
                "input_tokens": max(0, int(payload.get("inputTokens", 0))),
                "output_tokens": max(0, int(payload.get("outputTokens", 0))),
                "duration_ms": max(0, int(payload.get("durationMs", 0))),
                "error": str(payload.get("error", ""))[:4000] or None,
                "created_at": now,
                "updated_at": now,
            }
            connection.execute(
                "INSERT INTO reader_chat_responses(id, turn_id, assistant_text, model_id, "
                "prompt_version, revision, status, input_tokens, output_tokens, duration_ms, "
                "error, created_at, updated_at) VALUES (:id, :turn_id, :assistant_text, "
                ":model_id, :prompt_version, :revision, :status, :input_tokens, :output_tokens, "
                ":duration_ms, :error, :created_at, :updated_at)",
                response,
            )
            connection.execute(
                "UPDATE reader_conversations SET updated_at = ? WHERE id = ?",
                (now, conversation_id),
            )
        return self._reader_chat_turn_contract(turn, response)

    def clear_reader_conversation(self, paper_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM reader_conversations WHERE paper_id = ?", (paper_id,)
            )
        return bool(cursor.rowcount)

    @staticmethod
    def _estimate_context_tokens(text: str) -> int:
        return max(1, (len(text.encode("utf-8")) + 3) // 4)

    def _ensure_context_scope(
        self, connection: sqlite3.Connection, scope_id: str, paper_id: str | None = None
    ) -> Any:
        scope = connection.execute(
            "SELECT * FROM context_scopes WHERE id = ?", (scope_id,)
        ).fetchone()
        if scope:
            return scope
        now = utc_now()
        if scope_id == "research:default":
            connection.execute(
                "INSERT INTO context_scopes(id, scope_type, paper_id, name, created_at, updated_at) "
                "VALUES (?, 'research', NULL, ?, ?, ?)",
                (scope_id, "多论文研究上下文", now, now),
            )
        elif scope_id.startswith("paper:"):
            resolved_paper_id = paper_id or scope_id.removeprefix("paper:")
            paper = connection.execute(
                "SELECT title FROM papers WHERE id = ?", (resolved_paper_id,)
            ).fetchone()
            if not paper:
                raise KeyError(f"Unknown paper: {resolved_paper_id}")
            connection.execute(
                "INSERT INTO context_scopes(id, scope_type, paper_id, name, created_at, updated_at) "
                "VALUES (?, 'paper', ?, ?, ?, ?)",
                (scope_id, resolved_paper_id, f"{paper['title']} · 阅读上下文", now, now),
            )
        else:
            raise ValueError("Context scope must be research:default or paper:<paperId>")
        return connection.execute(
            "SELECT * FROM context_scopes WHERE id = ?", (scope_id,)
        ).fetchone()

    @staticmethod
    def _context_scope_contract(scope: Any) -> dict[str, Any]:
        return {
            "id": scope["id"],
            "scopeType": scope["scope_type"],
            "paperId": scope["paper_id"] or None,
            "name": scope["name"],
        }

    def get_context_draft(self, scope_id: str = "research:default") -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            scope = self._ensure_context_scope(connection, scope_id)
            rows = connection.execute(
                "SELECT ci.*, p.title AS paper_title, csi.item_type, csi.title AS item_title, "
                "csi.custom_text, csi.created_at AS scope_created_at, "
                "csi.updated_at AS scope_updated_at FROM context_scope_items csi "
                "JOIN context_items ci ON ci.id = csi.context_item_id "
                "JOIN papers p ON p.id = ci.paper_id WHERE csi.scope_id = ? "
                "ORDER BY csi.sort_order, csi.created_at, ci.id",
                (scope_id,),
            ).fetchall()
            compression_rows = connection.execute(
                "SELECT cc.* FROM context_compressions cc "
                "JOIN context_items ci ON ci.active_compression_id = cc.id "
                "JOIN context_scope_items csi ON csi.context_item_id = ci.id "
                "WHERE csi.scope_id = ?",
                (scope_id,),
            ).fetchall()
        compressions = {
            row["context_item_id"]: self._context_compression_summary(row)
            for row in compression_rows
        }
        items = []
        for row in rows:
            source_text = row["custom_text"] if row["item_type"] == "custom" else row["source_text"]
            estimated_tokens = self._estimate_context_tokens(source_text or "")
            item = {
                "id": row["id"],
                "scopeId": scope_id,
                "itemType": row["item_type"],
                "title": row["item_title"] or ("论文 Markdown 原文" if not row["section_id"] else "自定义上下文"),
                "paperId": row["paper_id"],
                "paperTitle": row["paper_title"],
                "sectionId": row["section_id"] or None,
                "blockId": row["block_id"] or None,
                "mode": row["mode"],
                "sourceHash": row["source_hash"],
                "sourcePreview": (source_text or "")[:240],
                "estimatedTokens": estimated_tokens,
                "createdAt": row["scope_created_at"],
                "updatedAt": row["scope_updated_at"],
            }
            compression = compressions.get(row["id"])
            if compression and row["mode"] == "compressed":
                item["compression"] = compression
                item["estimatedTokens"] = compression["estimatedTokens"]
            items.append(item)
        paper_tokens = sum(item["estimatedTokens"] for item in items)
        return {
            "scope": self._context_scope_contract(scope),
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

    def read_context_item(
        self, item_id: str, scope_id: str = "research:default"
    ) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT ci.*, p.title AS paper_title, csi.item_type, csi.title AS item_title, "
                "csi.custom_text, csi.created_at AS scope_created_at, "
                "csi.updated_at AS scope_updated_at FROM context_scope_items csi "
                "JOIN context_items ci ON ci.id = csi.context_item_id "
                "JOIN papers p ON p.id = ci.paper_id WHERE ci.id = ? AND csi.scope_id = ?",
                (item_id, scope_id),
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown context item: {item_id}")
        source_text = row["custom_text"] if row["item_type"] == "custom" else row["source_text"]
        return {
            "id": row["id"],
            "scopeId": scope_id,
            "itemType": row["item_type"],
            "title": row["item_title"],
            "paperId": row["paper_id"],
            "paperTitle": row["paper_title"],
            "sectionId": row["section_id"] or None,
            "blockId": row["block_id"] or None,
            "sourceHash": row["source_hash"],
            "sourceText": source_text,
            "customText": source_text if row["item_type"] == "custom" else None,
            "estimatedTokens": self._estimate_context_tokens(source_text),
            "createdAt": row["scope_created_at"],
            "updatedAt": row["scope_updated_at"],
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
        self, item_id: str, model_id: str, prompt_version: str,
        scope_id: str = "research:default",
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
            connection.execute(
                "UPDATE context_scope_items SET item_type = 'compressed_markdown', updated_at = ? "
                "WHERE scope_id = ? AND context_item_id = ?",
                (utc_now(), scope_id, item_id),
            )
        return self.get_context_draft(scope_id)

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

    def add_paper_to_context(
        self, paper_id: str, mode: str = "full", scope_id: str = "research:default"
    ) -> dict[str, Any]:
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
            scope_id=scope_id,
            item_type="markdown",
            title="论文 Markdown 原文",
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
            scope_id=str(payload.get("scopeId") or "research:default"),
            item_type="custom" if block_id.startswith(("ai-", "chat:", "selection:")) else "markdown",
            title=str(payload.get("title") or "自定义上下文"),
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
        scope_id: str = "research:default",
        item_type: str = "markdown",
        title: str = "",
    ) -> dict[str, Any]:
        if not source_text:
            raise ValueError("Context source text is empty")
        now = utc_now()
        item_id = str(uuid.uuid4())
        estimated_tokens = self._estimate_context_tokens(source_text)
        with self.db.connect() as connection:
            self._ensure_context_scope(connection, scope_id, paper_id)
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
            connection.execute(
                "INSERT INTO context_scope_items(scope_id, context_item_id, item_type, title, "
                "custom_text, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, "
                "COALESCE((SELECT MAX(sort_order) + 1 FROM context_scope_items WHERE scope_id = ?), 0), ?, ?) "
                "ON CONFLICT(scope_id, context_item_id) DO UPDATE SET item_type = excluded.item_type, "
                "title = excluded.title, custom_text = excluded.custom_text, updated_at = excluded.updated_at",
                (scope_id, item_id, item_type, title, source_text if item_type == "custom" else None,
                 scope_id, created_at, now),
            )
        return self.get_context_draft(scope_id)

    def upsert_scoped_context_item(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        scope_id = str(payload.get("scopeId") or "research:default")
        item_id = str(payload.get("itemId", "")).strip()
        title = str(payload.get("title", "")).strip() or "自定义上下文"
        text = str(payload.get("text", "")).strip()
        if item_id:
            if not text:
                raise ValueError("Custom context text is empty")
            with self.db.connect() as connection:
                row = connection.execute(
                    "SELECT 1 FROM context_scope_items WHERE scope_id = ? AND context_item_id = ? "
                    "AND item_type = 'custom'", (scope_id, item_id),
                ).fetchone()
                if not row:
                    raise KeyError(f"Unknown editable context item: {item_id}")
                connection.execute(
                    "UPDATE context_scope_items SET title = ?, custom_text = ?, updated_at = ? "
                    "WHERE scope_id = ? AND context_item_id = ?",
                    (title, text, utc_now(), scope_id, item_id),
                )
            return self.get_context_draft(scope_id)
        paper_id = str(payload.get("paperId", "")).strip()
        if not paper_id or not text:
            raise ValueError("paperId and text are required for custom context")
        return self._upsert_context_item(
            paper_id=paper_id,
            section_id="custom",
            block_id=f"custom:{uuid.uuid4()}",
            source_text=text,
            mode="sections",
            source_hash=self._paper_source_hash(paper_id),
            scope_id=scope_id,
            item_type="custom",
            title=title,
        )

    def _paper_source_hash(self, paper_id: str) -> str:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT canonical_sha256 FROM papers WHERE id = ?", (paper_id,)
            ).fetchone()
        if not row:
            raise KeyError(f"Unknown paper: {paper_id}")
        return str(row["canonical_sha256"])

    def delete_scoped_context_item(self, scope_id: str, item_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            connection.execute(
                "DELETE FROM context_scope_items WHERE scope_id = ? AND context_item_id = ?",
                (scope_id, item_id),
            )
        return self.get_context_draft(scope_id)

    def reset_context_scope(self, scope_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            scope = self._ensure_context_scope(connection, scope_id)
            connection.execute("DELETE FROM context_scope_items WHERE scope_id = ?", (scope_id,))
        if scope["scope_type"] == "paper":
            return self.add_paper_to_context(scope["paper_id"], "full", scope_id)
        return self.get_context_draft(scope_id)

    def remove_paper_from_context(
        self, paper_id: str, scope_id: str = "research:default"
    ) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            connection.execute(
                "DELETE FROM context_scope_items WHERE scope_id = ? AND context_item_id IN "
                "(SELECT id FROM context_items WHERE paper_id = ?)", (scope_id, paper_id),
            )
        return self.get_context_draft(scope_id)

    def clear_context(self, scope_id: str = "research:default") -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            connection.execute("DELETE FROM context_scope_items WHERE scope_id = ?", (scope_id,))
        return self.get_context_draft(scope_id)

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
            connection.execute(
                "INSERT OR IGNORE INTO agent_prompts(id, agent_profile_id, name, content, "
                "sort_order, created_at, updated_at) "
                "SELECT 'prompt:' || id || ':default', id, '默认分析任务', "
                "'请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。', "
                "0, created_at, updated_at FROM agent_profiles"
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
            if not existing:
                connection.execute(
                    "INSERT OR IGNORE INTO agent_prompts(id, agent_profile_id, name, content, "
                    "sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
                    (
                        f"prompt:{profile_id}:default",
                        profile_id,
                        "默认分析任务",
                        "请分析当前研究上下文，提炼最重要且有证据支持的结论，并指出证据不足之处。",
                        record["created_at"],
                        record["updated_at"],
                    ),
                )
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
    def _agent_prompt_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "agentProfileId": record["agent_profile_id"],
            "name": record["name"],
            "content": record["content"],
            "sortOrder": record["sort_order"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    def list_agent_prompts(self, profile_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            if not connection.execute(
                "SELECT 1 FROM agent_profiles WHERE id = ?", (profile_id,)
            ).fetchone():
                raise ValueError("Unknown agent profile")
            rows = connection.execute(
                "SELECT * FROM agent_prompts WHERE agent_profile_id = ? "
                "ORDER BY sort_order, updated_at DESC, id",
                (profile_id,),
            ).fetchall()
        return [self._agent_prompt_contract(row) for row in rows]

    def upsert_agent_prompt(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        prompt_id = str(payload.get("id") or uuid.uuid4()).strip()
        profile_id = str(payload.get("agentProfileId", "")).strip()
        name = str(payload.get("name", "")).strip()
        content = str(payload.get("content", "")).strip()
        if not all((prompt_id, profile_id, name, content)):
            raise ValueError("Prompt id, agent profile, name, and content are required")
        if len(prompt_id) > 160 or len(name) > 160 or len(content) > 50000:
            raise ValueError("Agent prompt fields exceed their size limit")
        sort_order = int(payload.get("sortOrder", 0))
        if not -10000 <= sort_order <= 10000:
            raise ValueError("Agent prompt sort order is invalid")
        now = utc_now()
        with self.db.connect() as connection:
            if not connection.execute(
                "SELECT 1 FROM agent_profiles WHERE id = ?", (profile_id,)
            ).fetchone():
                raise ValueError("Unknown agent profile")
            existing = connection.execute(
                "SELECT created_at, agent_profile_id FROM agent_prompts WHERE id = ?",
                (prompt_id,),
            ).fetchone()
            if existing and existing["agent_profile_id"] != profile_id:
                raise ValueError("Agent prompt cannot be moved to another profile")
            duplicate = connection.execute(
                "SELECT id FROM agent_prompts WHERE agent_profile_id = ? "
                "AND name = ? COLLATE NOCASE AND id <> ?",
                (profile_id, name, prompt_id),
            ).fetchone()
            if duplicate:
                raise ValueError("An agent prompt with this name already exists")
            created_at = existing["created_at"] if existing else now
            connection.execute(
                "INSERT INTO agent_prompts(id, agent_profile_id, name, content, sort_order, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content, "
                "sort_order = excluded.sort_order, updated_at = excluded.updated_at",
                (prompt_id, profile_id, name, content, sort_order, created_at, now),
            )
            row = connection.execute(
                "SELECT * FROM agent_prompts WHERE id = ?", (prompt_id,)
            ).fetchone()
        return self._agent_prompt_contract(row)

    def delete_agent_prompt(self, prompt_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            cursor = connection.execute("DELETE FROM agent_prompts WHERE id = ?", (prompt_id,))
        return bool(cursor.rowcount)

    @staticmethod
    def _prompt_template_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "category": record["category"],
            "name": record["name"],
            "content": record["content"],
            "sortOrder": record["sort_order"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    def list_prompt_templates(self, category: str | None = None) -> list[dict[str, Any]]:
        self.initialize()
        if category is not None and category not in {
            "reader", "translation", "explanation", "markdown", "innovation"
        }:
            raise ValueError("Unknown prompt template category")
        with self.db.connect() as connection:
            if category:
                rows = connection.execute(
                    "SELECT * FROM prompt_templates WHERE category = ? "
                    "ORDER BY sort_order, updated_at DESC, id",
                    (category,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM prompt_templates "
                    "ORDER BY category, sort_order, updated_at DESC, id"
                ).fetchall()
        return [self._prompt_template_contract(row) for row in rows]

    def upsert_prompt_template(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        template_id = str(payload.get("id") or uuid.uuid4()).strip()
        category = str(payload.get("category", "")).strip()
        name = str(payload.get("name", "")).strip()
        content = str(payload.get("content", "")).strip()
        if category not in {"reader", "translation", "explanation", "markdown", "innovation"}:
            raise ValueError("Unknown prompt template category")
        if not all((template_id, name, content)):
            raise ValueError("Prompt template id, name, and content are required")
        if len(template_id) > 160 or len(name) > 160 or len(content) > 50000:
            raise ValueError("Prompt template fields exceed their size limit")
        sort_order = int(payload.get("sortOrder", 0))
        if not -10000 <= sort_order <= 10000:
            raise ValueError("Prompt template sort order is invalid")
        now = utc_now()
        with self.db.connect() as connection:
            existing = connection.execute(
                "SELECT created_at FROM prompt_templates WHERE id = ?", (template_id,)
            ).fetchone()
            duplicate = connection.execute(
                "SELECT id FROM prompt_templates WHERE category = ? "
                "AND name = ? COLLATE NOCASE AND id <> ?",
                (category, name, template_id),
            ).fetchone()
            if duplicate:
                raise ValueError("A prompt template with this name already exists in the category")
            created_at = existing["created_at"] if existing else now
            connection.execute(
                "INSERT INTO prompt_templates(id, category, name, content, sort_order, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                "category = excluded.category, name = excluded.name, content = excluded.content, "
                "sort_order = excluded.sort_order, updated_at = excluded.updated_at",
                (template_id, category, name, content, sort_order, created_at, now),
            )
            row = connection.execute(
                "SELECT * FROM prompt_templates WHERE id = ?", (template_id,)
            ).fetchone()
        return self._prompt_template_contract(row)

    def delete_prompt_template(self, template_id: str) -> bool:
        self.initialize()
        with self.db.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM prompt_templates WHERE id = ?", (template_id,)
            )
        return bool(cursor.rowcount)

    def _agent_run_contract(self, record: Any) -> dict[str, Any]:
        with self.db.connect() as connection:
            tool_rows = connection.execute(
                "SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY iteration, position",
                (record["id"],),
            ).fetchall()
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
            "toolCalls": [self._agent_tool_call_contract(row) for row in tool_rows],
        }

    @staticmethod
    def _agent_tool_call_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "runId": record["run_id"],
            "toolCallId": record["tool_call_id"],
            "iteration": record["iteration"],
            "position": record["position"],
            "toolName": record["tool_name"],
            "arguments": json.loads(record["arguments_json"]),
            "status": record["status"],
            "result": json.loads(record["result_json"]) if record["result_json"] else None,
            "error": record["error"],
            "startedAt": record["started_at"],
            "finishedAt": record["finished_at"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    def list_agent_tools(self, profile_id: str) -> list[dict[str, Any]]:
        self.initialize()
        with self.db.connect() as connection:
            profile = connection.execute(
                "SELECT allowed_tools_json FROM agent_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        if not profile:
            raise KeyError(f"Unknown agent profile: {profile_id}")
        allowed = json.loads(profile["allowed_tools_json"])
        return [AGENT_TOOL_DEFINITIONS[name] for name in allowed if name in AGENT_TOOL_DEFINITIONS]

    @staticmethod
    def _require_tool_string(arguments: dict[str, Any], name: str) -> str:
        value = str(arguments.get(name, "")).strip()
        if not value or len(value) > 1000:
            raise ValueError(f"Tool argument {name} is required and must be at most 1000 characters")
        return value

    def _run_agent_tool(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        if tool_name == "search_library":
            query = self._require_tool_string(arguments, "query").casefold()
            limit = max(1, min(int(arguments.get("limit", 10)), 20))
            matches = [paper for paper in self.list_papers() if query in paper["title"].casefold()]
            return [{"paperId": paper["id"], "title": paper["title"], "status": paper["status"], "pageCount": paper["pageCount"]} for paper in matches[:limit]]
        if tool_name == "read_paper":
            paper_id = self._require_tool_string(arguments, "paperId")
            maximum = max(1000, min(int(arguments.get("maxCharacters", 60000)), 100000))
            markdown = self.read_markdown(paper_id)
            return {"paperId": paper_id, "markdown": markdown[:maximum], "truncated": len(markdown) > maximum}
        if tool_name == "read_section":
            paper_id = self._require_tool_string(arguments, "paperId")
            section_id = self._require_tool_string(arguments, "sectionId")
            document = self.read_document(paper_id)
            section = next((item for item in document.get("sections", []) if str(item.get("id")) == section_id or str(item.get("title", "")).casefold() == section_id.casefold()), None)
            if not section:
                raise KeyError(f"Unknown section {section_id} in paper {paper_id}")
            return {"paperId": paper_id, "sectionId": section.get("id"), "title": section.get("title"), "pageStart": section.get("page_start"), "pageEnd": section.get("page_end"), "markdown": str(section.get("markdown", ""))[:80000], "anchors": section.get("anchors", [])[:100]}
        if tool_name == "read_figure":
            paper_id = self._require_tool_string(arguments, "paperId")
            figure_id = str(arguments.get("figureId", "")).strip()
            paper = next((item for item in self.list_papers() if item["id"] == paper_id), None)
            if not paper:
                raise KeyError(f"Unknown paper: {paper_id}")
            figures = paper["figures"]
            if figure_id:
                figures = [figure for figure in figures if figure["id"] == figure_id]
                if not figures:
                    raise KeyError(f"Unknown figure {figure_id} in paper {paper_id}")
            return {"paperId": paper_id, "figures": [{key: value for key, value in figure.items() if key not in {"relativePath", "thumbnailPath"}} for figure in figures[:50]]}
        if tool_name == "find_evidence":
            query = self._require_tool_string(arguments, "query")
            terms = [term.casefold() for term in query.split() if len(term) > 1][:8]
            if not terms:
                raise ValueError("Evidence query must contain searchable terms")
            requested_paper = str(arguments.get("paperId", "")).strip()
            limit = max(1, min(int(arguments.get("limit", 10)), 20))
            results = []
            for paper in self.list_papers():
                if requested_paper and paper["id"] != requested_paper:
                    continue
                try:
                    sections = self.read_document(paper["id"]).get("sections", [])
                except (FileNotFoundError, json.JSONDecodeError):
                    continue
                for section in sections:
                    text = str(section.get("markdown", ""))
                    folded = text.casefold()
                    positions = [folded.find(term) for term in terms]
                    positions = [position for position in positions if position >= 0]
                    if not positions:
                        continue
                    position = min(positions)
                    start = max(0, position - 180)
                    end = min(len(text), position + 420)
                    results.append({"paperId": paper["id"], "paperTitle": paper["title"], "sectionId": section.get("id"), "sectionTitle": section.get("title"), "page": section.get("page_start"), "snippet": text[start:end].strip()})
                    if len(results) >= limit:
                        return results
            return results
        if tool_name == "get_references":
            paper_id = self._require_tool_string(arguments, "paperId")
            limit = max(1, min(int(arguments.get("limit", 100)), 200))
            return {"paperId": paper_id, "references": self.read_references(paper_id)[:limit]}
        raise ValueError(f"Tool {tool_name} is not available in the read-only registry")

    def execute_agent_tool(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        run_id = str(payload.get("runId", "")).strip()
        tool_call_id = str(payload.get("toolCallId", "")).strip()
        tool_name = str(payload.get("toolName", "")).strip()
        arguments = payload.get("arguments") or {}
        iteration = int(payload.get("iteration", 1))
        if not run_id or not tool_call_id or not tool_name or not isinstance(arguments, dict):
            raise ValueError("Agent tool run, call ID, name, and object arguments are required")
        if len(tool_call_id) > 200 or len(tool_name) > 120 or not 1 <= iteration <= 6:
            raise ValueError("Agent tool call metadata is invalid")
        arguments_json = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
        if len(arguments_json.encode("utf-8")) > 128 * 1024:
            raise ValueError("Agent tool arguments exceed 128 KB")
        now = utc_now()
        with self.db.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM agent_tool_calls WHERE run_id = ? AND tool_call_id = ?",
                (run_id, tool_call_id),
            ).fetchone()
            if existing:
                return self._agent_tool_call_contract(existing)
            run = connection.execute(
                "SELECT ar.status, ar.context_snapshot_json, ap.allowed_tools_json FROM agent_runs ar JOIN agent_profiles ap ON ap.id = ar.agent_profile_id WHERE ar.id = ?",
                (run_id,),
            ).fetchone()
            if not run:
                raise KeyError(f"Unknown agent run: {run_id}")
            if run["status"] != "running":
                raise ValueError("Agent tools can only execute for an active run")
            allowed_tools = set(json.loads(run["allowed_tools_json"]))
            snapshot = json.loads(run["context_snapshot_json"])
            snapshot_tools = set((snapshot.get("toolVersions") or {}).keys())
            if snapshot_tools:
                allowed_tools &= snapshot_tools
            if tool_name not in allowed_tools or tool_name not in AGENT_TOOL_DEFINITIONS:
                status = "denied"
                error = f"Tool {tool_name} is not allowed for this agent"
            else:
                status = "running"
                error = None
            position = connection.execute(
                "SELECT COUNT(*) + 1 FROM agent_tool_calls WHERE run_id = ? AND iteration = ?",
                (run_id, iteration),
            ).fetchone()[0]
            if position > 8:
                raise ValueError("Agent tool call limit exceeded for this iteration")
            record_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO agent_tool_calls(id, run_id, tool_call_id, iteration, position, tool_name, arguments_json, status, error, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record_id, run_id, tool_call_id, iteration, position, tool_name, arguments_json, status, error, now, now if status == "denied" else None, now, now),
            )
        if status == "denied":
            with self.db.connect() as connection:
                return self._agent_tool_call_contract(connection.execute("SELECT * FROM agent_tool_calls WHERE id = ?", (record_id,)).fetchone())
        try:
            result = self._run_agent_tool(tool_name, arguments)
            result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
            if len(result_json.encode("utf-8")) > 512 * 1024:
                raise ValueError("Agent tool result exceeds 512 KB")
            final_status = "completed"
            error = None
        except Exception as tool_error:
            result_json = None
            final_status = "failed"
            error = f"{type(tool_error).__name__}: {tool_error}"[:4000]
        finished = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "UPDATE agent_tool_calls SET status = ?, result_json = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
                (final_status, result_json, error, finished, finished, record_id),
            )
            record = connection.execute("SELECT * FROM agent_tool_calls WHERE id = ?", (record_id,)).fetchone()
        return self._agent_tool_call_contract(record)

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

    def _recover_interrupted_innovation_runs(self) -> None:
        now = utc_now()
        with self.db.connect() as connection:
            connection.execute(
                "UPDATE innovation_stages SET status = 'interrupted', "
                "error = COALESCE(error, 'Stage interrupted by engine restart'), "
                "finished_at = ?, updated_at = ? WHERE status = 'running'",
                (now, now),
            )
            connection.execute(
                "UPDATE innovation_runs SET status = 'interrupted', "
                "error = COALESCE(error, 'Pipeline interrupted by engine restart'), "
                "finished_at = ?, updated_at = ? WHERE status = 'running'",
                (now, now),
            )

    def save_innovation_prompt(
        self, prompt_text: str, prompt_version: str = "innovation-v1"
    ) -> dict[str, Any]:
        self.initialize()
        prompt_text = prompt_text.strip()
        prompt_version = prompt_version.strip()
        if not prompt_text or len(prompt_text) > 100000 or not prompt_version:
            raise ValueError("Innovation prompt is empty or too large")
        now = utc_now()
        with self.db.connect() as connection:
            revision = connection.execute(
                "SELECT COALESCE(MAX(revision), 0) + 1 FROM innovation_prompt_revisions "
                "WHERE prompt_version = ?",
                (prompt_version,),
            ).fetchone()[0]
            record = {
                "id": str(uuid.uuid4()),
                "promptText": prompt_text,
                "promptVersion": prompt_version,
                "revision": revision,
                "createdAt": now,
            }
            connection.execute(
                "INSERT INTO innovation_prompt_revisions(id, prompt_text, prompt_version, "
                "revision, created_at) VALUES (?, ?, ?, ?, ?)",
                (record["id"], prompt_text, prompt_version, revision, now),
            )
        return record

    def get_innovation_prompt(
        self, prompt_version: str = "innovation-v1"
    ) -> dict[str, Any] | None:
        self.initialize()
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT * FROM innovation_prompt_revisions WHERE prompt_version = ? "
                "ORDER BY revision DESC LIMIT 1",
                (prompt_version,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "promptText": row["prompt_text"],
            "promptVersion": row["prompt_version"],
            "revision": row["revision"],
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _innovation_stage_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "runId": record["run_id"],
            "stage": record["stage"],
            "position": record["position"],
            "status": record["status"],
            "modelId": record["model_id"],
            "attempt": record["attempt"],
            "outputText": record["output_text"],
            "usage": {
                "inputTokens": record["input_tokens"],
                "outputTokens": record["output_tokens"],
                "durationMs": record["duration_ms"],
            },
            "error": record["error"],
            "startedAt": record["started_at"],
            "finishedAt": record["finished_at"],
            "updatedAt": record["updated_at"],
        }

    @classmethod
    def _innovation_run_contract(
        cls, record: Any, stages: list[Any]
    ) -> dict[str, Any]:
        return {
            "id": record["id"],
            "retryOf": record["retry_of"],
            "status": record["status"],
            "currentStage": record["current_stage"],
            "promptText": record["prompt_text"],
            "promptVersion": record["prompt_version"],
            "contextSnapshot": json.loads(record["context_snapshot_json"]),
            "stageModels": json.loads(record["stage_models_json"]),
            "stages": [cls._innovation_stage_contract(stage) for stage in stages],
            "cancelRequested": bool(record["cancel_requested"]),
            "error": record["error"],
            "startedAt": record["started_at"],
            "finishedAt": record["finished_at"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    def _read_innovation_run(self, connection: Any, run_id: str) -> dict[str, Any]:
        run = connection.execute(
            "SELECT * FROM innovation_runs WHERE id = ?", (run_id,)
        ).fetchone()
        if not run:
            raise KeyError(f"Unknown innovation run: {run_id}")
        stages = connection.execute(
            "SELECT * FROM innovation_stages WHERE run_id = ? ORDER BY position", (run_id,)
        ).fetchall()
        return self._innovation_run_contract(run, list(stages))

    def list_innovation_runs(self, limit: int = 30) -> list[dict[str, Any]]:
        self.initialize()
        limit = max(1, min(int(limit), 100))
        with self.db.connect() as connection:
            run_ids = [
                row["id"]
                for row in connection.execute(
                    "SELECT id FROM innovation_runs ORDER BY created_at DESC LIMIT ?", (limit,)
                )
            ]
            return [self._read_innovation_run(connection, run_id) for run_id in run_ids]

    def start_innovation_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        prompt_text = str(payload.get("promptText", "")).strip()
        prompt_version = str(payload.get("promptVersion", "innovation-v1")).strip()
        context_snapshot = payload.get("contextSnapshot") or {}
        stage_models = payload.get("stageModels") or {}
        if not prompt_text or len(prompt_text) > 100000:
            raise ValueError("Innovation prompt is empty or too large")
        if not isinstance(context_snapshot, dict) or not isinstance(stage_models, dict):
            raise ValueError("Innovation context and stage models must be objects")
        missing_models = [stage for stage in INNOVATION_STAGES if not stage_models.get(stage)]
        if missing_models:
            raise ValueError("Missing innovation stage models: " + ", ".join(missing_models))
        snapshot_json = json.dumps(context_snapshot, ensure_ascii=False, separators=(",", ":"))
        if len(snapshot_json.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("Innovation context snapshot exceeds 2 MB")
        now = utc_now()
        run_id = str(uuid.uuid4())
        with self.db.connect() as connection:
            connection.execute(
                "INSERT INTO innovation_runs(id, retry_of, status, current_stage, prompt_text, "
                "prompt_version, context_snapshot_json, stage_models_json, cancel_requested, "
                "error, started_at, finished_at, created_at, updated_at) "
                "VALUES (?, NULL, 'running', ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?)",
                (
                    run_id,
                    INNOVATION_STAGES[0],
                    prompt_text,
                    prompt_version,
                    snapshot_json,
                    json.dumps(stage_models, separators=(",", ":")),
                    now,
                    now,
                    now,
                ),
            )
            for position, stage in enumerate(INNOVATION_STAGES):
                connection.execute(
                    "INSERT INTO innovation_stages(id, run_id, stage, position, status, model_id, "
                    "attempt, output_text, input_tokens, output_tokens, duration_ms, error, "
                    "started_at, finished_at, updated_at) "
                    "VALUES (?, ?, ?, ?, 'pending', ?, 0, '', 0, 0, 0, NULL, NULL, NULL, ?)",
                    (str(uuid.uuid4()), run_id, stage, position, str(stage_models[stage]), now),
                )
            return self._read_innovation_run(connection, run_id)

    def start_innovation_stage(self, run_id: str, stage: str) -> dict[str, Any]:
        self.initialize()
        if stage not in INNOVATION_STAGES:
            raise ValueError("Unknown innovation stage")
        position = INNOVATION_STAGES.index(stage)
        now = utc_now()
        with self.db.connect() as connection:
            run = connection.execute(
                "SELECT * FROM innovation_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if not run:
                raise KeyError(f"Unknown innovation run: {run_id}")
            if run["status"] not in {"running", "interrupted"}:
                raise ValueError("Innovation run is not active")
            if position:
                previous = connection.execute(
                    "SELECT status FROM innovation_stages WHERE run_id = ? AND position = ?",
                    (run_id, position - 1),
                ).fetchone()
                if not previous or previous["status"] != "completed":
                    raise ValueError("Previous innovation stage is incomplete")
            stage_row = connection.execute(
                "SELECT * FROM innovation_stages WHERE run_id = ? AND stage = ?", (run_id, stage)
            ).fetchone()
            if stage_row["status"] == "completed":
                return self._innovation_stage_contract(stage_row)
            connection.execute(
                "UPDATE innovation_stages SET status = 'running', attempt = attempt + 1, "
                "error = NULL, started_at = ?, finished_at = NULL, updated_at = ? "
                "WHERE run_id = ? AND stage = ?",
                (now, now, run_id, stage),
            )
            connection.execute(
                "UPDATE innovation_runs SET status = 'running', current_stage = ?, "
                "cancel_requested = 0, error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
                (stage, now, run_id),
            )
            updated = connection.execute(
                "SELECT * FROM innovation_stages WHERE run_id = ? AND stage = ?", (run_id, stage)
            ).fetchone()
        return self._innovation_stage_contract(updated)

    def update_innovation_stage(
        self, run_id: str, stage: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        if stage not in INNOVATION_STAGES:
            raise ValueError("Unknown innovation stage")
        status = str(payload.get("status", "running"))
        if status not in {"running", "completed", "failed", "cancelled"}:
            raise ValueError("Invalid innovation stage status")
        output_text = str(payload.get("outputText", ""))
        if len(output_text) > 2_000_000:
            raise ValueError("Innovation stage output exceeds 2 million characters")
        now = utc_now()
        terminal = status in {"completed", "failed", "cancelled"}
        error = str(payload.get("error", ""))[:4000] or None
        with self.db.connect() as connection:
            current = connection.execute(
                "SELECT * FROM innovation_stages WHERE run_id = ? AND stage = ?", (run_id, stage)
            ).fetchone()
            if not current:
                raise KeyError(f"Unknown innovation stage: {stage}")
            if current["status"] == "completed" and status != "completed":
                raise ValueError("Completed innovation stages are immutable")
            connection.execute(
                "UPDATE innovation_stages SET status = ?, output_text = ?, input_tokens = ?, "
                "output_tokens = ?, duration_ms = ?, error = ?, finished_at = ?, updated_at = ? "
                "WHERE run_id = ? AND stage = ?",
                (
                    status,
                    output_text,
                    max(0, int(payload.get("inputTokens", current["input_tokens"]))),
                    max(0, int(payload.get("outputTokens", current["output_tokens"]))),
                    max(0, int(payload.get("durationMs", current["duration_ms"]))),
                    error,
                    now if terminal else None,
                    now,
                    run_id,
                    stage,
                ),
            )
            if status == "completed":
                position = INNOVATION_STAGES.index(stage)
                if position == len(INNOVATION_STAGES) - 1:
                    connection.execute(
                        "UPDATE innovation_runs SET status = 'completed', error = NULL, "
                        "finished_at = ?, updated_at = ? WHERE id = ?",
                        (now, now, run_id),
                    )
                else:
                    connection.execute(
                        "UPDATE innovation_runs SET current_stage = ?, updated_at = ? WHERE id = ?",
                        (INNOVATION_STAGES[position + 1], now, run_id),
                    )
            elif status in {"failed", "cancelled"}:
                connection.execute(
                    "UPDATE innovation_runs SET status = ?, error = ?, cancel_requested = ?, "
                    "finished_at = ?, updated_at = ? WHERE id = ?",
                    (status, error, 1 if status == "cancelled" else 0, now, now, run_id),
                )
            return self._read_innovation_run(connection, run_id)

    def cancel_innovation_run(self, run_id: str) -> dict[str, Any]:
        self.initialize()
        with self.db.connect() as connection:
            run = connection.execute(
                "SELECT current_stage FROM innovation_runs WHERE id = ?", (run_id,)
            ).fetchone()
        if not run:
            raise KeyError(f"Unknown innovation run: {run_id}")
        return self.update_innovation_stage(
            run_id, run["current_stage"], {"status": "cancelled", "error": "Cancelled by user"}
        )

    def retry_innovation_run(self, run_id: str) -> dict[str, Any]:
        self.initialize()
        now = utc_now()
        with self.db.connect() as connection:
            run = connection.execute(
                "SELECT * FROM innovation_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if not run:
                raise KeyError(f"Unknown innovation run: {run_id}")
            if run["status"] not in {"failed", "cancelled", "interrupted"}:
                raise ValueError("Only failed, cancelled, or interrupted pipelines can retry")
            stages = connection.execute(
                "SELECT * FROM innovation_stages WHERE run_id = ? ORDER BY position", (run_id,)
            ).fetchall()
            resume = next((stage for stage in stages if stage["status"] != "completed"), None)
            if not resume:
                raise ValueError("Innovation run has no incomplete stage")
            connection.execute(
                "UPDATE innovation_stages SET status = 'pending', output_text = '', error = NULL, "
                "input_tokens = 0, output_tokens = 0, duration_ms = 0, started_at = NULL, "
                "finished_at = NULL, updated_at = ? WHERE run_id = ? AND position >= ?",
                (now, run_id, resume["position"]),
            )
            connection.execute(
                "UPDATE innovation_runs SET status = 'running', current_stage = ?, "
                "cancel_requested = 0, error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
                (resume["stage"], now, run_id),
            )
            return self._read_innovation_run(connection, run_id)

    @staticmethod
    def _reader_analysis_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "paperId": record["paper_id"],
            "sectionId": record["section_id"],
            "blockId": record["block_id"],
            "analysisType": record["analysis_type"],
            "sourceHash": record["source_hash"],
            "sourceText": record["source_text"],
            "adjacentContext": record["adjacent_context"],
            "resultText": record["result_text"],
            "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "revision": record["revision"],
            "usage": {
                "inputTokens": record["input_tokens"],
                "outputTokens": record["output_tokens"],
                "durationMs": record["duration_ms"],
            },
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    @staticmethod
    def _reader_chat_turn_contract(turn: Any, response: Any | None) -> dict[str, Any]:
        contract = {
            "id": turn["id"],
            "turnIndex": turn["turn_index"],
            "userMessage": turn["user_message"],
            "contextSnapshot": json.loads(turn["context_snapshot_json"]),
            "createdAt": turn["created_at"],
        }
        if response:
            contract["response"] = {
                "id": response["id"],
                "assistantText": response["assistant_text"],
                "modelId": response["model_id"],
                "promptVersion": response["prompt_version"],
                "revision": response["revision"],
                "status": response["status"],
                "usage": {
                    "inputTokens": response["input_tokens"],
                    "outputTokens": response["output_tokens"],
                    "durationMs": response["duration_ms"],
                },
                "error": response["error"],
                "createdAt": response["created_at"],
                "updatedAt": response["updated_at"],
            }
        return contract

    @staticmethod
    def _translation_contract(record: dict[str, Any]) -> dict[str, Any]:
        segments = json.loads(record.get("segments_json") or "[]")
        terms = json.loads(record.get("terms_json") or "[]")
        source_text = record["source_text"]
        if not segments and source_text:
            segments = [{
                "id": "legacy",
                "sourceStart": int(record.get("source_start", 0)),
                "sourceEnd": int(record.get("source_end", -1)) if int(record.get("source_end", -1)) >= 0 else len(source_text),
                "sourceText": source_text,
                "translatedText": record["translated_text"],
            }]
        return {
            "id": record["id"],
            "paperId": record["paper_id"],
            "sectionId": record["section_id"],
            "blockId": record["block_id"],
            "sourceHash": record["source_hash"],
            "sourceText": record["source_text"],
            "translatedText": record["translated_text"],
            "sourceStart": int(record.get("source_start", 0)),
            "sourceEnd": int(record.get("source_end", -1)) if int(record.get("source_end", -1)) >= 0 else len(source_text),
            "segments": segments,
            "terms": terms,
            "targetLanguage": record["target_language"],
            "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "revision": record["revision"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    @staticmethod
    def _reader_annotation_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"],
            "paperId": record["paper_id"],
            "sectionId": record["section_id"],
            "blockId": record["block_id"],
            "sourceHash": record["source_hash"],
            "sourceStart": record["source_start"],
            "sourceEnd": record["source_end"],
            "annotationType": record["annotation_type"],
            "relatedId": record["related_id"],
            "createdAt": record["created_at"],
            "updatedAt": record["updated_at"],
        }

    @staticmethod
    def _figure_analysis_contract(record: Any) -> dict[str, Any]:
        return {
            "id": record["id"], "paperId": record["paper_id"],
            "figureId": record["figure_id"], "status": record["status"],
            "description": record["description"], "modelId": record["model_id"],
            "promptVersion": record["prompt_version"],
            "usage": {"inputTokens": record["input_tokens"], "outputTokens": record["output_tokens"], "durationMs": record["duration_ms"]},
            "error": record["error"], "updatedAt": record["updated_at"],
        }


def watch_library(root: str | Path, interval: float = 2.0) -> None:
    library = Library(root)
    library.initialize()
    while True:
        library.scan(require_stable=True)
        time.sleep(interval)
