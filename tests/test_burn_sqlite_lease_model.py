"""Independent-process tests for the research-only SQLite Burn lease model."""
import json
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from research.burn_sqlite_lease_model import (
    claim_cleanup, connect, final_claim, finishing_session_valid,
    initialize, issue_session,
)


class SqliteLeaseResearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "research.sqlite")
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        self.drop_id = 7
        self.now = 1000.0
        self.db.execute(
            """INSERT INTO research_drops(id,status,expires_at,downloaded,quota)
               VALUES(?, 'active', ?, 0, 1)""",
            (self.drop_id, self.now + 600),
        )

    def other_process(self, mode: str, now: float, token: str = "") -> bool:
        proc = subprocess.run(
            [
                sys.executable, "-m", "research.burn_sqlite_lease_model",
                mode, self.path, str(self.drop_id), str(now), *([token] if token else []),
            ],
            text=True, capture_output=True, timeout=20, check=False,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout.strip().splitlines()[-1])["result"]

    def test_finishing_lease_blocks_cleanup_in_another_process(self):
        token = issue_session(self.db, self.drop_id, self.now)
        self.assertTrue(final_claim(self.db, self.drop_id, token, self.now))
        self.assertFalse(self.other_process("cleanup", self.now + 2))
        self.assertTrue(self.other_process("valid", self.now + 2, token))
        self.assertEqual(
            self.db.execute("SELECT status FROM research_drops WHERE id=7").fetchone()[0],
            "burned",
        )

    def test_lease_expiry_permits_cleanup_but_not_token_reuse(self):
        token = issue_session(self.db, self.drop_id, self.now, duration=5)
        self.assertTrue(final_claim(self.db, self.drop_id, token, self.now))
        self.assertFalse(self.other_process("cleanup", self.now + 4))
        self.assertTrue(self.other_process("cleanup", self.now + 6))
        self.assertFalse(self.other_process("valid", self.now + 6, token))

    def test_drop_expiry_caps_any_lease(self):
        self.db.execute("UPDATE research_drops SET expires_at=? WHERE id=7", (self.now + 3,))
        token = issue_session(self.db, self.drop_id, self.now, duration=100)
        self.assertTrue(final_claim(self.db, self.drop_id, token, self.now + 1))
        self.assertFalse(self.other_process("cleanup", self.now + 2))
        self.assertTrue(self.other_process("cleanup", self.now + 4))
        self.assertFalse(self.other_process("valid", self.now + 4, token))

    def test_wrong_session_token_cannot_use_finishing_lease(self):
        owner = issue_session(self.db, self.drop_id, self.now)
        other = issue_session(self.db, self.drop_id, self.now)
        self.assertTrue(final_claim(self.db, self.drop_id, owner, self.now))
        self.assertTrue(self.other_process("valid", self.now + 1, owner))
        self.assertFalse(self.other_process("valid", self.now + 1, other))
        self.assertFalse(self.other_process("valid", self.now + 1, "forged-token"))

    def test_two_processes_cannot_both_claim_final_quota(self):
        tokens = [issue_session(self.db, self.drop_id, self.now) for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(
                lambda t: self.other_process("claim", self.now + 1, t), tokens
            ))
        self.assertEqual(sorted(results), [False, True])
        row = self.db.execute(
            "SELECT status, downloaded FROM research_drops WHERE id=7"
        ).fetchone()
        self.assertEqual(tuple(row), ("burned", 1))
        winner = tokens[results.index(True)]
        loser = tokens[results.index(False)]
        self.assertTrue(finishing_session_valid(self.db, self.drop_id, winner, self.now + 2))
        self.assertFalse(finishing_session_valid(self.db, self.drop_id, loser, self.now + 2))


if __name__ == "__main__":
    unittest.main()
