"""JSONL stdio bridge for the native Star Sugar Manor desktop shell."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from adapters import LocalStateAdapter, TailLogCache, artifacts_from_summary, iso_time, message_text, short_text
from cloud_catalog import CloudCatalog
from review_store import ReviewStore, is_non_notifying_heartbeat
from schedule_results import ScheduleResults, review_result_id
from task_progress import unavailable_cloud, unavailable_local


class InboxCollector:
    """Collect final assistant messages from recent local Codex rollouts."""

    def __init__(self, adapter: LocalStateAdapter):
        self.adapter = adapter

    def collect(self) -> list[dict[str, Any]]:
        rows, _, _ = self.adapter._read_codex()
        catalog, _, _ = self.adapter._read_catalog()
        catalog_titles = {item["thread_id"]: item.get("display_title") for item in catalog}
        records: list[dict[str, Any]] = []
        for row in rows[:40]:
            for event in self.adapter.log_cache.read(row["rollout_path"]):
                payload = event["payload"]
                if payload.get("type") != "task_complete":
                    continue
                raw_body = message_text(payload.get("last_agent_message"))
                if not raw_body.strip():
                    continue
                if is_non_notifying_heartbeat(raw_body):
                    continue
                created_at = iso_time(event.get("at") or payload.get("completed_at"))
                if not created_at:
                    continue
                task_id = row["id"]
                turn_id = str(event.get("turn_id") or payload.get("turn_id") or "")
                body = review_body(raw_body)
                if not body:
                    continue
                content_hash = hashlib.sha256((created_at + raw_body).encode()).hexdigest()[:20]
                dedup_key = f"{task_id}:turn:{turn_id}" if turn_id else f"{task_id}:complete:{content_hash}"
                result_id = hashlib.sha256(dedup_key.encode()).hexdigest()[:24]
                artifacts = []
                for artifact in artifacts_from_summary(raw_body, row.get("cwd")):
                    artifact_id = hashlib.sha256((result_id + artifact["path"]).encode()).hexdigest()[:20]
                    artifacts.append({
                        "id": artifact_id, "name": artifact["name"], "path": artifact["path"],
                        "url": f"manor://artifact/{result_id}/{artifact_id}",
                    })
                title = short_text(catalog_titles.get(task_id) or row.get("name") or row.get("title") or "未命名任务", 180) or "未命名任务"
                records.append({
                    "id": result_id, "dedupKey": dedup_key, "taskId": task_id, "turnId": turn_id or None,
                    "title": title, "source": "codex", "createdAt": created_at, "body": body,
                    "summary": short_text(body, 240), "threadUrl": f"codex://threads/{task_id}",
                    "artifacts": artifacts, "cwd": row.get("cwd") or "",
                })
        return records


def review_body(value: Any, limit: int = 200_000) -> str:
    """Keep an assistant's Markdown readable while excluding log-like lines."""
    text = message_text(value)
    text = re.sub(r"(?im)^\s*(system|developer)\s*:\s*.*(?:\n|$)", "", text)
    text = re.sub(r"(?im)^\s*(tool|function_call|custom_tool_call)[^\n]*(?:\n|$)", "", text)
    text = text.strip()
    if len(text) > limit:
        return text[:limit].rstrip() + "\n\n正文较长，请回到原任务查看完整内容"
    return text


def display_result_title(item: dict[str, Any]) -> str | None:
    """Use an explicit Markdown heading only for an automation-card copy."""
    for line in str(item.get("body") or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = re.fullmatch(r"#{1,6}\s+(.+?)\s*#*", stripped)
        if match:
            heading = match.group(1).strip()
            return heading if heading and len(heading) <= 160 else None
        return None
    return None


class DesktopService:
    def __init__(self, adapter: LocalStateAdapter | None = None, store: ReviewStore | None = None,
                 cloud_catalog: CloudCatalog | None = None, schedule_results: ScheduleResults | None = None):
        self.adapter = adapter or LocalStateAdapter(log_cache=TailLogCache())
        self.store = store or ReviewStore()
        self.cloud_catalog = cloud_catalog or CloudCatalog()
        self.schedule_results = schedule_results or ScheduleResults()
        self.collector = InboxCollector(self.adapter)

    def state(self) -> dict[str, Any]:
        state = self.adapter.snapshot()
        cloud = self.cloud_catalog.state()
        state["automations"] = list(state.get("automations", [])) + cloud["records"]
        state["cloudSync"] = {key: cloud[key] for key in ("available", "observedAt", "stale", "mode", "message")}
        # These are only the local catalogue's cloud entries.  They are useful
        # for navigation and labels but carry no claimed online task state.
        state["cloudTasks"] = [{
            "id": task["id"], "title": task["title"], "project": task.get("project", "未归属项目"),
            "projectId": task.get("projectId"), "updatedAt": task.get("updatedAt"),
            "threadUrl": task["threadUrl"], "source": "chatgpt", "state": "unknown",
            "availability": "snapshot-only",
        } for task in state.get("tasks", []) if task.get("source") == "chatgpt"]
        state.setdefault("sources", []).append({
            "id": "chatgpt-scheduled-snapshot", "label": "ChatGPT 计划页快照",
            "mode": "snapshot" if cloud["available"] else "unavailable", "lastSyncAt": cloud["observedAt"],
            "message": cloud["message"], "sourceUrl": cloud["sourceUrl"],
        })
        self.store.import_results(self.collector.collect())
        results_snapshot = self.schedule_results.state()
        active_cloud_ids = {item["id"] for item in cloud["records"] if item.get("status") == "ACTIVE"}
        self.store.import_results(self.schedule_results.review_records(results_snapshot["records"], active_cloud_ids))
        self._attach_automation_results(state["automations"], results_snapshot, active_cloud_ids)
        self._attach_automation_progress(state["automations"], state.get("tasks", []))
        state["inbox"] = self.store.inbox()
        state.setdefault("scope", {})["inboxSource"] = "收集最近 40 个本机 Codex 日志尾部的明确任务完成消息；历史验收记录独立保存在本机。"
        return state

    def _attach_automation_results(self, automations: list[dict[str, Any]], snapshot: dict[str, Any], active_cloud_ids: set[str]) -> None:
        cloud_records = {record["automationId"]: record for record in snapshot["records"] if record["automationId"] in active_cloud_ids}
        for automation in automations:
            active = automation.get("status") == "ACTIVE"
            results: list[dict[str, Any]] = []
            observed_at: str | None = None
            if active and automation.get("cloud") is True:
                record = cloud_records.get(automation.get("id"))
                if record:
                    item = self.store.get_item(review_result_id(record["id"]))
                    if item:
                        item["provenance"] = record["provenance"]
                        results = [item]
                        observed_at = snapshot["observedAt"]
            elif active:
                thread_id = automation.get("threadId")
                if isinstance(thread_id, str) and thread_id:
                    item = self.store.latest_for_task(thread_id)
                    if item:
                        display_title = display_result_title(item)
                        if display_title:
                            item["title"] = display_title
                        item["provenance"] = "关联任务最新结果"
                        results = [item]
                        observed_at = item.get("createdAt")
            automation["results"] = results
            automation["resultAvailability"] = "available" if results else "unavailable"
            automation["resultsObservedAt"] = observed_at
            automation["resultCount"] = len(results)
            automation["unreadResultCount"] = sum(item.get("status") == "unread" for item in results)

    @staticmethod
    def _attach_automation_progress(automations: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> None:
        """Associate a local schedule with its task without claiming a trigger.

        The task's process can be a manual conversation.  The association is
        useful context for a schedule home, but is deliberately not execution
        evidence for that schedule.
        """
        tasks_by_id = {task.get("id"): task for task in tasks if isinstance(task.get("id"), str)}
        for automation in automations:
            if automation.get("cloud") is True or automation.get("source") == "chatgpt":
                automation["progress"] = unavailable_cloud()
                continue
            thread_id = automation.get("threadId")
            task = tasks_by_id.get(thread_id) if isinstance(thread_id, str) else None
            if not task or not isinstance(task.get("progress"), dict):
                automation["progress"] = unavailable_local("未找到关联任务的本机过程。")
                continue
            progress = dict(task["progress"])
            message = str(progress.get("message") or "").strip()
            association = "关联任务进展，不代表由此定时计划触发。"
            progress["message"] = f"{association} {message}".strip()
            automation["progress"] = progress

    def dispatch(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise ValueError("Params must be an object.")
        if method == "state":
            return self.state()
        if method in {"mark_read", "accept", "reopen"}:
            result_id = params.get("id")
            if not isinstance(result_id, str) or not result_id:
                raise ValueError("A valid inbox item id is required.")
            getattr(self.store, method)(result_id)
            return self.state()
        if method == "artifact_path":
            result_id, artifact_id = params.get("resultId"), params.get("artifactId")
            if not isinstance(result_id, str) or not isinstance(artifact_id, str):
                raise ValueError("A resultId and artifactId are required.")
            return {"path": self.store.artifact_path(result_id, artifact_id)}
        if method == "import_cloud_snapshot":
            snapshot = params.get("snapshot", params)
            self.cloud_catalog.import_snapshot(snapshot)
            return self.state()
        if method == "import_cloud_results":
            snapshot = params.get("snapshot", params)
            self.schedule_results.import_snapshot(snapshot)
            return self.state()
        if method == "shutdown":
            return {"shuttingDown": True}
        raise ValueError("Unknown method.")


def response_for_line(service: DesktopService, line: str) -> dict[str, Any]:
    """Turn one JSONL request into exactly one protocol response."""
    request_id: Any = None
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("Request must be an object.")
        request_id = request.get("id")
        method = request.get("method")
        if not isinstance(method, str):
            raise ValueError("A method is required.")
        return {"id": request_id, "result": service.dispatch(method, request.get("params"))}
    except Exception as exc:
        return {"id": request_id, "error": {"message": str(exc) or type(exc).__name__}}


def run() -> None:
    service = DesktopService()
    for line in sys.stdin:
        response = response_for_line(service, line)
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if response.get("result") == {"shuttingDown": True}:
            break


if __name__ == "__main__":
    run()
