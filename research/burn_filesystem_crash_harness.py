"""Temporary-filesystem crash harness for the Burn research model.

THIS MODULE MAY DELETE ONLY FROM A MARKED RESEARCH SANDBOX.
It does NOT integrate with production NESS Burn, and is not a complete
distributed filesystem safety protocol. No network mounts are assumed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys

from research.burn_sqlite_lease_model import connect
from research.burn_transfer_fencing_model import (
    acquire_cleanup, finish_cleanup, migrate,
)

MARKER = ".burn_research_sandbox_only"


def _checked_root(root: str | Path) -> Path:
    path = Path(root)
    if path.is_symlink() or not path.is_dir() or not (path / MARKER).is_file():
        raise ValueError("refusing filesystem work outside a marked research sandbox")
    return path.resolve(strict=True)


def prepare_synthetic_pack(root: str | Path, drop_id: int, payload: bytes) -> Path:
    path = _checked_root(root)
    if not isinstance(drop_id, int) or drop_id < 1:
        raise ValueError("invalid synthetic drop ID")
    directory = path / f"pack-{drop_id}"
    directory.mkdir(exist_ok=False)
    (directory / "second-file.txt").write_bytes(payload)
    return directory


def cleanup_synthetic_pack(
    db_path: str, root: str | Path, drop_id: int, now: float,
    *, crash_after: str | None = None, lease_duration: float = 30.0,
) -> dict:
    """Claim -> rename to private staged directory -> unlink -> finalize.

    Crash injection: after claiming or after staging, exit the interpreter
    abruptly. A subsequent worker can reclaim after the bounded SQLite lease.
    Staging within the same filesystem is assumed; this is NOT a guarantee
    against out-of-band filesystem access or stale workers past lease expiry.
    """
    directory = _checked_root(root)
    if not isinstance(drop_id, int) or drop_id < 1:
        raise ValueError("invalid synthetic drop ID")
    if crash_after not in (None, "claim", "stage"):
        raise ValueError("unsupported crash injection")

    with connect(db_path) as db:
        migrate(db)
        claimed = acquire_cleanup(
            db, drop_id, now, cleanup_lease=lease_duration
        )
        if not claimed:
            return {"claimed": False, "completed": False}

        if crash_after == "claim":
            print(json.dumps({"crash_at": "claim", "generation": claimed["generation"]}), flush=True)
            os._exit(73)

        pack = directory / f"pack-{drop_id}"
        staged = directory / f".trash-{drop_id}-g{claimed['generation']}"
        if pack.is_dir():
            pack.rename(staged)

        if crash_after == "stage":
            print(json.dumps({"crash_at": "stage", "generation": claimed["generation"]}), flush=True)
            os._exit(74)

        # Reclaim orphaned staging directories left by previous owners.
        for old_stage in sorted(directory.glob(f".trash-{drop_id}-g*")):
            if old_stage.is_dir() and not old_stage.is_symlink():
                shutil.rmtree(old_stage)
            else:
                raise ValueError("unexpected staged entry; refusing to delete")
        success = finish_cleanup(
            db, drop_id, claimed["owner"], claimed["generation"], now
        )
        return {
            "claimed": True,
            "completed": success,
            "generation": claimed["generation"],
        }


def main(argv: list[str]):
    db_path, root, drop_id, now, *rest = argv
    crash = rest[0] if rest else None
    print(json.dumps(cleanup_synthetic_pack(
        db_path, root, int(drop_id), float(now), crash_after=crash
    )), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
