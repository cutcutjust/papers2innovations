from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pypdf import PdfReader


class ZoteroLockedError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_segment(value: str, fallback: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", value).strip(" .")
    value = re.sub(r"\s+", " ", value)
    return (value[:120] or fallback).strip()


class ZoteroImporter:
    QUOTAS = {"finft": 13, "multimodal": 17}

    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir).resolve() if data_dir else self.discover_data_dir()
        self.database_path = self.data_dir / "zotero.sqlite"

    @staticmethod
    def discover_data_dir() -> Path:
        profile_root = Path(os.environ.get("APPDATA", "")) / "Zotero" / "Zotero" / "Profiles"
        for prefs in sorted(profile_root.glob("*/prefs.js"), key=lambda path: path.stat().st_mtime, reverse=True):
            text = prefs.read_text(encoding="utf-8", errors="replace")
            use_custom = re.search(r'user_pref\("extensions\.zotero\.useDataDir",\s*true\)', text)
            match = re.search(r'user_pref\("extensions\.zotero\.dataDir",\s*"((?:\\.|[^"])*)"\)', text)
            if use_custom and match:
                decoded = bytes(match.group(1), "utf-8").decode("unicode_escape")
                candidate = Path(decoded)
                if (candidate / "zotero.sqlite").exists():
                    return candidate.resolve()
        default = Path.home() / "Zotero"
        if (default / "zotero.sqlite").exists():
            return default.resolve()
        raise FileNotFoundError("No Zotero data directory was found")

    def lock_reason(self) -> str | None:
        if not self.database_path.exists():
            return "zotero.sqlite does not exist"
        journal = self.database_path.with_name("zotero.sqlite-journal")
        wal = self.database_path.with_name("zotero.sqlite-wal")
        if journal.exists() and journal.stat().st_size > 0:
            return "Zotero database has an active rollback journal; close Zotero cleanly"
        if wal.exists() and wal.stat().st_size > 0:
            return "Zotero database has an active WAL; close Zotero cleanly"
        try:
            with self._connect() as connection:
                connection.execute("SELECT COUNT(*) FROM items").fetchone()
        except sqlite3.Error as error:
            return f"Zotero database is locked: {error}"
        return None

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            f"file:{self.database_path.as_posix()}?mode=ro", uri=True, timeout=1
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        return connection

    def inspect(self) -> dict[str, Any]:
        reason = self.lock_reason()
        result: dict[str, Any] = {
            "dataDir": str(self.data_dir),
            "databasePath": str(self.database_path),
            "locked": reason is not None,
            "lockReason": reason,
            "itemCount": 0,
            "pdfCount": 0,
            "missingPdfCount": 0,
            "collections": [],
        }
        if reason:
            return result
        with self._connect() as connection:
            result["itemCount"] = connection.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            result["collections"] = [
                {"id": row["collectionID"], "name": row["collectionName"], "parentId": row["parentCollectionID"]}
                for row in connection.execute(
                    "SELECT collectionID, collectionName, parentCollectionID FROM collections ORDER BY collectionID"
                )
            ]
            rows = self._attachment_rows(connection)
            result["pdfCount"] = len(rows)
            result["missingPdfCount"] = sum(not self._resolve_path(row).exists() for row in rows)
        return result

    @staticmethod
    def _attachment_rows(
        connection: sqlite3.Connection, attachment_keys: set[str] | None = None
    ) -> list[sqlite3.Row]:
        query = (
            "SELECT a.itemID attachmentID, a.key attachmentKey, ia.parentItemID, ia.path, "
            "ia.storageModTime, p.key itemKey "
            "FROM itemAttachments ia JOIN items a ON a.itemID = ia.itemID "
            "JOIN items p ON p.itemID = ia.parentItemID "
            "LEFT JOIN deletedItems d ON d.itemID = a.itemID "
            "WHERE d.itemID IS NULL AND lower(ia.contentType) = 'application/pdf'"
        )
        parameters: tuple[str, ...] = ()
        if attachment_keys:
            placeholders = ",".join("?" for _ in attachment_keys)
            query += f" AND a.key IN ({placeholders})"
            parameters = tuple(sorted(attachment_keys))
        return connection.execute(f"{query} ORDER BY a.itemID", parameters).fetchall()

    def _resolve_path(self, row: sqlite3.Row) -> Path:
        value = row["path"] or ""
        if value.startswith("storage:"):
            return self.data_dir / "storage" / row["attachmentKey"] / value.removeprefix("storage:")
        if value.startswith("attachments:"):
            raise ValueError("Linked attachment base directories are not supported in this milestone")
        return Path(value)

    @staticmethod
    def _metadata(connection: sqlite3.Connection, item_id: int) -> dict[str, str]:
        fields = {
            row["fieldName"]: row["value"]
            for row in connection.execute(
                "SELECT f.fieldName, v.value FROM itemData d "
                "JOIN fields f ON f.fieldID = d.fieldID "
                "JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID = ?",
                (item_id,),
            )
        }
        creators = [
            " ".join(part for part in (row["firstName"], row["lastName"]) if part).strip()
            for row in connection.execute(
                "SELECT c.firstName, c.lastName FROM itemCreators ic "
                "JOIN creators c ON c.creatorID = ic.creatorID WHERE ic.itemID = ? ORDER BY ic.orderIndex",
                (item_id,),
            )
        ]
        fields["authors"] = json.dumps(creators, ensure_ascii=False)
        return fields

    @staticmethod
    def _collections(connection: sqlite3.Connection, item_id: int) -> list[str]:
        return [
            row["collectionName"]
            for row in connection.execute(
                "SELECT c.collectionName FROM collectionItems ci "
                "JOIN collections c ON c.collectionID = ci.collectionID WHERE ci.itemID = ? ORDER BY c.collectionID",
                (item_id,),
            )
        ]

    @staticmethod
    def _category(collections: list[str]) -> str:
        if "多模态与会话情绪识别" in collections:
            return "multimodal"
        if "FinFT" in collections:
            return "finft"
        if "ICASSP-2026" in collections:
            return "icassp"
        return "unfiled"

    def candidates(self, attachment_keys: set[str] | None = None) -> list[dict[str, Any]]:
        reason = self.lock_reason()
        if reason:
            raise ZoteroLockedError(reason)
        candidates: list[dict[str, Any]] = []
        with self._connect() as connection:
            for row in self._attachment_rows(connection, attachment_keys):
                path = self._resolve_path(row)
                if not path.exists():
                    continue
                metadata = self._metadata(connection, row["parentItemID"])
                collections = self._collections(connection, row["parentItemID"])
                date = metadata.get("date", "")
                year_match = re.search(r"(?:19|20)\d{2}", date)
                try:
                    page_count = len(PdfReader(str(path), strict=False).pages)
                except Exception:
                    page_count = 0
                candidates.append(
                    {
                        "attachmentKey": row["attachmentKey"],
                        "itemKey": row["itemKey"],
                        "title": metadata.get("title") or path.stem,
                        "authors": json.loads(metadata.pop("authors", "[]")),
                        "year": int(year_match.group()) if year_match else None,
                        "doi": metadata.get("DOI"),
                        "collections": collections,
                        "sourcePath": str(path),
                        "filename": path.name,
                        "sha256": _sha256(path),
                        "pageCount": page_count,
                        "sizeBytes": path.stat().st_size,
                        "sourceModifiedAt": datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat(),
                        "category": self._category(collections),
                        "selected": False,
                        "metadata": metadata,
                    }
                )
        return candidates

    @staticmethod
    def _bucket(page_count: int) -> int:
        return 0 if page_count <= 8 else 1 if page_count <= 15 else 2

    @classmethod
    def recommended_sample(cls, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for candidate in candidates:
            by_category[candidate["category"]].append(candidate)
        selected: list[dict[str, Any]] = []
        selected_keys: set[str] = set()
        for category, quota in cls.QUOTAS.items():
            buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
            for candidate in by_category[category]:
                buckets[cls._bucket(candidate["pageCount"])].append(candidate)
            for values in buckets.values():
                values.sort(key=lambda item: (item["sha256"], item["attachmentKey"]))
            while len([item for item in selected if item["category"] == category]) < quota:
                progressed = False
                for bucket in (0, 1, 2):
                    if buckets[bucket]:
                        item = buckets[bucket].pop(0)
                        selected.append(item)
                        selected_keys.add(item["attachmentKey"])
                        progressed = True
                        if len([entry for entry in selected if entry["category"] == category]) >= quota:
                            break
                if not progressed:
                    break
        if len(selected) < 30:
            remaining = sorted(
                (item for item in candidates if item["attachmentKey"] not in selected_keys),
                key=lambda item: (cls._bucket(item["pageCount"]), item["sha256"]),
            )
            selected.extend(remaining[: 30 - len(selected)])
        chosen = {item["attachmentKey"] for item in selected[:30]}
        return [{**item, "selected": item["attachmentKey"] in chosen} for item in candidates]

    @staticmethod
    def copy_candidate(candidate: dict[str, Any], papers_dir: Path) -> Path:
        source = Path(candidate["sourcePath"])
        collection = candidate["collections"][0] if candidate["collections"] else "Unfiled"
        target_dir = papers_dir / "Zotero" / _safe_segment(collection, "Unfiled")
        target_dir.mkdir(parents=True, exist_ok=True)
        stem = _safe_segment(source.stem, candidate["attachmentKey"])
        target = target_dir / f"{stem}.pdf"
        if target.exists() and _sha256(target) == candidate["sha256"]:
            return target
        if target.exists():
            target = target_dir / f"{stem}-{candidate['attachmentKey']}.pdf"
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
        shutil.copyfile(source, temporary)
        if _sha256(temporary) != candidate["sha256"]:
            temporary.unlink(missing_ok=True)
            raise IOError(f"SHA-256 mismatch while copying {source.name}")
        os.replace(temporary, target)
        return target
