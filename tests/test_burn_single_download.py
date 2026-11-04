import importlib
import io
import os
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch

from werkzeug.test import Client


REPORT = b"Synthetic report\n"


class BurnSingleDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        cls.root = Path(stack.enter_context(TemporaryDirectory()))
        cls.db_path = cls.root / "ness.sqlite"
        stack.enter_context(patch.dict(os.environ, {
            "DB_PATH": str(cls.db_path),
            "BURN_STORAGE_DIR": str(cls.root / "burn"),
            "BURN_MAX_DL_FREE": "1",
            "STORAGE_DIR": str(cls.root / "storage"),
            "STORAGE_BACKEND": "local",
        }))
        cls.suite = importlib.import_module("app")
        cls.suite.init_db()

    def setUp(self):
        self.client = Client(self.suite.app)
        response = self.client.post("/api/burn/create", data={
            "plan": "free",
            "file": (io.BytesIO(REPORT), "report.txt"),
            "allow_view": "0",
        })
        self.assertEqual(response.status_code, 200)
        self.token = response.json["token"]
        self.file_url = f"/api/burn/{self.token}/file/0"
        self.file_path = self.root / "burn" / self.token / "report.txt"

    def test_only_one_concurrent_request_receives_the_file(self):
        file_checked = Barrier(2, timeout=5)
        file_read = Barrier(2, timeout=5)
        is_file = Path.is_file
        read_bytes = Path.read_bytes

        def synchronized_is_file(path):
            result = is_file(path)
            if path == self.file_path:
                file_checked.wait()
            return result

        def synchronized_read(path):
            data = read_bytes(path)
            if path == self.file_path:
                file_read.wait()
            return data

        def download():
            return Client(self.suite.app).get(self.file_url)

        with ExitStack() as stack:
            stack.enter_context(patch.object(Path, "is_file", synchronized_is_file))
            stack.enter_context(patch.object(Path, "read_bytes", synchronized_read))
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=2))
            requests = [pool.submit(download) for _ in range(2)]
            responses = [request.result(timeout=10) for request in requests]

        statuses = sorted(response.status_code for response in responses)
        self.assertEqual(statuses, [200, 410])
        self.assertEqual(next(r.data for r in responses if r.status_code == 200), REPORT)
        self.assertFalse(self.file_path.exists())

    def test_failed_read_leaves_download_available(self):
        with patch.object(Path, "read_bytes", side_effect=FileNotFoundError):
            self.assertEqual(self.client.get(self.file_url).status_code, 404)

        response = self.client.get(self.file_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, REPORT)

    def test_failed_removal_is_retried_without_reopening_access(self):
        with patch.object(self.suite.burn_product.shutil, "rmtree"):
            self.assertEqual(self.client.get(self.file_url).status_code, 200)

        self.assertTrue(self.file_path.exists())
        self.assertEqual(self.client.get(self.file_url).status_code, 404)

        self.suite.burn_product.cleanup_burn_expired()

        self.assertFalse(self.file_path.exists())
        with sqlite3.connect(self.db_path) as db:
            row = db.execute(
                "SELECT status, download_count, files_json FROM burn_drops WHERE public_token = ?",
                (self.token,),
            ).fetchone()
        self.assertEqual(row, ("burned", 1, "[]"))


if __name__ == "__main__":
    unittest.main()
