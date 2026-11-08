# Burn cross-process research — evidence, invariants and candidate protocol (2026-11-08)

**Status:** reproducible defect + isolated SQLite model; **NOT a production Burn fix**.

## Baseline and traceability

- Upstream: [Frahane/NESS_SUITE](https://github.com/Frahane/NESS_SUITE)
- Original accepted contribution: [PR #1](https://github.com/Frahane/NESS_SUITE/pull/1)
- In-process cleanup regression fix: [PR #2](https://github.com/Frahane/NESS_SUITE/pull/2), **merged by Frahane on 2026-11-08 at 16:29:19 UTC**, merge commit `c9b08546979af4ca62b62a35d5e7ea211daa678f`.
- Research base: contributor commit `ae4122ed5db5458eb93eb98b4c6aa91dc5542c52` (the code subsequently accepted in PR #2). Research experiments remain isolated from the official application.
- Research branch: `research/burn-multiprocess-invariants-20261108`. It is deliberately separate from the PR #2 branch, from upstream `main`, and from the contributor fork's `main`.

## Actual experiments on GitHub-hosted Ubuntu / Python 3.12

| Experiment | Source / exact scope | Evidence | Result |
| --- | --- | --- | --- |
| Existing Burn regression tests | `tests/test_burn_download_quota.py`, against corrected single-process research base | [GitHub Actions run 42492938693](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42492938693) | Job passes (21 legacy tests) |
| Cross-worker cleanup contract | `tests/test_burn_multiworker_contract.py`, two independent Python interpreters, shared temporary SQLite and files | Same run | Contract FAILS as expected: worker B deletes files of still-valid worker A finishing session |
| Cross-worker session recognition | Same executable test, a token issued in worker A and used in worker B | Same run | Contract FAILS as expected: worker B cannot validate worker A's process-local token |
| SQLite shared lease research MODEL | `research/burn_sqlite_lease_model.py` and `tests/test_burn_sqlite_lease_model.py`; isolated model not integrated into `burn.py` | [GitHub Actions run 42493166132](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42493166132) | All 5 MODEL tests pass |

**CAUTION:** The cross-worker characterization workflow is GREEN *because* it strictly checks for the two known contract-test failures. Its green status is **not** evidence that the defects are fixed. The five passing SQLite tests validate only the research MODEL.

### Why the current patch is insufficient across processes

The NESS Burn module holds `_VIEW_SESSIONS` in a process-local Python dictionary. The existing `_view_session_ok` and `cleanup_burn_expired` consult this dictionary. Different application workers do not share it.

The single-process guard accepted in PR #2 addresses its stated scope, but does not by itself enforce a cross-worker guarantee. A second process may purge a quota-closed pack while the first has an authorized finishing session. Separately, a token issued by one worker is unknown to another.

## Candidate invariants

1. **Quota uniqueness:** At most one new session claims the last unit of a given pack quota, even across independent processes.
2. **Cross-worker authority:** Any worker can validate an unexpired, authenticated, properly scoped session. No raw session secret needs to be stored.
3. **Bounded finishing:** A quota-closed pack is retained only for its valid finishing session, and never beyond its drop expiry or an explicitly bounded session deadline.
4. **Unauthorized denial:** Another token, an expired token, or a new session cannot download from a closed pack.
5. **Atomic claim publication:** Quota closure and the durable finishing-authorization marker commit in the *same* SQLite transaction. A crash cannot persist only one half.
6. **Deletion fencing:** A cleanup worker must acquire an exclusive deletion claim in SQLite after checking for live finishing leases. Once deletion is claimed, new authorization or lease renewal must be denied.
7. **Bounded eventual cleanup:** Expired, abandoned and crash-interrupted packs must ultimately be deleted; disk-deletion errors require idempotent retries and visibility.
8. **Scope separation:** `burn_after`/single-file immediate-burn behavior must not be silently changed to multi-file finishing semantics.

## Isolated protocol model (implemented, NOT wired to app)

`research/burn_sqlite_lease_model.py` uses two SQLite tables for simulated drops and hashed session tokens.

- `issue_session`: creates a 192-bit unpredictable raw token, persists only its SHA-256 digest and an expiry no later than the drop's expiry. Since the tokens have high entropy, a stored hash is suitable for this research model.
- `final_claim`: with `BEGIN IMMEDIATE`, checks ownership and expiry, increments the simulated final quota, marks the drop `burned`, and sets the finishing lease in one transaction.
- `finishing_session_valid`: verifies token ownership, charged finishing scope, drop status and both expiry bounds from another process.
- `claim_cleanup`: with `BEGIN IMMEDIATE`, checks for live finishing leases and atomically marks the drop `deleting` if none protect it. Filesystem deletion is **not** implemented in this model.

Five tests cover: external cleanup refusal while live; lease expiration and cleanup; drop-expiry override; wrong token rejection; two competing independent processes with one final-claim winner.

## Engineering gaps before a real integration

- **In-flight I/O:** A session may expire after verification but while a file is being read or streamed. A durable transfer pin, short bounded read lease or explicit request ownership is needed to fence deletion during I/O.
- **Cleanup crash:** `deleting` must have recoverable claim ownership / lease expiry and idempotent filesystem retries. Do not leave abandoned files forever.
- **Database and storage topology:** A single shared SQLite file and shared filesystem are assumed. This model says nothing about separate hosts/volumes, network filesystems, or distributed databases.
- **Authorization paths:** `/unlock`, inline view, passwordless sessions, renewals, token handling and all download routes must consistently use the durable model; updating cleanup alone is insufficient.
- **Concurrency and durability:** Need crash injection between quota claim / lease commit, pre-read and post-read hooks, concurrent cleanup claim, restart tests, schema migration and rollback tests.
- **Security and privacy:** Token leakage, replay, log redaction, per-drop token binding, retention limits, expiry/revocation and sensitive-file-removal policy must be audited.
- **Clock choice:** Timestamp comparison across machines requires a defensible time source and documented skew tolerance.
- **Operating conditions:** Benchmark contention/SQLite busy timeouts and test Windows + Ubuntu; evaluate multi-host behavior only if that deployment topology is required.

## Decision register

- **Confirmed:** Cross-process limitations are demonstrable with two independent interpreters.
- **Confirmed:** A transactionally published SQLite lease can satisfy five isolated modeled properties.
- **NOT confirmed:** That the isolated code is a safe drop-in replacement for NESS Burn.
- **Upstream status (verified 2026-11-08):** Frahane independently merged PR #2 into upstream `main`. This research branch made no additional upstream modifications, upstream PRs, or automatic merges.
- **Next gate:** Ask Frahane whether finishing a multi-file pack after quota exhaustion is the intended policy and whether the deployment uses multiple worker processes. Keep this as a separate research track pending that answer.


## Continuation: bounded I/O and recoverable cleanup (2026-11-08)

**Branch-only research changes; no modification to upstream or draft PR #2.**

The original shared SQLite lease model did not model *in-flight reads*. Its first five tests establish an atomic quota-closure and finishing-authorization claim, but do not protect a stream after its session expires. Two additional **research-only** modules now explore this separate property.

### V2 transfer and deletion-fencing model

- [Model source](../../research/burn_transfer_fencing_model.py)
- [Ten tests](../../tests/test_burn_transfer_fencing_model.py)
- [Successful GitHub Actions run 42495913297](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42495913297)
- [Final-revision rerun 42496101710](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101710)

The proposed experiment uses durable, hashed per-request transfer pins and SQLite `BEGIN IMMEDIATE` transactions to serialize read start against deletion claiming:

1. A session and a quota-closed multi-file pack must be valid **at read start** to create a pin.
2. A pin has a hard upper bound; it is capped by its read-window deadline and `drop_expiry + bounded_grace`.
3. No new read may start once a cleanup worker has claimed the drop for deletion.
4. Cleanup refuses to claim while a valid finishing-session lease or an unfinished, unexpired read pin exists.
5. When deletion is permitted, the database grants an exclusive *owner token* and increments a *deletion generation*. A crash-recovery worker may reclaim the deletion only after the preceding lease expires.
6. A stale worker's prior owner/generation cannot mark the newer deletion complete.

**Confirmed in the isolated model:** ten unit tests covering independent-process expiry/cleanup, token binding, concurrent cleanup claims, forced process exit after a committed deletion claim, fencing, and stale-owner rejection. These tests do **not** model actual live HTTP streaming; once a read deadline passes, the application would have to stop using the source file safely.

### Synthetic filesystem interruption experiments

- [Marked-sandbox adapter](../../research/burn_filesystem_crash_harness.py)
- [Six filesystem crash tests](../../tests/test_burn_filesystem_crash_harness.py)
- [Successful GitHub Actions run 42496101810](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101810)

These tests create only synthetic files in `TemporaryDirectory` and require a sandbox marker before any deletion. The cleanup adapter atomically acquires a SQLite deletion claim, renames the simulated pack folder to a staging location on the same filesystem, deletes staged files, then marks deletion complete.

Injected OS-process exits after **claim** and after **staging** prove that a second independent interpreter can recover expired deletion claims and clean up staged files. A live read pin blocks deletion of the synthetic pack until its bounded window ends or the read is recorded complete. Attempts outside a marked sandbox are refused.

**Results at final tested source revision `2600a9d`:**

| Test tier | Cases | GitHub Actions |
| --- | ---: | --- |
| Original SQLite finishing-lease model | 5 passed | [42496101790](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101790) |
| Transfer-fencing and crash-recovery model | 10 passed | [42496101710](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101710) |
| Temporary-filesystem crash experiments | 6 passed | [42496101810](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101810) |
| Existing original Burn regression suite | 21 passed | [42496101751](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101751) |
| Two expected multi-process contract failures on real NESS Burn code | Both failures reproduced | [42496101751](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42496101751) |

The green result on the *multi-process contract* workflow is a **negative control**: the workflow explicitly expects the existing application to fail both contracts. Do not sum those as fixed cases.

### Scientific limits and new adversarial gates

**Not proven:**
- Real Flask route integration, an actual streamed response body, or a client consuming data during a deletion race.
- Windows file-handle and directory-rename behavior; tests were run on Linux.
- No stale OS process will perform filesystem operations after its deletion-lease deadline. A database-generation check alone does **not** fence arbitrary filesystem syscalls. This would require per-operation ownership rechecks, renewal, or an architecture with one deletion worker and tightly bounded operations.
- Safety under shared network filesystems or several database hosts. Tests assume a **single local SQLite file** and one shared filesystem.
- Crash consistency or durability of the directory rename / SQLite commit *as a single atomic operation*. They are separate resources and require careful recovery and filesystem synchronization decisions.
- Safe schema migration of existing production drops, secret-handling practices, and any throughput/performance guarantee.

**Next safety gates before recommending an upstream implementation:**
1. Confirm with Frahane the actual worker topology and the desired rule for a final multi-file session versus strict expiration.
2. Model an actual streaming/open-handle lifecycle and deletion race, including read abort on pin expiry.
3. Introduce recoverable deletion work ownership that prevents a stale worker from performing destructive OS operations after lease reassignment (not just a stale database completion).
4. Test migration, reboots, failed `rmtree`, file permission errors, high contention, and Windows behavior.
5. Only then consider a narrowly-scoped implementation PR; do not mix this research branch into PR #2 or upstream `main`.

**Decision:** PR #2 has been merged by Frahane and its in-process safeguard is present in upstream `burn.py` at `420811ccb5b9c2e867e17254652efeaa083242c8`. Maintain the subsequent cross-process research as a separate exploratory branch with CI evidence; do not claim it is deployed or that production/live-data behavior has been validated.
