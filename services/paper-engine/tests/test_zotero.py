from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from pypdf import PdfWriter

from p2i_engine.library import Library
from p2i_engine.zotero import ZoteroImporter, ZoteroLockedError


def make_pdf(path: Path, pages: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    with path.open("wb") as stream:
        writer.write(stream)


def make_zotero(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    database = data_dir / "zotero.sqlite"
    with sqlite3.connect(database) as connection:
        connection.executescript("""
        CREATE TABLE items(itemID INTEGER PRIMARY KEY, key TEXT);
        CREATE TABLE itemAttachments(itemID INTEGER, parentItemID INTEGER, path TEXT, contentType TEXT, storageModTime INTEGER);
        CREATE TABLE deletedItems(itemID INTEGER);
        CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER);
        CREATE TABLE fields(fieldID INTEGER, fieldName TEXT);
        CREATE TABLE itemDataValues(valueID INTEGER, value TEXT);
        CREATE TABLE itemCreators(itemID INTEGER, creatorID INTEGER, orderIndex INTEGER);
        CREATE TABLE creators(creatorID INTEGER, firstName TEXT, lastName TEXT);
        CREATE TABLE collections(collectionID INTEGER, collectionName TEXT, parentCollectionID INTEGER);
        CREATE TABLE collectionItems(collectionID INTEGER, itemID INTEGER, orderIndex INTEGER);
        INSERT INTO items VALUES (1, 'ITEMKEY'), (2, 'ATTACHKEY');
        INSERT INTO itemAttachments VALUES (2, 1, 'storage:paper.pdf', 'application/pdf', 1);
        INSERT INTO fields VALUES (1, 'title'), (2, 'date'), (3, 'DOI');
        INSERT INTO itemDataValues VALUES (1, 'Test paper'), (2, '2025'), (3, '10.1/test');
        INSERT INTO itemData VALUES (1,1,1), (1,2,2), (1,3,3);
        INSERT INTO creators VALUES (1, 'Ada', 'Lovelace');
        INSERT INTO itemCreators VALUES (1,1,0);
        INSERT INTO collections VALUES (1, 'FinFT', NULL);
        INSERT INTO collectionItems VALUES (1,1,0);
        """)
    make_pdf(data_dir / "storage" / "ATTACHKEY" / "paper.pdf")


def test_zotero_inspection_and_candidate_resolution(tmp_path: Path) -> None:
    make_zotero(tmp_path)
    importer = ZoteroImporter(tmp_path)

    inspection = importer.inspect()
    candidates = importer.candidates()

    assert inspection["locked"] is False
    assert inspection["pdfCount"] == 1
    assert candidates[0]["title"] == "Test paper"
    assert candidates[0]["authors"] == ["Ada Lovelace"]
    assert candidates[0]["category"] == "finft"
    assert Path(candidates[0]["sourcePath"]).is_file()


def test_zotero_journal_blocks_formal_import(tmp_path: Path) -> None:
    make_zotero(tmp_path)
    (tmp_path / "zotero.sqlite-journal").write_bytes(b"active")
    importer = ZoteroImporter(tmp_path)

    assert importer.inspect()["locked"] is True
    with pytest.raises(ZoteroLockedError):
        importer.candidates()


def test_stratified_sample_uses_fixed_quotas() -> None:
    assert ZoteroImporter.QUOTAS == {"finft": 13, "multimodal": 17}
    candidates = []
    for category, count in {"finft": 20, "multimodal": 20, "icassp": 8, "unfiled": 8}.items():
        for index in range(count):
            candidates.append({
                "attachmentKey": f"{category}-{index}", "sha256": f"{len(candidates):064x}",
                "pageCount": [6, 11, 22][index % 3], "category": category, "selected": False,
            })

    result = ZoteroImporter.recommended_sample(candidates)
    selected = [item for item in result if item["selected"]]

    assert len(selected) == 30
    assert {category: sum(item["category"] == category for item in selected) for category in ZoteroImporter.QUOTAS} == ZoteroImporter.QUOTAS


def test_copy_is_atomic_and_hash_verified(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    make_pdf(source)
    from p2i_engine.zotero.importer import _sha256
    candidate = {
        "sourcePath": str(source), "sha256": _sha256(source), "collections": ["FinFT"],
        "attachmentKey": "ATTACHKEY",
    }

    target = ZoteroImporter.copy_candidate(candidate, tmp_path / "Papers")

    assert target.is_file()
    assert target.parent.name == "FinFT"
    assert not list(target.parent.glob("*.part"))


def test_import_reresolves_zotero_attachment_and_enqueues_parse(tmp_path: Path) -> None:
    zotero_dir = tmp_path / "zotero"
    make_zotero(zotero_dir)
    library = Library(tmp_path / "library")
    candidate = ZoteroImporter(zotero_dir).candidates()[0]
    # The service must ignore mutable path, hash, and metadata sent by the UI.
    requested = {
        **candidate,
        "selected": True,
        "sourcePath": str(tmp_path / "outside.pdf"),
        "sha256": "0" * 64,
        "title": "Untrusted title",
    }

    result = library.import_zotero([requested], zotero_dir)

    target = library.papers_dir / "Zotero" / "FinFT" / "paper.pdf"
    assert result["selected"] == 1
    assert result["copied"] == 1
    assert result["enqueued"] == 1
    assert target.is_file()
    with library.db.connect() as connection:
        job = connection.execute("SELECT status FROM jobs").fetchone()
        stage = connection.execute("SELECT stage, status FROM job_stages").fetchone()
        source = connection.execute("SELECT metadata_json FROM paper_sources").fetchone()
        parse_runs = connection.execute("SELECT COUNT(*) FROM parse_runs").fetchone()[0]
    assert job["status"] == "DISCOVERED"
    assert dict(stage) == {"stage": "hash", "status": "pending"}
    assert parse_runs == 0
    assert json.loads(source["metadata_json"])["title"] == "Test paper"


def test_import_rejects_unknown_attachment_before_copying(tmp_path: Path) -> None:
    zotero_dir = tmp_path / "zotero"
    make_zotero(zotero_dir)
    library = Library(tmp_path / "library")

    with pytest.raises(ValueError, match="unavailable"):
        library.import_zotero([{"attachmentKey": "MISSING", "selected": True}], zotero_dir)

    assert not list(library.papers_dir.rglob("*.pdf"))
