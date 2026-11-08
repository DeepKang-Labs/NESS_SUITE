# Burn stale-cleaner filesystem fencing — POSIX research (2026-11-08)

**Status: isolated Linux proof of concept, not a NESS_SUITE implementation.**

## Scientific question

The earlier SQLite prototype safely rejects a stale cleanup worker's **database completion**, but does not stop that old process from issuing filesystem mutations after its database cleanup lease expires and a replacement worker takes ownership.

Can cooperative cleanup workers ensure that filesystem mutation and deletion-claim handoff never overlap?

## Proposed invariant and mechanism

Let `D` be a single synthetic drop and `L_D` a stable, per-drop POSIX advisory file lock.

**Safety invariant (within this cooperative local-host model):**

> While a worker may rename or unlink files belonging to `D`, no *other cooperating cleaner* can reclaim `D` or mutate those files, and an expired claim cannot begin new filesystem mutation.

The experimental `research/burn_posix_flock_fencing.py` enforces the following ordering:

1. Enter the **stable `fcntl.flock(LOCK_EX)`** critical section for `D` before creating/reclaiming the SQLite deletion claim.
2. Acquire the SQLite claim using `BEGIN IMMEDIATE` through the previous `acquire_cleanup` model.
3. Verify the current claim owner, generation and deadline **under the still-held filesystem lock**.
4. If stale, return without touching filesystem data.
5. Otherwise stage and delete only the marked temporary pack, then record `deleted`, still under `flock`.
6. Release `flock` on exit. The OS also releases the lock if the process is killed.

A replacement worker cannot claim/reclaim until the previous worker has released the lock. Therefore an OS-level worker that pauses beyond its *simulated* lease deadline will abort on resumption before attempting deletion. A killed worker releases the lock; a later worker can reclaim the expired SQLite deletion and clean orphaned staging.

**Important:** This solves a narrower question than distributed fencing. POSIX `flock` is **advisory**. It only protects against processes that obey the same lock convention on a local filesystem with appropriate lock semantics.

## Actual reproducible CI evidence

Research branch: [research/burn-stale-worker-fencing-20261108](https://github.com/DeepKang-Labs/NESS_SUITE/tree/research/burn-stale-worker-fencing-20261108).

Test modules:

- `tests/test_burn_posix_flock_fencing.py` (6 new tests).
- `tests/test_burn_sqlite_lease_model.py` (5 preceding model tests).
- `tests/test_burn_transfer_fencing_model.py` (10 preceding model tests).
- `tests/test_burn_filesystem_crash_harness.py` (6 preceding synthetic-filesystem tests).
- `tests/test_burn_download_quota.py` (21 existing Burn application regressions).

[GitHub Actions run 42515038733](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42515038733): **both jobs succeeded on Ubuntu / Python 3.12**. One job executed 6 new POSIX tests and the 21 prior model tests; the other executed 21 existing Burn application tests. In total, 48 tests passed within these jobs.

### Six new tests

| Test | Property validated |
| --- | --- |
| Paused old worker and competing successor | B blocks on `flock` until A releases; A detects its expired claim, performs no deletion; B reclaims generation 2 and deletes |
| Stale worker with no contender | No deletion on expired ownership; subsequent independent worker can recover |
| `os._exit` after staging | Lock is released by OS; new worker reclaims expired generation, removes staged synthetic files |
| Simultaneous cleanup workers | One successful cleanup, one refusal; at most one mutation owner |
| Bounded active read pin | Cleanup is refused while the pin is live; allowed after the pin completes |
| Unmarked target directory | Filesystem cleanup is rejected outside a marked research sandbox |

The scenario uses **real independent Python OS processes and actual synthetic temporary files**. Timestamps are *controlled, injected model clock values* to make lease expiration deterministic; this is **not** a real wall-clock lease or a production load test.

## Preconditions, exclusions and limitations

- **Never deploy this module as-is.** It is not imported by the actual Burn route handlers, and only operates inside a marked temporary research sandbox.
- Every cleaner must use the same stable lock file. A rogue, outdated, or unrelated writer can bypass advisory locking and delete files anyway.
- The guarantee depends on **local POSIX `flock` semantics**. Windows, shared network filesystems, several hosts, container volumes and scheduler failure modes have not been evaluated.
- The lock is held across filesystem deletion: large directories or stalled I/O can starve cleanup workers. A rigorous throughput and fairness policy is required.
- The injected `claim_now` and `acting_now` values are model inputs, not trustworthy production clocks. A real system must use consistent, trusted time and handle clock adjustments.
- A worker may legitimately begin unlinking while its claim is current but finish after that deadline; the exclusive lock prevents a *cooperating* replacement from taking over until the old worker releases it. The experiment does not promise immediate revocation of an already-running OS syscall.
- Actual HTTP streaming, background cleanup schedulers, process restart integration, DB migrations, safe production path handling, symlink/reparse-point attacks, fsync/crash durability and non-cooperating mutators remain outside scope.
- The previously discovered multiworker session-recognition defect is not solved in the actual application. Earlier **green** negative-control tests intentionally reproduce this defect and should not be mistaken for production fixes.

## Decisions and follow-ups

1. Preserve **accepted upstream PR #1 and PR #2** unchanged. Frahane already merged both.
2. Preserve original `research/burn-multiprocess-invariants-20261108` as a prior evidence baseline. The current tests are on a new child research branch.
3. Do not open an upstream PR from this experiment. It has not passed production integration or Windows validation.
4. Next highest-value test: an end-to-end file streaming reader versus a delayed cleaner, with explicit read-pinning and no reading beyond its bounded deadline; include failure injection during streaming.
5. Ask Frahane for the actual deployment topology and desired expiration policy before choosing between a per-process lock, dedicated deletion service, or shared transactional ownership.

**Scientific conclusion:** The new tests are consistent with `flock` + durable SQLite ownership preventing an expired cleanup worker from mutating synthetic data *after a cooperating successor has taken over*. This is a Linux-local cooperative proof of concept, not a formal proof or a production security claim.
