from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from collections.abc import Callable
from typing import Any


GRAPH_SCHEMA_VERSION = 1


def normalize_title(value: str) -> str:
    return " ".join(re.findall(r"[\w]+", value.casefold(), flags=re.UNICODE))


def _reference_id(raw: str) -> str:
    return "ref-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def extract_references(document: dict[str, Any]) -> list[dict[str, Any]]:
    reference_texts: list[str] = []
    for section in document.get("sections", []):
        markdown = str(section.get("markdown", ""))
        heading = re.search(r"\bREFERENCES\b", markdown, flags=re.IGNORECASE)
        if heading:
            reference_texts.append(markdown[heading.end():])
    if not reference_texts:
        return []

    text = "\n".join(reference_texts)
    markers = list(re.finditer(r"(?:^|\s)\[(\d{1,3})\]\s+", text))
    references: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        raw = " ".join(text[marker.end():end].split()).strip(" ,;.")
        if len(raw) < 12:
            continue
        quoted = re.search(r"[\"“]([^\"”]{8,300})[\"”]", raw)
        title = quoted.group(1).strip(" ,;.") if quoted else ""
        if not title:
            candidates = [part.strip(" ,;.") for part in raw.split(",")]
            title = max((part for part in candidates if 12 <= len(part) <= 240), key=len, default=raw[:240])
        doi_match = re.search(r"\b10\.\d{4,9}/[-._;()/:A-Z0-9]+", raw, flags=re.IGNORECASE)
        arxiv_match = re.search(r"\barXiv\s*:?\s*(\d{4}\.\d{4,5}(?:v\d+)?)", raw, flags=re.IGNORECASE)
        year_matches = re.findall(r"\b(?:19|20)\d{2}\b", raw)
        prefix = raw[:quoted.start()] if quoted else raw.split(",", 1)[0]
        authors = [
            author.strip(" ,;.")
            for author in re.split(r"\s+(?:and|&)\s+|;", prefix)
            if author.strip(" ,;.")
        ][:12]
        key = (doi_match.group(0).lower().rstrip(".,;") if doi_match else normalize_title(title))
        if not key or key in seen:
            continue
        seen.add(key)
        references.append(
            {
                "id": _reference_id(raw),
                "index": int(marker.group(1)),
                "title": title,
                "authors": authors,
                "year": int(year_matches[-1]) if year_matches else None,
                "venue": None,
                "doi": doi_match.group(0).rstrip(".,;") if doi_match else None,
                "arxiv": arxiv_match.group(1) if arxiv_match else None,
                "rawCitation": raw,
                "resolvedPaperId": None,
            }
        )
    return references


def reference_key(reference: dict[str, Any]) -> str:
    if reference.get("doi"):
        return "doi:" + str(reference["doi"]).casefold()
    if reference.get("arxiv"):
        return "arxiv:" + str(reference["arxiv"]).casefold()
    return "title:" + normalize_title(str(reference.get("title", "")))


def build_two_level_graph(
    root_paper_id: str,
    papers: list[dict[str, Any]],
    load_references: Callable[[str], list[dict[str, Any]]],
    max_depth: int = 2,
) -> dict[str, Any]:
    if max_depth not in {1, 2}:
        raise ValueError("Citation graph maxDepth must be 1 or 2")
    paper_by_id = {paper["id"]: paper for paper in papers}
    root = paper_by_id.get(root_paper_id)
    if not root:
        raise KeyError(f"Unknown paper: {root_paper_id}")

    normalized_papers: dict[str, list[str]] = defaultdict(list)
    for paper in papers:
        normalized = normalize_title(str(paper.get("title", "")))
        if normalized:
            normalized_papers[normalized].append(paper["id"])

    def resolve(reference: dict[str, Any]) -> str | None:
        normalized = normalize_title(str(reference.get("title", "")))
        exact = normalized_papers.get(normalized, [])
        if len(exact) == 1:
            return exact[0]
        if len(normalized) >= 24:
            candidates = [
                paper_id
                for title, ids in normalized_papers.items()
                if normalized in title or title in normalized
                for paper_id in ids
            ]
            if len(set(candidates)) == 1:
                return candidates[0]
        return None

    nodes: dict[str, dict[str, Any]] = {
        root_paper_id: {
            "id": root_paper_id,
            "paperId": root_paper_id,
            "title": root["title"],
            "authors": root.get("authors", []),
            "year": root.get("year"),
            "depth": 0,
            "degree": 0,
            "resolved": True,
            "status": "ready",
        }
    }
    edges: dict[tuple[str, str, str], dict[str, Any]] = {}
    reference_nodes: dict[str, str] = {}
    direct_ids: list[str] = []
    references_by_direct: dict[str, list[dict[str, Any]]] = {}
    warnings: list[str] = []

    def add_reference(reference: dict[str, Any], depth: int) -> str:
        resolved_id = resolve(reference)
        key = reference_key(reference)
        node_id = resolved_id or reference_nodes.get(key) or reference["id"]
        reference_nodes[key] = node_id
        if node_id == root_paper_id:
            return node_id
        existing = nodes.get(node_id)
        if existing:
            existing["depth"] = min(existing["depth"], depth)
            return node_id
        paper = paper_by_id.get(resolved_id) if resolved_id else None
        nodes[node_id] = {
            "id": node_id,
            "paperId": resolved_id,
            "title": paper["title"] if paper else reference["title"],
            "authors": reference.get("authors", []),
            "year": reference.get("year"),
            "depth": depth,
            "degree": 0,
            "resolved": bool(resolved_id),
            "status": "ready" if resolved_id else "unresolved",
            "doi": reference.get("doi"),
            "arxiv": reference.get("arxiv"),
            "rawCitation": reference.get("rawCitation"),
        }
        return node_id

    def add_edge(source: str, target: str, relation: str, weight: int = 1) -> None:
        if source == target:
            return
        edge_key = (source, target, relation)
        if edge_key in edges:
            edges[edge_key]["weight"] += weight
            return
        edges[edge_key] = {
            "id": f"{relation}:{source}:{target}",
            "source": source,
            "target": target,
            "relation": relation,
            "weight": weight,
        }

    root_references = load_references(root_paper_id)
    for reference in root_references:
        reference["resolvedPaperId"] = resolve(reference)
        node_id = add_reference(reference, 1)
        add_edge(root_paper_id, node_id, "cites")
        if node_id != root_paper_id and node_id not in direct_ids:
            direct_ids.append(node_id)

    if max_depth == 2:
        for direct_id in direct_ids:
            direct = nodes[direct_id]
            if not direct.get("paperId"):
                warnings.append(f"Second-level references unavailable for unresolved paper: {direct['title']}")
                continue
            references = load_references(direct["paperId"])
            references_by_direct[direct_id] = references
            for reference in references:
                reference["resolvedPaperId"] = resolve(reference)
                target_id = add_reference(reference, 2)
                add_edge(direct_id, target_id, "cites")

    direct_sets = {
        direct_id: {reference_key(reference) for reference in references}
        for direct_id, references in references_by_direct.items()
    }
    for left_index, left_id in enumerate(direct_ids):
        for right_id in direct_ids[left_index + 1:]:
            shared = direct_sets.get(left_id, set()) & direct_sets.get(right_id, set())
            if shared:
                add_edge(left_id, right_id, "shared_reference", len(shared))
            left_authors = {normalize_title(author) for author in nodes[left_id].get("authors", [])}
            right_authors = {normalize_title(author) for author in nodes[right_id].get("authors", [])}
            if left_authors & right_authors:
                add_edge(left_id, right_id, "coauthor", len(left_authors & right_authors))
            left_targets = {
                resolve(reference) for reference in references_by_direct.get(left_id, [])
            }
            right_targets = {
                resolve(reference) for reference in references_by_direct.get(right_id, [])
            }
            if (
                nodes[right_id].get("paperId") in left_targets
                and nodes[left_id].get("paperId") in right_targets
            ):
                add_edge(left_id, right_id, "mutual_citation")
            left_words = set(normalize_title(nodes[left_id]["title"]).split())
            right_words = set(normalize_title(nodes[right_id]["title"]).split())
            union = left_words | right_words
            similarity = len(left_words & right_words) / len(union) if union else 0
            if similarity >= 0.25:
                add_edge(left_id, right_id, "topic_similarity", max(1, round(similarity * 10)))

    for edge in edges.values():
        nodes[edge["source"]]["degree"] += 1
        nodes[edge["target"]]["degree"] += 1

    unresolved = sum(1 for node in nodes.values() if not node["resolved"])
    status = "ready" if root_references and not warnings else "partial"
    return {
        "schemaVersion": GRAPH_SCHEMA_VERSION,
        "rootPaperId": root_paper_id,
        "maxDepth": max_depth,
        "status": status,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "directCount": sum(1 for node in nodes.values() if node["depth"] == 1),
        "secondLevelCount": sum(1 for node in nodes.values() if node["depth"] == 2),
        "unresolvedCount": unresolved,
        "warnings": warnings,
    }
