# NESS Burn single-download validation

**5 November 2026 · fresh Linux checkout**

The three existing single-download regression tests pass at commit `08d13c6b7a8d952f6ecddc4ede39d7a1d9d234e7`.

| Environment | Version |
| --- | --- |
| Platform | Linux x86-64 |
| Python | 3.12.14 |
| SQLite | 3.53.1 |
| Flask | 3.1.3 |
| Werkzeug | 3.1.9 |

Dependencies were installed from the repository's `requirements.txt` in a new virtual environment. The tests use a temporary SQLite database and a synthetic report file.

```sh
python -m unittest discover -s tests -p test_burn_single_download.py -v
```

```text
test_failed_read_leaves_download_available ... ok
test_failed_removal_is_retried_without_reopening_access ... ok
test_only_one_concurrent_request_receives_the_file ... ok

Ran 3 tests in 0.210s
OK
```

The concurrent case forces both requests past the file checks and file reads before allowing them to claim the drop. It expects one HTTP 200 response and one HTTP 410 response.

## Source checksums

```text
e35bc97da7766cccc4710b372f6fd18fc04f6a6369125c8333e19c5546decd95  burn.py
6246b9fcbef5f71aa0ee187f6fa2e3713e211fbf525cb7403a4185595c0972d0  tests/test_burn_single_download.py
03c9a30ead12b460c84569436ebef02d70d197130f95c9d8717122ae2fff2553  requirements.txt
```

This result covers the current single-download change. The multi-download implementation and its planned additional tests are still pending.

Upstream PR creation was retried on the same date and the integration returned HTTP 403, `Resource not accessible by integration`. The prepared opening link and description remain in [BURN_SINGLE_DOWNLOAD_PR.md](BURN_SINGLE_DOWNLOAD_PR.md).
