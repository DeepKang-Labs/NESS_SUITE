# NESS Suite — NCH Payment Implementation Guide

This document describes **exactly how NESS Suite verifies plan payments (TempMail, Burn, Storage) today**, what the code does on-chain, and what would be required to move from a **single treasury address** to **unique per-payment addresses derived from an xpub**.

Audience: engineers integrating or extending PrivateNess / Fiber / NCH settlement.

Language of the product and this document: **English**.

---

## 1. What is being paid

| Concept | Meaning in this system |
|--------|-------------------------|
| **Coin** | PrivateNess / Fiber family (Skycoin-compatible chain layout) |
| **NCH** | **Coin hours** (time-backed secondary unit), not the base coin balance |
| **Settlement** | User sends a transaction that credits **hours** to a configured treasury address |
| **Price** | Integer NCH amounts defined **only on the server** in `config.py` (`TIERS[*].price_nch`) |

The client never decides the amount. The API reads `plan` and looks up `TIERS[plan]["price_nch"]`.

Current default catalogue (overridable via env):

| Plan ID | Label | Price (NCH) |
|---------|--------|-------------|
| `flash` | Flash | 80 |
| `session` | Session | 350 |
| `day` | Day | 900 |
| `week` | Week | 3 200 |
| `month` | Month | 9 000 |

Free plan (`free` / Discovery) never hits the payment path.

---

## 2. Architecture (current production model)

```text
  Wallet (user)                    NESS TempMail                     Explorer API
       │                                 │                                 │
       │  1. Send NCH hours              │                                 │
       │     to NCH_PAYMENT_ADDRESS      │                                 │
       │ ────────────────────────────────┼────────────────────────────────►│
       │                                 │                                 │
       │  2. Paste txid in UI            │                                 │
       │ ───────────────────────────────►│  3. GET /api/transaction?txid=  │
       │                                 │ ───────────────────────────────►│
       │                                 │ ◄──────────── JSON ─────────────│
       │                                 │  4. Validate hours → address    │
       │                                 │  5. Create/upgrade mailbox      │
       │ ◄──── token + address ──────────│  6. UNIQUE txid anti-replay     │
```

### 2.1 Single treasury address

Configuration (`config.py` / `.env`):

```bash
NCH_PAYMENT_ADDRESS=NESS1...   # one shared receive address for all customers
```

Every paid activation credits **this same address**. Correlation of payer → product is done via:

1. **Transaction hash** (unique, stored in `subscriptions.transaction_hash`)
2. Optional **mailbox token** (upgrade path when the client already has a Discovery mailbox)

There is **no** per-invoice address in the current codebase.

### 2.2 Explorer list

```bash
NESS_EXPLORER_URLS=https://ness-explorer.magnetosphere.net,https://explorer.privateness.network
```

The code walks the list in order (`_explorer_get` in `app.py`):

- Prefer first base that returns **HTTP 200 + valid JSON**
- On **404**, try the next mirror (indexing lag), then fail with “Transaction not found”
- On network / non-JSON / other errors, try the next mirror
- If **all** bases fail without a definitive 404 → `ExplorerUnavailable` → HTTP **503**  
  **There is no simulated success.**

---

## 3. Explorer reality check (verified)

Probed from a live environment (2026-10-31):

| Base URL | `/api/health` | Usable as JSON API for this app? |
|----------|---------------|----------------------------------|
| `https://ness-explorer.magnetosphere.net` | **200** application/json, blockchain head + fiber metadata | **Yes — primary** |
| `https://explorer.privateness.network` | **200** but **HTML** SPA shell (not JSON) | **No — not a working API fallback today** |

Implications:

- Failover is **implemented in code**, but the second URL **does not currently expose** the same `/api/*` JSON surface.
- If magnetosphere is down, payment verification will correctly return **503 / explorer is down**, not a fake confirmation.
- Operators should treat `explorer.privateness.network` as a **placeholder** until a second host serves Skycoin-compatible explorer JSON (or remove it from `NESS_EXPLORER_URLS` to avoid wasted timeouts).

Primary health payload shape (relevant fields):

```json
{
  "blockchain": { "head": { "seq": 2515, "block_hash": "...", "timestamp": ... } },
  "fiber": { "name": "...", "coin_hours_ticker": "NCH" },
  "coin": "ness"
}
```

Transaction fetch used by verification:

```http
GET {explorer}/api/transaction?txid={hex}
Accept: application/json
```

---

## 4. Verification rules (authoritative)

Implemented in `verify_nch_payment_on_chain()`:

1. **Txid format** — normalized lowercase hex; reject implausible lengths early.
2. **Fetch** — `fetch_transaction(txid)` via `_explorer_get`.
3. **Confirmed** — transaction must be in a confirmed state (unconfirmed → reject).
4. **Confirmations (optional)** — if `PAYMENT_MIN_CONFIRMATIONS > 0`, require height/depth.
5. **Freshness (optional)** — if a timestamp is present and older than `PAYMENT_TX_MAX_AGE_SEC` (default 7 days), reject.
6. **Outputs** — parse outputs; sum **`hours`** (coin hours / NCH) where `dst` equals `NCH_PAYMENT_ADDRESS`.
7. **Amount** — `matched_hours >= TIERS[plan].price_nch`.
8. **Anti-replay** — insert into `subscriptions` with **UNIQUE** `transaction_hash`; second use → **409**.

Failure modes returned to the client:

| Situation | HTTP | Notes |
|-----------|------|--------|
| Bad plan / free plan | 400 | |
| Malformed txid | 400 | |
| Rate limit | 429 | Composite IP + Device-ID |
| Address taken (custom full) before chain | 409 | Pre-check — user not charged |
| Explorer all down / non-JSON | 503 | `explorer_ok: false` |
| Tx not found | 404 | After all mirrors |
| Insufficient hours / wrong address / unconfirmed | 402/400 | On-chain reject |
| Replay | 409 | |
| Paid but mailbox allocation failed | 500 | Logged `[PAY] CRITICAL` + txid |

### 4.1 Pre-chain guards (commercial safety)

Before calling the explorer:

- Reject if `transaction_hash` already in `subscriptions`.
- If creating a **new** mailbox with **full** custom local-part, reject if address already exists (**409**).

After a successful on-chain result:

- Retry address allocation up to 5 times on `IntegrityError`.
- On persistent failure → **500** with txid for manual recovery (not silent loss without a log).

### 4.2 Upgrades

If the client sends an existing mailbox `token`:

- Load mailbox by **public_token** (opaque).
- **Refuse downgrade** if the paid plan’s `price_nch` is lower than the current plan’s price.
- Else update `plan`, `expires_at`, `max_messages`.

---

## 5. Database tables involved

| Table | Role |
|-------|------|
| `mailboxes` | Address, plan, expiry, `public_token`, capacity |
| `subscriptions` | One row per successful payment; **UNIQUE** `transaction_hash` |
| `payment_intents` | Audit trail (`INSERT OR IGNORE`); purged after 90 days |

Mailbox public API uses `public_token` only — never sequential integer IDs.

---

## 6. Client flow (UI)

1. User selects a paid plan → modal shows **`NCH_PAYMENT_ADDRESS`** and exact NCH amount.
2. User pays from any compatible wallet (PrivateNess Network / Fiber).
3. User pastes **transaction hash** → `POST /api/payment/verify` with `plan`, `tx_hash`, optional `token`, optional `custom_local`, and `X-Device-Id`.
4. On success, UI stores `token` + address in `localStorage` and starts inbox polling.

QR and copy helpers are UX only; they do not change verification rules.

---

## 7. Unique payment addresses (xpub) — requirements vs current state

Moses (Skycoin / Skywire) outlined a modern approach:

- Derive receive addresses from an **xpub** (account-level public extended key).
- Prefer empty addresses (gap-limit scan) for each payment request.
- Optionally watch the chain from the client or a thin watcher over **dmsg** without running a full visor on the phone.

### 7.1 What we have today

| Capability | Status |
|------------|--------|
| Single treasury `NCH_PAYMENT_ADDRESS` | **Implemented** |
| On-chain hours verification via explorer JSON | **Implemented** |
| Multi-URL explorer walk | **Implemented** (effective only if URL returns JSON) |
| Per-payment unique address | **Not implemented** |
| xpub derivation in server or browser | **Not implemented** |
| dmsg / thin client wallet bridge | **Not implemented** |
| HD gap-limit tracking + address pool table | **Not implemented** |

### 7.2 What you need before enabling unique addresses

1. **Treasury xpub** (or a dedicated payment account xpub) — never the xprv on the app server if it can be avoided; prefer watch-only derivation.
2. **Derivation library** compatible with Skycoin/Fiber address format (not Bitcoin BIP84 by default — use the chain’s own HD rules / library, e.g. Skycoin crypto packages or a well-reviewed WASM/JS port).
3. **Address inventory** in SQLite, for example:
   - `payment_addresses(address UNIQUE, derivation_index, status, intent_id, created_at)`
   - statuses: `available` → `reserved` → `paid` / `expired`
4. **Reserve → pay → confirm** workflow:
   - On “Pay for plan X”, allocate next unused derived address, bind to `payment_intents`.
   - Verify tx **hours to that specific address** (not only the global treasury constant).
   - Mark address `paid` and never reuse (or reuse only after strict policy).
5. **Gap limit policy** — how many reserved-but-unpaid addresses may exist; expiry of reservations (e.g. 30–60 minutes) so the pool does not stall.
6. **Explorer (or node) that can**:
   - resolve tx by id (already used), and ideally
   - query address balance / recent txs for watchers (`/api/balance`, address txs — confirm paths on your explorer build).
7. **Operational ownership** of the corresponding private keys offline (hardware / cold) for sweeping NCH from many derived addresses back to cold storage.

### 7.3 Are we in a position to ship xpub unique addresses now?

**Not yet — not with the current repo alone.**

Conditions **met**:

- Stable on-chain verification of **hours** to a known address
- Anti-replay by txid
- Intent/audit tables that can be extended
- Product need for privacy (shared address leaks less structure than open indexes, but unique addresses are still better for accounting)

Conditions **not met**:

- No xpub in configuration
- No derivation + gap-limit module
- No per-intent address binding in verify path
- Fallback explorer JSON API not actually available
- No automated sweep / ops runbook for many hot receive addresses

**Recommended sequence:**

1. Keep single-address settlement for production MVP (current code).
2. Stand up a **second real JSON explorer** (or point `NESS_EXPLORER_URLS` only at magnetosphere until then).
3. Add `PAYMENT_XPUB` + derivation service behind a feature flag.
4. Switch verify to `expected_address = intent.reserved_address`.
5. Only then expose unique addresses in the UI.

---

## 8. Local development notes

- Verification always hits **real** explorers. There is **no** `DEV_BYPASS_PAYMENT` in this tree.
- To test activation you must send **real NCH** (or use a test treasury you control) and a real txid.
- SMTP reception testing is independent of payment (direct `smtplib` to the local port).

Environment variables (payment-related):

```bash
NCH_PAYMENT_ADDRESS=...
NESS_EXPLORER_URLS=https://ness-explorer.magnetosphere.net
PAYMENT_TX_MAX_AGE_SEC=604800
PAYMENT_MIN_CONFIRMATIONS=0
EXPLORER_TIMEOUT_SEC=12
PRICE_FLASH_NCH=80
PRICE_SESSION_NCH=350
PRICE_DAY_NCH=900
PRICE_WEEK_NCH=3200
PRICE_MONTH_NCH=9000
```

---

## 9. Security properties (payment path)

- Server-side prices only
- Opaque mailbox tokens (no IDOR via sequential ids)
- UNIQUE txid anti-replay
- Rate limit on verify: IP + Device-ID
- No trust in client-supplied “amount received”
- Explorer failure → hard fail (503), never soft-success
- Downgrade of an active higher plan via a cheaper payment is rejected

Remaining product/ops risks:

- Shared treasury address reduces invoice-level privacy and complicates support matching without txid
- Single working explorer = availability risk until a true JSON mirror exists
- Manual recovery path if allocation fails after payment (`[PAY] CRITICAL` logs)

---

## 10. File map

| File | Payment-related responsibility |
|------|--------------------------------|
| `config.py` | `NCH_PAYMENT_ADDRESS`, explorer URLs, tier prices |
| `app.py` | `_explorer_get`, `probe_explorer`, `verify_nch_payment_on_chain`, `/api/payment/verify` |
| `static/js/app.js` | Pay modal, copy/QR, submit tx hash |
| `templates/index.html` | Bootstrap injects `PAY_ADDRESS` + `TIERS` |

---

## 11. Summary for implementers

**Today:** one treasury address, NCH (coin hours) verified on-chain through PrivateNess explorer JSON, unique txid, graduated plans, no payment simulation.

**Fallback explorer URL:** listed for resilience; **as of the last probe it serves HTML only** and does not participate usefully in verification.

**Unique xpub addresses:** architecturally desirable; **not present** in this codebase; requires HD derivation, address pool state, intent binding, and ops for key management before it is production-safe.

---

*Document aligned with the NESS Suite multi-file tree. If code and this guide diverge, trust the code paths named above and update this file in the same change set.*
