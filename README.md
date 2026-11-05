# NESS Suite

## Multi-download follow-up

[Initial single-download PR text and opening link](docs/contributions/BURN_SINGLE_DOWNLOAD_PR.md). Upstream PR creation is pending.

This branch prepares the extension of the atomic claim to multi-download plans. [Requirements, regression cases and the final-session policy question](docs/contributions/BURN_MULTI_DOWNLOAD_PLAN.md) are recorded for review. The application currently includes the initial single-use correction described below.


## NESS Burn contribution

This branch proposes a focused change to single-use attachment downloads. If two requests reach the same drop at the same time, one SQLite update claims the download before the response is sent. The regression tests also cover retrying after a failed file read and cleaning up after a failed deletion.

[Upstream baseline `863e296`](https://github.com/Frahane/NESS_SUITE/commit/863e296604d3b95654b4c8bdf7af2bca4093b78b) · [Compare with the baseline](https://github.com/DeepKang-Labs/NESS_SUITE/compare/863e296604d3b95654b4c8bdf7af2bca4093b78b...contribution%2Fburn-single-download) · [Code](burn.py) · [Regression tests](tests/test_burn_single_download.py)

From the repository root, run the tests in a Python environment with the project dependencies installed.

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p test_burn_single_download.py -v
```

The three tests use a temporary SQLite database and a synthetic file. The project documentation follows below.

---

**PrivateNess Network · NESS Coin-Hours (NCH) · TempMail · Burn · Pay · Storage**

Single-process Python application that serves four related products on one payment rail, one SQLite database, and one design system:

| Product | Role |
|---------|------|
| **NESS TempMail** | Ephemeral inboxes; inbound SMTP; paid capacity by TTL / quota |
| **NESS Burn** | One-time encrypted content drops (journalism, whistleblowing, handoff) |
| **NESS Pay** (Invoice) | Payment links: invoice, coffee, fundraising — NCH to *your* address |
| **NESS Storage** | **Private** encrypted vault on this device — **not** for sharing (NESS Burn is for Sharing) |

Paid activations settle **on-chain**.

---

## Design principles

1. **Sovereign reception** — inbound SMTP is in-process (`aiosmtpd`). Unregistered recipients are dropped with `250` (no bounce, no enumeration, no backscatter).
2. **Pay for capacity, not identity** — graduated plans; settlement in NCH on PrivateNess / Fiber.
3. **Opaque tokens** — APIs use high-entropy `public_token` values, never sequential IDs.
4. **Cross-product anti-replay** — every spent `tx_hash` is claimed once in `used_transactions` via `_claim_tx` (mail, burn, invoice, storage).
5. **Payment intents** — before paying, the client obtains a short-lived secret `intent_id`. Verification requires both `tx_hash` **and** a valid pending intent (anti front-running). The intent id stays in the browser session; it is not a user-facing copy field.
6. **Fail closed on explorers** — if explorers are unreachable, verification returns an explicit offline / explorer-down error. Confirmations are never invented.
7. **Client-side vault** — drafts and Storage payloads are encrypted with **NessVault** (Web Crypto) before leaving the browser when applicable.
8. **Rate limits** — sensitive endpoints use **IP** buckets plus **global** service caps. Device ID is for **ownership**, not rate keys.

---

## Architecture

```text
  Browser ──► HTTP (Flask)
                │
                ├── app.py          TempMail + shared helpers (claim, rates, explorers)
                ├── burn.py         Burn routes (register)
                ├── invoice.py      Pay / Invoice routes (register)
                ├── storage.py      Private Storage routes (register)
                └── config.py       dotenv only — no business logic

  SMTP thread ──► aiosmtpd ──► messages table (registered mailboxes only)
  Cleanup thread ──► purge expired mail / burn / invoice / storage / intents
  SQLite (WAL) ──► single DB_PATH
  Explorers ──► NESS_EXPLORER_URLS (failover, cached probe)
```

### Frontend layout

```text
templates/     index.html | burn.html | invoice.html | storage.html
static/css/    app.css (design system) + product overrides
static/js/     ness-crypto.js → suite-nav.js → confirm-modal.js → product.js
```

Theme key is exactly **`ness_theme`** (`light` | `dark`) across all products.

---

## Products in brief

### TempMail

- Plans: Discovery (free) → Flash → Session → Day → Week → Month  
- Opaque mailbox token; message list + sandboxed reader; attachments gated by tier  
- **Renew** extends TTL: *time remaining + new plan duration*

### Burn

- Ephemeral **publish** of notes, files, voice (optional passphrase on higher tiers)  
- Limits: size, file count (`0` = unlimited), downloads, audio length  
- Public view/download; optional burn-after-download  
- **Not** a permanent archive — use Storage for private retention, Burn for handoff

### Pay (Invoice)

- Purposes: invoice, buy-me-coffee, fundraiser, other  
- Payee address is **the merchant’s** NESS address (not the suite treasury)  
- Manage token for cancel/rotate; unpaid caps per purpose on the server  
- Fiber has **no** payment memo field — do not expect on-chain memos

### Storage

- **Personal vault only** — ciphertext stored for the owning device; no share links  
- Client encrypts with NessVault before upload; server stores opaque blobs  
- Backend: `STORAGE_BACKEND=local` (default, destroy-on-expiry) or experimental `ipfs`  
- Free tier is **capped per device** (objects + cumulative bytes) even when plan `max_objects` is unlimited  
- Global disk hard cap: `STORAGE_HARD_DISK_CAP_MB`  
- **Renew** same rule as mail/burn: remaining + plan TTL  

---

## Plan tables (defaults — override via `.env`)

Amounts and limits are defined in `config.py` and are **environment-overridable**. Defaults below match the code at packaging time.

### TempMail (`TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Discovery | 0 | 5 min | 3 messages |
| Flash | 80 | 30 min | 12 messages |
| Session | 350 | 5 h | 50 messages · attach ≤ 2 MB |
| Day | 900 | 1 day | 150 messages · attach ≤ 10 MB |
| Week | 3200 | 7 days | 750 messages · attach ≤ 25 MB |
| Month | 9000 | 30 days | 3000 messages · attach ≤ 50 MB |

### Burn (`BURN_TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Spark | 0 | 15 min | 20 MB · 2 files · 1 download |
| Flash | 100 | 1 h | 100 MB · 5 files · 3 downloads |
| Session | 350 | 6 h | 500 MB · unlimited files · 15 downloads |
| Day | 1000 | 1 day | 2 GB · unlimited · 50 downloads |
| Week | 3500 | 7 days | 10 GB · unlimited · 200 downloads |
| Month | 10000 | 30 days | 50 GB · unlimited · 1000 downloads |

### Storage (`STORAGE_TIERS`)

| Plan | NCH | Lifetime | Capacity (defaults) |
|------|-----|----------|---------------------|
| Spark | 0 | 24 h | 100 MB (free device caps still apply) |
| Flash | 80 | 7 days | 5 GB |
| Short | 450 | 30 days | 20 GB |
| Medium | 1600 | 90 days | 100 GB |
| Long | 4800 | 365 days | 500 GB |

Free Storage additionally enforces per-device limits (`STORAGE_FREE_DEVICE_OBJECTS`, `STORAGE_FREE_DEVICE_MB`) to prevent disk abuse.

---

## Configuration

Copy `.env.example` → `.env`. **Never** commit a live treasury key or production address as a secret in git; `NCH_PAYMENT_ADDRESS` is the suite receive address for **TempMail / Burn / Storage** plans. Invoice payees use the address entered by the merchant.

Important variables:

| Variable | Role |
|----------|------|
| `NCH_PAYMENT_ADDRESS` | Treasury / plan settlement address |
| `NESS_EXPLORER_URLS` | Comma-separated explorer bases (failover) |
| `MAIL_DOMAIN` | Domain shown on generated addresses |
| `SMTP_PORT` / `SMTP_FALLBACK_PORT` | 25 then fallbacks (e.g. 2525 on non-root) |
| `DB_PATH` | SQLite file |
| `MAX_CONTENT_LENGTH_MB` | Flask body limit for a single request (default 2048 MB; not the same as tier quota) |
| `STORAGE_BACKEND` | `local` (recommended) or `ipfs` |
| `STORAGE_HARD_DISK_CAP_MB` | Global Storage disk ceiling |
| `STORAGE_PRICE_*` / `BURN_PRICE_*` / `STORAGE_MAX_MB_*` / TTLs | Plan economics |

See `.env.example` for the full list of plan price and capacity keys.

---

## Payment verification flow

1. Client selects a paid plan → `POST /api/payment/intent` with `product` + `plan`  
2. Server stores a pending **intent** (`intent_id`, catalog `amount_nch`, expiry)  
3. User sends **at least** that amount of NCH to the pay address  
4. Client submits `tx_hash` + session `intent_id` to the product verify/pay endpoint  
5. Server checks intent → explorers → `_tx_already_used` → **`_claim_tx`** → business insert  

Overpayment is accepted (`>=` required amount). Explorer failures distinguish **offline** (no network) vs **explorer_down** when possible.

Detailed notes: [`docs/PAYMENTS.md`](docs/PAYMENTS.md).

---

## Security (implemented)

- Opaque tokens; no sequential IDOR on mail/burn/storage/invoice  
- `_claim_tx` + `used_transactions` cross-product  
- Payment **intent_id** anti front-running  
- IP + global rate limits; unlock lockout (Burn)  
- CSP / nosniff / frame deny / referrer policy on responses  
- HTML sanitization for Burn notes (tags, `on*`, `javascript:`, `data:text/html`)  
- Passwords never in URL query strings (Burn: view_token after unlock)  
- Device ID header for ownership; anon fails closed on create/list where required  
- Storage free-tier and disk caps; cleanup of expired objects and stale intents  

---

## Run (development)

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set NCH_PAYMENT_ADDRESS, MAIL_DOMAIN, …
python app.py
```

UI: `http://127.0.0.1:5000/` · Burn `/burn` · Pay `/invoice` · Storage `/storage`

SMTP on non-root hosts typically binds **2525** (see startup logs). Internet MX still expects port **25** on a real VPS with DNS MX records.

### Local mail inject (paid/active address only)

```python
import smtplib
from email.mime.text import MIMEText

RECIPIENT = "your-active-address@yourdomain.com"
msg = MIMEText("Body")
msg["Subject"] = "Local test"
msg["From"] = "tester@example.org"
msg["To"] = RECIPIENT

with smtplib.SMTP("127.0.0.1", 2525, timeout=10) as s:
    s.sendmail(msg["From"], [RECIPIENT], msg.as_string())
```

---

## Dependencies

```text
flask>=3.0.0
aiosmtpd>=1.4.0
python-dotenv>=1.0.0
```

No frontend framework. Optional: explorer connectivity only (HTTPS outbound).

---

## Production checklist

- [ ] Real `NCH_PAYMENT_ADDRESS` (not a placeholder)  
- [ ] `MAIL_DOMAIN` + DNS **MX** / A for SMTP on port 25 (or 25→app reverse forward)  
- [ ] `FLASK_DEBUG` unset or false  
- [ ] Reverse proxy body size aligned with `MAX_CONTENT_LENGTH_MB`  
- [ ] Disk monitoring if Storage is enabled (`STORAGE_HARD_DISK_CAP_MB`)  
- [ ] Prefer `STORAGE_BACKEND=local` unless IPFS unpin/GC is operated deliberately  
- [ ] Backup policy for `DB_PATH` (tokens, invoices, audit)  

---

## Repository layout

```text
app.py              Orchestration, TempMail, shared payment/rate/explorer helpers
burn.py             Burn product
invoice.py          Pay / Invoice product
storage.py          Private Storage product
config.py           dotenv-backed settings and tier tables
templates/          HTML shells
static/css|js/      Design system + product scripts
docs/PAYMENTS.md    Payment integration notes
.env.example        Environment template
requirements.txt
```

---

## What this is not

- Not a full Skycoin node or wallet — verification is via public explorers  
- Not a shared cloud drive — **Storage is private to the device vault**; sharing is via **NESS Burn**  
- Not KYC’d virtual numbers or identity services  

NESS Suite is built to stay small, auditable, and honest about cryptography and chain settlement.

**Powered by PrivateNess Network**
