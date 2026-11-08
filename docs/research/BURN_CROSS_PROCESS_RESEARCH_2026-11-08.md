# Burn cross-process research — evidence, invariants and candidate protocol (2026-11-08)

**Status:** reproducible defect + isolated SQLite model; **NOT a production Burn fix**.

## Baseline and traceability

- Upstream: [Frahane/NESS_SUITE](https://github.com/Frahane/NESS_SUITE)
- Original accepted contribution: [PR #1](https://github.com/Frahane/NESS_SUITE/pull/1)
- In-process cleanup regression fix awaiting policy review: [draft PR #2](https://github.com/Frahane/NESS_SUITE/pull/2)
- Research base: contributor commit `ae4122ed5db5458eb93eb98b4c6aa91dc5542c52`, corresponding to draft PR #2.
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

The single-process guard in draft PR #2 remains worth evaluating on its stated scope, but it cannot by itself enforce a cross-worker guarantee. A second process may purge a quota-closed pack while the first has an authorized finishing session. Separately, a token issued by one worker is unknown to another.

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
- **No upstream change:** Draft PR #2 remains unchanged; no upstream `main` modification, new upstream PR, or automatic merge.
- **Next gate:** Ask Frahane whether finishing a multi-file pack after quota exhaustion is the intended policy and whether the deployment uses multiple worker processes. Keep this as a separate research track pending that answer.
