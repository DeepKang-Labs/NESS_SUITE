"""Windows/Ubuntu synthetic multi-process deletion-fencing contract.

Tests use subprocesses, SQLite and a marked TemporaryDirectory only. Fixed
clock inputs enable deterministic lease expiry but do not simulate wall-clock
drift or production load. No production NESS Burn code is modified.
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


@unittest.skipUnless(os.name in ("nt", "posix"), "unsupported lock backend")
class PortableCleanupFenceTests(unittest.TestCase):
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
            "INSERT INTO research_drops(id,status,expires_at,downloaded,quota)"
            " VALUES(7,'active',1600.0,0,1)"
        )
        self.pack = prepare_synthetic_pack(
            self.root, 7, b"synthetic research bytes, never user content"
        )
        self.file = self.pack / "second-file.txt"
        self.session = issue_session(self.db, 7, 1000.0, duration=1)
        self.assertTrue(final_claim(self.db, 7, self.session, 1000.0))
        self.processes = []

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.communicate(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

    def cmd(self, now, *options):
        return [
            sys.executable, "-m", "research.burn_portable_cleanup_fencing",
            self.path, str(self.root), "7", str(now), *options,
        ]

    def start(self, now, *options):
        proc = subprocess.Popen(
            self.cmd(now, *options),
            cwd=str(Path(__file__).resolve().parents[1]),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.processes.append(proc)
        return proc

    def result(self, proc, expected_returncode=0):
        out, err = proc.communicate(timeout=14)
        self.assertEqual(proc.returncode, expected_returncode, err)
        self.assertTrue(out.strip(), err)
        return json.loads(out.strip().splitlines()[-1])

    def run_worker(self, now, *options, expected_returncode=0):
        return self.result(self.start(now, *options), expected_returncode)

    def state(self):
        return tuple(self.db.execute(
            "SELECT status, delete_generation FROM research_drops WHERE id=7"
        ).fetchone())

    def pause_owner(self):
        proc = self.start(1002, "--acting-now", "1008", "--pause")
        marker = self.root / ".paused-7"
        deadline = time.monotonic() + 7
        while not marker.exists() and time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            time.sleep(0.02)
        self.assertTrue(marker.exists(), "first cleaner never acquired the lock")
        return proc

    def resume_owner(self):
        (self.root / ".resume-7").write_text("continue", encoding="ascii")

    def test_paused_stale_worker_does_not_delete_after_successor_queues(self):
        first = self.pause_owner()
        contender = self.start(1008)
        time.sleep(0.15)
        self.assertIsNone(contender.poll(), "successor bypassed OS lock")
        self.assertTrue(self.file.exists())
        self.resume_owner()
        old = self.result(first)
        new = self.result(contender)
        self.assertEqual((old["outcome"], old["generation"]), ("stale", 1))
        self.assertEqual((new["outcome"], new["generation"]), ("deleted", 2))
        self.assertFalse(self.file.exists())
        self.assertEqual(self.state(), ("deleted", 2))

    def test_stale_owner_without_successor_leaves_pack_intact(self):
        old = self.run_worker(1002, "--acting-now", "1008")
        self.assertEqual(old["outcome"], "stale")
        self.assertTrue(self.file.exists())
        self.assertEqual(self.state(), ("deleting", 1))
        subsequent = self.run_worker(1008)
        self.assertEqual(subsequent["outcome"], "deleted")
        self.assertFalse(self.file.exists())

    def test_abrupt_exit_after_staging_releases_cross_process_lock(self):
        first = self.run_worker(1002, "--crash-after-stage", expected_returncode=76)
        self.assertEqual(first["outcome"], "staged_then_killed")
        self.assertEqual(len(list(self.root.glob(".trash-7-g*"))), 1)
        self.assertFalse(self.pack.exists())
        self.assertEqual(self.run_worker(1003)["outcome"], "not_claimed")
        recovered = self.run_worker(1008)
        self.assertEqual((recovered["outcome"], recovered["generation"]),
                         ("deleted", 2))
        self.assertEqual(list(self.root.glob(".trash-7-g*")), [])
        self.assertEqual(self.state(), ("deleted", 2))

    def test_racing_workers_have_exactly_one_winner(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: self.run_worker(1002), range(2)))
        self.assertEqual(
            sorted(v["outcome"] for v in outcomes),
            ["deleted", "not_claimed"],
        )
        self.assertEqual(self.state(), ("deleted", 1))

    def test_active_read_pin_defers_cleanup_across_processes(self):
        self.db.execute(
            "UPDATE research_sessions SET expires_at=1005.0 WHERE drop_id=7"
        )
        pin = begin_read(self.db, 7, self.session, 1001.0)
        self.assertIsNotNone(pin)
        self.assertEqual(self.run_worker(1006)["outcome"], "not_claimed")
        self.assertTrue(self.file.exists())
        self.assertTrue(finish_read(self.db, pin, 1007.0))
        self.assertEqual(self.run_worker(1008)["outcome"], "deleted")
        self.assertFalse(self.file.exists())

    def test_unmarked_directory_fails_without_touching_pack(self):
        with tempfile.TemporaryDirectory() as unmarked:
            result = subprocess.run(
                [sys.executable, "-m", "research.burn_portable_cleanup_fencing",
                 self.path, unmarked, "7", "1002"],
                cwd=str(Path(__file__).resolve().parents[1]),
                capture_output=True, text=True, timeout=10,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("marked research sandbox", result.stderr)
        self.assertTrue(self.file.exists())
        self.assertEqual(self.state(), ("burned", 0))

    def test_stable_lockfile_is_not_replaced_by_successive_cleaners(self):
        self.assertEqual(
            self.run_worker(1002, "--acting-now", "1008")["outcome"], "stale"
        )
        lock = self.root / ".portable-research-locks" / "pack-7.lck"
        self.assertTrue(lock.is_file())
        self.assertEqual(lock.read_bytes(), b"X")
        self.assertEqual(self.run_worker(1008)["outcome"], "deleted")
        self.assertTrue(lock.is_file())
        self.assertEqual(lock.read_bytes(), b"X")

    def test_negative_control_uncooperative_mutator_can_bypass_lock(self):
        # This verifies LIMITATIONS, not a passing security guarantee:
        # an actor ignoring advisory lock can remove an unlocked data file.
        paused = self.pause_owner()
        self.assertTrue(self.file.exists())
        self.file.unlink()
        self.assertFalse(self.file.exists(), "unexpected mandatory protection")
        self.resume_owner()
        self.assertEqual(self.result(paused)["outcome"], "stale")
        self.assertEqual(self.run_worker(1008)["outcome"], "deleted")


if __name__ == "__main__":
    unittest.main()
