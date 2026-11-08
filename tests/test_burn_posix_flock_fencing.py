"""POSIX-only synthetic tests for fenced cleanup of temporary Burn packs.

These are research experiments, not proof about live NESS Burn routes.
Time is injected to force lease expiration without real-world waiting.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from research.burn_sqlite_lease_model import connect, final_claim, initialize, issue_session
from research.burn_transfer_fencing_model import begin_read, finish_read, migrate
from research.burn_filesystem_crash_harness import MARKER, prepare_synthetic_pack


@unittest.skipUnless(os.name == "posix", "fcntl.flock research requires POSIX")
class PosixFlockFenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / MARKER).write_text("synthetic-only", encoding="utf-8")
        self.path = str(self.root / "research.sqlite")
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        migrate(self.db)
        self.db.execute(
            """INSERT INTO research_drops(id,status,expires_at,downloaded,quota)
               VALUES(7,'active',1600.0,0,1)"""
        )
        self.directory = prepare_synthetic_pack(self.root, 7, b"safe temporary research bytes")
        self.file = self.directory / "second-file.txt"
        self.token = issue_session(self.db, 7, 1000.0, duration=1.0)
        self.assertTrue(final_claim(self.db, 7, self.token, 1000.0))

    def _cmd(self, claim_now, *options):
        return [
            sys.executable, "-m", "research.burn_posix_flock_fencing",
            self.path, str(self.root), "7", str(claim_now), *options,
        ]

    def _start(self, claim_now, *options):
        return subprocess.Popen(
            self._cmd(claim_now, *options),
            cwd=str(Path(__file__).resolve().parents[1]),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def _finish(self, proc, expected=0):
        try:
            out, err = proc.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            self.fail("worker timed out")
        self.assertEqual(proc.returncode, expected, err)
        self.assertTrue(out.strip(), err)
        return json.loads(out.strip().splitlines()[-1])

    def _run(self, now, *opts, expected=0):
        return self._finish(self._start(now, *opts), expected)

    def _db_state(self):
        row = self.db.execute(
            "SELECT status, delete_generation FROM research_drops WHERE id=7"
        ).fetchone()
        return tuple(row)

    def test_paused_stale_worker_cannot_delete_after_lease_expiry(self):
        paused = self._start(
            1002, "--acting-now", "1008", "--pause"
        )
        contender = None
        try:
            ready = self.root / ".ready-7"
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                if paused.poll() is not None:
                    break
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "worker A did not acquire and pause")
            self.assertTrue(self.file.exists())
            contender = self._start(1008)
            time.sleep(0.16)
            self.assertIsNone(contender.poll(), "worker B bypassed worker A's OS lock")
            self.assertTrue(self.file.exists())
            (self.root / ".resume-7").write_text("continue", encoding="ascii")
            a = self._finish(paused)
            b = self._finish(contender)
            self.assertEqual(a["outcome"], "stale", a)
            self.assertEqual(a["generation"], 1)
            self.assertEqual(b["outcome"], "deleted", b)
            self.assertEqual(b["generation"], 2)
            self.assertFalse(self.file.exists())
            self.assertEqual(self._db_state(), ("deleted", 2))
        finally:
            if paused.poll() is None:
                paused.kill()
                paused.communicate()
            if contender is not None and contender.poll() is None:
                contender.kill()
                contender.communicate()

    def test_stale_worker_without_reclaimer_leaves_files_untouched(self):
        outcome = self._run(1002, "--acting-now", "1008")
        self.assertEqual(outcome["outcome"], "stale")
        self.assertTrue(self.file.exists())
        self.assertEqual(self._db_state(), ("deleting", 1))
        recovered = self._run(1008)
        self.assertEqual(recovered["outcome"], "deleted")
        self.assertFalse(self.file.exists())

    def test_sigexit_releases_flock_and_reclaimed_worker_cleans_staging(self):
        dying = self._run(1002, "--crash-after-stage", expected=76)
        self.assertEqual(dying["outcome"], "staged_then_killed")
        self.assertFalse(self.directory.exists())
        self.assertEqual(len(list(self.root.glob(".trash-7-g*"))), 1)
        blocked = self._run(1003)
        self.assertEqual(blocked["outcome"], "not_claimed")
        recovered = self._run(1008)
        self.assertEqual(recovered["outcome"], "deleted")
        self.assertEqual(recovered["generation"], 2)
        self.assertEqual(list(self.root.glob(".trash-7-g*")), [])
        self.assertEqual(self._db_state(), ("deleted", 2))

    def test_both_workers_racing_get_single_cleanup_winner(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: self._run(1002), range(2)))
        self.assertEqual(sorted(v["outcome"] for v in outcomes),
                         ["deleted", "not_claimed"])
        self.assertEqual(self._db_state(), ("deleted", 1))

    def test_live_read_pin_blocks_flock_worker_until_completion(self):
        # Session is still valid at read start; then it expires, but a bounded
        # transfer pin keeps the synthetic pack available across workers.
        # Extend the already-charged finishing-session deadline in the model.
        # A fresh session cannot be issued after the drop is quota-closed.
        self.db.execute(
            "UPDATE research_sessions SET expires_at=1005.0 WHERE drop_id=7"
        )
        pin = begin_read(self.db, 7, self.token, 1001.0)
        self.assertTrue(pin)
        self.assertEqual(self._run(1006)["outcome"], "not_claimed")
        self.assertTrue(self.file.exists())
        self.assertTrue(finish_read(self.db, pin, 1007.0))
        self.assertEqual(self._run(1008)["outcome"], "deleted")
        self.assertFalse(self.file.exists())

    def test_unmarked_directory_is_never_accepted(self):
        with tempfile.TemporaryDirectory() as unmarked:
            proc = subprocess.run(
                [sys.executable, "-m", "research.burn_posix_flock_fencing",
                 self.path, unmarked, "7", "1002"],
                cwd=str(Path(__file__).resolve().parents[1]),
                text=True, capture_output=True, timeout=8,
            )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("marked research sandbox", proc.stderr)
        self.assertTrue(self.file.exists())


if __name__ == "__main__":
    unittest.main()
