import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from adapters import utc_now
from cloud_catalog import CloudCatalog


class CloudCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.catalog = CloudCatalog(Path(self.temp.name) / "cloud-snapshot.json")

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, observed_at=None, records=None):
        return {
            "version": 1,
            "observedAt": (observed_at or utc_now()).isoformat().replace("+00:00", "Z"),
            "sourceUrl": "https://chatgpt.com/scheduled",
            "records": records if records is not None else [{
                "id": "cloud:schedule-01", "name": "每日提醒", "status": "ACTIVE",
                "scheduleLabel": "每天09:00", "nextDisplay": "明天09:00",
                "threadUrl": "https://chatgpt.com/scheduled", "executionStatus": "unknown",
            }],
        }

    def test_missing_snapshot_is_available_as_an_explicit_absence(self):
        state = self.catalog.state()
        self.assertFalse(state["available"])
        self.assertTrue(state["stale"])
        self.assertEqual([], state["records"])

    def test_rejects_malformed_or_duplicate_local_ids_without_writing(self):
        malformed = self.snapshot(records=[{"id": "not-local", "name": "x", "status": "ACTIVE", "scheduleLabel": "每天"}])
        with self.assertRaises(ValueError):
            self.catalog.import_snapshot(malformed)
        duplicate = self.snapshot(records=[
            {"id": "cloud:duplicate", "name": "一", "status": "ACTIVE", "scheduleLabel": "每天"},
            {"id": "cloud:duplicate", "name": "二", "status": "PAUSED", "scheduleLabel": "每周"},
        ])
        with self.assertRaises(ValueError):
            self.catalog.import_snapshot(duplicate)
        self.assertFalse(self.catalog.path.exists())

    def test_stale_snapshot_is_marked_stale_and_active_is_not_running(self):
        observed = utc_now() - timedelta(hours=25)
        self.catalog.import_snapshot(self.snapshot(observed))
        state = self.catalog.state(now=utc_now())
        self.assertTrue(state["stale"])
        record = state["records"][0]
        self.assertEqual("cloud:schedule-01", record["id"])
        self.assertEqual("ACTIVE", record["status"])
        self.assertEqual("unknown", record["executionStatus"])
        self.assertEqual("stale", record["freshness"])

    def test_a_running_observation_expires_after_two_minutes(self):
        observed = utc_now() - timedelta(minutes=3)
        record = self.snapshot(observed)["records"][0]
        record["executionStatus"] = "running"
        self.catalog.import_snapshot(self.snapshot(observed, [record]))
        self.assertEqual("unknown", self.catalog.state(now=utc_now())["records"][0]["executionStatus"])

    def test_rejects_non_chatgpt_links(self):
        snapshot = self.snapshot()
        snapshot["records"][0]["threadUrl"] = "https://example.test/path"
        with self.assertRaises(ValueError):
            self.catalog.import_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
