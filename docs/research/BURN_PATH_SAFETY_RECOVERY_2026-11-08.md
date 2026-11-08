# NESS Burn — research path safety and deletion recovery (2026-11-08)

**Decision: research only. Not a production security patch. No upstream PR.**

## Why this separate branch exists

Frahane merged the two narrowly scoped final-session Burn fixes, [PR #1](https://github.com/Frahane/NESS_SUITE/pull/1) and [PR #2](https://github.com/Frahane/NESS_SUITE/pull/2). Their effects in the current single-process implementation must be preserved. This new research is **not** a follow-up patch to those PRs and is **not** evidence that upstream has an exploitable path traversal bug.

Current upstream README describes NESS_SUITE as **single-process**. Our previously developed multi-process locking, HTTP streaming and SQLite fencing models explore possible future architecture and should not be conflated with the current production shape.

Research branch: [research/burn-path-safety-recovery-20261108](https://github.com/DeepKang-Labs/NESS_SUITE/tree/research/burn-path-safety-recovery-20261108).

Base: `research/burn-portable-cleanup-fencing-20261108` — does not change official `Frahane/NESS_SUITE:main` or the fork's synchronized `main`.

## Hypothesis and experimental approach

An owner-generation lease plus a cooperative OS lock prevents overlap among participating deletion workers, but deleting with `shutil.rmtree` still requires a bounded path policy and recoverable failure semantics.

The new research-only `research/burn_path_safety_research.py` rejects:
- A sandbox root without an ordinary marker file.
- Symbolic links, Windows directory junctions/reparse points where recognized, and nonregular entries.
- A symlinked pack directory, nested symlinks inside the pack, or a symlinked lock directory/file.
- Unexpected symlinked staging directories from previous interrupted generations.
- Invalid, empty, traversal or separator-containing synthetic pack names.
- Non-cooperating filesystem actors are NOT fenced by these validations.

A dedicated `UnsafeResearchPath` exception communicates fail-closed refusal. Lock directories are created using `mkdir(exist_ok=True)` followed by an `lstat`/reparse guard to tolerate initialization by two cooperative workers.

The child-branch `research/burn_portable_cleanup_fencing.py` invokes these checks before renaming or deleting synthetic data. It also supports **controlled synthetic exception injections** after:
1. SQLite deletion claim committed, before filesystem mutation.
2. Directory moved into a staging location, before deletion.
3. Files already unlinked, before SQLite finalization.

Tests then verify that a second independent OS process can reclaim an expired deletion lease, complete the remaining filesystem work and mark deletion complete. A DB operation and OS filesystem manipulation are **not** an atomic cross-resource transaction; these tests only establish recovery for the three chosen interruptions.

## Evidence and exact scope

New tests: `tests/test_burn_path_safety_recovery.py` (12 declared tests, with the Windows-junction case intentionally skipped on Linux).

[GitHub Actions run 42532264789](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42532264789) — **both OS matrix jobs passed** on Python 3.12:
- Ubuntu research: 11 new test successes and 1 expected Windows-only skip; original 8 portable-cleanup tests passed.
- Windows research: 12 new tests passed, including creation and rejection of an actual Windows junction; original 8 portable-cleanup tests passed.
- Existing unmodified 21 Burn application tests passed on each OS.

[GitHub Actions run 42532264956](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42532264956) — repeat all 12 declared tests **three times** on each OS: Windows 36 successes; Ubuntu 33 successes and 3 Windows-only skips. This is a reproducibility check, **not** exhaustive race model checking.

### Preserved failed first run

[GitHub Actions run 42532116611](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42532116611) initially failed the **existing** `test_unmarked_directory_fails_without_touching_pack` under both OSes, while new Ubuntu tests passed. Root cause: the new marker checker emitted the generic diagnostic `research path missing` rather than the previously expected `marked research sandbox`. This was **diagnostic compatibility**, not a missing refusal or a successful unsafe deletion.

Commit `38e4e483e9ba3d0c2b0da9427b20544be7605cfe` restored an explicit missing-marker error. Run 42532164761 then passed on both platforms; subsequent runs reconfirmed the result. Do not discard this failure from the research trail.

## What this does NOT prove

1. **No atomic path-identity guarantee.** The code checks with `lstat`/reparse metadata before issuing `rename` or `rmtree`. A hostile or noncooperating writer can switch path components after validation (TOCTOU). For a stronger production guarantee, evaluate OS-specific directory-handle and open-by-handle operations with ownership of parent directories, including `O_NOFOLLOW`/directory FD operations on POSIX and properly constrained Windows handles.
2. **No hardened Windows reparse-point policy.** The tested junction and symlink cases are a subset of reparse-point behavior. Other tags and replacement strategies remain untested.
3. **No durability proof across power loss.** SQLite and the filesystem are separate resources; fsync order, power interruption, and missing/corrupted staging state need more analysis.
4. **No proof for multi-host/network filesystem or malicious local users.** Cooperative locks apply only when all relevant cleanup paths agree on the lock and storage semantics are known.
5. **No full deployment migration or production integration.** No change to Flask, real Burn sessions, DB migrations, actual user files, authorization policy or backend topology.
6. **No exploit claim against upstream.** The upstream file naming and token paths are separately sanitized; this research identifies hardening demands for an optional future cleanup redesign.
7. **Tests are synthetic.** All deletion happens within marked temporary directories created by the test harness.

## Next integration decision gates

- Confirm with Frahane whether any worker/process scaling is actually planned; the current published system is explicitly single-process.
- Prioritize a narrow real-code test for the **existing single-process** Burn behavior before proposing a third PR. If a reproducible flaw is observed, open a separate minimal patch against the latest official `main`.
- For a portable deletion service, decide who controls filesystem roots and how to avoid path-identity TOCTOU. Use controlled file descriptors/handles or a trusted single deletion worker; do not treat `lstat` alone as a secure boundary.
- Add deterministic failure tests for permission-denied unlink, locked file on Windows, power-loss recovery strategy and stale stage directories.
- Review cost of scanning an entire tree and holding the per-drop OS lock during `rmtree`; test large synthetic packs and contention before shipping.

**Recommendation:** Keep all of this branch in the research lane. Share a concise review with the maintainer only when relevant, and never merge the exploratory files wholesale into the official app.
