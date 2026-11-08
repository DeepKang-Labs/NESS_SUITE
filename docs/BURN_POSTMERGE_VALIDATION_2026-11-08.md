# Burn post-merge regression validation — 2026-11-08

## Scope

Upstream: [Frahane/NESS_SUITE](https://github.com/Frahane/NESS_SUITE).
Accepted contribution: [PR #1](https://github.com/Frahane/NESS_SUITE/pull/1), merged on 2026-11-08 at 09:34:22 UTC.

The upstream follow-up commit `2142882b7e9387daf40b988ecfc7cc1a524ab135` removed the finishing-session guard from `cleanup_burn_expired()`.

## Actual GitHub Actions evidence

| Revision | Run | Result |
| --- | --- | --- |
| Unchanged upstream `2142882` | [42490023542](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42490023542) | 21 tests, 1 failure: `test_last_unit_session_finishes_multi_file_pack`, line 215 |
| Patch `ae4122e` based on upstream | [42489991881](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42489991881) | 21/21 tests pass |

Both runs: Python 3.12 / GitHub-hosted Ubuntu; `python -m unittest discover -s tests -p 'test_burn_download_quota.py' -v`; standard `requirements.txt`. Neither run changes the original tests.

## Patch

Branch: [fix/burn-retain-finishing-session-postmerge](https://github.com/DeepKang-Labs/NESS_SUITE/tree/fix/burn-retain-finishing-session-postmerge).

Commit: `ae4122ed5db5458eb93eb98b4c6aa91dc5542c52`.

Single file changed: `burn.py` (+13 lines). Restores an expiry-bounded, in-process check to prevent immediate cleanup of the multi-file pack while its last authorized downloading session is active.

The workflow replay branches `ci/burn-postmerge-regression-check` and `ci/burn-upstream-baseline-20261108` are not part of the fix PR diff.

## Unresolved caveats

- In-memory `_VIEW_SESSIONS` is process-local. This fix does not prove safe cross-worker cleanup.
- A full interleaving / race-condition matrix was not run. No live production test is claimed.
- Ask Frahane if preserving the last authorized pack session remains intended policy before upstream merge.

## Upstream PR preparation

Proposed title: **fix(burn): preserve the final pack session during cleanup**

Suggested PR body:

> The latest upstream commit `2142882` deletes remaining files in a quota-closed multi-file Burn pack even while an active session is authorized to finish. The existing unchanged regression test fails on upstream (20/21 pass) but passes on this minimal `burn.py` fix (21/21 pass). See the linked GitHub Actions run logs for both baseline and patched runs. This restores the established single-process behavior; cross-worker correctness is not claimed. Please confirm that final-session retention remains the intended policy.

Submission is **not complete**: the GitHub connector returned HTTP 403 when creating an upstream draft PR. The fork has Issues disabled (HTTP 410). Human manual PR creation is required unless permissions change.
