"""End-to-end loopback HTTP streaming against a separate cleanup OS process.

Cross-platform research characterization, not a test of the actual NESS Burn
Flask route (which currently reads the full file via Path.read_bytes()).
Only synthetic files under a marked TemporaryDirectory may be removed.
"""
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from research.burn_sqlite_lease_model import connect, final_claim, initialize, issue_session
from research.burn_transfer_fencing_model import migrate
from research.burn_filesystem_crash_harness import MARKER, prepare_synthetic_pack


class BurnHttpStreamCrossprocessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / MARKER).write_text("research synthetic sandbox only", encoding="utf-8")
        self.db_path = str(self.root / "research.sqlite")
        self.db = connect(self.db_path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        migrate(self.db)
        self.drop_id = 7
        now = time.time()
        self.db.execute(
            "INSERT INTO research_drops(id,status,expires_at,downloaded,quota) VALUES(7,'active',?,0,1)",
            (now + 35,),
        )
        self.session = issue_session(self.db, 7, now, duration=25)
        self.assertTrue(final_claim(self.db, 7, self.session, now))
        self.payload = b"synthetic-data-only_" * 160
        self.pack = prepare_synthetic_pack(self.root, 7, self.payload)
        self.filepath = self.pack / "second-file.txt"
        self.cwd = str(Path(__file__).resolve().parents[1])
        self.service = None

    def tearDown(self):
        if self.service is not None:
            self.service.terminate()
            try:
                self.service.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                self.service.kill()
                self.service.communicate(timeout=5)

    def wait_file(self, name, timeout=6):
        path = self.root / name
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if path.is_file():
                return path
            if self.service is not None and self.service.poll() is not None:
                self.fail(f"HTTP process stopped unexpectedly ({self.service.returncode})")
            time.sleep(0.015)
        self.fail(f"Timed out waiting for {name}")

    def start_server(self, *, window=4.0):
        command = [
            sys.executable, "-m", "research.burn_http_stream_research",
            "serve", self.db_path, str(self.root), "7",
            "--window", str(window),
        ]
        self.service = subprocess.Popen(
            command, cwd=self.cwd, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, text=True,
        )
        return int(self.wait_file("server-port").read_text(encoding="ascii"))

    def get_stream(self, port, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
        conn.request("GET", "/stream", headers={
            "X-Research-Session": self.session if token is None else token,
        })
        response = conn.getresponse()
        return conn, response

    def cleanup_from_other_process(self):
        result = subprocess.run([
            sys.executable, "-m", "research.burn_http_stream_research",
            "cleanup", self.db_path, str(self.root), "7",
        ], cwd=self.cwd, capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.strip().splitlines()[-1])

    def expire_session(self):
        # Simulate the server's finishing-session deadline crossing while
        # the already-issued per-HTTP-transfer pin remains live.
        self.db.execute(
            "UPDATE research_sessions SET expires_at=? WHERE drop_id=7",
            (time.time() - 1.0,),
        )

    def test_http_stream_survives_other_process_cleanup_then_completes(self):
        port = self.start_server(window=5.0)
        conn, response = self.get_stream(port)
        try:
            self.assertEqual(response.status, 200)
            first = response.read(256)
            self.assertEqual(first, self.payload[:256])
            self.wait_file("first-chunk-sent")
            self.expire_session()
            self.assertEqual(
                self.cleanup_from_other_process(),
                {"claimed": False, "removed": False},
            )
            self.assertEqual(self.filepath.read_bytes(), self.payload)
            (self.root / "release-stream").write_text("resume", encoding="ascii")
            remainder = response.read()
            self.assertEqual(first + remainder, self.payload)
            self.wait_file("stream-completed")
            cleaned = self.cleanup_from_other_process()
            self.assertTrue(cleaned["claimed"] and cleaned["removed"])
            self.assertFalse(self.filepath.exists())
        finally:
            conn.close()

    def test_http_stream_aborts_at_hard_pin_deadline(self):
        port = self.start_server(window=1.2)
        conn, response = self.get_stream(port)
        try:
            self.assertEqual(response.status, 200)
            first = response.read(256)
            self.assertEqual(first, self.payload[:256])
            self.wait_file("first-chunk-sent")
            self.expire_session()
            self.assertEqual(self.cleanup_from_other_process()["claimed"], False)
            self.wait_file("stream-aborted", timeout=6)
            with self.assertRaises((http.client.IncompleteRead, ConnectionError, OSError)):
                response.read()
            cleaned = self.cleanup_from_other_process()
            self.assertTrue(cleaned["claimed"] and cleaned["removed"])
        finally:
            conn.close()

    def test_http_stream_rejects_unknown_token_before_body(self):
        port = self.start_server()
        conn, response = self.get_stream(port, token="not-a-valid-session-token")
        try:
            self.assertEqual(response.status, 403)
            response.read()
            self.assertFalse((self.root / "first-chunk-sent").exists())
        finally:
            conn.close()

    def test_killed_stream_worker_leaves_only_bounded_pin(self):
        port = self.start_server(window=1.25)
        conn, response = self.get_stream(port)
        try:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(256), self.payload[:256])
            self.wait_file("first-chunk-sent")
            self.expire_session()
            self.service.kill()
            self.service.communicate(timeout=5)
            self.assertEqual(self.cleanup_from_other_process()["claimed"], False)
            # No false claim that a dead worker runs cleanup: another process
            # can reclaim once the independently stored pin expires.
            time.sleep(1.35)
            cleaned = self.cleanup_from_other_process()
            self.assertTrue(cleaned["claimed"] and cleaned["removed"])
            self.assertFalse(self.filepath.exists())
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
