"""Safe, local-only summaries of a task's recent visible progress.

The log format contains much more than a person should see in the manor.  This
module intentionally consumes only the normalized event envelope supplied by
``TailLogCache`` and has a narrow allow-list: public commentary, a few
lifecycle markers, and tool *categories*.  It never returns prompts,
reasoning, commands, parameters, tool output, or paths.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
from typing import Any, Iterable


MAX_PROGRESS_EVENTS = 12
_LIFECYCLE = {
    "task_started": ("任务开始", "running"),
    "task_complete": ("任务结束", "completed"),
    "task_failed": ("任务失败", "failed"),
    "turn_failed": ("任务失败", "failed"),
    "turn_aborted": ("任务中断", "interrupted"),
    "approval_requested": ("等待审批", "waiting"),
    "approval_required": ("等待审批", "waiting"),
    "permission_requested": ("等待审批", "waiting"),
}
_SAFE_PHASES = {"running", "waiting", "completed", "failed", "interrupted", "idle", "unknown"}


def unavailable_local(message: str = "未读取到本机执行过程。") -> dict[str, Any]:
    return {
        "availability": "unavailable", "source": "local-log", "phase": "unknown", "turnId": None,
        "updatedAt": None, "truncated": False, "events": [], "message": message,
    }


def unavailable_cloud() -> dict[str, Any]:
    return {
        "availability": "unavailable", "source": "cloud-snapshot", "phase": "unknown", "turnId": None,
        "updatedAt": None, "truncated": False, "events": [],
        "message": "云端计划快照不包含执行过程。",
    }


def local_progress(events: Iterable[dict[str, Any]], task_status: str, now: dt.datetime | None = None) -> dict[str, Any]:
    """Return recent, same-turn progress without changing the task status.

    ``task_status`` has already applied the log adapter's lifecycle and
    heartbeat rules.  A tool event therefore never changes a task into a
    running or completed task by itself.
    """
    del now  # Status freshness belongs to LocalStateAdapter._status_from_log.
    indexed = [(index, event) for index, event in enumerate(events) if _turn_id(event)]
    if not indexed:
        return unavailable_local("没有可关联到轮次的本机过程记录。")

    starts = [(index, event) for index, event in indexed if _event_type(event) == "task_started"]
    if starts:
        _, current = max(starts, key=lambda pair: (_event_time(pair[1]), pair[0]))
        turn_id = _turn_id(current)
        selected = [(index, event) for index, event in indexed if _turn_id(event) == turn_id]
        missing_start = False
    else:
        # A bounded tail can begin in the middle of a turn.  Keep only the
        # newest explicit turn; never borrow events from an adjacent turn.
        _, current = max(indexed, key=lambda pair: (_event_time(pair[1]), pair[0]))
        turn_id = _turn_id(current)
        selected = [(index, event) for index, event in indexed if _turn_id(event) == turn_id]
        missing_start = True

    output: list[tuple[float, int, dict[str, Any]]] = []
    saw_tail_cut = any(bool(event.get("tail_truncated")) for _, event in selected)
    for index, event in selected:
        public = _public_event(event, turn_id, index)
        if public:
            output.append((_timestamp(public.get("at")), index, public))
    # Timestamp ties retain file order.  Never use the opaque stable ID as a
    # secondary sort key because that makes a repeated snapshot visually jump.
    output.sort(key=lambda item: (item[0], item[1]))
    deduplicated: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for _, _, public in output:
        if public["id"] in seen_ids:
            continue
        seen_ids.add(public["id"])
        deduplicated.append(public)
    output = deduplicated
    over_limit = len(output) > MAX_PROGRESS_EVENTS
    if over_limit:
        output = output[-MAX_PROGRESS_EVENTS:]

    # Public content may be absent even while lifecycle evidence is available.
    # In that case the lifecycle event is still useful and safe; no events at
    # all means we should not pretend the detailed process is readable.
    if not output:
        return unavailable_local("本轮没有可展示的公开过程记录。")

    truncated = missing_start or saw_tail_cut or over_limit
    notes: list[str] = []
    if missing_start:
        notes.append("仅读取日志尾部；当前轮次开始记录未在可读范围内。")
    elif saw_tail_cut:
        notes.append("仅读取日志尾部。")
    if over_limit:
        notes.append("仅保留最近 12 项公开过程。")
    latest = output[-1].get("at")
    phase = task_status if task_status in _SAFE_PHASES else "unknown"
    return {
        "availability": "available", "source": "local-log", "phase": phase, "turnId": turn_id,
        "updatedAt": latest, "truncated": truncated, "events": output,
        **({"message": " ".join(notes)} if notes else {}),
    }


def _turn_id(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    value = event.get("turn_id") or payload.get("turn_id")
    return str(value) if isinstance(value, (str, int)) and str(value) else ""


def _event_type(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    return str(payload.get("type") or "")


def _event_time(event: dict[str, Any]) -> float:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    return _timestamp(event.get("at") or payload.get("completed_at") or payload.get("started_at"))


def _timestamp(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / (1000 if value > 100_000_000_000 else 1)
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _iso(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / (1000 if value > 100_000_000_000 else 1)
        try:
            return dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OSError):
            return None
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            return None
    return None


def _public_event(event: dict[str, Any], turn_id: str, index: int) -> dict[str, Any] | None:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    event_type = str(payload.get("type") or "")
    at = _iso(event.get("at") or payload.get("completed_at") or payload.get("started_at"))
    if not at:
        return None
    if event_type in _LIFECYCLE:
        label, status = _LIFECYCLE[event_type]
        return _item(event, turn_id, index, at, "lifecycle", label, status=status)
    if event_type != "item_completed":
        return None
    item = payload.get("item")
    if not isinstance(item, dict):
        return None
    item_type = re.sub(r"[^a-z]", "", str(item.get("type") or "").casefold())
    if item_type == "agentmessage" and str(item.get("phase") or "").casefold() == "commentary":
        detail = _safe_public_text(item.get("content"))
        return _item(event, turn_id, index, at, "update", "进展更新", detail=detail) if detail else None
    if item_type == "commandexecution":
        label = _command_label(item)
        failed = _command_failed(item)
        return _item(event, turn_id, index, at, "tool", f"{label}{'失败' if failed else ''}",
                     status="failed" if failed else _tool_status(item))
    if item_type in {"functioncall", "customtoolcall", "toolcall"}:
        # The call name/arguments are not a safe display surface.  A generic
        # category still shows that visible work happened without leaking them.
        return _item(event, turn_id, index, at, "tool", "工具操作", status=_tool_status(item))
    return None


def _item(event: dict[str, Any], turn_id: str, index: int, at: str, kind: str, label: str,
          detail: str | None = None, status: str | None = None) -> dict[str, Any]:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    stable = source.get("id") or source.get("call_id") or payload.get("id") or payload.get("call_id")
    if not isinstance(stable, (str, int)) or not str(stable):
        stable = hashlib.sha256(f"{turn_id}|{at}|{kind}|{label}|{detail or ''}".encode()).hexdigest()[:20]
    item: dict[str, Any] = {"id": f"{turn_id}:{stable}", "at": at, "kind": kind, "label": label}
    if detail:
        item["detail"] = detail
    if status:
        item["status"] = status
    return item


def _command_label(item: dict[str, Any]) -> str:
    """Name only a few unambiguous local file operations; never echo a command."""
    parsed = item.get("parsed_cmd")
    operation = ""
    if isinstance(parsed, dict):
        operation = str(parsed.get("operation") or parsed.get("action") or parsed.get("type") or "")
    elif isinstance(parsed, list):
        # Some writers serialize a parsed command as a small operation list.
        # Only its declared operation category is safe to inspect.
        names = {str(part.get("type") or part.get("operation") or "").casefold()
                 for part in parsed if isinstance(part, dict)}
        if names & {"read", "read_file", "readfile"}:
            return "读取文件"
        if names & {"list", "list_files", "listfiles", "directory"}:
            return "查看目录"
        if names & {"search", "grep", "rg"}:
            return "检索内容"
    elif isinstance(parsed, str):
        matched = re.match(r"\s*([A-Za-z][A-Za-z0-9_-]{0,30})\b", parsed)
        operation = matched.group(1) if matched else ""
    command = operation.casefold()
    if command in {"cat", "sed", "head", "tail", "less", "more"}:
        return "读取文件"
    if command in {"ls", "find", "tree", "dir"}:
        return "查看目录"
    if command in {"rg", "grep", "ag", "ack"}:
        return "检索内容"
    return "执行命令"


def _command_failed(item: dict[str, Any]) -> bool:
    try:
        if item.get("exit_code") is not None and int(item["exit_code"]) != 0:
            return True
    except (TypeError, ValueError):
        pass
    return str(item.get("status") or "").casefold() in {"failed", "error", "cancelled", "canceled"}


def _tool_status(item: dict[str, Any]) -> str | None:
    raw = str(item.get("status") or "").casefold()
    if raw in {"failed", "error", "cancelled", "canceled"}:
        return "failed"
    if raw in {"completed", "complete", "succeeded", "success"}:
        return "completed"
    if raw in {"running", "in_progress"}:
        return "running"
    return None


def _safe_public_text(value: Any, limit: int = 420) -> str:
    """Keep public commentary brief while removing obvious unsafe fragments."""
    if isinstance(value, str):
        text = value
    elif isinstance(value, dict) and isinstance(value.get("text"), str):
        text = value["text"]
    elif isinstance(value, list):
        parts = []
        for part in value:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        text = " ".join(parts)
    else:
        return ""
    text = re.sub(r"https?://[^\s)]+", "[链接已省略]", text)
    text = re.sub(r"(?i)\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+", r"\1=[已隐藏]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{16,}\b", "[密钥已隐藏]", text)
    text = re.sub(r"/(?:Users|home|private|etc)/[^\s`]+", "[本地路径已省略]", text)
    text = re.sub(r"(?im)^\s*(system|developer|analysis|reasoning)\s*:\s*.*$", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit].rstrip()
