from __future__ import annotations

from typing import Any

import pytest

from p2i_engine.citations import build_two_level_graph, extract_references


def reference(title: str, identifier: str) -> dict[str, Any]:
    return {
        "id": identifier,
        "index": 1,
        "title": title,
        "authors": [],
        "year": 2024,
        "venue": None,
        "doi": None,
        "arxiv": None,
        "rawCitation": title,
        "resolvedPaperId": None,
    }


def test_extracts_structured_references_and_deduplicates() -> None:
    document = {
        "sections": [
            {
                "markdown": (
                    "4. CONCLUSION\n\nREFERENCES\n"
                    "[1] A. Author and B. Writer, “Grounded Graph Research,” Journal, 2024. "
                    "doi:10.1000/example.1\n"
                    "[2] C. Author, “Second Scientific Work,” arXiv:2401.12345, 2023.\n"
                    "[3] A. Author, “Grounded Graph Research,” Journal, 2024. doi:10.1000/example.1"
                )
            }
        ]
    }

    references = extract_references(document)

    assert len(references) == 2
    assert references[0]["title"] == "Grounded Graph Research"
    assert references[0]["doi"] == "10.1000/example.1"
    assert references[1]["arxiv"] == "2401.12345"


def test_two_level_graph_handles_cycles_duplicates_and_relationships() -> None:
    papers = [
        {"id": "root", "title": "Root Paper"},
        {"id": "paper-b", "title": "Direct Paper B"},
        {"id": "paper-d", "title": "Direct Paper D"},
    ]
    references = {
        "root": [
            reference("Direct Paper B", "b"),
            reference("Direct Paper D", "d"),
            reference("Unresolved Direct Paper", "missing"),
            reference("Unresolved Direct Paper", "missing-duplicate"),
        ],
        "paper-b": [reference("Root Paper", "cycle-root"), reference("Direct Paper D", "b-cites-d"), reference("Shared Work X", "x1")],
        "paper-d": [reference("Direct Paper B", "d-cites-b"), reference("Shared Work X", "x2")],
    }

    graph = build_two_level_graph("root", papers, lambda paper_id: references.get(paper_id, []))

    assert graph["maxDepth"] == 2
    assert graph["directCount"] == 3
    assert graph["secondLevelCount"] == 1
    assert len([node for node in graph["nodes"] if node["id"] == "root"]) == 1
    assert len([node for node in graph["nodes"] if node["title"] == "Shared Work X"]) == 1
    assert any(edge["relation"] == "shared_reference" for edge in graph["edges"])
    assert any(edge["relation"] == "mutual_citation" for edge in graph["edges"])
    assert graph["status"] == "partial"


def test_graph_rejects_expansion_beyond_depth_two() -> None:
    papers = [{"id": "root", "title": "Root Paper"}]
    with pytest.raises(ValueError, match="maxDepth"):
        build_two_level_graph("root", papers, lambda _: [], max_depth=3)
