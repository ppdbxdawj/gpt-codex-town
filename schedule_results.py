"""Validated local snapshots of explicit ChatGPT scheduled-task results."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from adapters import iso_time
from review_store import application_data_dir


RESULTS_NAME = "cloud-results.json"


def _chat_thread_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("threadUrl must be text.")
    parsed = urlparse(value)
    if (parsed.scheme, parsed.netloc) != ("https", "chatgpt.com") or not parsed.path.startswith("/c/"):
        raise ValueError("threadUrl must be an https://chatgpt.com/c/... link.")
    return value


def review_result_id(result_id: str) -> str:
    """Keep the imported message identity stable without double-prefixing it."""
    return result_id if result_id.startswith("cloud-result:") else f"cloud-result:{result_id}"


class ScheduleResults:
    """Persists only explicit, validated cloud result snapshots."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else application_data_dir() / RESULTS_NAME

    def import_snapshot(self, snapshot: Any) -> dict[str, Any]:
        normalized = self._validate(snapshot)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".cloud-results-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(normalized, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass
            raise
        return normalized

    def state(self) -> dict[str, Any]:
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                snapshot = self._validate(json.load(handle))
        except FileNotFoundError:
            return {"available": False, "observedAt": None, "records": [], "message": "尚未导入云端结果快照。"}
        except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
            return {"available": False, "observedAt": None, "records": [], "message": f"云端结果快照不可用：{type(exc).__name__}。"}
        return {"available": True, "observedAt": snapshot["observedAt"], "records": snapshot["records"], "message": "来自手动导入的云端结果快照。"}

    @staticmethod
    def review_records(records: list[dict[str, Any]], active_ids: set[str]) -> list[dict[str, Any]]:
        return [{
            "id": review_result_id(record["id"]), "dedupKey": f"cloud:{record['id']}",
            "taskId": record["taskId"], "turnId": record["turnId"], "title": record["title"],
            "source": "chatgpt", "createdAt": record["createdAt"], "body": record["body"],
            "summary": record["body"][:240], "threadUrl": record["threadUrl"], "artifacts": [],
        } for record in records if record["automationId"] in active_ids]

    @staticmethod
    def _validate(snapshot: Any) -> dict[str, Any]:
        if not isinstance(snapshot, dict) or snapshot.get("version") != 1:
            raise ValueError("Cloud results snapshot version 1 is required.")
        observed_at = iso_time(snapshot.get("observedAt"))
        if not observed_at or not isinstance(snapshot.get("records"), list):
            raise ValueError("Cloud results require observedAt and records.")
        seen: set[str] = set()
        records: list[dict[str, Any]] = []
        for raw in snapshot["records"]:
            if not isinstance(raw, dict) or "artifacts" in raw:
                raise ValueError("Cloud results cannot include artifacts.")
            automation_id, result_id = raw.get("automationId"), raw.get("id")
            body, title, task_id = raw.get("body"), raw.get("title"), raw.get("taskId")
            if (not isinstance(automation_id, str) or not automation_id.startswith("cloud:")
                    or not isinstance(result_id, str) or not result_id.strip() or result_id in seen
                    or not isinstance(body, str) or not body.strip() or not isinstance(title, str) or not title.strip()
                    or not isinstance(task_id, str) or not task_id.strip()):
                raise ValueError("Cloud result fields are invalid.")
            created_at = iso_time(raw.get("createdAt"))
            if not created_at:
                raise ValueError("Cloud result createdAt must be an ISO timestamp.")
            turn_id = raw.get("turnId")
            if turn_id is not None and not isinstance(turn_id, str):
                raise ValueError("turnId must be text or null.")
            provenance = raw.get("provenance")
            if not isinstance(provenance, str) or not provenance.strip():
                raise ValueError("Cloud result provenance is required.")
            seen.add(result_id)
            records.append({"automationId": automation_id, "id": result_id.strip(), "taskId": task_id.strip(),
                            "turnId": turn_id, "title": title.strip(), "body": body.strip(), "createdAt": created_at,
                            "threadUrl": _chat_thread_url(raw.get("threadUrl")), "provenance": provenance.strip()})
        return {"version": 1, "observedAt": observed_at, "records": records}
