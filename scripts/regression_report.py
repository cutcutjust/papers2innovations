from __future__ import annotations

import argparse
import json
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def load_document(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    document_path = Path(path)
    if not document_path.is_file():
        return {}
    return json.loads(document_path.read_text(encoding="utf-8"))


def build_report(root: Path) -> dict[str, Any]:
    database = root / ".p2i" / "library.sqlite"
    if not database.is_file():
        raise FileNotFoundError(database)
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT p.id, p.title, p.status, p.page_count, p.document_path, "
            "ps.source_collection, ps.source_attachment_key "
            "FROM papers p JOIN paper_sources ps ON ps.paper_id = p.id "
            "WHERE ps.source_type = 'zotero' ORDER BY ps.imported_at, p.id"
        ).fetchall()

    papers: list[dict[str, Any]] = []
    for row in rows:
        document = load_document(row["document_path"])
        ocr = document.get("ocr") or {}
        papers.append(
            {
                "id": row["id"],
                "attachmentKey": row["source_attachment_key"],
                "collection": row["source_collection"],
                "title": row["title"],
                "status": row["status"],
                "pageCount": row["page_count"] or document.get("page_count", 0),
                "figures": len(document.get("figures", [])),
                "tables": len(document.get("tables", [])),
                "ocr": {
                    "requests": ocr.get("request_count", 0),
                    "cacheHits": ocr.get("cache_hits", 0),
                    "inputTokens": ocr.get("input_tokens", 0),
                    "outputTokens": ocr.get("output_tokens", 0),
                    "durationMs": ocr.get("duration_ms", 0),
                    "failedPages": ocr.get("failed_pages", []),
                },
                "warnings": document.get("warnings", []),
            }
        )

    statuses = Counter(paper["status"] for paper in papers)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(UTC).isoformat(),
        "library": str(root),
        "summary": {
            "papers": len(papers),
            "ready": statuses["READY"],
            "partial": statuses["PARTIAL"],
            "failed": statuses["FAILED"],
            "pages": sum(paper["pageCount"] for paper in papers),
            "figures": sum(paper["figures"] for paper in papers),
            "tables": sum(paper["tables"] for paper in papers),
            "ocrRequests": sum(paper["ocr"]["requests"] for paper in papers),
            "ocrCacheHits": sum(paper["ocr"]["cacheHits"] for paper in papers),
            "inputTokens": sum(paper["ocr"]["inputTokens"] for paper in papers),
            "outputTokens": sum(paper["ocr"]["outputTokens"] for paper in papers),
            "ocrDurationMs": sum(paper["ocr"]["durationMs"] for paper in papers),
            "failedPages": sum(len(paper["ocr"]["failedPages"]) for paper in papers),
        },
        "papers": papers,
    }


def markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Papers2Innovations regression report",
        "",
        f"Generated: {report['generatedAt']}",
        "",
        "| Papers | Ready | Partial | Failed | Pages | Figures | Tables | OCR calls | Cache hits | Failed pages |",
        "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        f"| {summary['papers']} | {summary['ready']} | {summary['partial']} | {summary['failed']} | {summary['pages']} | {summary['figures']} | {summary['tables']} | {summary['ocrRequests']} | {summary['ocrCacheHits']} | {summary['failedPages']} |",
        "",
        "| Status | Pages | Figures | Tables | OCR calls | Cache hits | Title |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for paper in report["papers"]:
        title = paper["title"].replace("|", "\\|")
        lines.append(
            f"| {paper['status']} | {paper['pageCount']} | {paper['figures']} | {paper['tables']} | "
            f"{paper['ocr']['requests']} | {paper['ocr']['cacheHits']} | {title} |"
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=r"E:\Papers2Innovations-Library")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    report = build_report(root)
    output = root / ".p2i" / "reports"
    output.mkdir(parents=True, exist_ok=True)
    (output / "regression-30.local.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output / "regression-30.local.md").write_text(
        markdown_report(report), encoding="utf-8"
    )
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
