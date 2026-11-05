# Initial Burn pull request preparation

**Status — prepared in the contributor fork. The upstream PR has not been created.**

The GitHub integration returned HTTP 403, `Resource not accessible by integration`, on the upstream create-PR action. The fork and contribution branch remain available. The comparison below can be opened with the contributor's GitHub account.

[Open the upstream comparison and pull-request form](https://github.com/Frahane/NESS_SUITE/compare/main...DeepKang-Labs:contribution/burn-single-download?expand=1)

- Base repository and branch are `Frahane/NESS_SUITE`, `main`.
- Head repository and branch are `DeepKang-Labs/NESS_SUITE`, `contribution/burn-single-download`.
- Reviewed head is `08d13c6b7a8d952f6ecddc4ede39d7a1d9d234e7`.
- Prepare this as a draft for upstream review. A fresh Linux execution of the three tests is recorded in [BURN_SINGLE_DOWNLOAD_VALIDATION.md](BURN_SINGLE_DOWNLOAD_VALIDATION.md).

## Title

Burn: claim single-use attachment downloads atomically

## Description

Two concurrent attachment requests can both read an active single-use drop before either updates the counter. This change claims the download with a conditional SQLite update before returning the response. One request wins and the other receives 410.

The file is read before the claim so a failed read leaves access available. Cleanup retains the information needed to retry deletion while the drop remains closed.

Three regression cases are included in `tests/test_burn_single_download.py` for concurrent requests, failed reads and cleanup retries. They use a temporary SQLite database and a synthetic file. All three pass on a fresh Linux checkout with Python 3.12.14, SQLite 3.53.1 and Flask 3.1.3. [Validation record](https://github.com/DeepKang-Labs/NESS_SUITE/blob/contribution/burn-multi-download/docs/contributions/BURN_SINGLE_DOWNLOAD_VALIDATION.md).

The diff is limited to `burn.py`, the regression tests and the README, based on upstream `863e296604d3b95654b4c8bdf7af2bca4093b78b`.

The requested multi-download extension is tracked separately. It must preserve one quota charge per session and extend the conditional update to independent sessions competing for quota. [Follow-up requirements and regression cases](https://github.com/DeepKang-Labs/NESS_SUITE/blob/contribution/burn-multi-download/docs/contributions/BURN_MULTI_DOWNLOAD_PLAN.md).
