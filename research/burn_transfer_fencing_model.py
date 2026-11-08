"""Research-only v2 fencing model for NESS Burn across Python processes.

Independent SQLite experiment: no Flask routes, no actual file deletion, no
production migration. Tokens are high-entropy; the database stores only hashes.
The time argument is supplied by the test harness and must never be taken from
an untrusted client in a real implementation.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import sys

from research.burn_sqlite_lease_model import _digest, connect


def migrate(db: sqlite3.Connection) -> None:
    """Apply experimental additive schema to a v1 research database."""
    cols = {row["name"] for row in db.execute("PRAGMA table_info(research_drops)")}
    for name, declaration in (
        ("delete_generation", "INTEGER NOT NULL DEFAULT 0"),
        ("delete_owner_hash", "TEXT"),
        ("delete_until", "REAL"),
    ):
        if name not in cols:
            db.execute(f"ALTER TABLE research_drops ADD COLUMN {name} {declaration}")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS research_transfer_pins (
            pin_hash TEXT PRIMARY KEY,
            drop_id INTEGER NOT NULL,
            session_hash TEXT NOT NULL,
            until REAL NOT NULL,
            finished INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(drop_id) REFERENCES research_drops(id)
        );
        CREATE INDEX IF NOT EXISTS idx_research_active_pins
          ON research_transfer_pins(drop_id, finished, until);
    """)


def begin_read(
    db: sqlite3.Connection, drop_id: int, session_token: str,
    now: float, *, transfer_window: float = 20.0, drop_grace: float = 30.0,
) -> str | None:
    """Pin an authorized transfer before I/O, atomically versus deletion.

    No new pin after session/drop expiry. A transfer that started while valid
    can drain during a bounded grace interval, then must stop.
    """
    if not 0 < transfer_window <= 120 or not 0 <= drop_grace <= 120:
        raise ValueError("unsupported bounded lease parameters")
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("""
            SELECT d.status, d.expires_at AS drop_exp, s.expires_at AS sess_exp
            FROM research_drops d JOIN research_sessions s ON s.drop_id=d.id
            WHERE d.id=? AND s.token_sha256=? AND s.charged=1
              AND s.finishes_pack=1
        """, (drop_id, _digest(session_token))).fetchone()
        if (row is None or row["status"] != "burned"
                or row["sess_exp"] <= now or row["drop_exp"] <= now):
            db.rollback()
            return None
        until = min(now + transfer_window, row["drop_exp"] + drop_grace)
        if until <= now:
            db.rollback()
            return None
        token = secrets.token_urlsafe(24)
        db.execute(
            """INSERT INTO research_transfer_pins
               (pin_hash, drop_id, session_hash, until)
               VALUES (?, ?, ?, ?)""",
            (_digest(token), drop_id, _digest(session_token), until),
        )
        db.commit()
        return token
    except Exception:
        db.rollback()
        raise


def finish_read(db: sqlite3.Connection, pin_token: str, now: float) -> bool:
    """Close transfer pin after I/O; expired pins cannot certify success."""
    db.execute("BEGIN IMMEDIATE")
    try:
        changed = db.execute("""
            UPDATE research_transfer_pins SET finished=1
            WHERE pin_hash=? AND finished=0 AND until>?
              AND EXISTS (
                  SELECT 1 FROM research_drops
                  WHERE research_drops.id=research_transfer_pins.drop_id
                    AND research_drops.status='burned'
              )
        """, (_digest(pin_token), now)).rowcount
        db.commit()
        return changed == 1
    except Exception:
        db.rollback()
        raise


def acquire_cleanup(
    db: sqlite3.Connection, drop_id: int, now: float,
    *, cleanup_lease: float = 30.0,
) -> dict | None:
    """Atomically fence deletion and receive a single-use owner capability.

    Crash recovery: a deleting claim can be reclaimed only after its deadline.
    A generation/owner guard rejects stale completion from a previous worker.
    Note that real filesystem deletion would also need ownership checks/renewal.
    """
    if not 0 < cleanup_lease <= 120:
        raise ValueError("unsupported cleanup lease")
    db.execute("BEGIN IMMEDIATE")
    try:
        drop = db.execute("SELECT * FROM research_drops WHERE id=?", (drop_id,)).fetchone()
        if drop is None or drop["status"] == "deleted":
            db.rollback()
            return None
        if drop["status"] == "deleting":
            if drop["delete_until"] is None or drop["delete_until"] > now:
                db.rollback()
                return None
        elif drop["status"] not in ("burned", "expired") and drop["expires_at"] > now:
            db.rollback()
            return None

        # Even if the logical session has expired, a bounded, previously
        # authorized read pin can keep a file alive for its finite I/O window.
        if db.execute("""
            SELECT 1 FROM research_transfer_pins
            WHERE drop_id=? AND finished=0 AND until>? LIMIT 1
        """, (drop_id, now)).fetchone():
            db.rollback()
            return None

        if drop["expires_at"] > now and db.execute("""
            SELECT 1 FROM research_sessions
            WHERE drop_id=? AND charged=1 AND finishes_pack=1
              AND expires_at>? LIMIT 1
        """, (drop_id, now)).fetchone():
            db.rollback()
            return None

        owner = secrets.token_urlsafe(24)
        generation = drop["delete_generation"] + 1
        db.execute("""
            UPDATE research_drops
            SET status='deleting', delete_owner_hash=?,
                delete_until=?, delete_generation=?
            WHERE id=?
        """, (_digest(owner), now + cleanup_lease, generation, drop_id))
        db.commit()
        return {"owner": owner, "generation": generation}
    except Exception:
        db.rollback()
        raise


def finish_cleanup(
    db: sqlite3.Connection, drop_id: int, owner: str,
    generation: int, now: float,
) -> bool:
    """Record deletion completion, but never perform OS-level deletion."""
    db.execute("BEGIN IMMEDIATE")
    try:
        changed = db.execute("""
            UPDATE research_drops
            SET status='deleted', delete_owner_hash=NULL, delete_until=NULL
            WHERE id=? AND status='deleting' AND delete_owner_hash=?
              AND delete_generation=? AND delete_until>?
        """, (drop_id, _digest(owner), generation, now)).rowcount
        db.commit()
        return changed == 1
    except Exception:
        db.rollback()
        raise


def cli(argv: list[str]) -> dict:
    mode, db_path, drop_id, now, *args = argv
    with connect(db_path) as db:
        migrate(db)
        target, clock = int(drop_id), float(now)
        if mode == "begin":
            result = begin_read(db, target, args[0], clock)
        elif mode == "finish":
            result = finish_read(db, args[0], clock)
        elif mode == "cleanup":
            result = acquire_cleanup(db, target, clock)
        elif mode == "finalize":
            result = finish_cleanup(db, target, args[0], int(args[1]), clock)
        else:
            raise ValueError("unsupported research operation")
    return {"result": result}


if __name__ == "__main__":
    print(json.dumps(cli(sys.argv[1:])), flush=True)
