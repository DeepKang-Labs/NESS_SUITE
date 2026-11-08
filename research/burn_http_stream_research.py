"""Cross-platform, loopback-only HTTP streaming experiment for NESS Burn.

RESEARCH ONLY. This is NOT an application route or a production delete worker.
Uses real HTTP chunked transfer, distinct OS processes, shared SQLite model
and a marked TemporaryDirectory containing synthetic files. Windows/POSIX
parity is tested in CI without importing POSIX-specific fcntl.

The cleanup CLI is NOT a complete filesystem fencing solution: its deletion
claim and actual OS unlink are separate operations. No safety against stale,
uncooperative, or crashed mid-unlink workers is claimed.
"""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import time

from research.burn_sqlite_lease_model import _digest, connect
from research.burn_transfer_fencing_model import (
    acquire_cleanup, begin_read, finish_cleanup, finish_read, migrate,
)
from research.burn_filesystem_crash_harness import _checked_root


class ResearchStreamingHandler(BaseHTTPRequestHandler):
    server_version = "BurnSyntheticHTTPResearch/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Do not log session headers or token values.
        return

    def do_GET(self):
        if self.path != "/stream":
            self.send_error(404)
            return
        server = self.server
        dbpath = server.dbpath
        root = server.root
        token = self.headers.get("X-Research-Session", "")
        # Only hashed tokens are persisted in SQLite; raw secrets are not logged.
        if not token:
            self.send_error(403)
            return
        with connect(dbpath) as db:
            migrate(db)
            pin = begin_read(
                db, server.drop_id, token, time.time(),
                transfer_window=server.transfer_window,
                drop_grace=server.drop_grace,
            )
            if not pin:
                self.send_error(403)
                return
            deadline = db.execute(
                "SELECT until FROM research_transfer_pins WHERE pin_hash=?",
                (_digest(pin),),
            ).fetchone()["until"]

        filepath = root / f"pack-{server.drop_id}" / "second-file.txt"
        started = False
        complete = False
        try:
            with filepath.open("rb") as src:
                # Exercise real HTTP/1.1 chunk framing; no read_bytes() buffering.
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                while True:
                    if time.time() >= deadline:
                        break
                    data = src.read(256)
                    if not data:
                        complete = True
                        break
                    self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                    if not started:
                        started = True
                        (root / "first-chunk-sent").write_text("1", encoding="ascii")
                        # Deliberately stall after actual client-visible bytes.
                        while not (root / "release-stream").exists():
                            if time.time() >= deadline:
                                break
                            time.sleep(0.01)
            # The file handle is CLOSED before releasing the durable pin.
            if complete and time.time() < deadline:
                with connect(dbpath) as db:
                    if finish_read(db, pin, time.time()):
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                        (root / "stream-completed").write_text("1", encoding="ascii")
                        return
            (root / "stream-aborted").write_text("1", encoding="ascii")
        except (OSError, ConnectionError, ValueError):
            (root / "stream-aborted").write_text("1", encoding="ascii")
        finally:
            # An aborted chunked body has NO terminal zero-length chunk.
            # The client should detect an incomplete transfer.
            self.close_connection = True


def serve(db_path, root_path, drop_id, transfer_window, drop_grace):
    root = _checked_root(root_path)
    if drop_id < 1:
        raise ValueError("invalid synthetic drop id")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ResearchStreamingHandler)
    httpd.daemon_threads = True
    httpd.dbpath = db_path
    httpd.root = root
    httpd.drop_id = drop_id
    httpd.transfer_window = transfer_window
    httpd.drop_grace = drop_grace
    # Publish readiness atomically: observers must never read a zero-byte port file.
    temporary_port_file = root / "server-port.tmp"
    temporary_port_file.write_text(str(httpd.server_port), encoding="ascii")
    temporary_port_file.replace(root / "server-port")
    try:
        httpd.serve_forever(poll_interval=0.05)
    finally:
        httpd.server_close()


def cleanup(db_path, root_path, drop_id, now=None):
    """Separate-process cleanup of ONLY a marked synthetic directory."""
    root = _checked_root(root_path)
    if drop_id < 1:
        raise ValueError("invalid synthetic drop id")
    if now is None:
        now = time.time()
    with connect(db_path) as db:
        migrate(db)
        claim = acquire_cleanup(db, drop_id, now)
        if claim is None:
            return {"claimed": False, "removed": False}
        pack = root / f"pack-{drop_id}"
        if pack.is_symlink():
            raise ValueError("refusing symlink pack")
        if pack.exists():
            if not pack.is_dir():
                raise ValueError("unexpected synthetic pack entry")
            shutil.rmtree(pack)
        finished = finish_cleanup(db, drop_id, claim["owner"], claim["generation"], now)
        return {"claimed": True, "removed": bool(finished)}


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    server = sp.add_parser("serve")
    server.add_argument("db")
    server.add_argument("root")
    server.add_argument("drop_id", type=int)
    server.add_argument("--window", type=float, default=4.0)
    server.add_argument("--grace", type=float, default=5.0)
    worker = sp.add_parser("cleanup")
    worker.add_argument("db")
    worker.add_argument("root")
    worker.add_argument("drop_id", type=int)
    ns = ap.parse_args()
    if ns.cmd == "serve":
        serve(ns.db, ns.root, ns.drop_id, ns.window, ns.grace)
    else:
        print(json.dumps(cleanup(ns.db, ns.root, ns.drop_id)), flush=True)


if __name__ == "__main__":
    main()
