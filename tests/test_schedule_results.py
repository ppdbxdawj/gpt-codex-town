import tempfile
import unittest
from pathlib import Path

from cloud_catalog import CloudCatalog
from desktop_service import DesktopService
from review_store import ReviewStore
from schedule_results import ScheduleResults, review_result_id


class FakeAdapter:
    def __init__(self, automations=None, tasks=None):
        self.automations = automations or []
        self.tasks = tasks or []

    def snapshot(self):
        return {"sources": [], "tasks": self.tasks, "automations": self.automations, "scope": {}}

    def _read_codex(self):
        return [], [], None

    def _read_catalog(self):
        return [], [], None


class ScheduleResultsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ReviewStore(self.root / "reviews.sqlite3")
        self.results = ScheduleResults(self.root / "cloud-results.json")
        self.catalog = CloudCatalog(self.root / "cloud-snapshot.json")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    @staticmethod
    def record(automation_id="cloud:one", result_id="message-one", task_id="thread-one"):
        return {
            "automationId": automation_id, "id": result_id, "taskId": task_id, "turnId": "turn-one",
            "title": "真实计划产出", "body": "这是一份可供阅读的真实结果。",
            "createdAt": "2026-10-27T03:42:00Z", "threadUrl": "https://chatgpt.com/c/thread-one",
            "provenance": "手动读取任务最终消息",
        }

    def snapshot(self, records=None):
        return {"version": 1, "observedAt": "2026-10-27T03:42:58Z", "records": records or [self.record()]}

    def import_catalog(self, records):
        self.catalog.import_snapshot({
            "version": 1, "observedAt": "2026-10-27T03:42:58Z",
            "sourceUrl": "https://chatgpt.com/scheduled", "records": records,
        })

    @staticmethod
    def schedule(automation_id, status="ACTIVE"):
        return {"id": automation_id, "name": automation_id, "status": status,
                "scheduleLabel": "每天", "executionStatus": "unknown"}

    def test_reimports_three_ids_without_resetting_review_state(self):
        records = [self.record(result_id="one"), self.record(result_id="two"), self.record(result_id="cloud-result:three")]
        snapshot = self.results.import_snapshot(self.snapshot(records))
        review_records = self.results.review_records(snapshot["records"], {"cloud:one"})
        self.store.import_results(review_records)
        self.store.mark_read(review_result_id("one"))
        self.store.import_results(review_records)
        inbox = {item["id"]: item for item in self.store.inbox()["items"]}
        self.assertEqual(3, len(inbox))
        self.assertEqual("read", inbox[review_result_id("one")]["status"])
        self.assertIn("cloud-result:three", inbox)

    def test_rejects_invalid_url_or_empty_body_without_writing_snapshot(self):
        invalid_url = self.record()
        invalid_url["threadUrl"] = "https://example.test/c/thread-one"
        with self.assertRaises(ValueError):
            self.results.import_snapshot(self.snapshot([invalid_url]))
        self.assertFalse(self.results.path.exists())
        invalid_body = self.record()
        invalid_body["body"] = "  "
        with self.assertRaises(ValueError):
            self.results.import_snapshot(self.snapshot([invalid_body]))
        self.assertFalse(self.results.path.exists())

    def test_only_active_cloud_schedule_gets_its_exact_snapshot_result(self):
        self.import_catalog([self.schedule("cloud:one", "ACTIVE"), self.schedule("cloud:two", "PAUSED")])
        active = self.record("cloud:one", "selected", "shared-thread")
        paused = self.record("cloud:two", "paused", "other-thread")
        self.results.import_snapshot(self.snapshot([active, paused]))
        # A newer result on the same task must not replace the selected message.
        self.store.import_results([{
            "id": "local-newer", "dedupKey": "local-newer", "taskId": "shared-thread", "turnId": "later",
            "title": "其他消息", "source": "codex", "createdAt": "2026-10-27T04:00:00Z",
            "body": "不属于该云端计划。", "summary": "不属于该云端计划。",
            "threadUrl": "codex://threads/shared-thread", "artifacts": [],
        }])
        state = DesktopService(adapter=FakeAdapter(), store=self.store, cloud_catalog=self.catalog,
                               schedule_results=self.results).state()
        automations = {item["id"]: item for item in state["automations"]}
        attached = automations["cloud:one"]
        self.assertEqual("available", attached["resultAvailability"])
        self.assertEqual([review_result_id("selected")], [item["id"] for item in attached["results"]])
        self.assertEqual("手动读取任务最终消息", attached["results"][0]["provenance"])
        self.assertEqual("unavailable", automations["cloud:two"]["resultAvailability"])
        self.assertEqual(0, automations["cloud:two"]["resultCount"])
        self.assertNotIn(review_result_id("paused"), {item["id"] for item in state["inbox"]["items"]})

    def test_missing_active_result_does_not_claim_completion(self):
        self.import_catalog([self.schedule("cloud:one", "ACTIVE")])
        self.results.import_snapshot(self.snapshot([self.record("cloud:other", "other")]))
        state = DesktopService(adapter=FakeAdapter(), store=self.store, cloud_catalog=self.catalog,
                               schedule_results=self.results).state()
        automation = next(item for item in state["automations"] if item["id"] == "cloud:one")
        self.assertEqual("unavailable", automation["resultAvailability"])
        self.assertEqual(0, automation["resultCount"])
        self.assertEqual([], automation["results"])

    def test_local_automation_card_uses_short_markdown_heading_without_rewriting_history(self):
        record = {
            "id": "morning-result", "dedupKey": "morning-result", "taskId": "morning-thread",
            "turnId": "turn-one", "title": "Create a Scheduled Task called Morning Brief",
            "source": "codex", "createdAt": "2026-10-27T04:00:00Z",
            "body": "\n# Morning Brief\n\n今天的简报正文。", "summary": "今天的简报正文。",
            "threadUrl": "codex://threads/morning-thread", "artifacts": [],
        }
        self.store.import_results([record])
        adapter = FakeAdapter([{
            "id": "morning-plan", "name": "Morning Brief", "status": "ACTIVE", "source": "codex",
            "cloud": False, "threadId": "morning-thread", "executionStatus": "unknown",
        }])
        state = DesktopService(adapter=adapter, store=self.store, cloud_catalog=self.catalog,
                               schedule_results=self.results).state()
        automation = next(item for item in state["automations"] if item["id"] == "morning-plan")
        self.assertEqual("Morning Brief", automation["results"][0]["title"])
        self.assertEqual("Create a Scheduled Task called Morning Brief", self.store.get_item("morning-result")["title"])

    def test_local_automation_reuses_associated_task_progress_without_claiming_trigger(self):
        progress = {
            "availability": "available", "source": "local-log", "phase": "running", "turnId": "turn-live",
            "updatedAt": "2026-10-27T04:00:00Z", "truncated": False,
            "events": [{"id": "event", "at": "2026-10-27T04:00:00Z", "kind": "update", "label": "进展更新"}],
        }
        adapter = FakeAdapter([{
            "id": "morning-plan", "name": "Morning Brief", "status": "ACTIVE", "source": "codex",
            "cloud": False, "threadId": "morning-thread", "executionStatus": "unknown",
        }], [{"id": "morning-thread", "progress": progress}])
        state = DesktopService(adapter=adapter, store=self.store, cloud_catalog=self.catalog,
                               schedule_results=self.results).state()
        attached = next(item for item in state["automations"] if item["id"] == "morning-plan")["progress"]
        self.assertEqual(progress["events"], attached["events"])
        self.assertIn("不代表由此定时计划触发", attached["message"])

    def test_cloud_automation_process_is_unavailable_even_when_active(self):
        self.import_catalog([self.schedule("cloud:one", "ACTIVE")])
        self.results.import_snapshot(self.snapshot([self.record("cloud:one", "result")]))
        state = DesktopService(adapter=FakeAdapter(), store=self.store, cloud_catalog=self.catalog,
                               schedule_results=self.results).state()
        progress = next(item for item in state["automations"] if item["id"] == "cloud:one")["progress"]
        self.assertEqual("unavailable", progress["availability"])
        self.assertEqual("cloud-snapshot", progress["source"])
        self.assertEqual([], progress["events"])


if __name__ == "__main__":
    unittest.main()
