# NESS Burn multi-download validation

**5 November 2026 · Linux x86-64 · Python 3.12.14**

The multi-download proposal passes eighteen regression tests, including the three existing single-use cases. The same suite against pre-extension application code produces nine expected failures and nine passes.

| Component | Version |
| --- | --- |
| Python | 3.12.14 |
| SQLite | 3.53.1 |
| Flask | 3.1.3 |
| Werkzeug | 3.1.9 |

The source baseline for this extension is contributor commit `9f9b31087e514c7635ecbf6dc41d934d34659087`. Its application code already contains the initial single-use correction. All quotas and files in these tests are synthetic. Multi-download capacity is represented by rows in a temporary SQLite database, using the existing Flask download routes and the actual accounting helper.

## Reproduction

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p test_burn_single_download.py -v
```

Concurrent cases use barriers after reading the file, so both requests reach the claim with an earlier database snapshot. The failure cases exercise rollback and inspect the session marker at commit time. The final-claim case verifies that a burned row can be recovered by the existing cleanup after an interruption before filesystem deletion.

## Observed output

```text
test_already_charged_session_rechecks_availability_after_file_read (test_burn_single_download.BurnSingleDownloadTests.test_already_charged_session_rechecks_availability_after_file_read) ... ok
test_exhaustion_preserves_current_immediate_destruction_policy (test_burn_single_download.BurnSingleDownloadTests.test_exhaustion_preserves_current_immediate_destruction_policy) ... ok
test_expiry_after_file_read_prevents_a_new_claim (test_burn_single_download.BurnSingleDownloadTests.test_expiry_after_file_read_prevents_a_new_claim) ... ok
test_failed_commit_rolls_back_before_marking_a_session_charged (test_burn_single_download.BurnSingleDownloadTests.test_failed_commit_rolls_back_before_marking_a_session_charged) ... ok
test_failed_multi_file_read_does_not_charge_the_session (test_burn_single_download.BurnSingleDownloadTests.test_failed_multi_file_read_does_not_charge_the_session) ... ok
test_failed_passwordless_commit_does_not_publish_a_charged_marker (test_burn_single_download.BurnSingleDownloadTests.test_failed_passwordless_commit_does_not_publish_a_charged_marker) ... ok
test_failed_read_leaves_download_available (test_burn_single_download.BurnSingleDownloadTests.test_failed_read_leaves_download_available) ... ok
test_failed_removal_is_retried_without_reopening_access (test_burn_single_download.BurnSingleDownloadTests.test_failed_removal_is_retried_without_reopening_access) ... ok
test_independent_sessions_cannot_both_claim_the_last_unit (test_burn_single_download.BurnSingleDownloadTests.test_independent_sessions_cannot_both_claim_the_last_unit) ... ok
test_independent_sessions_increment_from_the_current_database_value (test_burn_single_download.BurnSingleDownloadTests.test_independent_sessions_increment_from_the_current_database_value) ... ok
test_last_claim_is_closed_before_filesystem_cleanup (test_burn_single_download.BurnSingleDownloadTests.test_last_claim_is_closed_before_filesystem_cleanup) ... ok
test_only_one_concurrent_request_receives_the_file (test_burn_single_download.BurnSingleDownloadTests.test_only_one_concurrent_request_receives_the_file) ... ok
test_parallel_files_in_one_session_consume_one_unit (test_burn_single_download.BurnSingleDownloadTests.test_parallel_files_in_one_session_consume_one_unit) ... ok
test_passwordless_client_bursts_keep_the_existing_coalescing_rule (test_burn_single_download.BurnSingleDownloadTests.test_passwordless_client_bursts_keep_the_existing_coalescing_rule) ... ok
test_passwordless_window_can_charge_again_after_expiry (test_burn_single_download.BurnSingleDownloadTests.test_passwordless_window_can_charge_again_after_expiry) ... ok
test_rejected_claim_keeps_the_session_uncharged (test_burn_single_download.BurnSingleDownloadTests.test_rejected_claim_keeps_the_session_uncharged) ... ok
test_status_change_after_file_read_prevents_a_new_claim (test_burn_single_download.BurnSingleDownloadTests.test_status_change_after_file_read_prevents_a_new_claim) ... ok
test_two_distinct_files_in_one_session_consume_one_unit (test_burn_single_download.BurnSingleDownloadTests.test_two_distinct_files_in_one_session_consume_one_unit) ... ok

----------------------------------------------------------------------
Ran 18 tests in 0.330s

OK
```

## Corrected source SHA-256

```text
e9dc59e4ac7d56e63133d16476cb6fce47f8f13bfa3affe8bc0b089d55d732ce  burn.py
adc025644b37f4bdcedf5ffd7a3efd5547d3a71a4739a84c2ada8caad96fbc69  tests/test_burn_single_download.py
```

## Scope for review

The session lock covers the database claim and commit. A successful transaction increments the current database counter. On the last unit it also marks the drop burned, while retaining the file list for cleanup. Only then is a session marker published. Requests in a charged session recheck availability before receiving an already-read file.

The existing passwordless two-minute client window is retained. The existing single-process session architecture is assumed. This is a Linux/Flask validation. Windows and fallback-server validation remain pending. The HEAD metadata case is a separate follow-up.

The existing immediate-destruction policy on quota exhaustion is preserved. Whether the last session should finish all files before destruction remains a question for the maintainer. [Accounting contract and remaining policy question](BURN_MULTI_DOWNLOAD_PLAN.md).
