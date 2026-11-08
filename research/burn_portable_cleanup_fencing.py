"""Research-only cross-platform file-locking deletion experiment.

Do NOT import into production Burn. Locks are advisory/cooperative; every
mutator must follow the same stable lock file. The experiment deletes only
synthetic packs inside a marker-protected temporary research sandbox.

Windows: msvcrt.locking() holds byte range [0, 1) of the stable lock file.
POSIX: fcntl.flock() holds an advisory exclusive file lock.
Neither lock supplies distributed fencing or cross-platform lock parity on
network mounts.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import sys
import time

from research.burn_sqlite_lease_model import _digest, connect
from research.burn_filesystem_crash_harness import _checked_root
from research.burn_transfer_fencing_model import (
    acquire_cleanup, finish_cleanup, migrate,
)

if os.name == "nt":
    import msvcrt
elif os.name == "posix":
    import fcntl
else:
    raise RuntimeError("unsupported operating system in portable lock research")


@contextmanager
def exclusive_process_lock(lockpath: Path, *, timeout: float = 8.0):
    """Use one stable, never-unlinked lock file for cooperating local workers.

    The lock file is NOT removed after release: removing it may create
    multiple lock inodes/handles for the same logical pack.
    """
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    if lockpath.is_symlink():
        raise ValueError("lockfile must not be a symlink")
    with lockpath.open("a+b") as file:
        # Windows byte-range locking requires one existing byte.
        file.seek(0, os.SEEK_END)
        if file.tell() == 0:
            file.write(b"X")
            file.flush()
        file.seek(0)
        deadline = time.monotonic() + timeout
        acquired = False
        try:
            while not acquired:
                try:
                    if os.name == "nt":
                        file.seek(0)
                        msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except (OSError, BlockingIOError) as exc:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("cooperating cleanup lock timeout") from exc
                    time.sleep(0.012)
            yield
        finally:
            if acquired:
                if os.name == "nt":
                    file.seek(0)
                    msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def claim_is_current(db, drop_id, owner, generation, now):
    return db.execute(
        """SELECT 1 FROM research_drops
           WHERE id=? AND status='deleting' AND delete_owner_hash=?
             AND delete_generation=? AND delete_until>?""",
        (drop_id, _digest(owner), generation, now),
    ).fetchone() is not None


def fenced_cleanup(
    db_path: str, root_path: str, drop_id: int, claim_now: float, *,
    acting_now: float | None = None, lease_duration: float = 5.0,
    pause: bool = False, crash_after_stage: bool = False,
) -> dict:
    """Serialize deletion claim and file mutations using a cross-process lock.

    Database and filesystem are separate resources. Holding this OS lock
    across both narrows race opportunities ONLY among cooperating workers.
    Stale claim is checked before the first rename/unlink.
    """
    root = _checked_root(root_path)
    if type(drop_id) is not int or drop_id <= 0:
        raise ValueError("invalid synthetic drop ID")
    locks = root / ".portable-research-locks"
    locks.mkdir(exist_ok=True)
    lockpath = locks / f"pack-{drop_id}.lck"
    with exclusive_process_lock(lockpath):
        with connect(db_path) as db:
            migrate(db)
            claim = acquire_cleanup(db, drop_id, claim_now, cleanup_lease=lease_duration)
            if claim is None:
                return {"outcome": "not_claimed"}
            generation = claim["generation"]
            if pause:
                (root / f".paused-{drop_id}").write_text(
                    str(generation), encoding="ascii"
                )
                resume = root / f".resume-{drop_id}"
                deadline = time.monotonic() + 7.0
                while not resume.exists() and time.monotonic() < deadline:
                    time.sleep(0.015)
                if not resume.exists():
                    return {"outcome": "pause_timeout", "generation": generation}
            instant = claim_now if acting_now is None else acting_now
            if not claim_is_current(db, drop_id, claim["owner"], generation, instant):
                return {"outcome": "stale", "generation": generation}
            pack = root / f"pack-{drop_id}"
            stage = root / f".trash-{drop_id}-g{generation}"
            if pack.is_symlink() or (pack.exists() and not pack.is_dir()):
                raise ValueError("unexpected pack entry; refusing to remove")
            if pack.is_dir():
                pack.rename(stage)
            if crash_after_stage:
                print(json.dumps({
                    "outcome": "staged_then_killed", "generation": generation
                }), flush=True)
                os._exit(76)
            for candidate in sorted(root.glob(f".trash-{drop_id}-g*")):
                if candidate.is_dir() and not candidate.is_symlink():
                    shutil.rmtree(candidate)
                else:
                    raise ValueError("unexpected staged entry; refusing to remove")
            finished = finish_cleanup(
                db, drop_id, claim["owner"], generation, instant
            )
            return {
                "outcome": "deleted" if finished else "completion_refused",
                "generation": generation,
            }


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("db_path")
    p.add_argument("root")
    p.add_argument("drop_id", type=int)
    p.add_argument("claim_now", type=float)
    p.add_argument("--acting-now", type=float)
    p.add_argument("--pause", action="store_true")
    p.add_argument("--crash-after-stage", action="store_true")
    a = p.parse_args()
    print(json.dumps(fenced_cleanup(
        a.db_path, a.root, a.drop_id, a.claim_now,
        acting_now=a.acting_now, pause=a.pause,
        crash_after_stage=a.crash_after_stage,
    )), flush=True)


if __name__ == "__main__":
    main()
