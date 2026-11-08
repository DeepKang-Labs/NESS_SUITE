"""Research-only fail-closed path policy for temporary Burn cleanup packs.

This module supports isolated cooperative tests on Ubuntu and Windows.
It is NOT a proven defense against a hostile actor that can replace
directory entries between validation and filesystem operations (TOCTOU).
Only a secured root, OS-specific dir-handle operations and controlled
writers could address that stronger threat model.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat


class UnsafeResearchPath(ValueError):
    """The candidate path violates the synthetic cleanup experiment's policy."""


def _stat_no_reparse(path: Path):
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        raise UnsafeResearchPath("research path missing") from None
    if stat.S_ISLNK(metadata.st_mode) or path.is_symlink():
        raise UnsafeResearchPath("symbolic link forbidden")
    # Python 3.12 on Windows marks junctions/reparse points separately.
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        raise UnsafeResearchPath("Windows junction forbidden")
    flags = getattr(metadata, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if flags & reparse:
        raise UnsafeResearchPath("Windows reparse point forbidden")
    return metadata


def checked_root(path: str | Path) -> Path:
    root = Path(path)
    if not stat.S_ISDIR(_stat_no_reparse(root).st_mode):
        raise UnsafeResearchPath("research sandbox must be a real directory")
    marker = root / ".burn_research_sandbox_only"
    if not stat.S_ISREG(_stat_no_reparse(marker).st_mode):
        raise UnsafeResearchPath("research sandbox marker must be a regular file")
    return root.resolve(strict=True)


def checked_tree(root: Path, relative_name: str) -> Path | None:
    """Validate a synthetic directory tree without following directory links.

    Missing roots are allowed (e.g. a crash after prior unlink). Every
    existing child must be a regular file or real directory, never a link,
    junction, reparse point, pipe, device or another special entry.
    """
    if not isinstance(relative_name, str) or not relative_name or (
        "/" in relative_name or "\\" in relative_name or relative_name in {".", ".."}
    ):
        raise UnsafeResearchPath("invalid synthetic pack name")
    target = root / relative_name
    if not target.exists() and not target.is_symlink():
        return None
    if not stat.S_ISDIR(_stat_no_reparse(target).st_mode):
        raise UnsafeResearchPath("research pack must be a real directory")
    stack = [target]
    while stack:
        base = stack.pop()
        for child in base.iterdir():
            info = _stat_no_reparse(child)
            if stat.S_ISDIR(info.st_mode):
                stack.append(child)
            elif not stat.S_ISREG(info.st_mode):
                raise UnsafeResearchPath("special file forbidden inside pack")
    return target


def checked_lock_file(root: Path, drop_id: int) -> Path:
    if type(drop_id) is not int or drop_id <= 0:
        raise UnsafeResearchPath("invalid synthetic drop id")
    folder = root / ".portable-research-locks"
    if folder.exists() or folder.is_symlink():
        if not stat.S_ISDIR(_stat_no_reparse(folder).st_mode):
            raise UnsafeResearchPath("lock directory is not a real directory")
    else:
        folder.mkdir()
    lock = folder / f"pack-{drop_id}.lck"
    if lock.exists() or lock.is_symlink():
        if not stat.S_ISREG(_stat_no_reparse(lock).st_mode):
            raise UnsafeResearchPath("lock file is not regular")
    return lock
