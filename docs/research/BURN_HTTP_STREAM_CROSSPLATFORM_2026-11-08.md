# Burn HTTP streaming research — Linux/Windows cross-process evidence (2026-11-08)

**Status: tested isolated HTTP prototype; NOT integrated into NESS Burn.**

## Motivation and scope correction

At upstream `Frahane/NESS_SUITE` after merged PRs [#1](https://github.com/Frahane/NESS_SUITE/pull/1) and [#2](https://github.com/Frahane/NESS_SUITE/pull/2), `burn.py` still uses `data = path.read_bytes()` before constructing a Flask `Response(data, ...)`. **This reads the whole disk file before constructing a response.** It is not a generator that reads file chunks from disk while the network stream runs.

Consequently the following experiments demonstrate a **possible future streaming design**, NOT an existing live-stream bug in Frahane's application. They do not demonstrate a production security fix.

## New separate research branch

[DeepKang-Labs/NESS_SUITE — research/burn-http-stream-crossplatform-20261108](https://github.com/DeepKang-Labs/NESS_SUITE/tree/research/burn-http-stream-crossplatform-20261108)

New files:
- `research/burn_http_stream_research.py` — actual HTTP/1.1 chunked loopback server, a second OS process for cleanup, a marked temporary sandbox, and the previous shared SQLite model.
- `tests/test_burn_http_stream_crossplatform.py` — four distinct streaming scenarios.
- `.github/workflows/burn-http-stream-crossplatform.yml` — native Windows and Linux matrix, plus the unchanged app regression suite on Linux.
- `.github/workflows/burn-existing-windows-regression.yml` — an independent run of the unchanged app regression suite on Windows.

**Evidence:**
- [GitHub Actions run 42515894448](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42515894448): `loopback-streaming` passed on GitHub-hosted **Ubuntu** and **Windows**, four streaming tests per OS; unchanged Burn regression suite 21/21 passed on Ubuntu.
- [GitHub Actions run 42515983070](https://github.com/DeepKang-Labs/NESS_SUITE/actions/runs/42515983070): unchanged Burn regression suite 21/21 passed on Windows / Python 3.12.

All tests are synthetic, with `TemporaryDirectory` and a required `.burn_research_sandbox_only` marker. They do not use any real user files, production access tokens or internet-facing services. The HTTP server binds to **127.0.0.1** only.

## Streaming lifecycle under test

1. A drop and high-entropy session are created in the isolated shared SQLite model. Quota closure and a finishing authorization are committed together.
2. A separate OS process starts a real loopback HTTP/1.1 server. Client provides its synthetic token via `X-Research-Session` header, never in the URL.
3. The server atomically registers a short, durable `research_transfer_pins` lease **before opening the file**.
4. The server emits HTTP chunk framing and **only 256 bytes at first**, then blocks on an explicit test-controlled barrier, leaving the original file handle open.
5. A **different Python process** attempts cleanup through SQLite. The first attempt fails while the transfer pin remains valid—even if the finishing-session expiry has been shortened in the database.
6. If the client releases the barrier before the pin deadline, the server sends the remaining chunks, closes the file handle, marks the transfer finished, then sends HTTP's terminating zero-length chunk. The other process can subsequently delete the marked temporary pack.
7. If the transfer lease expires, the server refuses to continue, closes its file handle and closes the HTTP connection **without** emitting the terminating chunk. The client therefore observes an incomplete body, not a falsely successful full download. The separate cleanup process can reclaim expired protection.
8. A forced OS-process kill during a stalled transfer leaves a bounded SQLite pin. Another cleaner can delete after the deadline.

## Four reproducible scenarios

| Scenario | What is established in this prototype |
| --- | --- |
| Valid HTTP stream vs independent cleaner | Valid pin prevents deletion while the client receives only an initial chunk. Following normal completion and session expiry, cleanup succeeds |
| Pin expires mid-response | Incomplete HTTP body is visible to the client, then cleanup succeeds; no successful full-body claim |
| Forged session token | Server returns HTTP 403 before streaming body |
| Stream worker killed after initial bytes | Durable pin remains bounded and a separate cleaner eventually reclaims |

All four passed on Windows and Ubuntu with Python 3.12.

## Architecture distinction and limits

The prior Linux `fcntl.flock` deletion-worker experiment and this cross-platform HTTP experiment solve **different subproblems**:

- The SQLite **transfer pin** prevents compliant cleanup from starting while a live per-transfer lease exists. The logic is portable across the tested local Windows and Linux setups.
- The Linux `flock` prototype serializes cooperating cleanup workers to keep a stale cleaner from issuing filesystem mutations after another cleaner reclaims the deletion slot.
- **This HTTP harness does not include a cross-platform equivalent of the `flock` stale-worker filesystem fence.** Its SQLite cleanup claim and OS `rmtree` are still separate operations. The HTTP experiment is NOT evidence that Windows deletion ownership has been made fully safe.

Important remaining questions:
- The HTTP client may stop reading even if the server successfully writes and closes the response; remote receipt/acknowledgment is not proven by successful server-side sends.
- No real-world network latency, TLS, reverse proxy buffering, large files, production rate limits, leaked headers or authentication policy are exercised.
- Unexpected crashes while a cleanup worker is actively deleting files are not resolved by this portable stream prototype; retain the POSIX-only staging experiments as separate evidence.
- SQLite durability is local and does not guarantee behavior for network-backed database/filesystem mounts or multiple hosts.
- Existing Flask Burn routes, their `read_bytes` behavior, the 21 regression tests and upstream code remain unchanged. We have not replaced the route with this experiment.
- A real streaming implementation must define exact semantics for a request already started before the drop's expiry, pin renewal, client cancellation, and whether partial receipt counts toward the quota.
- The current model's injected/testing clock in earlier exercises is NOT a production clock; this new HTTP harness uses real wall-clock deadlines but is still a bounded synthetic CI test, not a formal timing proof.

## Decision register

- **Demonstrated:** Four synthetic real-HTTP stream-vs-cleanup tests pass independently on native GitHub-hosted Windows and Ubuntu.
- **Demonstrated:** Existing 21 tests for the unchanged application pass on both GitHub-hosted systems.
- **Not demonstrated:** Cross-platform full filesystem deletion fencing, drop-in production streaming implementation, multiple hosts, or real-world guarantees to remote clients.
- **Preserve:** Upstream PRs #1 and #2 are merged; no changes are proposed to official `main`.
- **Next highest-priority experiment:** A Windows-compatible cleanup critical section that prevents a paused, stale OS process from unlinking files after lease reassignment; independently verify a cross-platform reader/cancellation policy and crash recovery before any integration proposal.
- **No upstream PR:** This branch is scientific evidence, not a deployable patch.
