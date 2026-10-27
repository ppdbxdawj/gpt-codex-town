import datetime as dt
import unittest

from task_progress import local_progress, unavailable_cloud


NOW = dt.datetime(2026, 10, 27, 10, 0, tzinfo=dt.timezone.utc)


def event(second, payload, turn_id=None, *, tail=False):
    return {
        "at": (NOW + dt.timedelta(seconds=second)).isoformat().replace("+00:00", "Z"),
        "payload": payload,
        "turn_id": turn_id or payload.get("turn_id"),
        "tail_truncated": tail,
    }


class TaskProgressTests(unittest.TestCase):
    def test_current_turn_contains_only_safe_public_events(self):
        events = [
            event(-10, {"type": "task_started", "turn_id": "old"}, "old"),
            event(-9, {"type": "task_complete", "turn_id": "old"}, "old"),
            event(-8, {"type": "task_started", "turn_id": "new"}, "new"),
            event(-7, {"type": "reasoning", "turn_id": "new", "content": "private chain"}, "new"),
            event(-6, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "AgentMessage", "id": "message-1", "phase": "commentary",
                "content": "正在整理公开进展。 https://example.test/?token=hidden",
            }}, "new"),
            event(-5, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "CommandExecution", "id": "command-1", "parsed_cmd": [{"type": "search"}],
                "command": "do-not-return-this", "raw_content": "raw tool output must not return",
                "exit_code": 0, "status": "completed",
            }}, "new"),
            event(-4, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "CommandExecution", "id": "command-2", "parsed_cmd": "cat /private/secret",
                "exit_code": 1,
            }}, "new"),
            event(-3, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "AgentMessage", "id": "final", "phase": "final_answer", "content": "final must not return"}}, "new"),
            event(-2, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "AgentMessage", "id": "analysis", "phase": "analysis", "content": "analysis must not return"}}, "new"),
            event(-1, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "UserMessage", "id": "user", "phase": "commentary", "content": "user must not return"}}, "new"),
            event(0, {"type": "item_completed", "turn_id": "new", "item": {
                "type": "AgentMessage", "id": "system", "phase": "commentary", "content": "system: hidden"}}, "new"),
            event(1, {"type": "task_complete", "turn_id": "old"}, "old"),
            event(2, {"type": "item_completed", "item": {
                "type": "AgentMessage", "id": "unbound", "phase": "commentary", "content": "unbound must not return"}}),
        ]
        progress = local_progress(events, "running", NOW)
        self.assertEqual("available", progress["availability"])
        self.assertEqual("new", progress["turnId"])
        self.assertEqual("running", progress["phase"])
        self.assertFalse(progress["truncated"])
        self.assertEqual(["lifecycle", "update", "tool", "tool"], [item["kind"] for item in progress["events"]])
        self.assertEqual("检索内容", progress["events"][2]["label"])
        self.assertEqual("读取文件失败", progress["events"][3]["label"])
        rendered = str(progress)
        self.assertNotIn("private chain", rendered)
        self.assertNotIn("do-not-return-this", rendered)
        self.assertNotIn("raw tool output", rendered)
        self.assertNotIn("/private/secret", rendered)
        self.assertNotIn("token=hidden", rendered)
        self.assertNotIn("final must not return", rendered)
        self.assertNotIn("analysis must not return", rendered)
        self.assertNotIn("user must not return", rendered)
        self.assertNotIn("hidden", rendered)
        self.assertNotIn("任务结束", [item["label"] for item in progress["events"]])

    def test_event_ids_deduplicate_and_stay_stable_when_tail_moves(self):
        public = {"type": "item_completed", "turn_id": "same", "item": {
            "type": "AgentMessage", "id": "stable-message", "phase": "commentary", "content": "进展"}}
        first = [event(-2, {"type": "task_started", "turn_id": "same"}, "same"), event(-1, public, "same"), event(-1, public, "same")]
        second = [event(-3, {"type": "task_started", "turn_id": "older"}, "older"), *first]
        ids_one = [item["id"] for item in local_progress(first, "running")["events"]]
        ids_two = [item["id"] for item in local_progress(second, "running")["events"]]
        self.assertEqual(2, len(ids_one))
        self.assertEqual(ids_one, ids_two)

    def test_limit_and_missing_start_are_honestly_marked_truncated(self):
        events = []
        for number in range(14):
            events.append(event(number, {"type": "item_completed", "turn_id": "tail", "item": {
                "type": "AgentMessage", "id": f"message-{number}", "phase": "commentary", "content": f"第 {number} 步"}}, "tail", tail=True))
        progress = local_progress(events, "running", NOW)
        self.assertEqual("tail", progress["turnId"])
        self.assertEqual("running", progress["phase"])
        self.assertTrue(progress["truncated"])
        self.assertEqual(12, len(progress["events"]))
        self.assertIn("开始记录", progress["message"])

    def test_empty_and_cloud_sources_are_unavailable(self):
        local = local_progress([], "unknown", NOW)
        cloud = unavailable_cloud()
        self.assertEqual("unavailable", local["availability"])
        self.assertEqual([], local["events"])
        self.assertEqual("unavailable", cloud["availability"])
        self.assertEqual("cloud-snapshot", cloud["source"])
        self.assertEqual([], cloud["events"])

    def test_progress_does_not_promote_unknown_task_to_running(self):
        records = [event(0, {"type": "task_started", "turn_id": "turn"}, "turn"), event(1, {
            "type": "item_completed", "turn_id": "turn", "item": {
                "type": "CommandExecution", "id": "command", "parsed_cmd": "rg thing", "status": "completed"}}, "turn")]
        self.assertEqual("unknown", local_progress(records, "unknown", NOW)["phase"])


if __name__ == "__main__":
    unittest.main()
