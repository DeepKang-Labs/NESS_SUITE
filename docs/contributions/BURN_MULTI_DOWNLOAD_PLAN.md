# NESS Burn multi-download follow-up

The initial single-use fix is proposed separately from this extension. This branch implements the multi-download quota extension and retains the initial single-use correction. The implementation and its eighteen regression cases are ready for review.

## Accounting contract

A successful claim consumes one unit of the drop's download quota. Files fetched within the same valid unlock session share that unit. For passwordless access, preserve the existing same-client coalescing window unless the maintainer chooses a different rule. This accounting concerns `download_count` and `max_downloads`.

Two independent sessions competing for the last available unit must produce one successful claim. A session must be marked charged only after its database claim has committed. A failed claim must not authorize a response body or cause later requests to bypass accounting.

## Implemented changes

- New claims use an incremental conditional update in `_charge_download_once`.
- The claim requires an active, unexpired drop with quota available.
- The resulting counter is read within the transaction before deciding whether the drop should burn. This uses a subsequent SELECT and supports SQLite versions without RETURNING.
- The session marker is published after commit while holding the session lock.
- File reads precede the claim and cleanup retains the existing retry behavior.
- Already-charged requests recheck the drop's availability before delivery.
- An exhausted drop is marked burned within the claim transaction, preserving file metadata until cleanup succeeds.

The SQL claim retains the following shape.

```sql
UPDATE burn_drops
SET download_count = download_count + 1
WHERE id = ?
  AND status = 'active'
  AND download_count < max_downloads
  AND julianday(expires_at) > julianday('now')
```

A row count of zero must prevent delivery for a request requiring a new claim. The actual returned counter must come from the database, not the row read before file I/O.

## Required regression cases

| Case | Trigger | Expected result |
| --- | --- | --- |
| M1 | One unlock session fetches two different files while quota remains | Both files are returned and the counter increases once |
| M2 | Two simultaneous requests share an unlock session | One quota charge and no early use of an uncommitted marker |
| M3 | Two independent sessions start from the same counter | Two successful claims increase the counter by two when capacity permits |
| M4 | Two independent sessions compete for the final unit | One successful response, one refusal, and the counter never exceeds the limit |
| M5 | Expiry or status changes after file read and before claim | The conditional claim refuses delivery |
| M6 | A file read fails before the claim | The counter and session charge marker remain available for a valid retry |
| M7 | The claim fails or its transaction rolls back | No successful delivery and no permanently charged session marker |
| M8 | Passwordless requests share a client key and time window | Existing coalescing behavior is preserved |
| M9, separate follow-up | A HEAD request reaches the file route | Metadata behavior remains to be corrected and tested separately |

The tests use temporary SQLite databases, synthetic files and controlled barriers to reproduce concurrent reads. They include the original three single-use regression cases and cover M1 through M8, including rollback and interrupted-cleanup cases. [Validation results and versions](BURN_MULTI_DOWNLOAD_VALIDATION.md).

## Rule to confirm for the final session

A multi-file session may consume the final available unit before all of its files have been fetched. The current implementation destroys the drop on exhaustion, which can prevent later files in that session from being retrieved. Confirm whether that session must be allowed to finish or whether immediate destruction is the intended policy before changing cleanup behavior. This proposal preserves immediate destruction on exhaustion. Allowing the final session to finish all files would require a separate lifecycle decision.

## Status

The corrected application passes eighteen tests on Linux. With the same eighteen cases, the pre-extension application has nine expected failures and nine passes. The initial single-download contribution remains on its separate branch. The multi-file final-session policy and HEAD metadata follow-up remain open.

Baseline for this branch is `08d13c6b7a8d952f6ecddc4ede39d7a1d9d234e7` in the contributor fork, based on upstream `863e296604d3b95654b4c8bdf7af2bca4093b78b`.
