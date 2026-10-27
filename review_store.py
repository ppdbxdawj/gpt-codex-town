"""Persistent local review inbox for the desktop Star Sugar Manor app."""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from adapters import allowed_artifact


_DONT_NOTIFY_HEARTBEAT = re.compile(
    r"^\s*<heartbeat\b[^>]*>.*?<decision>\s*DONT_NOTIFY\s*</decision>.*?</heartbeat>\s*$",
    re.IGNORECASE | re.DOTALL,
)


def is_non_notifying_heartbeat(body: str) -> bool:
    """Recognize only a complete internal no-notification control envelope."""
    return bool(_DONT_NOTIFY_HEARTBEAT.fullmatch(body or ""))


def application_data_dir() -> Path:
    override = os.environ.get("MANOR_DATA_DIR")
    return Path(override).expanduser() if override else Path.home() / "Library" / "Application Support" / "StarSugarManor"


class ReviewStore:
    """Stores user review choices separately from all Codex source data."""

    def __init__(self, database_path: Path | None = None):
        self.database_path = Path(database_path) if database_path else application_data_dir() / "reviews.sqlite3"
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.database_path)
        self.connection.row_factory = sqlite3.Row
        self._create_schema()

    def close(self) -> None:
        self.connection.close()

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS review_results (
                id TEXT PRIMARY KEY,
                dedup_key TEXT NOT NULL UNIQUE,
                task_id TEXT NOT NULL,
                turn_id TEXT,
                title TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                body TEXT NOT NULL,
                summary TEXT NOT NULL,
                thread_url TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'accepted')),
                read_at TEXT,
                accepted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS review_artifacts (
                result_id TEXT NOT NULL REFERENCES review_results(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                cwd TEXT,
                url TEXT NOT NULL,
                PRIMARY KEY (result_id, id)
            );
            CREATE INDEX IF NOT EXISTS review_results_created_at ON review_results(created_at DESC);
            """
        )
        self.connection.commit()

    def import_results(self, records: Iterable[dict[str, Any]]) -> None:
        """Add source results idempotently without overwriting review choices."""
        records = list(records)
        self._validate_records(records)
        with self.connection:
            for record in records:
                self.connection.execute(
                    """INSERT INTO review_results
                       (id, dedup_key, task_id, turn_id, title, source, created_at, body, summary, thread_url, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread')
                       ON CONFLICT(dedup_key) DO UPDATE SET
                         title=excluded.title, source=excluded.source, created_at=excluded.created_at,
                         body=excluded.body, summary=excluded.summary, thread_url=excluded.thread_url""",
                    (record["id"], record["dedupKey"], record["taskId"], record.get("turnId"), record["title"],
                     record["source"], record["createdAt"], record["body"], record["summary"], record["threadUrl"]),
                )
                for artifact in record.get("artifacts", []):
                    self.connection.execute(
                        """INSERT INTO review_artifacts (result_id, id, name, path, cwd, url)
                           VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT(result_id, id) DO UPDATE SET
                             name=excluded.name, path=excluded.path, cwd=excluded.cwd, url=excluded.url""",
                        (record["id"], artifact["id"], artifact["name"], artifact["path"], record.get("cwd"), artifact["url"]),
                    )

    @staticmethod
    def _validate_records(records: list[dict[str, Any]]) -> None:
        required = {"id", "dedupKey", "taskId", "title", "source", "createdAt", "body", "summary", "threadUrl"}
        for record in records:
            if not isinstance(record, dict) or not required.issubset(record):
                raise ValueError("Invalid review result record.")
            if record["source"] not in {"codex", "chatgpt"}:
                raise ValueError("Unsupported review result source.")
            if not isinstance(record.get("artifacts", []), list):
                raise ValueError("Artifacts must be a list.")
            if record["source"] == "chatgpt":
                if record["artifacts"] or not str(record["dedupKey"]).startswith("cloud:"):
                    raise ValueError("Cloud results require cloud dedup keys and no artifacts.")
                parsed = re.match(r"^https://chatgpt\.com/c/", str(record["threadUrl"]))
                if not parsed:
                    raise ValueError("Cloud results require a ChatGPT conversation URL.")
            for artifact in record.get("artifacts", []):
                if not {"id", "name", "path", "url"}.issubset(artifact):
                    raise ValueError("Invalid review artifact.")

    def mark_read(self, result_id: str) -> None:
        self._update_status(result_id, "read")

    def accept(self, result_id: str) -> None:
        self._update_status(result_id, "accepted")

    def reopen(self, result_id: str) -> None:
        if not self._exists(result_id):
            raise KeyError("Unknown inbox item.")
        with self.connection:
            self.connection.execute("UPDATE review_results SET status='read', accepted_at=NULL WHERE id=?", (result_id,))

    def _update_status(self, result_id: str, status: str) -> None:
        if not self._exists(result_id):
            raise KeyError("Unknown inbox item.")
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with self.connection:
            if status == "read":
                # Reading an accepted item must never revoke the acceptance.
                self.connection.execute(
                    "UPDATE review_results SET status=CASE WHEN status='unread' THEN 'read' ELSE status END, "
                    "read_at=COALESCE(read_at, ?) WHERE id=?", (now, result_id)
                )
            else:
                self.connection.execute(
                    "UPDATE review_results SET status='accepted', read_at=COALESCE(read_at, ?), accepted_at=? WHERE id=?",
                    (now, now, result_id),
                )

    def _exists(self, result_id: str) -> bool:
        return self.connection.execute("SELECT 1 FROM review_results WHERE id=?", (result_id,)).fetchone() is not None

    def inbox(self, limit: int = 200) -> dict[str, Any]:
        # Filter at read time so a previous version's imported control messages
        # are hidden without deleting history or changing a genuine result.
        visible_rows = [dict(row) for row in self.connection.execute(
            "SELECT * FROM review_results ORDER BY created_at DESC, id DESC"
        ).fetchall() if not is_non_notifying_heartbeat(row["body"])]
        items = [self._item(row) for row in visible_rows[:limit]]
        counts: dict[str, int] = {}
        for row in visible_rows:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        return {
            "items": items,
            "pendingCount": counts.get("unread", 0) + counts.get("read", 0),
            "unreadCount": counts.get("unread", 0),
            "acceptedCount": counts.get("accepted", 0),
        }

    def _item(self, row: dict[str, Any]) -> dict[str, Any]:
        artifacts = [dict(artifact) for artifact in self.connection.execute(
            "SELECT id, name, path, url FROM review_artifacts WHERE result_id=? ORDER BY name", (row["id"],)
        )]
        return {
            "id": row["id"], "taskId": row["task_id"], "turnId": row["turn_id"], "title": row["title"],
            "source": row["source"], "createdAt": row["created_at"], "body": row["body"], "summary": row["summary"],
            "threadUrl": row["thread_url"], "artifacts": artifacts, "status": row["status"],
            "readAt": row["read_at"], "acceptedAt": row["accepted_at"],
        }

    def artifact_path(self, result_id: str, artifact_id: str) -> str:
        row = self.connection.execute(
            "SELECT path, cwd FROM review_artifacts WHERE result_id=? AND id=?", (result_id, artifact_id)
        ).fetchone()
        if row is None:
            raise KeyError("Unknown artifact.")
        safe_path = allowed_artifact(row["path"], row["cwd"])
        if not safe_path:
            raise ValueError("Artifact is no longer available at a permitted local path.")
        return str(safe_path)

    def latest_for_task(self, task_id: str) -> dict[str, Any] | None:
        rows = self.connection.execute(
            "SELECT * FROM review_results WHERE task_id=? ORDER BY created_at DESC, id DESC", (task_id,)
        ).fetchall()
        for row in rows:
            if not is_non_notifying_heartbeat(row["body"]):
                return self._item(dict(row))
        return None

    def get_item(self, result_id: str) -> dict[str, Any] | None:
        """Return one visible stored result by its immutable result id."""
        row = self.connection.execute("SELECT * FROM review_results WHERE id=?", (result_id,)).fetchone()
        if row is None or is_non_notifying_heartbeat(row["body"]):
            return None
        return self._item(dict(row))
