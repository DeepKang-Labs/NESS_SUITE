# NESS Burn portable cleanup fencing — Windows and Linux research (2026-11-08)

**Status: isolated, synthetic, non-production experiment. No upstream PR.**

## Question

Can separate Python cleanup workers on Windows and Linux prevent an **expired** worker from deleting a synthetic Burn pack after another worker is allowed to reclaim ownership?

Previous Linux-only experiments used `fcntl.flock`; the new experiment tests a **cooperative local-process protocol on both platforms**.

## Proposed protocol

Research implementation: [research/burn_portable_cleanup_fencing.py](../../research/burn_portable_cleanup_fencing.py)

1. Require a research sandbox root with the explicit `.burn_research_sandbox_only` marker.
2. Derive an unchanging per-drop lock file in `.portable-research-locks`. Do not unlink or replace the lock file during normal cleanup.
3. Acquire an exclusive OS lock before creating or reclaiming the SQLite deletion claim:
   - **Windows:** lock byte range `[0, 1)` with `msvcrt.locking(..., LK_NBLCK, 1)` and bounded retries.
   - **POSIX:** acquire `fcntl.flock(..., LOCK_EX | LOCK_NB)` and bounded retries.
4. SQLite `BEGIN IMMEDIATE` grants an owner capability and monotonically incremented deletion generation.
5. While holding the OS lock, verify that the ownership generation and lease expiry are still valid **before first filesystem mutation**.
6. Only then rename a synthetic pack into a generation-specific staging folder, remove staged files, and commit deletion completion.
7. Release the OS lock. A hard-killed Python process automatically releases the kernel-level lock; after its SQLite claim expires, a successor can resume staged deletion.

In this model, the **filesystem critical section spans both database ownership and file operations**. This blocks a second *cooperating* cleaner until the current worker releases the lock, avoiding the stale cleaner's original overlap.

## Tests actually executed

[GitHub Actions run 42519652211](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42519652211) — **success** on both GitHub-hosted Ubuntu and Windows with Python 3.12.

| Suite | Cases per OS | Ubuntu | Windows |
| --- | ---: | --- | --- |
| New portable cleanup-fencing tests | 8 | PASS | PASS |
| Previous SQLite finishing-lease model | 5 | PASS | PASS |
| Previous bounded transfer/deletion recovery model | 10 | PASS | PASS |
| Previous actual temporary-filesystem crash tests | 6 | PASS | PASS |
| Existing, unchanged NESS Burn quota regressions | 21 | PASS | PASS |
| Synthetic loopback HTTP/1.1 streaming experiments | 4 | PASS | PASS |
| **Total** | **54** | **54/54** | **54/54** |

**Caution:** A successful synthetic model test does not mean NESS Burn production routes were changed or made safe under these conditions. The four streaming experiments are about a *hypothetical streamed-file design*. Current upstream `burn.py` reads the whole file using `Path.read_bytes()` before constructing the response.

The eight new portable tests demonstrate:

1. Suspended worker A's deletion authorization becomes stale; worker B waits on the same OS lock, then reclaims generation 2; A does not delete.
2. Stale worker with no successor leaves files untouched until a later recovery worker runs.
3. Abrupt process exit after staging releases the OS lock; another worker removes orphaned staged synthetic files after lease expiry.
4. Concurrent workers yield one deletion owner and one refusal.
5. Active short-lived read pin prevents a cooperating cleanup worker from deleting, even after the initiating session expires.
6. An unmarked directory is refused, without touching the legitimate synthetic pack.
7. A stable lock file survives the stale-worker and successor sequence instead of being unlinked/recreated.
8. **Deliberate negative control:** a noncooperating actor can unlink an unlocked data file *despite* the independent lockfile being held. The OS lock is advisory, not a security sandbox.

Every destructive test uses temporary synthetic files and never accesses a real user drop. Forced exits and lock contention use distinct OS processes. Tests inject deterministic **model timestamps** `1002` and `1008` for lease-expiry checks, but exercise the **real native process locks and OS filesystem**.

## Security limitations (must not be hidden)

- `msvcrt.locking` and `flock` use different OS primitives; their observed local-host behavior on hosted CI does not imply cross-OS lock interoperability on shared network filesystems.
- All mutating cleanup paths must cooperate and acquire the same lock. A noncooperating process can bypass this protocol entirely; the negative-control test proves that.
- A stable lock directory must be secured against path replacement, symlink, junction, reparse-point and link-file attacks. The current `Path.is_symlink()` check is not an atomic open and is **not** sufficient for production.
- Blocking the per-drop lock for the full duration of potentially slow disk cleanup can cause contention, lock timeouts, and starvation. Benchmarks are still required.
- The SQLite claim uses model-injected clock values; real deployment needs a trusted clock and failure policy for skew.
- This design does not provide a transactional commit across SQLite and the OS filesystem. Crash recovery is demonstrated for staged synthetic files, not general corruption recovery or power-loss durability.
- It does not ensure an active HTTP client actually receives the entire response; a successful write on the server is not a client acknowledgment.
- The actual Burn application does not use this protocol, and its process-local `_VIEW_SESSIONS` limitation remains a separate real integration issue.
- No test here covers network-mounted volumes, multiple hosts, hostile actors, throughput under load, Windows antivirus interference, or arbitrary filesystem permissions.

## Reproduction

On a repository checkout with Python 3.12:

```sh
python -m unittest discover -s tests -p test_burn_portable_cleanup_fencing.py -v
python -m unittest discover -s tests -p test_burn_sqlite_lease_model.py -v
python -m unittest discover -s tests -p test_burn_transfer_fencing_model.py -v
python -m unittest discover -s tests -p test_burn_filesystem_crash_harness.py -v
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p test_burn_download_quota.py -v
python -m unittest discover -s tests -p test_burn_http_stream_crossplatform.py -v
```

CI workflow: `.github/workflows/burn-portable-fencing-matrix.yml`.

## Decision and next gates

- **Proven for the defined model:** cooperative local-process deletion exclusion and stale-owner refusal on both hosted OSes for tested scenarios.
- **Not proven:** production security, hostile filesystem actors, multi-host orchestration, or fail-safe integration into real `burn.py`.
- **Keep** upstream accepted PR #1 and #2 unchanged; neither is a multiworker fix.
- **No upstream PR yet:** ask Frahane about actual deployment model and whether multi-process workers share a writable local SQLite database and filesystem.
- **Next science priorities:** repeated race stress, filesystem path hardening, crash injection between SQLite and rename/unlink, and eventually a real Flask route integration branch only after policy/design review. Keep the existing HTTP-streaming experiment as a separate prospective architecture, not an asserted current bug.

Research branch: [research/burn-portable-cleanup-fencing-20261108](https://github.com/DeepKang-Labs/NESS_SUITE/tree/research/burn-portable-cleanup-fencing-20261108).

## Repeated-race stability gate

[GitHub Actions run 42519823155](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42519823155) completed successfully.

A separate workflow `.github/workflows/burn-portable-fencing-stress.yml` replays the **eight new independent-process tests five times per operating system** (40 cases on hosted Ubuntu, 40 on hosted Windows). All 80 replays passed. This improves reproducibility evidence but is neither exhaustive race exploration nor a statistical probability-of-failure guarantee.

The complete 54-cases-per-OS matrix was rerun successfully on the same research commit [42519823116](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42519823116).

## Repository maintenance performed

Contributor fork `DeepKang-Labs/NESS_SUITE:main` was fast-forwarded without force from `555a05dfe1fcf6f0aec734906b3066718f6db950` to upstream `Frahane/NESS_SUITE:main` at `420811ccb5b9c2e867e17254652efeaa083242c8`. GitHub comparison confirmed this to be an **eight-commit fast-forward with zero divergent contributor commits**. The research branches remain separate and have not been merged into `main`. This is repository synchronization, not an upstream code contribution.

**Current gate:** No upstream PR should be opened from this research branch unless deployment topology, policy for multi-file quota exhaustion, filesystem path-hardening, durability and fail-closed migration strategy are reviewed.

## Adversarial reruns and harness correction (same date)

A previous **intermediate** matrix run [42519793496](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42519793496) reported **failure** for the *Windows HTTP streaming research harness only*. The original 21 Burn regressions and the Windows/Ubuntu portable locking tests in that run were successful. Examination of the failing job log showed:

```text
test_http_stream_aborts_at_hard_pin_deadline ... ERROR
ValueError: invalid literal for int() with base 10: ''
at tests/test_burn_http_stream_crossplatform.py:76
```

The HTTP server wrote `server-port` directly via `Path.write_text`. A separate test process observed the file *after creation but before the port digits were written*. The failure is a **readiness-publication race in our research harness**, not evidence of a Burn application download failure.

**Fix:** The synthetic HTTP server now fully writes `server-port.tmp` and atomically renames it to `server-port`. This was committed on both the source HTTP research branch (`4381799`) and this portable-fencing child branch (`3ca85c0`).

**Fresh CI after fix:**

- [42520009624](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42520009624): full **54 tests/OS** matrix successful, including unchanged 21 Burn regressions per OS.
- [42520009613](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42520009613): **five complete repetitions of eight portable-locking tests per OS = 80 test executions**, all successful.
- [42520009748](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42520009748): **six complete repetitions of four synthetic HTTP tests per OS = 48 test executions**, all successful.

These repeated runs provide better reproducibility evidence. They do **not** prove the absence of races, nor eliminate the need for production failure injection and load testing.

**Integrity note:** The failure is retained in the research trail; do not silently discard failed CI runs when interpreting evidence.
