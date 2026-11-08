"""Research-only bounded transfer and crash-recovery tests; no production I/O."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from research.burn_sqlite_lease_model import (
    connect, final_claim, initialize, issue_session,
)
from research.burn_transfer_fencing_model import (
    acquire_cleanup, begin_read, finish_cleanup, finish_read, migrate,
)


class TransferFencingResearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "research.sqlite")
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        migrate(self.db)
        self.drop_id = 7
        self.now = 1000.0
        self.db.execute(
            """INSERT INTO research_drops(id,status,expires_at,downloaded,quota)
               VALUES(?, 'active', ?, 0, 1)""",
            (self.drop_id, self.now + 600),
        )

    def owner(self, duration=5):
        token = issue_session(self.db, self.drop_id, self.now, duration=duration)
        self.assertTrue(final_claim(self.db, self.drop_id, token, self.now))
        return token

    def subprocess_operation(self, mode, now, *args):
        process = subprocess.run(
            [
                sys.executable, "-m", "research.burn_transfer_fencing_model",
                mode, self.path, str(self.drop_id), str(now), *[str(x) for x in args],
            ],
            cwd=str(Path(__file__).resolve().parents[1]),
            text=True, capture_output=True, timeout=20, check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout.strip().splitlines()[-1])["result"]

    def test_cross_worker_cleanup_respects_inflight_pin_after_session_expiry(self):
        token = self.owner(duration=5)
        pin = self.subprocess_operation("begin", self.now + 1, token)
        self.assertIsInstance(pin, str)
        self.assertIsNone(self.subprocess_operation("cleanup", self.now + 6))
        self.assertTrue(self.subprocess_operation("finish", self.now + 7, pin))
        claimed = self.subprocess_operation("cleanup", self.now + 8)
        self.assertIsInstance(claimed, dict)
        self.assertTrue(self.subprocess_operation(
            "finalize", self.now + 9, claimed["owner"], claimed["generation"]))
        self.assertEqual(
            self.db.execute("SELECT status FROM research_drops WHERE id=7").fetchone()[0],
            "deleted",
        )

    def test_pin_expiry_allows_recovery_if_transfer_never_finishes(self):
        token = self.owner(duration=2)
        pin = self.subprocess_operation("begin", self.now + 1, token)
        self.assertIsNone(self.subprocess_operation("cleanup", self.now + 6))
        claim = self.subprocess_operation("cleanup", self.now + 22)
        self.assertIsNotNone(claim)
        self.assertFalse(finish_read(self.db, pin, self.now + 22))

    def test_drop_expiry_allows_bounded_drain_but_never_indefinite_retention(self):
        self.db.execute(
            "UPDATE research_drops SET expires_at=? WHERE id=7", (self.now + 3,)
        )
        token = self.owner(duration=20)
        pin = begin_read(
            self.db, self.drop_id, token, self.now + 2,
            transfer_window=20, drop_grace=5,
        )
        self.assertTrue(pin)
        self.assertIsNone(self.subprocess_operation("cleanup", self.now + 4))
        self.assertIsNotNone(self.subprocess_operation("cleanup", self.now + 8))
        self.assertFalse(finish_read(self.db, pin, self.now + 8))

    def test_expired_session_cannot_begin_new_read(self):
        token = self.owner(duration=2)
        self.assertIsNone(begin_read(self.db, self.drop_id, token, self.now + 3))
        self.assertIsNotNone(self.subprocess_operation("cleanup", self.now + 3))

    def test_invalid_token_cannot_start_or_finish(self):
        token = self.owner()
        self.assertIsNone(begin_read(self.db, self.drop_id, "forged", self.now + 1))
        pin = begin_read(self.db, self.drop_id, token, self.now + 1)
        self.assertTrue(pin)
        self.assertFalse(finish_read(self.db, "other-pin", self.now + 2))
        self.assertTrue(finish_read(self.db, pin, self.now + 2))
        self.assertFalse(finish_read(self.db, pin, self.now + 2))

    def test_cleanup_lease_is_exclusive_across_workers(self):
        self.owner(duration=1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(
                lambda _: self.subprocess_operation("cleanup", self.now + 2),
                range(2),
            ))
        self.assertEqual(sorted(bool(x) for x in claims), [False, True])

    def test_stale_generation_cannot_complete_reclaimed_deletion(self):
        self.owner(duration=1)
        old = acquire_cleanup(self.db, self.drop_id, self.now + 2, cleanup_lease=5)
        self.assertTrue(old)
        self.assertIsNone(self.subprocess_operation("cleanup", self.now + 3))
        current = self.subprocess_operation("cleanup", self.now + 8)
        self.assertIsNotNone(current)
        self.assertEqual(current["generation"], old["generation"] + 1)
        self.assertFalse(finish_cleanup(
            self.db, self.drop_id, old["owner"], old["generation"], self.now + 9))
        self.assertTrue(self.subprocess_operation(
            "finalize", self.now + 9, current["owner"], current["generation"]))
        self.assertEqual(self.db.execute(
            "SELECT status FROM research_drops WHERE id=7"
        ).fetchone()[0], "deleted")

    def test_abrupt_crash_after_committed_deletion_claim_is_recoverable(self):
        self.owner(duration=1)
        script = """
import json, os, sys
from research.burn_sqlite_lease_model import connect
from research.burn_transfer_fencing_model import migrate, acquire_cleanup
with connect(sys.argv[1]) as db:
    migrate(db)
    claim = acquire_cleanup(db, 7, 1002.0, cleanup_lease=5)
    print(json.dumps(claim), flush=True)
os._exit(71)
"""
        process = subprocess.run(
            [sys.executable, "-c", script, self.path],
            cwd=str(Path(__file__).resolve().parents[1]),
            text=True, capture_output=True, timeout=20, check=False,
        )
        self.assertEqual(process.returncode, 71, process.stderr)
        old = json.loads(process.stdout.strip().splitlines()[-1])
        self.assertTrue(old)
        self.assertIsNone(self.subprocess_operation("cleanup", self.now + 3))
        current = self.subprocess_operation("cleanup", self.now + 8)
        self.assertEqual(current["generation"], old["generation"] + 1)
        self.assertFalse(self.subprocess_operation(
            "finalize", self.now + 9, old["owner"], old["generation"]))
        self.assertTrue(self.subprocess_operation(
            "finalize", self.now + 9, current["owner"], current["generation"]))

    def test_deleting_state_fences_new_read(self):
        token = self.owner(duration=1)
        claim = self.subprocess_operation("cleanup", self.now + 2)
        self.assertTrue(claim)
        self.assertIsNone(begin_read(self.db, self.drop_id, token, self.now + 2))

    def test_expired_cleanup_owner_cannot_finish_without_reclaim(self):
        self.owner(duration=1)
        claim = acquire_cleanup(self.db, self.drop_id, self.now + 2, cleanup_lease=5)
        self.assertFalse(finish_cleanup(
            self.db, self.drop_id, claim["owner"], claim["generation"], self.now + 7))
        self.assertEqual(self.db.execute(
            "SELECT status FROM research_drops WHERE id=7"
        ).fetchone()[0], "deleting")


if __name__ == "__main__":
    unittest.main()
