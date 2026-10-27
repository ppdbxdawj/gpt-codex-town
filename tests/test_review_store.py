import tempfile
import unittest
from pathlib import Path

from cloud_catalog import CloudCatalog
from desktop_service import DesktopService, response_for_line, review_body
from review_store import ReviewStore, is_non_notifying_heartbeat


class ReviewStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "reviews.sqlite3"
        self.store = ReviewStore(self.database)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def record(self, turn="turn-a", result_id="result-a"):
        return {"id": result_id, "dedupKey": f"task-a:turn:{turn}", "taskId": "task-a", "turnId": turn,
                "title": "Task", "source": "codex", "createdAt": "2026-10-27T00:00:00Z", "body": "Done.",
                "summary": "Done.", "threadUrl": "codex://threads/task-a", "artifacts": [], "cwd": str(self.root)}

    def test_deduplicates_same_turn_without_changing_unread_state(self):
        self.store.import_results([self.record(), self.record()])
        inbox = self.store.inbox()
        self.assertEqual(1, len(inbox["items"]))
        self.assertEqual("unread", inbox["items"][0]["status"])

    def test_persists_review_state_across_restart(self):
        self.store.import_results([self.record()])
        self.store.accept("result-a")
        self.store.close()
        self.store = ReviewStore(self.database)
        item = self.store.inbox()["items"][0]
        self.assertEqual("accepted", item["status"])
        self.assertIsNotNone(item["acceptedAt"])

    def test_read_does_not_accept_and_reopen_returns_to_pending(self):
        self.store.import_results([self.record()])
        self.store.mark_read("result-a")
        self.assertEqual("read", self.store.inbox()["items"][0]["status"])
        self.store.accept("result-a")
        self.store.reopen("result-a")
        item = self.store.inbox()["items"][0]
        self.assertEqual("read", item["status"])
        self.assertIsNone(item["acceptedAt"])
        self.assertIsNotNone(item["readAt"])

    def test_new_turn_is_a_separate_historical_review_item(self):
        self.store.import_results([self.record("turn-a", "result-a"), self.record("turn-b", "result-b")])
        self.assertEqual(2, len(self.store.inbox()["items"]))

    def test_artifact_path_is_revalidated(self):
        artifact = self.root / "deliverable.txt"
        artifact.write_text("ok")
        record = self.record()
        record["artifacts"] = [{"id": "artifact-a", "name": artifact.name, "path": str(artifact), "url": "manor://artifact/result-a/artifact-a"}]
        self.store.import_results([record])
        self.assertEqual(str(artifact.resolve()), self.store.artifact_path("result-a", "artifact-a"))

    def test_rejects_malformed_input_without_creating_item(self):
        with self.assertRaises(ValueError):
            self.store.import_results([{"id": "missing-fields"}])
        self.assertEqual([], self.store.inbox()["items"])

    def test_reimport_updates_content_without_resetting_acceptance(self):
        first = self.record()
        first["body"] = "第一段\n\n[原始链接](https://example.test/result)"
        first["summary"] = "第一段"
        self.store.import_results([first])
        self.store.accept("result-a")
        updated = self.record()
        updated.update({"title": "更新后的标题", "body": "第二段\n\n[保留链接](https://example.test/new)", "summary": "第二段"})
        self.store.import_results([updated])
        item = self.store.inbox()["items"][0]
        self.assertEqual("accepted", item["status"])
        self.assertEqual("更新后的标题", item["title"])
        self.assertEqual(updated["body"], item["body"])
        self.assertIsNotNone(item["acceptedAt"])

    def test_review_body_preserves_markdown_paragraphs_and_links(self):
        body = review_body("第一段\n\n[成果链接](https://example.test/result)\n\n第二段")
        self.assertIn("\n\n", body)
        self.assertIn("https://example.test/result", body)

    def test_hides_legacy_dont_notify_heartbeat_from_items_and_counts(self):
        record = self.record()
        record["body"] = "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>"
        self.store.import_results([record])
        inbox = self.store.inbox()
        self.assertEqual([], inbox["items"])
        self.assertEqual(0, inbox["pendingCount"])
        self.assertTrue(is_non_notifying_heartbeat(record["body"]))

    def test_keeps_real_text_that_merely_mentions_heartbeat(self):
        record = self.record()
        record["body"] = "成果已生成。\n\n<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>"
        self.store.import_results([record])
        self.assertEqual("result-a", self.store.inbox()["items"][0]["id"])
        self.assertFalse(is_non_notifying_heartbeat(record["body"]))

    def test_corrupt_jsonl_request_returns_one_protocol_error(self):
        response = response_for_line(None, "{not-json}\n")
        self.assertEqual({"id": None}, {"id": response["id"]})
        self.assertIn("error", response)

    def test_non_object_params_return_protocol_error_without_crashing_service(self):
        service = DesktopService(store=self.store)
        response = response_for_line(service, '{"id":"x","method":"mark_read","params":"bad"}\n')
        self.assertEqual("x", response["id"])
        self.assertIn("error", response)

    def test_import_cloud_snapshot_merges_without_turning_active_into_running(self):
        class FakeAdapter:
            def snapshot(self):
                return {"sources": [], "tasks": [], "automations": [{
                    "id": "local-plan", "name": "本机计划", "status": "ACTIVE", "source": "codex",
                    "cloud": False, "executionStatus": "unknown",
                }], "scope": {}}

            def _read_codex(self):
                return [], [], None

            def _read_catalog(self):
                return [], [], None

        service = DesktopService(adapter=FakeAdapter(), store=self.store,
                                 cloud_catalog=CloudCatalog(self.root / "cloud-snapshot.json"))
        snapshot = {"version": 1, "observedAt": "2026-10-27T03:08:00Z",
                    "sourceUrl": "https://chatgpt.com/scheduled", "records": [{
                        "id": "cloud:schedule-01", "name": "云端计划", "status": "ACTIVE",
                        "scheduleLabel": "每天09:00", "nextDisplay": "明天09:00",
                        "threadUrl": "https://chatgpt.com/scheduled", "executionStatus": "unknown",
                    }]}
        state = service.dispatch("import_cloud_snapshot", {"snapshot": snapshot})
        self.assertTrue(state["cloudSync"]["available"])
        self.assertEqual(["codex", "chatgpt"], [item["source"] for item in state["automations"]])
        self.assertTrue(all(item["executionStatus"] == "unknown" for item in state["automations"]))


if __name__ == "__main__":
    unittest.main()
