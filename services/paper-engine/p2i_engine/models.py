from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class JobStatus(StrEnum):
    DISCOVERED = "DISCOVERED"
    HASHING = "HASHING"
    QUEUED = "QUEUED"
    RENDERING = "RENDERING"
    PARSING_LAYOUT = "PARSING_LAYOUT"
    RECOGNIZING_TEXT = "RECOGNIZING_TEXT"
    EXTRACTING_FIGURES = "EXTRACTING_FIGURES"
    CHECKING_FORMULAS = "CHECKING_FORMULAS"
    CLEANING_DOCUMENT = "CLEANING_DOCUMENT"
    VERIFYING_DOCUMENT = "VERIFYING_DOCUMENT"
    PARSING_REFERENCES = "PARSING_REFERENCES"
    RESOLVING_METADATA = "RESOLVING_METADATA"
    INDEXING = "INDEXING"
    GENERATING_RESEARCH_CARD = "GENERATING_RESEARCH_CARD"
    READY = "READY"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    MISSING = "MISSING"
    CANCELLED = "CANCELLED"


class BoundingBox(BaseModel):
    left: float
    top: float
    right: float
    bottom: float


class EvidenceAnchor(BaseModel):
    paper_id: str
    section_id: str
    block_id: str
    page: int
    bbox: BoundingBox | None = None
    source_text: str


class PaperSection(BaseModel):
    id: str
    title: str
    level: int = 1
    order: int
    page_start: int | None = None
    page_end: int | None = None
    markdown: str
    anchors: list[EvidenceAnchor] = Field(default_factory=list)


class PaperFigure(BaseModel):
    id: str
    caption: str | None = None
    relative_path: str
    page: int | None = None
    bbox: BoundingBox | None = None
    mime_type: str = "image/png"
    thumbnail_path: str | None = None


class OcrUsage(BaseModel):
    provider: str = "qwen"
    model: str = "qwen3.5-ocr"
    page_count: int = 0
    cache_hits: int = 0
    request_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
    failed_pages: list[int] = Field(default_factory=list)


class ParserInfo(BaseModel):
    name: str
    version: str


class MarkdownFormattingInfo(BaseModel):
    model_id: str
    prompt_version: str
    source_sha256: str
    updated_at: str = Field(default_factory=utc_now)


class PaperDocument(BaseModel):
    schema_version: str = "1.0"
    paper_id: str
    source_sha256: str
    title: str
    authors: list[str] = Field(default_factory=list)
    abstract: str | None = None
    language: str | None = None
    page_count: int
    sections: list[PaperSection] = Field(default_factory=list)
    figures: list[PaperFigure] = Field(default_factory=list)
    tables: list[dict[str, Any]] = Field(default_factory=list)
    parser: ParserInfo
    formatting: MarkdownFormattingInfo | None = None
    ocr: OcrUsage | None = None
    partial: bool = False
    warnings: list[str] = Field(default_factory=list)
    generated_at: str = Field(default_factory=utc_now)


class ProgressEvent(BaseModel):
    request_id: str | int | None = None
    job_id: str
    paper_id: str | None = None
    status: JobStatus
    progress: float = Field(ge=0, le=1)
    message: str


class CancelledError(Exception):
    pass
