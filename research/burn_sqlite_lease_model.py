"""Research prototype only: cross-process Burn finishing-session lease protocol.

Not connected to NESS_SUITE production routes. Verifies atomic, process-independent
session and cleanup decisions using an isolated SQLite database. No live data.
"""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import sys


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def connect(path: str):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS research_drops (
            id INTEGER PRIMARY KEY, status TEXT NOT NULL,
            expires_at REAL NOT NULL, downloaded INTEGER NOT NULL DEFAULT 0,
            quota INTEGER NOT NULL CHECK (quota > 0)
        );
        CREATE TABLE IF NOT EXISTS research_sessions (
            token_sha256 TEXT PRIMARY KEY, drop_id INTEGER NOT NULL,
            expires_at REAL NOT NULL, charged INTEGER NOT NULL DEFAULT 0,
            finishes_pack INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (drop_id) REFERENCES research_drops(id)
        );
        CREATE INDEX IF NOT EXISTS idx_research_sessions_active
          ON research_sessions(drop_id, finishes_pack, expires_at);
    """)


def issue_session(db, drop_id: int, now: float, duration: float = 300.0) -> str:
    token = secrets.token_urlsafe(24)
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute(
            "SELECT * FROM research_drops WHERE id=? AND status='active' AND expires_at>?",
            (drop_id, now),
        ).fetchone()
        if row is None:
            raise ValueError("no active drop")
        expires_at = min(row["expires_at"], now + duration)
        db.execute(
            "INSERT INTO research_sessions(token_sha256,drop_id,expires_at) VALUES(?,?,?)",
            (_digest(token), drop_id, expires_at),
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return token


def final_claim(db, drop_id: int, token: str, now: float) -> bool:
    """Close quota and publish the finishing lease in ONE SQLite transaction."""
    db.execute("BEGIN IMMEDIATE")
    try:
        session = db.execute(
            "SELECT * FROM research_sessions WHERE token_sha256=? AND drop_id=? AND expires_at>?",
            (_digest(token), drop_id, now),
        ).fetchone()
        drop = db.execute("SELECT * FROM research_drops WHERE id=?", (drop_id,)).fetchone()
        if not session or not drop or drop["expires_at"] <= now:
            db.rollback()
            return False
        if session["charged"] and session["finishes_pack"] and drop["status"] == "burned":
            db.commit()
            return True
        if drop["status"] != "active" or drop["downloaded"] != drop["quota"] - 1:
            db.rollback()
            return False
        db.execute(
            "UPDATE research_drops SET downloaded=downloaded+1, status='burned' WHERE id=?",
            (drop_id,),
        )
        db.execute(
            "UPDATE research_sessions SET charged=1, finishes_pack=1 WHERE token_sha256=?",
            (_digest(token),),
        )
        db.commit()
        return True
    except Exception:
        db.rollback()
        raise


def finishing_session_valid(db, drop_id: int, token: str, now: float) -> bool:
    return bool(db.execute(
        """SELECT 1 FROM research_sessions AS s
           JOIN research_drops AS d ON d.id=s.drop_id
           WHERE s.drop_id=? AND s.token_sha256=? AND s.charged=1
             AND s.finishes_pack=1 AND s.expires_at>?
             AND d.expires_at>? AND d.status='burned'""",
        (drop_id, _digest(token), now, now),
    ).fetchone())


def claim_cleanup(db, drop_id: int, now: float) -> bool:
    """Acquire a durable deletion claim; filesystem removal is intentionally NOT modeled."""
    db.execute("BEGIN IMMEDIATE")
    try:
        drop = db.execute("SELECT * FROM research_drops WHERE id=?", (drop_id,)).fetchone()
        if not drop or drop["status"] not in ("burned", "expired"):
            db.rollback()
            return False
        if drop["expires_at"] > now and db.execute(
            """SELECT 1 FROM research_sessions
               WHERE drop_id=? AND charged=1 AND finishes_pack=1 AND expires_at>?
               LIMIT 1""",
            (drop_id, now),
        ).fetchone():
            db.rollback()
            return False
        db.execute("UPDATE research_drops SET status='deleting' WHERE id=?", (drop_id,))
        db.commit()
        return True
    except Exception:
        db.rollback()
        raise


if __name__ == "__main__":
    # CLI intentionally tiny: used by tests to invoke a DIFFERENT OS process.
    import json
    mode, db_path, drop_id, now, *extra = sys.argv[1:]
    with connect(db_path) as db:
        if mode == "cleanup":
            result = claim_cleanup(db, int(drop_id), float(now))
        elif mode == "valid":
            result = finishing_session_valid(db, int(drop_id), extra[0], float(now))
        elif mode == "claim":
            result = final_claim(db, int(drop_id), extra[0], float(now))
        else:
            raise ValueError("unknown mode")
        print(json.dumps({"result": result}))
