"""POSIX-only, research-only file-system fencing for NESS Burn cleanup.

Demonstrates the difference between a durable SQLite lease alone and a
process-shared critical-section lock around every destructive file operation.
NOT wired into the app. Only removes marked synthetic files in TempDirectory.
Every cleanup participant must cooperate with the same flock protocol.
"""
from __future__ import annotations

import argparse
import fcntl  # POSIX Linux prototype; Windows deliberately unsupported.
import json
import os
from pathlib import Path
import shutil
import sqlite3
import time

from research.burn_sqlite_lease_model import _digest, connect
from research.burn_filesystem_crash_harness import _checked_root
from research.burn_transfer_fencing_model import acquire_cleanup, finish_cleanup, migrate


def _has_current_claim(db, drop_id: int, owner: str, generation: int, now: float) -> bool:
    """Revalidate ownership AND deadline under the filesystem process lock."""
    return db.execute(
        """SELECT 1 FROM research_drops
           WHERE id=? AND status='deleting' AND delete_owner_hash=?
             AND delete_generation=? AND delete_until>?""",
        (drop_id, _digest(owner), generation, now),
    ).fetchone() is not None


def fenced_cleanup(
    db_path: str, root: str | Path, drop_id: int,
    claim_now: float, *, acting_now: float | None = None,
    cleanup_lease: float = 5.0,
    pause: bool = False, crash_after_stage: bool = False,
) -> dict:
    """Serialize claim, stage, unlink and finalize using one stable flock.

    A delayed worker must revalidate before starting filesystem work. Another
    cleanup worker cannot reclaim its lease until the old worker releases
    flock (or is killed); a killed worker releases the OS lock automatically.
    The lock file is stable and is never removed by cleanup. This only works
    when every deletion actor honors the SAME filesystem locking protocol.
    """
    rootdir = _checked_root(root)
    if isinstance(drop_id, bool) or not isinstance(drop_id, int) or drop_id < 1:
        raise ValueError("invalid synthetic drop ID")
    lockdir = rootdir / ".research-flocks"
    lockdir.mkdir(exist_ok=True)
    lockfile = lockdir / f"pack-{drop_id}.lock"
    with lockfile.open("a+b") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            with connect(db_path) as db:
                migrate(db)
                claim = acquire_cleanup(db, drop_id, claim_now, cleanup_lease=cleanup_lease)
                if claim is None:
                    return {"outcome": "not_claimed"}
                generation = claim["generation"]
                if pause:
                    # Deterministic harness barrier; never enable in production.
                    ready = rootdir / f".ready-{drop_id}"
                    resume = rootdir / f".resume-{drop_id}"
                    ready.write_text(str(generation), encoding="ascii")
                    deadline = time.monotonic() + 8.0
                    while not resume.exists() and time.monotonic() < deadline:
                        time.sleep(0.015)
                    if not resume.exists():
                        return {"outcome": "pause_timeout", "generation": generation}
                instant = claim_now if acting_now is None else acting_now
                if not _has_current_claim(db, drop_id, claim["owner"], generation, instant):
                    return {"outcome": "stale", "generation": generation}

                # No other cooperating cleanup can reclaim or mutate the pack
                # between the validation and these operations: flock is held.
                pack = rootdir / f"pack-{drop_id}"
                staged = rootdir / f".trash-{drop_id}-g{generation}"
                if pack.is_dir() and not pack.is_symlink():
                    pack.rename(staged)
                elif pack.exists() or pack.is_symlink():
                    raise ValueError("unexpected pack entry; refusing deletion")

                if crash_after_stage:
                    print(json.dumps({"outcome": "staged_then_killed", "generation": generation}), flush=True)
                    os._exit(76)

                for previous in sorted(rootdir.glob(f".trash-{drop_id}-g*")):
                    if previous.is_dir() and not previous.is_symlink():
                        shutil.rmtree(previous)
                    else:
                        raise ValueError("unexpected staging entry; refusing deletion")
                marked = finish_cleanup(db, drop_id, claim["owner"], generation, instant)
                return {
                    "outcome": "deleted" if marked else "completion_refused",
                    "generation": generation,
                }
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db_path")
    parser.add_argument("root")
    parser.add_argument("drop_id", type=int)
    parser.add_argument("claim_now", type=float)
    parser.add_argument("--acting-now", type=float)
    parser.add_argument("--pause", action="store_true")
    parser.add_argument("--crash-after-stage", action="store_true")
    ns = parser.parse_args()
    result = fenced_cleanup(
        ns.db_path, ns.root, ns.drop_id, ns.claim_now,
        acting_now=ns.acting_now, pause=ns.pause,
        crash_after_stage=ns.crash_after_stage,
    )
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
