"""Read-only adapters for the Star Sugar Manor local dashboard.

This module intentionally has no task-control code.  It only turns a small,
safe subset of local Codex metadata into the JSON shape consumed by the UI.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
from urllib.parse import unquote
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from task_progress import local_progress, unavailable_cloud, unavailable_local


CODEX_ROOT = Path.home() / ".codex"
STATE_DB = CODEX_ROOT / "state_5.sqlite"
CATALOG_DB = CODEX_ROOT / "sqlite" / "codex-dev.db"
DOCUMENT_ROOTS = (Path.home() / "Documents" / "Codex", Path.home() / "Documents" / "ChatGPT")
ALLOWED_STATUSES = {"running", "waiting", "completed", "failed", "interrupted", "idle", "unknown"}
MAX_LOG_BYTES = 512 * 1024
MAX_TASKS = 100
MAX_LOGGED_TASKS = 40


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_time(value: Any) -> str | None:
    """Format either Unix seconds/milliseconds or an ISO date as UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        number = float(value)
        if number > 100_000_000_000:
            number /= 1000
        return dt.datetime.fromtimestamp(number, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def unix_seconds(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / (1000 if value > 100_000_000_000 else 1)
    parsed = iso_time(value)
    if not parsed:
        return 0
    return dt.datetime.fromisoformat(parsed.replace("Z", "+00:00")).timestamp()


def short_text(value: Any, limit: int = 800) -> str:
    """Return a display-safe one-line summary without credentials in URLs."""
    if isinstance(value, dict):
        value = value.get("text") or value.get("content") or value.get("message") or ""
    if isinstance(value, list):
        value = " ".join(str(x.get("text", "")) if isinstance(x, dict) else str(x) for x in value)
    text = re.sub(r"https?://[^\s)]+", "[链接已省略]", str(value or ""))
    text = re.sub(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+", r"\1=[已隐藏]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{16,}\b", "[密钥已隐藏]", text)
    text = re.sub(r"(?im)^\s*(system|developer)\s*:\s*.*$", "", text)
    text = re.sub(r"(?im)^\s*(tool|function_call|custom_tool_call)[^\n]*$", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit].rstrip()


def message_text(value: Any) -> str:
    """Flatten a final assistant message without applying display truncation."""
    if isinstance(value, dict):
        value = value.get("text") or value.get("content") or value.get("message") or ""
    if isinstance(value, list):
        value = " ".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in value)
    return str(value or "")


def is_user_task(source: str) -> bool:
    lowered = (source or "").lower()
    return not any(marker in lowered for marker in ("subagent", "guardian", "auto-review"))


def allowed_artifact(path_text: str, cwd: str | None) -> Path | None:
    """Accept only existing regular files under a task or document root.

    ``resolve`` is deliberate: a symlink inside a permitted directory must not
    become a route to a private configuration file.
    """
    try:
        candidate = Path(path_text).expanduser()
        if not candidate.is_absolute() or not candidate.exists() or not candidate.is_file():
            return None
        resolved = candidate.resolve(strict=True)
        denied = (CODEX_ROOT.resolve(), Path.home() / ".ssh", Path.home() / ".config", Path.home() / ".aws")
        if any(_is_within(resolved, root) for root in denied):
            return None
        filename = resolved.name.casefold()
        if (any(part.startswith(".") for part in resolved.parts)
                or filename.startswith(".env")
                or resolved.suffix.casefold() in {".key", ".pem", ".p12", ".pfx"}
                or filename in {"id_rsa", "id_ed25519", "credentials", "credentials.json"}):
            return None
        roots = list(DOCUMENT_ROOTS)
        safe_cwd = _safe_project_root(cwd)
        if safe_cwd:
            roots.insert(0, safe_cwd)
        if not any(_is_within(resolved, root) for root in roots):
            return None
        return resolved
    except (OSError, RuntimeError, ValueError):
        return None


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def _safe_project_root(cwd: str | None) -> Path | None:
    """Return a sufficiently specific, non-sensitive task working directory."""
    if not cwd:
        return None
    try:
        root = Path(cwd).expanduser().resolve(strict=False)
        home = Path.home().resolve()
        broad = {Path("/"), home, home.parent, Path("/Users"), home / "Desktop", home / "Downloads"}
        if root in broad or any(part.startswith(".") for part in root.parts):
            return None
        return root if root.is_absolute() else None
    except (OSError, RuntimeError, ValueError):
        return None


_ARTIFACT_RE = re.compile(
    r"!?\[[^\]]*\]\(<?(?P<markdown>/[^)>]+)>?\)|<(?P<angle>/[^>]+)>|(?<![\w(])(?P<plain>/Users/[^\s)<]+)"
)


def _artifact_path_text(value: str) -> str:
    decoded = unquote(value.strip())
    return re.sub(r":\d+(?::\d+)?$", "", decoded)


def artifacts_from_summary(summary: str, cwd: str | None) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    seen: set[Path] = set()
    for match in _ARTIFACT_RE.finditer(summary or ""):
        raw_path = _artifact_path_text(match.group("markdown") or match.group("angle") or match.group("plain"))
        safe_path = allowed_artifact(raw_path, cwd)
        if not safe_path or safe_path in seen:
            continue
        seen.add(safe_path)
        artifact_id = hashlib.sha256(str(safe_path).encode()).hexdigest()[:24]
        found.append({"name": safe_path.name, "path": str(safe_path), "url": f"/api/artifact/{artifact_id}"})
    return found


@dataclass
class TailLogCache:
    entries: dict[Path, tuple[int, int, list[dict[str, Any]]]] = field(default_factory=dict)
    problems: dict[Path, str] = field(default_factory=dict)

    def read(self, path: str | Path) -> list[dict[str, Any]]:
        log_path = Path(path)
        try:
            info = log_path.stat()
        except OSError as exc:
            self.problems[log_path] = type(exc).__name__
            return []
        cached = self.entries.get(log_path)
        if cached and cached[:2] == (info.st_mtime_ns, info.st_size):
            return cached[2]
        try:
            with log_path.open("rb") as handle:
                if info.st_size > MAX_LOG_BYTES:
                    handle.seek(-MAX_LOG_BYTES, os.SEEK_END)
                    handle.readline()  # discard a partial JSON line
                raw_lines = handle.read().splitlines()
        except OSError as exc:
            self.problems[log_path] = type(exc).__name__
            return []
        self.problems.pop(log_path, None)
        events: list[dict[str, Any]] = []
        tail_truncated = info.st_size > MAX_LOG_BYTES
        for raw in raw_lines:
            try:
                record = json.loads(raw.decode("utf-8"))
                # Progress and state only rely on the event stream.  Do not
                # retain response-item, reasoning, token, or context records
                # merely because they happened to include a payload shape.
                record_type = record.get("type")
                if record_type not in (None, "", "event_msg"):
                    continue
                payload = record.get("payload", {})
                # Some writer versions wrap the event in an ``event_msg``
                # envelope.  Both formats are local log representations of
                # the same event and are safe to normalize here.
                if isinstance(payload, dict) and payload.get("type") == "event_msg":
                    payload = payload.get("payload") or payload.get("event") or payload.get("data") or payload
                if isinstance(payload, dict) and payload.get("type"):
                    events.append({"at": record.get("timestamp"), "payload": payload,
                                   "turn_id": payload.get("turn_id") or record.get("turn_id"),
                                   "record_type": record_type or "event_msg",
                                   "tail_truncated": tail_truncated})
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        self.entries[log_path] = (info.st_mtime_ns, info.st_size, events)
        return events


class LocalStateAdapter:
    def __init__(self, state_db: Path = STATE_DB, catalog_db: Path = CATALOG_DB, log_cache: TailLogCache | None = None):
        self.state_db = Path(state_db)
        self.catalog_db = Path(catalog_db)
        self.log_cache = log_cache or TailLogCache()

    @staticmethod
    def _connect(path: Path) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)

    def snapshot(self) -> dict[str, Any]:
        now = utc_now()
        sources: list[dict[str, Any]] = []
        codex_rows, project_rows, codex_problem = self._read_codex()
        catalog, automations, catalog_problem = self._read_catalog()
        sources.append(self._source("codex-state", "Codex 本机任务", self.state_db, codex_problem, "local-logs", now))
        sources.append(self._source("task-catalog", "ChatGPT 本机目录快照", self.catalog_db, catalog_problem, "snapshot", now))

        catalog_by_id = {item["thread_id"]: item for item in catalog}
        tasks: list[dict[str, Any]] = []
        known_ids: set[str] = set()
        collected_events: list[dict[str, Any]] = []
        automation_log_evidence: dict[str, tuple[float, str, str]] = {}
        for row in codex_rows:
            catalog_item = catalog_by_id.get(row["id"], {})
            title = catalog_item.get("display_title") or row["name"] or row["title"] or "未命名任务"
            task = self._base_task(
                row["id"], title, "codex", row["updated_at"], row["project_id"], row["model"], row["cwd"]
            )
            task["summary"] = short_text(row["title"] or title)
            if len(tasks) < MAX_LOGGED_TASKS:
                status, detail, raw_summary, events = self._status_from_log(row["rollout_path"], now)
                task["status"], task["statusDetail"] = status, detail
                task["progress"] = local_progress(events, status, now)
                if raw_summary:
                    task["summary"] = short_text(raw_summary)
                    task["artifacts"] = artifacts_from_summary(raw_summary, row["cwd"])
                collected_events.extend(self._event_objects(row["id"], events))
                self._collect_automation_log_evidence(automation_log_evidence, row["id"], events)
            known_ids.add(row["id"])
            task.setdefault("progress", unavailable_local())
            tasks.append(task)

        current_logs = {Path(row["rollout_path"]) for row in codex_rows if row.get("rollout_path")}
        if current_logs.intersection(self.log_cache.problems) and not codex_problem:
            sources[0]["mode"] = "unavailable"
            sources[0]["message"] = "部分 Codex 日志不可读取，部分状态未确认。"

        for item in catalog:
            thread_id = item["thread_id"]
            if thread_id in known_ids:
                continue
            kind = item.get("source_kind", "")
            if kind == "chatgpt":
                source = "chatgpt"
            elif kind.lower() in {"vscode", "cli", "app", "local"}:
                source = "codex"
            else:
                continue
            task = self._base_task(thread_id, item.get("display_title") or "未命名任务", source,
                                   item.get("source_updated_at"), item.get("project_id"), None, item.get("cwd"))
            task["statusDetail"] = "仅有本机目录快照，状态未确认。"
            task["progress"] = unavailable_cloud() if source == "chatgpt" else unavailable_local()
            tasks.append(task)

        tasks.sort(key=lambda task: unix_seconds(task.get("updatedAt")), reverse=True)
        tasks = tasks[:MAX_TASKS]
        self._apply_automation_log_evidence(automations, automation_log_evidence, now)
        projects = self._projects(project_rows, tasks)
        return {
            "generatedAt": now.isoformat().replace("+00:00", "Z"),
            "sources": sources,
            "tasks": tasks,
            "automations": automations,
            "projects": projects,
            "events": sorted(collected_events, key=lambda event: unix_seconds(event.get("at")), reverse=True)[:40],
            "scope": {
                "taskLimit": MAX_TASKS,
                "logTaskLimit": MAX_LOGGED_TASKS,
                "eventLimit": 40,
                "message": "显示最近本机任务；旧任务或仅目录快照的执行状态可能未知。",
            },
        }

    def _source(self, source_id: str, label: str, path: Path, problem: str | None, mode: str,
                synced_at: dt.datetime) -> dict[str, Any]:
        try:
            changed_at = max((candidate.stat().st_mtime for candidate in (path, Path(str(path) + "-wal")) if candidate.exists()), default=None)
        except OSError:
            changed_at = None
        return {"id": source_id, "label": label, "mode": "unavailable" if problem else mode,
                "lastSyncAt": synced_at.isoformat().replace("+00:00", "Z"), "lastChangedAt": iso_time(changed_at),
                "message": problem or "只读本机快照"}

    def _read_codex(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
        if not self.state_db.exists():
            return [], [], "未找到 Codex 本机状态库。"
        try:
            with self._connect(self.state_db) as con:
                con.row_factory = sqlite3.Row
                rows = [dict(row) for row in con.execute(
                    "SELECT id, rollout_path, updated_at, source, title, archived, model, cwd, project_id, name "
                    "FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?", (MAX_TASKS * 2,))]
                projects = [dict(row) for row in con.execute("SELECT id, name FROM projects ORDER BY name")]
            return [row for row in rows if is_user_task(row.get("source", ""))][:MAX_TASKS], projects, None
        except (sqlite3.Error, OSError) as exc:
            return [], [], f"无法读取 Codex 状态库：{type(exc).__name__}。"

    def _read_catalog(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
        if not self.catalog_db.exists():
            return [], [], "未找到 ChatGPT 本机目录快照。"
        try:
            with self._connect(self.catalog_db) as con:
                con.row_factory = sqlite3.Row
                catalog = [dict(row) for row in con.execute(
                    "SELECT thread_id, display_title, source_kind, source_updated_at, project_id, cwd "
                    "FROM local_thread_catalog ORDER BY source_updated_at DESC LIMIT ?", (MAX_TASKS * 2,))]
                automation_rows = [dict(row) for row in con.execute(
                    "SELECT id, name, status, kind, rrule, next_run_at, last_run_at, target_thread_id FROM automations "
                    "ORDER BY updated_at DESC")]
                try:
                    run_rows = [dict(row) for row in con.execute(
                        "SELECT automation_id, status, thread_id, created_at, updated_at FROM automation_runs "
                        "ORDER BY COALESCE(updated_at, created_at) DESC")]
                except sqlite3.Error:
                    # Older local catalogues have no run table.  Its absence
                    # means the execution state is unknown, never successful.
                    run_rows = []
            latest_runs: dict[str, dict[str, Any]] = {}
            for run in run_rows:
                automation_id = run.get("automation_id")
                if isinstance(automation_id, str) and automation_id not in latest_runs:
                    latest_runs[automation_id] = run
            return catalog[:MAX_TASKS], [self._automation(row, latest_runs.get(row.get("id"))) for row in automation_rows], None
        except (sqlite3.Error, OSError) as exc:
            return [], [], f"无法读取本机目录快照：{type(exc).__name__}。"

    @staticmethod
    def _automation(row: dict[str, Any], latest_run: dict[str, Any] | None = None) -> dict[str, Any]:
        status = row.get("status") if row.get("status") in {"ACTIVE", "PAUSED"} else "PAUSED"
        return {"id": row["id"], "name": row["name"], "status": status, "schedule": row.get("rrule") or "",
                "nextRunAt": iso_time(row.get("next_run_at")), "lastRunAt": iso_time(row.get("last_run_at")),
                "threadId": row.get("target_thread_id"), "source": "codex", "cloud": False,
                # Schedule enablement (ACTIVE) is deliberately unrelated to
                # execution.  Only a run row or explicitly tagged log event
                # can supply a non-unknown value.
                "executionStatus": LocalStateAdapter._run_execution_status(latest_run)}

    @staticmethod
    def _run_execution_status(run: dict[str, Any] | None) -> str:
        status = str((run or {}).get("status") or "").casefold().replace("-", "_").replace(" ", "_")
        aliases = {"running": "running", "in_progress": "running", "queued": "waiting", "pending": "waiting",
                   "completed": "completed", "succeeded": "completed", "success": "completed", "failed": "failed",
                   "error": "failed", "cancelled": "interrupted", "canceled": "interrupted", "interrupted": "interrupted"}
        execution = aliases.get(status, "unknown")
        if execution in {"running", "waiting"}:
            observed_at = unix_seconds((run or {}).get("updated_at") or (run or {}).get("created_at"))
            if not observed_at or utc_now().timestamp() - observed_at > 15 * 60:
                return "unknown"
        return execution

    @staticmethod
    def _log_execution_status(payload: dict[str, Any]) -> str:
        event_type = payload.get("type")
        if event_type == "task_started":
            return "running"
        if event_type in {"approval_requested", "approval_required", "permission_requested"}:
            return "waiting"
        if event_type == "task_complete":
            return "completed"
        if event_type in {"task_failed", "turn_failed"}:
            return "failed"
        if event_type == "turn_aborted":
            return "interrupted"
        return "unknown"

    def _collect_automation_log_evidence(self, evidence: dict[str, tuple[float, str, str]], task_id: str,
                                         events: Iterable[dict[str, Any]]) -> None:
        """Use a log only when the event itself identifies its automation."""
        for event in events:
            payload = event["payload"]
            automation_id = payload.get("automationId") or payload.get("automation_id")
            status = self._log_execution_status(payload)
            if not isinstance(automation_id, str) or not automation_id or status == "unknown":
                continue
            candidate = (self._event_time(event), status, task_id)
            previous = evidence.get(automation_id)
            if previous is None or candidate[0] > previous[0]:
                evidence[automation_id] = candidate

    @staticmethod
    def _apply_automation_log_evidence(automations: list[dict[str, Any]], evidence: dict[str, tuple[float, str, str]],
                                       now: dt.datetime) -> None:
        for automation in automations:
            if automation.get("executionStatus") != "unknown":
                continue
            observed = evidence.get(automation.get("id"))
            # An explicit automation ID is still paired with the known target
            # when one exists, so an unrelated manual conversation cannot
            # animate this schedule.
            is_stale_activity = observed and observed[1] in {"running", "waiting"} and now.timestamp() - observed[0] > 15 * 60
            if observed and not is_stale_activity and (not automation.get("threadId") or observed[2] == automation["threadId"]):
                automation["executionStatus"] = observed[1]

    @staticmethod
    def _base_task(thread_id: str, title: str, source: str, updated_at: Any, project: str | None,
                   model: str | None, cwd: str | None) -> dict[str, Any]:
        return {"id": thread_id, "title": short_text(title, 180) or "未命名任务", "source": source,
                "status": "unknown", "updatedAt": iso_time(updated_at), "project": project or "",
                "model": model or "", "summary": "", "threadUrl": (f"https://chatgpt.com/c/{thread_id}" if source == "chatgpt" else f"codex://threads/{thread_id}"),
                "artifacts": [], "statusDetail": "暂无可确认的运行记录。", "_cwd": cwd or ""}

    def _status_from_log(self, log_path: str, now: dt.datetime) -> tuple[str, str, str, list[dict[str, Any]]]:
        events = self.log_cache.read(log_path)
        if not events:
            return "unknown", "没有可解析的近期日志。", "", []
        starts = [event for event in events if event["payload"].get("type") == "task_started" and event.get("turn_id")]
        if not starts:
            # Do not read a multi-megabyte history just to recover lifecycle
            # records. A tail with recent same-turn work is useful evidence of
            # activity, but never proves completion when its start is absent.
            activity_types = {"item_completed", "token_count", "message", "reasoning", "custom_tool_call",
                              "custom_tool_call_output", "function_call", "function_call_output"}
            activity = [event for event in events if event.get("turn_id") and event["payload"].get("type") in activity_types]
            if activity:
                latest_activity = max(activity, key=self._event_time)
                if now.timestamp() - self._event_time(latest_activity) <= 2 * 60:
                    return "running", "检测到近期执行活动，尚未读取到结束事件。", "", events
            return "unknown", "日志尾部没有当前轮次的开始记录，状态未确认。", "", events
        current = max(starts, key=self._event_time)
        current_turn = str(current["turn_id"])
        turn_events = [event for event in events if str(event.get("turn_id") or "") == current_turn]
        final_types = {"task_complete", "task_failed", "turn_failed", "turn_aborted"}
        finals = [event for event in turn_events if event["payload"].get("type") in final_types]
        # A completion, failure, or interruption is a definite terminal state
        # for this turn.  It remains stronger evidence than later incidental
        # log activity from the same turn.
        if finals:
            latest = max(finals, key=self._event_time)
            kind, payload = latest["payload"]["type"], latest["payload"]
            if kind == "task_complete":
                return "completed", "最近一轮已结束（不代表成果已验收）。", message_text(payload.get("last_agent_message")), events
            if kind == "turn_aborted":
                return "interrupted", "最近一轮已中断。", "", events
            if kind in {"task_failed", "turn_failed"}:
                return "failed", "最近一轮报告失败。", message_text(payload.get("message") or payload.get("error")), events
        approval_types = {"approval_requested", "approval_required", "permission_requested"}
        approvals = [(index, event) for index, event in enumerate(turn_events)
                     if event["payload"].get("type") in approval_types]
        if approvals:
            approval_index, approval = max(approvals, key=lambda pair: (self._event_time(pair[1]), pair[0]))
            # A decision prompt is waiting only until the same turn provides
            # clear post-approval execution evidence.  Reasoning and token
            # counters alone do not prove that work resumed.
            approval_at = self._event_time(approval)
            continuations = [event for event in turn_events[approval_index + 1:]
                             if self._event_time(event) >= approval_at and self._is_execution_continuation(event)]
            if continuations:
                activity_at = max(self._event_time(event) for event in continuations)
                if now.timestamp() - activity_at <= 15 * 60:
                    return "running", "审批后检测到同轮继续执行。", "", events
                return "unknown", "审批后的执行活动超过 15 分钟，状态未确认。", "", events
            if now.timestamp() - approval_at <= 15 * 60:
                return "waiting", "最近一轮明确等待审批。", "", events
            return "unknown", "最近一轮等待审批超过 15 分钟，状态未确认。", "", events
        activity_at = max(self._event_time(event) for event in turn_events)
        if not current_turn:
            return "unknown", "近期日志没有任务状态事件。", "", events
        if now.timestamp() - activity_at <= 15 * 60:
            return "running", "最近一轮正在运行。", "", events
        return "unknown", "最近一轮超过 15 分钟没有心跳，状态未确认。", "", events

    @staticmethod
    def _is_execution_continuation(event: dict[str, Any]) -> bool:
        payload = event.get("payload") or {}
        event_type = payload.get("type")
        if event_type in {"custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output"}:
            return True
        if event_type != "item_completed":
            return False
        # Some writers emit a completed reasoning item.  It is not evidence
        # that an approval was acted on; accept only recognized public/tool
        # item classes and never an incomplete or unknown item.
        item = payload.get("item")
        if not isinstance(item, dict):
            return False
        item_type = "".join(character for character in str(item.get("type") or "").casefold() if character.isalpha())
        if item_type == "agentmessage":
            return str(item.get("phase") or "").casefold() == "commentary"
        return item_type in {"commandexecution", "functioncall", "customtoolcall", "toolcall"}

    @staticmethod
    def _event_time(event: dict[str, Any]) -> float:
        payload = event["payload"]
        return unix_seconds(event.get("at") or payload.get("completed_at") or payload.get("started_at"))

    @staticmethod
    def _event_objects(task_id: str, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        labels = {"task_started": "任务开始", "task_complete": "任务结束", "task_failed": "任务失败", "turn_failed": "任务失败", "turn_aborted": "任务中断",
                  "approval_requested": "等待审批", "approval_required": "等待审批", "permission_requested": "等待审批"}
        return [{"id": f"{task_id}:{index}", "taskId": task_id, "type": event["payload"]["type"],
                 "at": iso_time(event.get("at")), "label": labels[event["payload"]["type"]]}
                for index, event in enumerate(events) if event["payload"].get("type") in labels]

    @staticmethod
    def _projects(rows: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> list[dict[str, str]]:
        projects = {row["id"]: {"id": row["id"], "name": row["name"]} for row in rows}
        for task in tasks:
            project_id = task["project"]
            task["projectId"] = project_id or None
            task["project"] = projects.get(project_id, {}).get("name", "未归属项目")
            task.pop("_cwd", None)
        return sorted(projects.values(), key=lambda project: project["name"])


def build_state() -> dict[str, Any]:
    return LocalStateAdapter().snapshot()
