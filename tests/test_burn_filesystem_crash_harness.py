"""Research synthetic-filesystem tests: actual removal only inside marked temp dirs."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from research.burn_sqlite_lease_model import connect, final_claim, initialize, issue_session
from research.burn_transfer_fencing_model import begin_read, finish_read, migrate
from research.burn_filesystem_crash_harness import (
    MARKER, cleanup_synthetic_pack, prepare_synthetic_pack,
)


class BurnFilesystemCrashResearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / MARKER).write_text("RESEARCH ONLY", encoding="utf-8")
        self.db_path = str(self.root / "research.sqlite")
        self.db = connect(self.db_path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        migrate(self.db)
        self.drop_id = 7
        self.now = 1000.0
        self.db.execute(
            """INSERT INTO research_drops(id,status,expires_at,downloaded,quota)
               VALUES(7,'active',1600.0,0,1)"""
        )
        self.pack = prepare_synthetic_pack(
            self.root, self.drop_id, b"synthetic data -- NOT PRIVATE"
        )
        self.file = self.pack / "second-file.txt"

    def owner(self, duration=5):
        token = issue_session(self.db, self.drop_id, self.now, duration=duration)
        self.assertTrue(final_claim(self.db, self.drop_id, token, self.now))
        return token

    def child(self, now, crash=None, expected_exit=0):
        cmd = [
            sys.executable, "-m", "research.burn_filesystem_crash_harness",
            self.db_path, str(self.root), str(self.drop_id), str(now),
        ]
        if crash:
            cmd.append(crash)
        result = subprocess.run(
            cmd, text=True, capture_output=True, timeout=20, check=False,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        self.assertEqual(result.returncode, expected_exit, result.stderr)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def status(self):
        return self.db.execute(
            "SELECT status FROM research_drops WHERE id=7"
        ).fetchone()[0]

    def test_live_transfer_pin_prevents_other_worker_from_unlinking(self):
        token = self.owner()
        pin = begin_read(self.db, self.drop_id, token, self.now + 1)
        self.assertTrue(pin)
        self.assertEqual(self.child(self.now + 6)["claimed"], False)
        self.assertEqual(self.file.read_bytes(), b"synthetic data -- NOT PRIVATE")
        self.assertTrue(finish_read(self.db, pin, self.now + 7))
        deleted = self.child(self.now + 8)
        self.assertTrue(deleted["claimed"] and deleted["completed"])
        self.assertFalse(self.pack.exists())
        self.assertEqual(self.status(), "deleted")

    def test_abrupt_crash_after_sqlite_claim_can_be_recovered(self):
        self.owner(duration=1)
        self.assertEqual(self.child(self.now + 2, "claim", expected_exit=73)["crash_at"], "claim")
        self.assertTrue(self.file.exists())
        self.assertFalse(self.child(self.now + 3)["claimed"])
        final = self.child(self.now + 33)
        self.assertTrue(final["completed"])
        self.assertFalse(self.pack.exists())
        self.assertEqual(self.status(), "deleted")

    def test_abrupt_crash_after_filesystem_staging_can_be_recovered(self):
        self.owner(duration=1)
        self.assertEqual(self.child(self.now + 2, "stage", expected_exit=74)["crash_at"], "stage")
        self.assertFalse(self.pack.exists())
        staged = list(self.root.glob(".trash-7-g*"))
        self.assertEqual(len(staged), 1)
        self.assertEqual((staged[0] / "second-file.txt").read_bytes(), b"synthetic data -- NOT PRIVATE")
        self.assertFalse(self.child(self.now + 3)["claimed"])
        final = self.child(self.now + 33)
        self.assertTrue(final["completed"])
        self.assertEqual(list(self.root.glob(".trash-7-g*")), [])
        self.assertEqual(self.status(), "deleted")

    def test_second_cleanup_after_completion_cannot_reclaim(self):
        self.owner(duration=1)
        self.assertTrue(self.child(self.now + 2)["completed"])
        self.assertFalse(self.child(self.now + 60)["claimed"])
        self.assertEqual(self.status(), "deleted")

    def test_filesystem_harness_refuses_unmarked_directory(self):
        self.owner(duration=1)
        with tempfile.TemporaryDirectory() as unmarked:
            with self.assertRaises(ValueError):
                cleanup_synthetic_pack(self.db_path, unmarked, self.drop_id, self.now + 2)
        self.assertTrue(self.file.exists())
        self.assertEqual(self.status(), "burned")

    def test_bounded_grace_after_drop_expiry_protects_real_file(self):
        self.db.execute("UPDATE research_drops SET expires_at=1003.0 WHERE id=7")
        token = self.owner(duration=25)
        pin = begin_read(
            self.db, self.drop_id, token, self.now + 2,
            transfer_window=20, drop_grace=5,
        )
        self.assertTrue(pin)
        self.assertFalse(self.child(self.now + 4)["claimed"])
        self.assertTrue(self.file.exists())
        self.assertTrue(self.child(self.now + 8)["completed"])
        self.assertFalse(self.file.exists())
        self.assertFalse(finish_read(self.db, pin, self.now + 8))


if __name__ == "__main__":
    unittest.main()
