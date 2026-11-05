# NESS Burn multi-download follow-up

The initial single-use fix is proposed separately from this extension. This branch records the multi-download requirements for review. It adds documentation and keeps the initial implementation and its three regression tests as the starting point.

## Accounting contract

A successful claim consumes one unit of the drop's download quota. Files fetched within the same valid unlock session share that unit. For passwordless access, preserve the existing same-client coalescing window unless the maintainer chooses a different rule. This accounting concerns `download_count` and `max_downloads`.

Two independent sessions competing for the last available unit must produce one successful claim. A session must be marked charged only after its database claim has committed. A failed claim must not authorize a response body or cause later requests to bypass accounting.

## Implementation outline

- Replace the stale absolute assignment in `_charge_download_once` with an incremental conditional update.
- Preserve the existing conditions for an active, unexpired drop with quota available.
- Read the resulting counter within the same transaction before deciding whether the drop should burn. A subsequent SELECT avoids introducing a requirement for SQLite RETURNING support.
- Coordinate the session marker with the database commit. Requests sharing a session must not treat an in-flight or failed claim as successful.
- Keep file reads before the claim and preserve cleanup retry behavior from the single-use fix.
- Check already-charged requests against the drop's current availability rules.

The SQL claim should retain the following shape.

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
| M9 | A HEAD request reaches the file route | Check metadata behavior and ensure it does not consume quota |

Use temporary SQLite databases, synthetic files and controlled barriers to reproduce concurrent reads. The extension must preserve the original single-use regression cases. Capture Python and SQLite versions with the eventual results.

## Rule to confirm for the final session

A multi-file session may consume the final available unit before all of its files have been fetched. The current implementation destroys the drop on exhaustion, which can prevent later files in that session from being retrieved. Confirm whether that session must be allowed to finish or whether immediate destruction is the intended policy before changing cleanup behavior. The initial PR does not decide this policy.

## Status

The multi-download implementation and these additional regression cases have not been executed. The execution environment was unavailable during preparation of this follow-up. The initial single-use tests remain in `tests/test_burn_single_download.py`. They have now been rerun successfully in a fresh Linux environment. See [the validation record](BURN_SINGLE_DOWNLOAD_VALIDATION.md). The additional multi-download cases above remain pending.

Baseline for this branch is `08d13c6b7a8d952f6ecddc4ede39d7a1d9d234e7` in the contributor fork, based on upstream `863e296604d3b95654b4c8bdf7af2bca4093b78b`.
