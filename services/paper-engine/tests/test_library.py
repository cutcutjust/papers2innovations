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
    assert version == 7


def test_agent_profiles_runs_retry_and_restart_recovery_are_persistent(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    profiles = library.list_agent_profiles()
    assert len(profiles) == 6
    profile = profiles[0]
    assert profile["allowedTools"]
    assert profile["systemPrompt"]

    snapshot = {
        "id": "snapshot-1",
        "agentProfileId": profile["id"],
        "modelId": profile["modelId"],
        "items": [],
        "tokenBreakdown": {
            "systemPrompt": 10,
            "tools": 20,
            "conversation": 0,
            "papers": 0,
            "figures": 0,
            "outputReserve": 30,
            "safetyBuffer": 40,
        },
        "promptVersion": profile["promptVersion"],
        "toolVersions": {},
        "retrievalQueries": [],
        "externalResults": [],
        "createdAt": "2026-07-27T00:00:00Z",
    }
    first = library.start_agent_run({
        "agentProfileId": profile["id"],
        "userPrompt": "Summarize grounded evidence.",
        "contextSnapshot": snapshot,
    })
    checkpoint = library.update_agent_run(first["id"], {
        "status": "running",
        "outputText": "Partial grounded output",
        "durationMs": 250,
    })
    assert checkpoint["status"] == "running"
    assert checkpoint["outputText"].startswith("Partial")

    restarted = Library(tmp_path)
    restarted.initialize()
    interrupted = restarted.list_agent_runs(profile["id"])[0]
    assert interrupted["status"] == "interrupted"
    assert interrupted["outputText"] == "Partial grounded output"

    retried = restarted.retry_agent_run(interrupted["id"])
    completed = restarted.update_agent_run(retried["id"], {
        "status": "completed",
        "outputText": "Persisted grounded output.",
        "inputTokens": 42,
        "outputTokens": 9,
        "durationMs": 800,
    })
    assert completed["retryOf"] == interrupted["id"]
    assert completed["usage"] == {"inputTokens": 42, "outputTokens": 9, "durationMs": 800}
    assert Library(tmp_path).list_agent_runs(profile["id"])[0]["outputText"] == "Persisted grounded output."


def test_agent_profile_rejects_unknown_tool_and_protects_run_history(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    profile = library.list_agent_profiles()[0]
    with pytest.raises(ValueError, match="Unknown agent tools"):
        library.upsert_agent_profile({**profile, "allowedTools": ["shell"]})

    library.start_agent_run({
        "agentProfileId": profile["id"],
        "userPrompt": "Ground this claim.",
        "contextSnapshot": {},
    })
    with pytest.raises(ValueError, match="run history"):
        library.delete_agent_profile(profile["id"])


def test_innovation_pipeline_resumes_from_failed_stage_without_repeating_completed(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    prompt = library.save_innovation_prompt("Generate grounded ideas.")
    assert prompt["revision"] == 1
    assert library.get_innovation_prompt()["promptText"] == "Generate grounded ideas."

    stage_models = {
        "compression": "model-fast",
        "evidence": "model-long",
        "ideas": "model-reasoning",
        "novelty": "model-reasoning",
        "critique": "model-reasoning",
    }
    run = library.start_innovation_run({
        "promptText": prompt["promptText"],
        "promptVersion": prompt["promptVersion"],
        "contextSnapshot": {"id": "snapshot-innovation", "items": []},
        "stageModels": stage_models,
    })
    assert [stage["status"] for stage in run["stages"]] == ["pending"] * 5

    library.start_innovation_stage(run["id"], "compression")
    library.update_innovation_stage(run["id"], "compression", {
        "status": "completed",
        "outputText": "Compressed context with anchors.",
        "inputTokens": 50,
        "outputTokens": 10,
    })
    library.start_innovation_stage(run["id"], "evidence")
    failed = library.update_innovation_stage(run["id"], "evidence", {
        "status": "failed",
        "outputText": "Partial evidence ledger.",
        "error": "provider unavailable",
    })
    assert failed["status"] == "failed"

    retried = library.retry_innovation_run(run["id"])
    assert retried["currentStage"] == "evidence"
    assert retried["stages"][0]["status"] == "completed"
    assert retried["stages"][0]["outputText"] == "Compressed context with anchors."
    assert retried["stages"][1]["status"] == "pending"
    assert retried["stages"][1]["attempt"] == 1


def test_innovation_pipeline_marks_active_stage_interrupted_after_restart(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    models = {stage: "model" for stage in ("compression", "evidence", "ideas", "novelty", "critique")}
    run = library.start_innovation_run({
        "promptText": "Create a falsifiable hypothesis.",
        "contextSnapshot": {},
        "stageModels": models,
    })
    library.start_innovation_stage(run["id"], "compression")

    restarted = Library(tmp_path)
    restarted.initialize()
    recovered = restarted.list_innovation_runs()[0]
    assert recovered["status"] == "interrupted"
    assert recovered["stages"][0]["status"] == "interrupted"


def test_reader_translation_is_revisioned_and_persisted(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    source = tmp_path / "Papers" / "reader.pdf"
    make_pdf(source)
    library.scan()
    paper = library.list_papers()[0]

    document = library.read_document(paper["id"])
    assert document["paper_id"] == paper["id"]

    payload = {
        "paperId": paper["id"],
        "sectionId": "section-1",
        "blockId": "section-1:block-1",
        "sourceText": "A grounded source paragraph.",
        "translatedText": "一段有依据的译文。",
        "targetLanguage": "zh-CN",
        "modelId": "test-model",
        "promptVersion": "reader-translate-v1",
    }
    first = library.save_translation(payload)
    second = library.save_translation({**payload, "translatedText": "修订后的译文。"})

    assert first["revision"] == 1
    assert second["revision"] == 2
    restored = Library(tmp_path).list_translations(paper["id"])
    assert len(restored) == 1
    assert restored[0]["translatedText"] == "修订后的译文。"
    assert restored[0]["sourceHash"]


def test_context_draft_is_shared_persistent_and_deduplicated(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "context.pdf")
    library.scan()
    paper = library.list_papers()[0]

    first = library.add_selection_to_context({
        "paperId": paper["id"],
        "sectionId": "page-1",
        "blockId": "page-1:block-1",
        "sourceText": "Grounded context paragraph.",
    })
    second = library.add_selection_to_context({
        "paperId": paper["id"],
        "sectionId": "page-1",
        "blockId": "page-1:block-1",
        "sourceText": "Updated grounded context paragraph.",
    })

    assert len(first["items"]) == 1
    assert len(second["items"]) == 1
    assert second["tokenBreakdown"]["papers"] > 0
    restored = Library(tmp_path).get_context_draft()
    assert restored["items"][0]["sourcePreview"].startswith("Updated grounded")
    assert library.remove_paper_from_context(paper["id"])["items"] == []


def test_context_compression_is_cached_revisioned_and_source_bound(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "context-compression.pdf")
    library.scan()
    paper = library.list_papers()[0]
    draft = library.add_selection_to_context({
        "paperId": paper["id"],
        "sectionId": "page-1",
        "blockId": "page-1:block-1",
        "sourceText": "A long grounded source paragraph for compression.",
    })
    item = draft["items"][0]
    payload = {
        "itemId": item["id"],
        "sourceHash": item["sourceHash"],
        "compressedText": "Grounded compressed evidence.",
        "modelId": "test-model",
        "promptVersion": "context-compress-v1",
        "inputTokens": 42,
        "outputTokens": 9,
        "durationMs": 1200,
    }

    first = library.save_context_compression(payload)
    second = library.save_context_compression({
        **payload, "compressedText": "Revised compressed evidence."
    })

    assert first["revision"] == 1
    assert second["revision"] == 2
    cached = Library(tmp_path).get_context_compression(
        item["id"], "test-model", "context-compress-v1"
    )
    assert cached and cached["compressedText"] == "Revised compressed evidence."
    restored = Library(tmp_path).get_context_draft()
    assert restored["items"][0]["mode"] == "compressed"
    assert restored["items"][0]["compression"]["revision"] == 2
    assert restored["items"][0]["compression"]["usage"]["inputTokens"] == 42
    assert restored["tokenBreakdown"]["papers"] == second["estimatedTokens"]

    alternate = library.save_context_compression({
        **payload,
        "modelId": "alternate-model",
        "compressedText": "Alternate model result.",
    })
    library.activate_context_compression(
        item["id"], "test-model", "context-compress-v1"
    )
    active = library.get_context_draft()["items"][0]["compression"]
    assert active["id"] == second["id"]
    assert active["id"] != alternate["id"]

    with pytest.raises(ValueError, match="source changed"):
        library.save_context_compression({**payload, "sourceHash": "stale-hash"})


def test_citation_graph_repairs_empty_reference_artifacts_and_caches(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "citation-root.pdf")
    library.scan()
    paper = library.list_papers()[0]
    document_path = Path(paper["documentPath"])
    document = json.loads(document_path.read_text(encoding="utf-8"))
    document["sections"] = [{
        "id": "references",
        "title": "References",
        "level": 1,
        "order": 0,
        "markdown": "REFERENCES\n[1] A. Author, “An Unresolved Scientific Work,” Journal, 2024.",
        "anchors": [],
    }]
    document_path.write_text(json.dumps(document), encoding="utf-8")

    first = library.build_citation_graph(paper["id"])
    second = library.build_citation_graph(paper["id"])

    assert first["cacheHit"] is False
    assert first["directCount"] == 1
    assert first["unresolvedCount"] == 1
    assert second["cacheHit"] is True
    assert library.read_references(paper["id"])[0]["title"] == "An Unresolved Scientific Work"


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
