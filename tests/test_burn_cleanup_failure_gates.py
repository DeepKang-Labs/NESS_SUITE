"""Additional CLEANUP characterization tests against the real single-process Burn.

Unlike the separate future multi-worker research models, these tests import the
actual NESS Flask application and call its production cleanup function. Each
file and database is synthetic and isolated in a TemporaryDirectory. They
intentionally DO NOT change burn.py or assert a newly discovered vulnerability.
"""
import importlib
import io
import json
import os
import shutil
import sqlite3
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from werkzeug.test import Client


class BurnSingleProcessCleanupGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        resources = ExitStack()
        cls.addClassCleanup(resources.close)
        cls.root = Path(resources.enter_context(TemporaryDirectory()))
        cls.database = cls.root / "ness.sqlite"
        resources.enter_context(patch.dict(os.environ, {
            "DB_PATH": str(cls.database),
            "BURN_STORAGE_DIR": str(cls.root / "burn"),
            "STORAGE_DIR": str(cls.root / "storage"),
            "STORAGE_BACKEND": "local",
            "BURN_MAX_DL_FREE": "1",
        }))
        cls.app_module = importlib.import_module("app")
        cls.app_module.init_db()
        cls.burn = cls.app_module.burn_product
        cls.sequence = 0

    def setUp(self):
        type(self).sequence += 1
        self.ip = f"198.51.100.{self.sequence}"
        self.token, self.folder = self._new_drop(self.ip)

    def _new_drop(self, ip):
        response = Client(self.app_module.app).post(
            "/api/burn/create",
            data={"plan": "free",
                  "file": (io.BytesIO(b"research synthetic only"), "first.txt"),
                  "allow_view": "0"},
            environ_overrides={"REMOTE_ADDR": ip},
        )
        self.assertEqual(response.status_code, 200, response.data)
        token = response.json["token"]
        folder = self.root / "burn" / token
        self.assertTrue((folder / "first.txt").is_file())
        return token, folder

    def _status(self, token):
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute(
                "SELECT status, files_json FROM burn_drops WHERE public_token=?",
                (token,),
            ).fetchone()

    def _set_status(self, token, status, expires=None):
        with closing(sqlite3.connect(self.database)) as db:
            if expires is None:
                db.execute(
                    "UPDATE burn_drops SET status=? WHERE public_token=?",
                    (status, token),
                )
            else:
                db.execute(
                    "UPDATE burn_drops SET status=?, expires_at=? WHERE public_token=?",
                    (status, expires, token),
                )
            db.commit()

    def _add_second_file(self, token, folder):
        second = folder / "second.txt"
        second.write_bytes(b"second synthetic only")
        with closing(sqlite3.connect(self.database)) as db:
            raw = db.execute(
                "SELECT files_json FROM burn_drops WHERE public_token=?",
                (token,),
            ).fetchone()[0]
            files = json.loads(raw)
            files.append({
                "filename": second.name,
                "size": second.stat().st_size,
                "content_type": "text/plain",
            })
            db.execute(
                "UPDATE burn_drops SET files_json=? WHERE public_token=?",
                (json.dumps(files), token),
            )
            db.commit()
        return second

    def test_partial_deletion_retains_metadata_and_retries(self):
        second = self._add_second_file(self.token, self.folder)
        self._set_status(self.token, "burned")
        def incomplete_delete(path, ignore_errors=False):
            self.assertEqual(Path(path), self.folder)
            (self.folder / "first.txt").unlink()
            # Simulate partial cleanup on a locked or unreadable remaining file.

        with patch.object(self.burn.shutil, "rmtree", side_effect=incomplete_delete):
            self.burn.cleanup_burn_expired()

        status, meta = self._status(self.token)
        self.assertEqual(status, "burned")
        self.assertNotEqual(meta, "[]")
        self.assertTrue(second.exists())
        self.assertFalse((self.folder / "first.txt").exists())

        self.burn.cleanup_burn_expired()
        self.assertEqual(self._status(self.token), ("burned", "[]"))
        self.assertFalse(self.folder.exists())

    def test_expired_active_partial_deletion_remains_retriable(self):
        second = self._add_second_file(self.token, self.folder)
        self._set_status(self.token, "active", "2000-01-01T00:00:00+00:00")
        def incomplete_delete(path, ignore_errors=False):
            (Path(path) / "first.txt").unlink()

        with patch.object(self.burn.shutil, "rmtree", side_effect=incomplete_delete):
            self.burn.cleanup_burn_expired()

        self.assertEqual(self._status(self.token)[0], "expired")
        self.assertNotEqual(self._status(self.token)[1], "[]")
        self.assertTrue(second.is_file())
        self.burn.cleanup_burn_expired()
        self.assertEqual(self._status(self.token), ("expired", "[]"))
        self.assertFalse(self.folder.exists())

    def test_one_failed_pack_does_not_block_another_pack_cleanup(self):
        second_token, second_folder = self._new_drop("203.0.113.240")
        self._set_status(self.token, "burned")
        self._set_status(second_token, "burned")
        original_rmtree = shutil.rmtree
        def one_unremovable_pack(path, ignore_errors=False):
            if Path(path) == self.folder:
                return
            return original_rmtree(path, ignore_errors=ignore_errors)

        with patch.object(self.burn.shutil, "rmtree", side_effect=one_unremovable_pack):
            self.burn.cleanup_burn_expired()

        self.assertNotEqual(self._status(self.token)[1], "[]")
        self.assertTrue(self.folder.exists())
        self.assertEqual(self._status(second_token), ("burned", "[]"))
        self.assertFalse(second_folder.exists())
        self.burn.cleanup_burn_expired()
        self.assertEqual(self._status(self.token), ("burned", "[]"))
        self.assertFalse(self.folder.exists())

    def test_missing_directory_clears_metadata_idempotently(self):
        self._set_status(self.token, "burned")
        shutil.rmtree(self.folder)
        self.burn.cleanup_burn_expired()
        self.assertEqual(self._status(self.token), ("burned", "[]"))
        self.burn.cleanup_burn_expired()
        self.assertEqual(self._status(self.token), ("burned", "[]"))

    def test_cleanup_preserves_unrelated_synthetic_directory(self):
        sentinel = self.root / "sentinel"
        sentinel.mkdir(exist_ok=True)
        marker = sentinel / "keep.txt"
        marker.write_bytes(b"do not remove")
        self._set_status(self.token, "burned")
        self.burn.cleanup_burn_expired()
        self.assertFalse(self.folder.exists())
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.read_bytes(), b"do not remove")


if __name__ == "__main__":
    unittest.main()
