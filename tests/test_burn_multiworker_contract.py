"""Research-only cross-worker Burn contract tests.

These tests intentionally fail on the existing process-local session implementation.
Run on an isolated synthetic database and temporary files, not production data.
They must not be merged upstream as passing regression tests until a durable
cross-worker session protocol has been implemented.
"""

import importlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import unittest
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from werkzeug.test import Client


class BurnMultiworkerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.env_values = {
            "DB_PATH": str(cls.root / "ness.sqlite"),
            "BURN_STORAGE_DIR": str(cls.root / "burn"),
            "BURN_MAX_DL_FREE": "1",
            "STORAGE_DIR": str(cls.root / "storage"),
            "STORAGE_BACKEND": "local",
        }
        cls.env_patch = patch.dict(os.environ, cls.env_values)
        cls.env_patch.start()
        cls.addClassCleanup(cls.env_patch.stop)
        cls.suite = importlib.import_module("app")
        cls.suite.init_db()
        cls.sequence = 0

    def setUp(self):
        type(self).sequence += 1
        self.ip = f"192.0.2.{self.sequence}"
        self.client = Client(self.suite.app)
        created = self.client.post(
            "/api/burn/create",
            data={
                "plan": "free",
                "file": (io.BytesIO(b"first synthetic file\n"), "first.txt"),
                "allow_view": "0",
            },
            environ_overrides={"REMOTE_ADDR": self.ip},
        )
        self.assertEqual(created.status_code, 200, created.data)
        self.token = created.json["token"]
        self.packdir = self.root / "burn" / self.token
        self.second = self.packdir / "second.txt"
        self.second.write_bytes(b"second synthetic file\n")
        with closing(sqlite3.connect(self.root / "ness.sqlite")) as db:
            row = db.execute(
                "SELECT id, files_json FROM burn_drops WHERE public_token = ?",
                (self.token,),
            ).fetchone()
            files = json.loads(row[1])
            files.append({
                "filename": "second.txt",
                "size": self.second.stat().st_size,
                "content_type": "text/plain",
            })
            db.execute(
                """UPDATE burn_drops SET files_json = ?, max_downloads = 1,
                   download_count = 0, burn_after = 0 WHERE id = ?""",
                (json.dumps(files), row[0]),
            )
            db.commit()
        unlock = self.client.post(
            f"/api/burn/{self.token}/unlock",
            environ_overrides={"REMOTE_ADDR": self.ip},
        )
        self.assertEqual(unlock.status_code, 200, unlock.data)
        self.view_token = unlock.json["view_token"]

    def _external_python(self, code, *args):
        env = os.environ.copy()
        env.update(self.env_values)
        result = subprocess.run(
            [sys.executable, "-c", code, *args],
            env=env,
            cwd=str(Path(__file__).resolve().parents[1]),
            text=True,
            capture_output=True,
            timeout=25,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_cross_worker_cleanup_preserves_authorized_pack(self):
        first = self.client.post(
            f"/api/burn/{self.token}/file/0",
            data={"view_token": self.view_token},
        )
        self.assertEqual(first.status_code, 200, first.data)
        self.assertTrue(self.suite.burn_product._VIEW_SESSIONS[self.view_token]["finishes_pack"])
        self.assertTrue(self.second.is_file())

        # A distinct process shares SQLite and the filesystem, but not
        # _VIEW_SESSIONS. This directly exercises the real cleanup function.
        self._external_python(
            "import burn; burn.cleanup_burn_expired(); print('child_cleanup_done')"
        )
        self.assertTrue(
            self.second.is_file(),
            "CROSS_WORKER_CLEANUP: an unexpired finishing session lost its pack",
        )

    def test_cross_worker_unlocked_session_is_recognized(self):
        # Simulate /unlock on worker A and the first file request on worker B.
        output = self._external_python(
            """
import json, sys
import app
from werkzeug.test import Client
app.init_db()
r = Client(app.app).post(
    f"/api/burn/{sys.argv[1]}/file/0",
    data={"view_token": sys.argv[2]},
)
print(json.dumps({"status": r.status_code, "error": (r.json or {}).get("error")}))
""",
            self.token,
            self.view_token,
        )
        result = json.loads(output.strip().splitlines()[-1])
        self.assertEqual(
            result["status"], 200,
            f"CROSS_WORKER_AUTH: a valid session was rejected on another worker: {result}",
        )


if __name__ == "__main__":
    unittest.main()
