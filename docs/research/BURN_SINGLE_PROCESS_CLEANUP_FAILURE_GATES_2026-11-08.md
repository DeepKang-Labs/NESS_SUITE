# NESS Burn — actual single-process cleanup failure characterization (2026-11-08)

**Status: passing characterization of the current application; no proposed code change; no upstream PR.**

## Why this investigation matters

Frahane/NESS_SUITE documents a **single-process** Flask/Python deployment. Earlier DeepKang-Labs experiments on worker coordination, SQLite leases, file locks and hypothetical HTTP streaming were deliberately isolated and are **not** evidence of a defect in that stated deployment.

This follow-on branch starts directly from the synchronized contributor fork **`main` at `420811ccb5b9c2e867e17254652efeaa083242c8`** (same Git commit as upstream at the time of the experiment). It imports the **real** `app.py` and `burn.py`, uses synthetic temporary uploads and SQLite, and calls the real `cleanup_burn_expired()` function.

Research branch: [research/burn-single-process-cleanup-gates-20261108](https://github.com/DeepKang-Labs/NESS_SUITE/tree/research/burn-single-process-cleanup-gates-20261108).

## What was tested

New file: `tests/test_burn_cleanup_failure_gates.py`. Five tests:

1. **Partial deletion of a closed two-file pack:** fake a partially completed `shutil.rmtree` call which removes the first file but leaves the second. `files_json` stays nonempty, and a later real cleanup removes the residual file and clears metadata.
2. **Expiry while deletion is incomplete:** the expired active pack becomes `expired`, keeps metadata while a file survives, and is later completely removed. Because the test uses an expiry in the year 2000, the normal seven-day SQLite retention rule removes the fully cleaned DB row.
3. **Isolation between two drops:** a simulated undeletable pack does not prevent another pack from being removed. Both are ultimately cleaned after the simulated failure is lifted.
4. **Missing directory and idempotence:** a pre-removed directory does not keep stale file metadata forever; repeated cleanup remains safe in the tested state.
5. **Unrelated sibling data:** cleaning the marked synthetic Burn pack does not delete an unrelated synthetic sentinel directory.

The simulation of partial filesystem removal is *intentional*; it does not reproduce specific filesystem permission codes, antivirus behavior, power failures or arbitrary OS attacks. Only temporary test data are written or deleted.

The standard `tests/test_burn_download_quota.py` suite of 21 tests is rerun, unchanged.

## GitHub Actions evidence

[Run 42532959584](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42532959584) — **success on both Windows and Ubuntu, Python 3.12**.

| Suite | Ubuntu | Windows |
| --- | --- | --- |
| New real-app cleanup characterization | 5/5 pass | 5/5 pass |
| Existing Burn regressions | 21/21 pass | 21/21 pass |

**Preserved initial failure:** [Run 42532897752](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42532897752) failed a new test because it incorrectly expected an `expired` SQLite row to remain after cleanup with an artificially ancient year-2000 expiry. The application correctly prunes cleaned drops older than seven days. The assertion was fixed on the *test branch*, not in production code. This was a test expectation error, not evidence of an application bug.

## Conclusion and next decision gates

- The existing single-process cleanup and retry logic behaves consistently in these **five selected synthetic scenarios**, on both tested OSes. No specific upstream production bug is demonstrated by them.
- The 21 previously accepted regression tests still pass. Do not propose a new upstream PR based on these passing tests alone.
- Outstanding work: characterize explicit OS permission-denied conditions, unexpected `shutil.rmtree` exceptions (which the current implementation calls with `ignore_errors=True`), reparse-point attacks from noncooperating local writers, long deletion duration, and crash recovery under process/power loss.
- Review real upstream application state again before suggesting an improvement. Only a narrow, reproduced defect or a clear maintainer-approved coverage addition should become a new PR.
- Preserve all multi-process and HTTP-stream experiments as separate research artifacts; they do **not** replace the present single-process code or mandate a deployment redesign.
- The banner `Compare & pull request` that GitHub may show to contributors after pushing a fork branch is **not** an existing PR and creates no merge. No manual action is required.

**Decision:** Keep branch isolated, no modifications to `Frahane/NESS_SUITE:main`, and no upstream PR #3 at this point.
