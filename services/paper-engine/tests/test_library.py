from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfWriter

from p2i_engine.library import Library
from p2i_engine.database import Database
from p2i_engine.models import PaperDocument, PaperFigure, PaperSection, ParserInfo


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
        assert version == 15
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert {"document_revisions", "page_recognitions", "document_uncertainties"} <= tables


def test_migration_0013_upgrades_existing_0012_context_without_data_loss(tmp_path: Path) -> None:
    database_path = tmp_path / ".p2i" / "library.sqlite"
    database_path.parent.mkdir(parents=True)
    migration_dir = Path(__file__).resolve().parents[1] / "migrations"
    with sqlite3.connect(database_path) as connection:
        connection.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        for migration in sorted(migration_dir.glob("*.sql")):
            version = int(migration.stem.split("_", 1)[0])
            if version > 12:
                continue
            connection.executescript(migration.read_text(encoding="utf-8"))
            connection.execute("INSERT INTO schema_migrations VALUES (?, 'test')", (version,))
        connection.execute(
            "INSERT INTO papers(id, canonical_sha256, title, status, created_at, updated_at) "
            "VALUES ('paper-1', 'hash', 'Existing paper', 'READY', 'test', 'test')"
        )
        connection.execute(
            "INSERT INTO context_items(id, paper_id, mode, source_hash, source_text, estimated_tokens, created_at, updated_at) "
            "VALUES ('context-1', 'paper-1', 'full', 'hash', 'Existing context', 4, 'test', 'test')"
        )
    Database(database_path).migrate()
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 15
        assert connection.execute(
            "SELECT scope_id FROM context_scope_items WHERE context_item_id = 'context-1'"
        ).fetchone()[0] == "research:default"


def test_paper_and_research_contexts_are_isolated_and_custom_items_are_editable(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "scoped-context.pdf")
    library.scan()
    paper = library.list_papers()[0]
    paper_scope = f"paper:{paper['id']}"

    research = library.add_selection_to_context({
        "paperId": paper["id"], "sectionId": "research", "blockId": "research-note",
        "sourceText": "Research-only evidence.",
    })
    paper_draft = library.add_paper_to_context(paper["id"], "full", paper_scope)
    assert research["scope"]["id"] == "research:default"
    assert paper_draft["scope"]["id"] == paper_scope
    assert all(item["sectionId"] != "research" for item in paper_draft["items"])

    created = library.upsert_scoped_context_item({
        "scopeId": paper_scope, "paperId": paper["id"], "title": "阅读笔记",
        "text": "First custom note.",
    })
    custom = next(item for item in created["items"] if item["itemType"] == "custom")
    updated = library.upsert_scoped_context_item({
        "scopeId": paper_scope, "itemId": custom["id"], "title": "修订笔记",
        "text": "Revised custom note.",
    })
    assert next(item for item in updated["items"] if item["id"] == custom["id"])["sourcePreview"] == "Revised custom note."
    library.delete_scoped_context_item(paper_scope, custom["id"])
    assert all(item["id"] != custom["id"] for item in Library(tmp_path).get_context_draft(paper_scope)["items"])
    assert Library(tmp_path).get_context_draft()["items"][0]["sectionId"] == "research"


def test_structured_translation_and_reader_annotation_round_trip(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "translation.pdf")
    library.scan()
    paper = library.list_papers()[0]
    record = library.save_translation({
        "paperId": paper["id"], "sectionId": "intro", "blockId": "intro:block-1",
        "sourceText": "First result.", "translatedText": "第一个结果。", "targetLanguage": "zh-CN",
        "modelId": "model", "promptVersion": "reader-translate-v3", "sourceStart": 0,
        "sourceEnd": 13, "segments": [{"id": "sentence-1", "sourceStart": 0,
        "sourceEnd": 13, "sourceText": "First result.", "translatedText": "第一个结果。"}],
        "terms": [{"text": "result", "translation": "结果", "explanation": "实验结果", "kind": "term"}],
    })
    annotation = library.save_reader_annotation({
        "paperId": paper["id"], "sectionId": "intro", "blockId": "intro:block-1",
        "sourceStart": 0, "sourceEnd": 5, "annotationType": "chat", "relatedId": "turn-1",
    })
    assert record["segments"][0]["translatedText"] == "第一个结果。"
    assert record["terms"][0]["kind"] == "term"
    annotations = library.list_reader_annotations(paper["id"])
    assert next(item for item in annotations if item["annotationType"] == "chat")["id"] == annotation["id"]
    assert next(item for item in annotations if item["annotationType"] == "translation")["targetType"] == "translation"


def test_reader_annotation_targets_and_content_crud(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "reader-crud.pdf")
    library.scan()
    paper = library.list_papers()[0]
    translation = library.save_translation({
        "paperId": paper["id"], "sectionId": "intro", "blockId": "intro:block-1",
        "sourceText": "A useful result.", "translatedText": "一个有用的结果。",
        "targetLanguage": "zh-CN", "modelId": "model", "promptVersion": "translate-v1",
        "sourceStart": 0, "sourceEnd": 16,
        "segments": [{"id": "sentence-1", "sourceStart": 0, "sourceEnd": 16,
                      "sourceText": "A useful result.", "translatedText": "一个有用的结果。"}],
    })
    analysis = library.save_reader_analysis({
        "paperId": paper["id"], "sectionId": "intro", "blockId": "intro:block-1",
        "analysisType": "theorem", "sourceText": "A useful result.",
        "adjacentContext": "", "resultText": "解释", "modelId": "model",
        "promptVersion": "analysis-v1", "sourceStart": 2, "sourceEnd": 8,
        "selectedText": "useful",
    })
    snapshot = {"id": "snapshot", "items": [], "tokenBreakdown": {}}
    turn = library.save_reader_chat_turn({
        "paperId": paper["id"], "userMessage": "What is useful?", "assistantText": "Answer",
        "contextSnapshot": snapshot, "modelId": "model", "promptVersion": "chat-v1",
        "status": "completed",
    })
    library.save_reader_annotation({
        "paperId": paper["id"], "sectionId": "intro", "blockId": "intro:block-1",
        "sourceStart": 2, "sourceEnd": 8, "annotationType": "chat",
        "targetType": "chat_turn", "relatedId": turn["id"], "selectedText": "useful",
    })
    updated = library.update_reader_chat_turn({
        "paperId": paper["id"], "turnId": turn["id"], "userMessage": "Why is it useful?",
        "assistantText": "Updated answer", "contextSnapshot": snapshot, "modelId": "model",
        "promptVersion": "chat-v1", "status": "completed",
    })
    assert updated["userMessage"] == "Why is it useful?"
    assert len(updated["revisions"]) == 2
    targets = {item["targetType"] for item in library.list_reader_annotations(paper["id"])}
    assert {"translation", "analysis", "chat_turn"} <= targets
    assert library.delete_translation(paper["id"], translation["id"])
    assert library.delete_reader_analysis(paper["id"], analysis["id"])
    assert library.delete_reader_chat_turn(paper["id"], turn["id"])
    assert library.list_reader_annotations(paper["id"]) == []


def test_figure_analysis_uses_content_model_prompt_cache(tmp_path: Path) -> None:
    calls: list[dict] = []
    library = Library(
        tmp_path,
        vision_config=lambda: {"modelId": "vision-model"},
        vision_analyze=lambda params: calls.append(params) or {
            "description": "## 图意概述\n\n缓存测试。", "modelId": "vision-model",
            "usage": {"inputTokens": 10, "outputTokens": 8, "durationMs": 20},
        },
    )
    library.initialize()
    source = library.papers_dir / "vision.pdf"
    make_pdf(source)
    library.scan()
    paper = library.list_papers()[0]
    source_hash = library.read_document(paper["id"])["source_sha256"]
    output = library.generated_dir / paper["id"]
    (output / "figures").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 32), "white").save(output / "figures" / "figure-1.png")
    document = PaperDocument(
        paper_id=paper["id"], source_sha256=source_hash, title="Vision paper",
        page_count=1, parser=ParserInfo(name="test", version="1"),
        sections=[PaperSection(id="intro", title="Introduction", order=0, markdown="Plain text.")],
        figures=[PaperFigure(id="figure-1", relative_path="figures/figure-1.png")],
    )
    library._preprocess_visual_artifacts(paper["id"], source_hash, document.title, source, output, document)
    library._preprocess_visual_artifacts(paper["id"], source_hash, document.title, source, output, document)
    figure_calls = [call for call in calls if str(call.get("figureId", "")).endswith("figure-1")]
    assert len(figure_calls) == 1
    analysis = library.list_figure_analyses(paper["id"])[0]
    assert analysis["status"] == "completed"
    assert analysis["usage"]["outputTokens"] == 8


def test_collection_tree_move_filter_and_delete_are_persistent(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "tree-paper.pdf")
    library.scan()
    paper = library.list_papers()[0]

    parent = library.create_collection("研究主题", color="#3984d8")
    child = library.create_collection("多模态", parent["id"], "#28a06a")
    moved = library.move_paper_to_collection(paper["id"], child["id"])
    assert moved["collectionId"] == child["id"]
    assert library.list_papers()[0]["collectionIds"] == [child["id"]]

    renamed = library.update_collection(child["id"], {"name": "多模态推理"})
    assert renamed["name"] == "多模态推理"
    with pytest.raises(ValueError, match="descendant"):
        library.update_collection(parent["id"], {"parentId": child["id"]})

    restarted = Library(tmp_path)
    restarted.initialize()
    assert any(item["name"] == "多模态推理" for item in restarted.list_collections())
    assert restarted.delete_collection(parent["id"]) is True
    assert restarted.list_collections() == []
    assert restarted.list_papers()[0]["collectionIds"] == []


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


def test_agent_prompt_templates_support_scoped_crud(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    profile = library.list_agent_profiles()[0]
    defaults = library.list_agent_prompts(profile["id"])
    assert len(defaults) == 1
    assert defaults[0]["name"] == "默认分析任务"

    created = library.upsert_agent_prompt({
        "agentProfileId": profile["id"],
        "name": "方法对比",
        "content": "比较上下文中的研究方法与实验设置。",
        "sortOrder": 2,
    })
    assert created["agentProfileId"] == profile["id"]
    updated = library.upsert_agent_prompt({
        **created,
        "name": "方法与实验对比",
        "content": "比较方法、数据集、指标和实验设置。",
    })
    assert updated["id"] == created["id"]
    assert updated["content"].startswith("比较方法")
    assert [item["name"] for item in library.list_agent_prompts(profile["id"])] == [
        "默认分析任务",
        "方法与实验对比",
    ]

    with pytest.raises(ValueError, match="already exists"):
        library.upsert_agent_prompt({
            "agentProfileId": profile["id"],
            "name": "方法与实验对比",
            "content": "重复名称",
        })
    assert library.delete_agent_prompt(created["id"]) is True
    assert library.delete_agent_prompt(created["id"]) is False

    new_profile = library.upsert_agent_profile({
        **profile,
        "id": "custom-agent",
        "name": "自定义智能体",
    })
    assert len(library.list_agent_prompts(new_profile["id"])) == 1
    assert library.delete_agent_profile(new_profile["id"]) is True
    with library.db.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM agent_prompts WHERE agent_profile_id = ?",
            (new_profile["id"],),
        ).fetchone()[0] == 0


def test_prompt_library_supports_category_crud(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    defaults = library.list_prompt_templates()
    assert {item["category"] for item in defaults} == {
        "reader", "translation", "explanation", "markdown", "innovation"
    }
    assert len(defaults) == 5

    created = library.upsert_prompt_template({
        "category": "translation",
        "name": "术语优先翻译",
        "content": "优先保持领域术语一致。",
        "sortOrder": 2,
    })
    assert created["category"] == "translation"
    updated = library.upsert_prompt_template({
        **created,
        "category": "explanation",
        "name": "术语解释",
        "content": "解释术语并引用原文锚点。",
    })
    assert updated["id"] == created["id"]
    assert updated["category"] == "explanation"
    assert any(item["name"] == "术语解释" for item in library.list_prompt_templates("explanation"))

    with pytest.raises(ValueError, match="already exists"):
        library.upsert_prompt_template({
            "category": "explanation",
            "name": "术语解释",
            "content": "重复名称",
        })
    with pytest.raises(ValueError, match="Unknown"):
        library.list_prompt_templates("agent")
    assert library.delete_prompt_template(created["id"]) is True
    assert library.delete_prompt_template(created["id"]) is False


def test_agent_profile_rejects_unknown_tool_and_protects_run_history(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    profile = next(item for item in library.list_agent_profiles() if item["id"] == "paper-analyst")
    with pytest.raises(ValueError, match="Unknown agent tools"):
        library.upsert_agent_profile({**profile, "allowedTools": ["shell"]})

    library.start_agent_run({
        "agentProfileId": profile["id"],
        "userPrompt": "Ground this claim.",
        "contextSnapshot": {},
    })
    with pytest.raises(ValueError, match="run history"):
        library.delete_agent_profile(profile["id"])


def test_agent_tool_registry_enforces_permissions_and_persists_provenance(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "tool-paper.pdf")
    library.scan()
    paper = library.list_papers()[0]
    profile = next(item for item in library.list_agent_profiles() if item["id"] == "paper-analyst")
    tools = library.list_agent_tools(profile["id"])
    assert {tool["name"] for tool in tools} == {"read_paper", "read_section", "find_evidence"}
    run = library.start_agent_run({
        "agentProfileId": profile["id"],
        "userPrompt": "Read local evidence.",
        "contextSnapshot": {"toolVersions": {tool["name"]: "1" for tool in tools}},
    })
    call = library.execute_agent_tool({
        "runId": run["id"],
        "toolCallId": "call-read-paper",
        "toolName": "read_paper",
        "arguments": {"paperId": paper["id"]},
        "iteration": 1,
    })
    assert call["status"] == "completed"
    assert call["result"]["paperId"] == paper["id"]
    assert library.execute_agent_tool({
        "runId": run["id"],
        "toolCallId": "call-read-paper",
        "toolName": "read_paper",
        "arguments": {"paperId": "different"},
        "iteration": 1,
    })["id"] == call["id"]
    denied = library.execute_agent_tool({
        "runId": run["id"],
        "toolCallId": "call-create-note",
        "toolName": "create_note",
        "arguments": {"text": "must not write"},
        "iteration": 1,
    })
    assert denied["status"] == "denied"
    restored = Library(tmp_path).list_agent_runs(profile["id"])[0]
    assert [item["status"] for item in restored["toolCalls"]] == ["completed", "denied"]


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


def test_reader_analysis_and_chat_are_revisioned_and_persisted(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "reader-interactions.pdf")
    library.scan()
    paper = library.list_papers()[0]

    analysis_payload = {
        "paperId": paper["id"],
        "sectionId": "method",
        "blockId": "method:block-1",
        "analysisType": "formula",
        "sourceText": "$y = Wx$",
        "adjacentContext": "The method projects the input representation.",
        "resultText": "The matrix W maps input x to output y.",
        "modelId": "test-model",
        "promptVersion": "reader-analysis-v1",
        "inputTokens": 20,
        "outputTokens": 8,
        "durationMs": 300,
    }
    first = library.save_reader_analysis(analysis_payload)
    second = library.save_reader_analysis({
        **analysis_payload,
        "resultText": "W is a learned linear projection from x to y.",
    })
    assert first["revision"] == 1
    assert second["revision"] == 2
    assert Library(tmp_path).list_reader_analyses(paper["id"])[0]["revision"] == 2

    grammar = library.save_reader_analysis({
        **analysis_payload,
        "blockId": "method:block-grammar",
        "analysisType": "grammar",
        "sourceText": "The proposed model improves accuracy.",
        "resultText": "句子主干为 model improves accuracy。",
        "promptVersion": "reader-analysis-v2",
    })
    assert grammar["analysisType"] == "grammar"

    snapshot = {"id": "reader-chat-context", "items": []}
    turn = library.save_reader_chat_turn({
        "paperId": paper["id"],
        "userMessage": "What does this projection do?",
        "assistantText": "It transforms x into the output space.",
        "contextSnapshot": snapshot,
        "modelId": "test-model",
        "promptVersion": "reader-chat-v1",
        "status": "completed",
        "inputTokens": 30,
        "outputTokens": 9,
        "durationMs": 450,
    })
    retried = library.save_reader_chat_turn({
        "paperId": paper["id"],
        "turnId": turn["id"],
        "userMessage": "What does this projection do?",
        "assistantText": "It maps x into the learned representation y.",
        "contextSnapshot": snapshot,
        "modelId": "test-model",
        "promptVersion": "reader-chat-v1",
        "status": "completed",
    })
    assert retried["response"]["revision"] == 2
    restored = Library(tmp_path).get_reader_conversation(paper["id"])
    assert len(restored["turns"]) == 1
    assert restored["turns"][0]["response"]["assistantText"].startswith("It maps")
    failed = library.save_reader_chat_turn({
        "paperId": paper["id"],
        "userMessage": "Can this fail before the first token?",
        "assistantText": "",
        "contextSnapshot": snapshot,
        "modelId": "test-model",
        "promptVersion": "reader-chat-v1",
        "status": "failed",
        "error": "Connection refused",
    })
    assert failed["response"]["assistantText"] == ""
    assert failed["response"]["status"] == "failed"
    assert library.clear_reader_conversation(paper["id"]) is True
    assert library.get_reader_conversation(paper["id"])["turns"] == []


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
    assert len(document["sections"]) == 1
    assert document["sections"][0]["title"] == "Document"
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


def test_ai_formatted_markdown_is_validated_and_persisted(tmp_path: Path) -> None:
    library = Library(tmp_path)
    library.initialize()
    make_pdf(library.papers_dir / "format-me.pdf", pages=2)
    library.scan()
    paper = library.list_papers()[0]
    document = library.read_document(paper["id"])
    formatted_sections = [
        {
            "id": section["id"],
            "markdown": f'{section["markdown"]}\n\nAI formatted paragraph.',
        }
        for section in document["sections"]
    ]

    saved = library.save_formatted_document(
        paper["id"],
        formatted_sections,
        "model-format",
        "markdown-format-v1",
        document["source_sha256"],
    )

    assert saved["formatting"]["model_id"] == "model-format"
    assert saved["formatting"]["prompt_version"] == "markdown-format-v1"
    assert "AI formatted paragraph" in library.read_markdown(paper["id"])
    with library.db.connect() as connection:
        stored = connection.execute(
            "SELECT markdown FROM sections WHERE paper_id = ?", (paper["id"],)
        ).fetchone()["markdown"]
    assert "AI formatted paragraph" in stored

    with pytest.raises(ValueError, match="content changed"):
        library.save_formatted_document(
            paper["id"], formatted_sections, "model-format", "markdown-format-v1", "wrong"
        )
