"""Adversarial path and crash-failure tests for synthetic Burn research cleanup.

Cross-platform tests only touch TemporaryDirectory synthetic data and use
the explicit research marker. Link tests skip where the OS does not permit
creating a test link. They characterize the cooperative sandbox policy;
they do not claim protection from attacker-controlled TOCTOU replacement.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from research.burn_sqlite_lease_model import connect, final_claim, initialize, issue_session
from research.burn_transfer_fencing_model import migrate
from research.burn_filesystem_crash_harness import MARKER, prepare_synthetic_pack
from research.burn_path_safety_research import (
    UnsafeResearchPath, checked_root, checked_tree,
)


class BurnPathSafetyCrashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / MARKER).write_text("synthetic research only", encoding="utf-8")
        self.dbpath = str(self.root / "research.sqlite")
        self.db = connect(self.dbpath)
        self.addCleanup(self.db.close)
        initialize(self.db)
        migrate(self.db)
        self.db.execute(
            "INSERT INTO research_drops(id,status,expires_at,downloaded,quota)"
            " VALUES(7,'active',1600.0,0,1)"
        )
        self.pack = prepare_synthetic_pack(self.root, 7, b"temporary synthetic bytes")
        self.session = issue_session(self.db, 7, 1000.0, duration=1)
        self.assertTrue(final_claim(self.db, 7, self.session, 1000))

    def _subprocess(self, now=1002, *options, expected=0):
        result = subprocess.run(
            [sys.executable, "-m", "research.burn_portable_cleanup_fencing",
             self.dbpath, str(self.root), "7", str(now), *options],
            cwd=str(Path(__file__).resolve().parents[1]),
            capture_output=True, text=True, timeout=15,
        )
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stderr)
        return result

    def _state(self):
        return tuple(self.db.execute(
            "SELECT status, delete_generation FROM research_drops WHERE id=7"
        ).fetchone())

    def _external_sentinel(self):
        # Separate sibling of the sandbox, but still inside test-managed temp storage.
        sibling = Path(self.tmp.name).with_name(Path(self.tmp.name).name + "_sentinel")
        # Avoid unmanaged sibling paths: use a nested, NOT pack-owned directory.
        sibling = self.root / "external_synthetic"
        sibling.mkdir(exist_ok=True)
        sentinel = sibling / "must_remain.txt"
        sentinel.write_bytes(b"must never delete research sentinel")
        return sibling, sentinel

    def _symlink_or_skip(self, destination, target, *, directory=False):
        try:
            destination.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"test symlink capability unavailable: {exc}")

    def test_regular_pack_cleanup_remains_functional(self):
        result = self._subprocess()
        self.assertIn('"outcome": "deleted"', result.stdout)
        self.assertEqual(self._state(), ("deleted", 1))
        self.assertFalse(self.pack.exists())

    def test_sandbox_marker_link_is_rejected(self):
        marker = self.root / MARKER
        marker.unlink()
        original = self.root / "real_marker"
        original.write_text("synthetic", encoding="utf-8")
        self._symlink_or_skip(marker, original)
        with self.assertRaises(UnsafeResearchPath):
            checked_root(self.root)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.pack.is_dir())

    def test_pack_directory_symlink_is_rejected(self):
        outside, sentinel = self._external_sentinel()
        shutil.rmtree(self.pack)
        self._symlink_or_skip(self.pack, outside, directory=True)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(sentinel.is_file())
        self.assertEqual(sentinel.read_bytes(), b"must never delete research sentinel")

    def test_nested_symlink_inside_pack_fails_closed(self):
        _, sentinel = self._external_sentinel()
        self._symlink_or_skip(self.pack / "alias", sentinel)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(sentinel.is_file())
        self.assertEqual(self._state(), ("deleting", 1))

    def test_lockfile_symlink_is_rejected_before_claim(self):
        _, sentinel = self._external_sentinel()
        locks = self.root / ".portable-research-locks"
        locks.mkdir()
        self._symlink_or_skip(locks / "pack-7.lck", sentinel)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_bytes(), b"must never delete research sentinel")
        self.assertEqual(self._state(), ("burned", 0))

    def test_lockdir_symlink_is_rejected_before_claim(self):
        outside, sentinel = self._external_sentinel()
        self._symlink_or_skip(self.root / ".portable-research-locks", outside, directory=True)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(sentinel.is_file())
        self.assertEqual(self._state(), ("burned", 0))

    def test_staged_symlink_fails_closed_and_preserves_outside(self):
        outside, sentinel = self._external_sentinel()
        self._symlink_or_skip(self.root / ".trash-7-g0", outside, directory=True)
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(sentinel.is_file())
        self.assertEqual(self._state(), ("deleting", 1))

    def test_failure_after_claim_can_be_recovered(self):
        failure = self._subprocess(1002, "--failure-at", "after_claim", expected=None)
        self.assertNotEqual(failure.returncode, 0)
        self.assertTrue(self.pack.is_dir())
        self.assertEqual(self._state(), ("deleting", 1))
        self.assertIn('"outcome": "not_claimed"', self._subprocess(1003).stdout)
        self.assertIn('"outcome": "deleted"', self._subprocess(1008).stdout)
        self.assertFalse(self.pack.exists())
        self.assertEqual(self._state(), ("deleted", 2))

    def test_failure_after_stage_can_be_recovered(self):
        failure = self._subprocess(1002, "--failure-at", "after_stage", expected=None)
        self.assertNotEqual(failure.returncode, 0)
        self.assertFalse(self.pack.exists())
        self.assertEqual(len(list(self.root.glob(".trash-7-g*"))), 1)
        self.assertIn('"outcome": "deleted"', self._subprocess(1008).stdout)
        self.assertEqual(list(self.root.glob(".trash-7-g*")), [])
        self.assertEqual(self._state(), ("deleted", 2))

    def test_failure_after_unlink_can_be_recovered(self):
        failure = self._subprocess(1002, "--failure-at", "after_unlink", expected=None)
        self.assertNotEqual(failure.returncode, 0)
        self.assertFalse(self.pack.exists())
        self.assertEqual(self._state(), ("deleting", 1))
        self.assertIn('"outcome": "deleted"', self._subprocess(1008).stdout)
        self.assertEqual(self._state(), ("deleted", 2))

    def test_names_with_separator_or_traversal_are_rejected(self):
        for candidate in ("../external", "pack-7/elsewhere", r"..\\escape", ".", ".."):
            with self.subTest(name=candidate):
                with self.assertRaises(UnsafeResearchPath):
                    checked_tree(self.root, candidate)
        self.assertTrue(self.pack.exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction test")
    def test_windows_junction_is_rejected_if_creatable(self):
        outside, sentinel = self._external_sentinel()
        shutil.rmtree(self.pack)
        command = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(self.pack), str(outside)],
            capture_output=True, text=True,
        )
        if command.returncode:
            self.skipTest("Windows junction creation not available on this runner")
        self.assertTrue(self.pack.is_junction())
        result = self._subprocess(expected=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_bytes(), b"must never delete research sentinel")


if __name__ == "__main__":
    unittest.main()
