"""Validated, local-only storage for manually observed ChatGPT schedules.

The scheduled-task page has no local live API.  This module therefore treats
an import as an observation with an explicit timestamp, never as live state.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from adapters import iso_time, utc_now
from review_store import application_data_dir


SNAPSHOT_NAME = "cloud-snapshot.json"
_SCHEDULE_STATUSES = {"ACTIVE", "PAUSED", "COMPLETED"}
_EXECUTION_STATUSES = {"unknown", "running", "waiting", "completed", "failed", "interrupted"}


def _chatgpt_url(value: Any) -> str | None:
    """Return a safe ChatGPT link, or ``None`` for an absent link."""
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("A threadUrl must be a string.")
    parsed = urlparse(value)
    if (parsed.scheme != "https" or parsed.netloc != "chatgpt.com" or not parsed.path.startswith("/")
            or parsed.username or parsed.password or parsed.fragment):
        raise ValueError("A threadUrl must be an https://chatgpt.com link with a valid path.")
    return value


def _timestamp(value: Any, label: str) -> str:
    parsed = iso_time(value)
    if not parsed:
        raise ValueError(f"{label} must be an ISO timestamp.")
    return parsed


class CloudCatalog:
    """Owns only the imported schedule snapshot in the app-data directory."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else application_data_dir() / SNAPSHOT_NAME

    def import_snapshot(self, snapshot: Any) -> dict[str, Any]:
        normalized = self._validate(snapshot)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".cloud-snapshot-", suffix=".tmp", dir=self.path.parent)
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

    def state(self, now: dt.datetime | None = None) -> dict[str, Any]:
        now = now or utc_now()
        try:
            with self.path.open("r", encoding="utf-8") as handle:
                snapshot = self._validate(json.load(handle))
        except FileNotFoundError:
            return self._empty("尚未导入 ChatGPT 计划快照。")
        except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
            return self._empty(f"ChatGPT 计划快照不可用：{type(exc).__name__}。")

        observed = dt.datetime.fromisoformat(snapshot["observedAt"].replace("Z", "+00:00"))
        stale = now - observed > dt.timedelta(hours=24)
        two_minutes_old = now - observed > dt.timedelta(minutes=2)
        records: list[dict[str, Any]] = []
        for record in snapshot["records"]:
            execution = record.get("executionStatus", "unknown")
            # A hand-captured in-progress indication has a very short useful
            # life; schedule status such as ACTIVE never reaches this branch.
            if execution == "running" and two_minutes_old:
                execution = "unknown"
            records.append({
                # Imported IDs are deliberately local labels such as
                # ``cloud:schedule-01`` rather than a copied platform ID.
                "id": record["id"],
                "name": record["name"],
                "status": record["status"],
                "source": "chatgpt",
                "cloud": True,
                "scheduleLabel": record["scheduleLabel"],
                "nextDisplay": record.get("nextDisplay"),
                "lastDisplay": record.get("lastDisplay"),
                "threadUrl": record.get("threadUrl") or "https://chatgpt.com/scheduled",
                "observedAt": snapshot["observedAt"],
                "executionStatus": execution,
                "freshness": "stale" if stale else "snapshot",
            })
        message = "来自已观察的 ChatGPT 计划页快照，不会持续实时同步。"
        if stale:
            message = "ChatGPT 计划快照已超过 24 小时，请在计划页重新采集。"
        return {"available": True, "observedAt": snapshot["observedAt"], "stale": stale,
                "mode": "snapshot", "message": message, "records": records,
                "sourceUrl": snapshot["sourceUrl"]}

    @staticmethod
    def _empty(message: str) -> dict[str, Any]:
        return {"available": False, "observedAt": None, "stale": True, "mode": "snapshot",
                "message": message, "records": [], "sourceUrl": "https://chatgpt.com/scheduled"}

    @staticmethod
    def _validate(snapshot: Any) -> dict[str, Any]:
        if not isinstance(snapshot, dict) or snapshot.get("version") != 1:
            raise ValueError("Cloud snapshot version 1 is required.")
        observed_at = _timestamp(snapshot.get("observedAt"), "observedAt")
        source_url = _chatgpt_url(snapshot.get("sourceUrl"))
        if source_url != "https://chatgpt.com/scheduled":
            raise ValueError("sourceUrl must be https://chatgpt.com/scheduled.")
        incoming = snapshot.get("records")
        if not isinstance(incoming, list):
            raise ValueError("Cloud snapshot records must be a list.")
        ids: set[str] = set()
        records: list[dict[str, Any]] = []
        for raw in incoming:
            if not isinstance(raw, dict):
                raise ValueError("Each cloud schedule must be an object.")
            source_id, name = raw.get("id"), raw.get("name")
            if (not isinstance(source_id, str) or not source_id.startswith("cloud:")
                    or not isinstance(name, str) or not name.strip()):
                raise ValueError("Each cloud schedule needs a local cloud: id and name.")
            if source_id in ids:
                raise ValueError("Cloud schedule ids must be unique.")
            ids.add(source_id)
            status = raw.get("status")
            if status not in _SCHEDULE_STATUSES:
                raise ValueError("Cloud schedule status is invalid.")
            schedule = raw.get("scheduleLabel")
            if not isinstance(schedule, str) or not schedule.strip():
                raise ValueError("Each cloud schedule needs a scheduleLabel.")
            next_display, last_display = raw.get("nextDisplay"), raw.get("lastDisplay")
            if next_display is not None and not isinstance(next_display, str):
                raise ValueError("nextDisplay must be text or null.")
            if last_display is not None and not isinstance(last_display, str):
                raise ValueError("lastDisplay must be text or null.")
            execution = raw.get("executionStatus", "unknown")
            if execution not in _EXECUTION_STATUSES:
                raise ValueError("executionStatus is invalid.")
            records.append({"id": source_id, "name": name.strip(), "status": status,
                            "scheduleLabel": schedule.strip(), "nextDisplay": next_display,
                            "lastDisplay": last_display, "threadUrl": _chatgpt_url(raw.get("threadUrl")),
                            "executionStatus": execution})
        return {"version": 1, "observedAt": observed_at, "sourceUrl": source_url, "records": records}
