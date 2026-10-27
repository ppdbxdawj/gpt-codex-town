import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from adapters import LocalStateAdapter, TailLogCache, allowed_artifact, artifacts_from_summary


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_db = self.root / "state.sqlite"
        self.catalog_db = self.root / "catalog.sqlite"
        self._state_schema()
        self._catalog_schema()
        self.now = datetime.now(timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def _state_schema(self):
        with sqlite3.connect(self.state_db) as con:
            con.execute("CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at INTEGER, source TEXT, title TEXT, archived INTEGER, model TEXT, cwd TEXT, project_id TEXT, name TEXT)")
            con.execute("CREATE TABLE projects (id TEXT, name TEXT)")

    def _catalog_schema(self):
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("CREATE TABLE local_thread_catalog (thread_id TEXT, display_title TEXT, source_kind TEXT, source_updated_at REAL, project_id TEXT, cwd TEXT)")
            con.execute("CREATE TABLE automations (id TEXT, name TEXT, status TEXT, kind TEXT, rrule TEXT, next_run_at INTEGER, last_run_at INTEGER, target_thread_id TEXT, updated_at INTEGER)")

    def _add_codex(self, task_id, events, updated=None):
        log = self.root / f"{task_id}.jsonl"
        log.write_text("\n".join(json.dumps({"timestamp": at, "payload": payload}) for at, payload in events) + "\n")
        with sqlite3.connect(self.state_db) as con:
            con.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, 'test-model', ?, '', '')",
                        (task_id, str(log), int((updated or self.now).timestamp()), "vscode", "Fallback title", str(self.root)))

    def _snapshot(self):
        return LocalStateAdapter(self.state_db, self.catalog_db, TailLogCache()).snapshot()

    def test_start_then_completion_is_completed_with_summary(self):
        started = (self.now - timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
        ended = (self.now - timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
        self._add_codex("done", [(started, {"type": "task_started", "turn_id": "a"}),
                                  (ended, {"type": "task_complete", "turn_id": "a", "last_agent_message": "Finished safely."})])
        task = self._snapshot()["tasks"][0]
        self.assertEqual("completed", task["status"])
        self.assertEqual("Finished safely.", task["summary"])
        self.assertIn("generatedAt", self._snapshot())

    def test_task_progress_uses_only_current_public_turn_events(self):
        started = (self.now - timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
        updated = (self.now - timedelta(seconds=2)).isoformat().replace("+00:00", "Z")
        self._add_codex("progress", [
            (started, {"type": "task_started", "turn_id": "visible"}),
            (updated, {"type": "item_completed", "turn_id": "visible", "item": {
                "type": "AgentMessage", "id": "public", "phase": "commentary", "content": "正在检查结果。"}}),
            (updated, {"type": "item_completed", "turn_id": "visible", "item": {
                "type": "Reasoning", "id": "private", "content": "must never leave the log"}}),
        ])
        progress = self._snapshot()["tasks"][0]["progress"]
        self.assertEqual("running", progress["phase"])
        self.assertEqual("visible", progress["turnId"])
        self.assertEqual(["任务开始", "进展更新"], [item["label"] for item in progress["events"]])
        self.assertNotIn("must never", str(progress))

    def test_latest_turn_is_not_overwritten_by_old_completion(self):
        old = (self.now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        recent = (self.now - timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
        self._add_codex("new-turn", [(old, {"type": "task_complete", "turn_id": "old"}),
                                      (recent, {"type": "task_started", "turn_id": "new"})])
        self.assertEqual("running", self._snapshot()["tasks"][0]["status"])

    def test_old_turn_late_completion_does_not_override_latest_start(self):
        old = (self.now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        new = (self.now - timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
        late = self.now.isoformat().replace("+00:00", "Z")
        self._add_codex("late-old", [(old, {"type": "task_started", "turn_id": "old"}),
                                      (new, {"type": "task_started", "turn_id": "new"}),
                                      (late, {"type": "task_complete", "turn_id": "old"})])
        self.assertEqual("running", self._snapshot()["tasks"][0]["status"])

    def test_old_turn_approval_and_activity_do_not_pollute_current_turn(self):
        old = (self.now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        new = (self.now - timedelta(seconds=50)).isoformat().replace("+00:00", "Z")
        recent = (self.now - timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
        self._add_codex("old-approval", [
            (old, {"type": "task_started", "turn_id": "old"}),
            (new, {"type": "task_started", "turn_id": "new"}),
            (recent, {"type": "approval_requested", "turn_id": "old"}),
            (recent, {"type": "item_completed", "turn_id": "old", "item": {"type": "CommandExecution"}}),
        ])
        self.assertEqual("running", self._snapshot()["tasks"][0]["status"])

    def test_recent_approval_without_later_execution_is_waiting(self):
        started = (self.now - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
        approval = (self.now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        older_activity = (self.now - timedelta(minutes=2, seconds=30)).isoformat().replace("+00:00", "Z")
        self._add_codex("waiting", [(started, {"type": "task_started", "turn_id": "turn"}),
                                     (approval, {"type": "approval_requested", "turn_id": "turn"}),
                                     (older_activity, {"type": "item_completed", "turn_id": "turn", "item": {"type": "CommandExecution"}}),
                                     (approval, {"type": "item_completed", "turn_id": "turn", "item": {"type": "UnknownInternalItem"}})])
        self.assertEqual("waiting", self._snapshot()["tasks"][0]["status"])

    def test_stale_approval_becomes_unknown(self):
        started = (self.now - timedelta(minutes=20)).isoformat().replace("+00:00", "Z")
        approval = (self.now - timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
        self._add_codex("stale-waiting", [(started, {"type": "task_started", "turn_id": "turn"}),
                                           (approval, {"type": "approval_requested", "turn_id": "turn"})])
        task = self._snapshot()["tasks"][0]
        self.assertEqual("unknown", task["status"])
        self.assertIn("15", task["statusDetail"])

    def test_approval_followed_by_execution_resumes_running(self):
        started = (self.now - timedelta(minutes=4)).isoformat().replace("+00:00", "Z")
        approval = (self.now - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
        continued = (self.now - timedelta(seconds=5)).isoformat().replace("+00:00", "Z")
        self._add_codex("resumed", [
            (started, {"type": "task_started", "turn_id": "turn"}),
            (approval, {"type": "approval_requested", "turn_id": "turn"}),
            (continued, {"type": "reasoning", "turn_id": "turn"}),
            (continued, {"type": "token_count", "turn_id": "turn"}),
            (continued, {"type": "item_completed", "turn_id": "turn", "item": {"type": "CommandExecution"}}),
        ])
        task = self._snapshot()["tasks"][0]
        self.assertEqual("running", task["status"])
        self.assertIn("审批后", task["statusDetail"])

    def test_expired_started_turn_becomes_unknown(self):
        stale = (self.now - timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
        self._add_codex("stale", [(stale, {"type": "task_started", "turn_id": "old"})])
        task = self._snapshot()["tasks"][0]
        self.assertEqual("unknown", task["status"])
        self.assertIn("15", task["statusDetail"])

    def test_old_start_with_recent_same_turn_heartbeat_is_running(self):
        stale = (self.now - timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
        recent = self.now.isoformat().replace("+00:00", "Z")
        self._add_codex("heartbeat", [(stale, {"type": "task_started", "turn_id": "alive"}),
                                       (recent, {"type": "item_completed", "turn_id": "alive", "item": {"type": "agentMessage"}})])
        self.assertEqual("running", self._snapshot()["tasks"][0]["status"])

    def test_large_tail_without_start_uses_recent_activity_only(self):
        task_id = "task-large-tail-fixture"
        log = self.root / "large.jsonl"
        recent = self.now.isoformat().replace("+00:00", "Z")
        with log.open("wb") as handle:
            handle.write(json.dumps({"timestamp": (self.now - timedelta(minutes=20)).isoformat(), "payload": {"type": "task_started", "turn_id": "live"}}).encode() + b"\n")
            handle.write(b"x" * (600 * 1024) + b"\n")
            handle.write(json.dumps({"timestamp": recent, "payload": {"type": "item_completed", "turn_id": "live", "item": {"type": "agentMessage"}}}).encode() + b"\n")
        with sqlite3.connect(self.state_db) as con:
            con.execute("INSERT INTO threads VALUES (?, ?, ?, 'vscode', 'x', 0, '', ?, '', '')", (task_id, str(log), int(self.now.timestamp()), str(self.root)))
        task = self._snapshot()["tasks"][0]
        self.assertEqual("running", task["status"])
        self.assertIn("近期执行活动", task["statusDetail"])

    def test_failure_is_distinct_from_interruption(self):
        at = self.now.isoformat().replace("+00:00", "Z")
        earlier = (self.now - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
        self._add_codex("failed", [(earlier, {"type": "task_started", "turn_id": "x"}),
                                    (at, {"type": "task_failed", "turn_id": "x", "message": "network failed"})])
        self.assertEqual("failed", self._snapshot()["tasks"][0]["status"])

    def test_truncated_log_and_missing_catalog_degrade_cleanly(self):
        log = self.root / "bad.jsonl"
        log.write_bytes(b'{"bad partial\n' + json.dumps({"timestamp": self.now.isoformat(), "payload": {"type": "task_started", "turn_id": "x"}}).encode() + b"\n")
        with sqlite3.connect(self.state_db) as con:
            con.execute("INSERT INTO threads VALUES ('partial', ?, ?, 'vscode', 'x', 0, '', ?, '', '')", (str(log), int(self.now.timestamp()), str(self.root)))
        missing = LocalStateAdapter(self.state_db, self.root / "not-here.sqlite").snapshot()
        self.assertEqual("running", missing["tasks"][0]["status"])
        self.assertIn("未找到", missing["sources"][1]["message"])
        for key in ("sources", "tasks", "automations", "projects", "events"):
            self.assertIn(key, missing)

    def test_chatgpt_catalog_is_unknown_not_completed(self):
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("INSERT INTO local_thread_catalog VALUES ('cloud-1', 'Cloud title', 'chatgpt', ?, '', '')", (self.now.timestamp(),))
        task = self._snapshot()["tasks"][0]
        self.assertEqual("chatgpt", task["source"])
        self.assertEqual("unknown", task["status"])
        self.assertEqual("https://chatgpt.com/c/cloud-1", task["threadUrl"])
        self.assertEqual("unavailable", task["progress"]["availability"])
        self.assertEqual("cloud-snapshot", task["progress"]["source"])

    def test_outside_and_symlink_artifacts_are_rejected(self):
        safe = self.root / "safe.txt"
        safe.write_text("ok")
        outside = self.root.parent / "private.txt"
        outside.write_text("private")
        link = self.root / "looks-safe.txt"
        link.symlink_to(outside)
        summary = f"[safe]({safe}) [bad]({outside}) [link]({link})"
        artifacts = artifacts_from_summary(summary, str(self.root))
        self.assertEqual(["safe.txt"], [artifact["name"] for artifact in artifacts])

    def test_angle_encoded_space_and_line_artifact_is_found(self):
        artifact = self.root / "中文 成果.txt"
        artifact.write_text("ok")
        encoded = str(artifact).replace(" ", "%20")
        found = artifacts_from_summary(f"[文件](<{encoded}:12>)", str(self.root))
        self.assertEqual(["中文 成果.txt"], [item["name"] for item in found])

    def test_home_cwd_cannot_expose_hidden_secret(self):
        secret = Path.home() / ".codex" / "auth.json"
        self.assertIsNone(allowed_artifact(str(secret), str(Path.home())))

    def test_active_schedule_does_not_imply_running_without_a_run_record(self):
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("INSERT INTO automations VALUES ('plan-a', '计划', 'ACTIVE', 'heartbeat', '', NULL, NULL, 'task-a', 1)")
        automation = self._snapshot()["automations"][0]
        self.assertEqual("codex", automation["source"])
        self.assertFalse(automation["cloud"])
        self.assertEqual("ACTIVE", automation["status"])
        self.assertEqual("unknown", automation["executionStatus"])

    def test_explicit_automation_run_can_supply_execution_status(self):
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("CREATE TABLE automation_runs (automation_id TEXT, status TEXT, thread_id TEXT, created_at INTEGER, updated_at INTEGER)")
            con.execute("INSERT INTO automations VALUES ('plan-a', '计划', 'ACTIVE', 'heartbeat', '', NULL, NULL, 'task-a', 1)")
            con.execute("INSERT INTO automation_runs VALUES ('plan-a', 'running', 'task-a', ?, ?)", (int(self.now.timestamp()), int(self.now.timestamp())))
        automation = self._snapshot()["automations"][0]
        self.assertEqual("running", automation["executionStatus"])

    def test_old_running_automation_run_becomes_unknown(self):
        old = int((self.now - timedelta(minutes=16)).timestamp())
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("CREATE TABLE automation_runs (automation_id TEXT, status TEXT, thread_id TEXT, created_at INTEGER, updated_at INTEGER)")
            con.execute("INSERT INTO automations VALUES ('plan-a', '计划', 'ACTIVE', 'heartbeat', '', NULL, NULL, 'task-a', 1)")
            con.execute("INSERT INTO automation_runs VALUES ('plan-a', 'running', 'task-a', ?, ?)", (old, old))
        self.assertEqual("unknown", self._snapshot()["automations"][0]["executionStatus"])

    def test_tagged_log_event_can_supply_execution_status_only_for_its_target(self):
        current = self.now.isoformat().replace("+00:00", "Z")
        self._add_codex("task-a", [(current, {"type": "task_started", "turn_id": "turn-a", "automationId": "plan-a"})])
        with sqlite3.connect(self.catalog_db) as con:
            con.execute("INSERT INTO automations VALUES ('plan-a', '计划', 'ACTIVE', 'heartbeat', '', NULL, NULL, 'task-a', 1)")
        self.assertEqual("running", self._snapshot()["automations"][0]["executionStatus"])


if __name__ == "__main__":
    unittest.main()
