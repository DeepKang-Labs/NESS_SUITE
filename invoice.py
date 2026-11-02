"""
NESS Invoice — ephemeral NCH invoices (no on-chain memo required).

Payment identification on NESS / Skycoin Fiber (no memo field):
  1. Exact destination address (merchant pay-to)
  2. Minimum NCH (coin-hours) amount on outputs to that address
  3. Transaction hash submitted by the payer (anti-replay via UNIQUE)

Never rely on OP_RETURN / memo — Fiber does not expose a reliable memo path.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from config import BASE_DIR, DB_PATH

# ── Limits (no service fee in MVP — merchant receives full amount) ───────────
INVOICE_MAX_ACTIVE_PER_DEVICE = 10
INVOICE_MAX_UNPAID_PER_PURPOSE = 3  # anti-abuse soft limit; global device cap still applies
INVOICE_MAX_TITLE = 120
INVOICE_MAX_DESCRIPTION = 2000
INVOICE_MIN_AMOUNT_NCH = 1
INVOICE_MAX_AMOUNT_NCH = 50_000_000
# Allowed lifetimes (hours)
INVOICE_TTL_CHOICES_HOURS = (1, 6, 24, 72, 168)  # 1h … 7d
INVOICE_DEFAULT_TTL_HOURS = 24

# Multi-purpose labels (UI). Stored as short codes.
PURPOSE_CHOICES = {
    "invoice": {"id": "invoice", "label": "Invoice", "hint": "Bill for work or a product"},
    "coffee": {"id": "coffee", "label": "Buy me a coffee", "hint": "Tips and small support"},
    "fund": {"id": "fund", "label": "Fundraiser", "hint": "Collect toward a goal"},
    "other": {"id": "other", "label": "Payment request", "hint": "Any NCH payment link"},
}
DEFAULT_PURPOSE = "invoice"

_ADDRESS_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{20,50}$")  # Skycoin/Fiber base58

_deps: dict = {}


def register(app, deps: dict):
    """Wire invoice routes onto the shared Flask / MiniApp instance."""
    global _deps
    _deps = deps
    _init_invoice_schema()
    _mount_routes(app, deps)


def _init_invoice_schema(get_db=None):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS invoices (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            public_token    TEXT    UNIQUE NOT NULL,
            manage_token    TEXT    UNIQUE NOT NULL,
            title           TEXT    NOT NULL,
            description     TEXT    NOT NULL DEFAULT '',
            amount_nch      INTEGER NOT NULL,
            pay_to_address  TEXT    NOT NULL,
            status          TEXT    NOT NULL DEFAULT 'unpaid',
            tx_hash         TEXT    UNIQUE,
            amount_received INTEGER,
            created_at      TEXT    NOT NULL,
            expires_at      TEXT    NOT NULL,
            paid_at         TEXT,
            creator_key     TEXT
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_public ON invoices(public_token)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_manage ON invoices(manage_token)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoices(status, expires_at)"
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(invoices)").fetchall()}
    if "purpose" not in cols:
        conn.execute(
            "ALTER TABLE invoices ADD COLUMN purpose TEXT NOT NULL DEFAULT 'invoice'"
        )
    conn.commit()
    conn.close()


def _new_token() -> str:
    return secrets.token_urlsafe(18)


def _valid_ness_address(addr: str) -> bool:
    addr = (addr or "").strip()
    return bool(_ADDRESS_RE.match(addr))


def _parse_ttl_hours(raw) -> int:
    try:
        h = int(raw)
    except (TypeError, ValueError):
        return INVOICE_DEFAULT_TTL_HOURS
    if h in INVOICE_TTL_CHOICES_HOURS:
        return h
    # nearest allowed
    return min(INVOICE_TTL_CHOICES_HOURS, key=lambda x: abs(x - h))


def cleanup_invoices_expired():
    """Expire unpaid invoices past TTL. Dedicated connection (no Flask context)."""
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000;")
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "UPDATE invoices SET status = 'expired' "
            "WHERE status = 'unpaid' AND expires_at < ?",
            (now,),
        )
        # Hard-delete old terminal rows after 30 days
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        conn.execute(
            "DELETE FROM invoices WHERE status IN ('paid','expired','cancelled') "
            "AND created_at < ?",
            (cutoff,),
        )
        conn.commit()
    except Exception as exc:
        print(f"[INVOICE] cleanup error: {exc}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _mount_routes(app, deps: dict):
    get_db = deps["get_db"]
    jsonify = deps["jsonify"]
    request = deps["request"]
    HAS_FLASK = deps["HAS_FLASK"]
    render_template = deps.get("render_template")
    _rate_ok = deps["_rate_ok"]
    _rate_key = deps["_rate_key"]
    _owner_key = deps.get("_owner_key") or (lambda kind="inv": _rate_key(kind))

    def _invoice_owner_keys():
        """Current stable key + legacy rate_key form (inv:ip:device)."""
        keys = []
        try:
            keys.append(_owner_key("inv"))
        except Exception:
            pass
        try:
            leg = _rate_key("inv")
            if leg not in keys:
                keys.append(leg)
        except Exception:
            pass
        return keys

    def _device_id_only():
        try:
            # deps may expose via owner key "inv:DEVICE"
            ok = _owner_key("inv")
            if isinstance(ok, str) and ok.startswith("inv:"):
                return ok.split(":", 1)[1]
        except Exception:
            pass
        return "anon"

    def _fetch_mine_rows(db, statuses=None):
        statuses = statuses or ("unpaid", "paid", "expired", "cancelled")
        owner_keys = _invoice_owner_keys()
        device = _device_id_only()
        st_ph = ",".join("?" * len(statuses))
        params = list(statuses)
        clauses = []
        if owner_keys:
            ph = ",".join("?" * len(owner_keys))
            clauses.append(f"creator_key IN ({ph})")
            params.extend(owner_keys)
        # Legacy rows: any creator_key that ends with this device id
        if device and device != "anon" and len(device) >= 8:
            clauses.append("creator_key LIKE ?")
            params.append("%" + device)
        if not clauses:
            return []
        where_own = "(" + " OR ".join(clauses) + ")"
        sql = (
            f"SELECT public_token, title, description, amount_nch, purpose, status, "
            f"expires_at, created_at, paid_at, creator_key "
            f"FROM invoices WHERE status IN ({st_ph}) AND {where_own} "
            f"ORDER BY created_at DESC LIMIT 40"
        )
        return db.execute(sql, tuple(params)).fetchall()

    def _row_to_mine_item(row):
        purpose = (row["purpose"] if "purpose" in row.keys() else "invoice") or "invoice"
        return {
            "token": row["public_token"],
            "title": row["title"],
            "amount_nch": row["amount_nch"],
            "purpose": purpose,
            "purpose_label": PURPOSE_CHOICES.get(purpose, PURPOSE_CHOICES["invoice"])["label"],
            "status": row["status"],
            "expires_at": row["expires_at"],
            "created_at": row["created_at"],
            "public_path": f"/invoice/i/{row['public_token']}",
        }
    verify_nch = deps["verify_nch_payment_on_chain"]
    ExplorerUnavailable = deps["ExplorerUnavailable"]
    PaymentVerificationError = deps["PaymentVerificationError"]
    _normalize_txid = deps["_normalize_txid"]
    _is_plausible_txid = deps["_is_plausible_txid"]
    probe_explorer_cached = deps["probe_explorer_cached"]
    explorer_payload = deps["_explorer_unavailable_payload"]
    json_mod = deps.get("json", json)

    def _page():
        if HAS_FLASK and render_template:
            return render_template("invoice.html")
        html = (BASE_DIR / "templates" / "invoice.html").read_text(encoding="utf-8")
        return html

    @app.route("/invoice")
    def invoice_index():
        return _page()

    @app.route("/invoice/i/<token>")
    def invoice_public_page(token):
        return _page()

    @app.route("/api/invoice/ping", methods=["GET"])
    def api_invoice_ping():
        return jsonify({"success": True, "service": "invoice", "ok": True})

    @app.route("/api/invoice/meta", methods=["GET"])
    def api_invoice_meta_static():
        return jsonify({
            "success": True,
            "ttl_choices_hours": list(INVOICE_TTL_CHOICES_HOURS),
            "default_ttl_hours": INVOICE_DEFAULT_TTL_HOURS,
            "min_amount_nch": INVOICE_MIN_AMOUNT_NCH,
            "max_amount_nch": INVOICE_MAX_AMOUNT_NCH,
            "note": (
                "Matched by destination address, NCH amount, and transaction hash."
            ),
            "purposes": list(PURPOSE_CHOICES.values()),
        })

    @app.route("/api/invoice/create", methods=["POST"])
    def api_invoice_create():
        try:
            return _api_invoice_create_impl()
        except Exception as exc:
            print(f"[INVOICE] create error: {exc}")
            return jsonify({"success": False, "error": "Could not create payment link. Try again."}), 500

    def _api_invoice_create_impl():
        if not _rate_ok(_rate_key("inv_create"), limit=8, window=60):
            return jsonify({"success": False, "error": "Too many invoices — slow down."}), 429
        _rate_global = deps.get("_rate_global")
        if _rate_global and not _rate_global("inv_create", limit=200, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if HAS_FLASK:
            from flask import request as fr
            if fr.content_length and fr.content_length > 64 * 1024:
                return jsonify({"success": False, "error": "Request too large"}), 413

        # Ensure schema (purpose column) exists even if process started before migration
        try:
            _init_invoice_schema()
        except Exception as exc:
            print(f"[INVOICE] schema ensure: {exc}")

        body = {}
        form = {}
        if HAS_FLASK:
            from flask import request as fr
            body = fr.get_json(silent=True) or {}
            form = fr.form or {}
            # Also accept raw JSON body edge-cases
            if not body and fr.data:
                try:
                    import json as _json
                    body = _json.loads(fr.data.decode("utf-8") or "{}")
                except Exception:
                    body = {}
        else:
            form = getattr(request, "form", {}) or {}

        def pick(key, default=""):
            if key in body and body[key] is not None:
                return body[key]
            return form.get(key, default)

        title = (str(pick("title", "")) or "").strip()
        description = (str(pick("description", "")) or "").strip()
        pay_to = (str(pick("pay_to_address", "")) or "").strip()
        purpose = (str(pick("purpose", DEFAULT_PURPOSE)) or DEFAULT_PURPOSE).strip().lower()
        if purpose not in PURPOSE_CHOICES:
            purpose = DEFAULT_PURPOSE
        try:
            amount = int(pick("amount_nch", 0))
        except (TypeError, ValueError):
            amount = 0
        ttl_hours = _parse_ttl_hours(pick("ttl_hours", INVOICE_DEFAULT_TTL_HOURS))

        if not title or len(title) > INVOICE_MAX_TITLE:
            return jsonify({
                "success": False,
                "error": f"Title required (max {INVOICE_MAX_TITLE} characters).",
            }), 400
        if len(description) > INVOICE_MAX_DESCRIPTION:
            return jsonify({
                "success": False,
                "error": f"Description max {INVOICE_MAX_DESCRIPTION} characters.",
            }), 400
        if amount < INVOICE_MIN_AMOUNT_NCH or amount > INVOICE_MAX_AMOUNT_NCH:
            return jsonify({
                "success": False,
                "error": f"Amount must be between {INVOICE_MIN_AMOUNT_NCH} and {INVOICE_MAX_AMOUNT_NCH} NCH.",
            }), 400
        if not _valid_ness_address(pay_to):
            return jsonify({
                "success": False,
                "error": "Invalid NESS address (Skycoin/Fiber base58, 20–50 characters).",
            }), 400

        device = _device_id_only()
        if not device or device == "anon" or len(device) < 16:
            return jsonify({
                "success": False,
                "error": "Device identity missing. Enable localStorage and reload.",
            }), 400
        creator_key = _owner_key("inv")
        owner_keys = _invoice_owner_keys()
        db = get_db()
        try:
            active_n = len(_fetch_mine_rows(db, statuses=("unpaid",)))
        except Exception:
            active_n = 0
        if active_n >= INVOICE_MAX_ACTIVE_PER_DEVICE:
            return jsonify({
                "success": False,
                "error": f"At most {INVOICE_MAX_ACTIVE_PER_DEVICE} unpaid payment links per device.",
            }), 400

        # One unpaid link per purpose (invoice / coffee / fund / other)
        same_n = 0
        try:
            for r in _fetch_mine_rows(db, statuses=("unpaid",)):
                p = (r["purpose"] if "purpose" in r.keys() else "invoice") or "invoice"
                if p == purpose:
                    same_n += 1
        except Exception as exc:
            print(f"[INVOICE] purpose count: {exc}")
        if same_n >= INVOICE_MAX_UNPAID_PER_PURPOSE:
            label = PURPOSE_CHOICES.get(purpose, {}).get("label", purpose)
            existing_item = None
            try:
                for r in _fetch_mine_rows(db, statuses=("unpaid",)):
                    p = (r["purpose"] if "purpose" in r.keys() else "invoice") or "invoice"
                    if p == purpose:
                        existing_item = _row_to_mine_item(r)
                        break
            except Exception as exc:
                print(f"[INVOICE] existing lookup: {exc}")
            return jsonify({
                "success": False,
                "error": (
                    f"You already have the maximum unpaid « {label} » links. "
                    "Open one from My links, or pick another purpose."
                ),
                "existing": existing_item,
            }), 409

        now = datetime.now(timezone.utc)
        expires = now + timedelta(hours=ttl_hours)
        public_token = _new_token()
        manage_token = _new_token()

        db.execute(
            """INSERT INTO invoices
               (public_token, manage_token, title, description, amount_nch,
                pay_to_address, status, created_at, expires_at, creator_key, purpose)
               VALUES (?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?)""",
            (
                public_token,
                manage_token,
                title,
                description,
                amount,
                pay_to,
                now.isoformat(),
                expires.isoformat(),
                creator_key,
                purpose,
            ),
        )
        db.commit()

        return jsonify({
            "success": True,
            "token": public_token,
            "manage_token": manage_token,
            "amount_nch": amount,
            "pay_to_address": pay_to,
            "purpose": purpose,
            "purpose_label": PURPOSE_CHOICES[purpose]["label"],
            "expires_at": expires.isoformat(),
            "public_path": f"/invoice/i/{public_token}",
        })

    def _row_public(row):
        return {
            "token": row["public_token"],
            "title": row["title"],
            "description": row["description"],
            "purpose": (row["purpose"] if "purpose" in row.keys() else "invoice") or "invoice",
            "purpose_label": PURPOSE_CHOICES.get(
                (row["purpose"] if "purpose" in row.keys() else "invoice") or "invoice",
                PURPOSE_CHOICES["invoice"],
            )["label"],
            "amount_nch": row["amount_nch"],
            "pay_to_address": row["pay_to_address"],
            "status": row["status"],
            "created_at": row["created_at"],
            "expires_at": row["expires_at"],
            "paid_at": row["paid_at"],
            "tx_hash": row["tx_hash"],
            "amount_received": row["amount_received"],
        }

    @app.route("/api/invoice/mine", methods=["GET"])
    def api_invoice_mine():
        """List this device's recent invoices (no manage tokens). Source of truth for My links."""
        if not _rate_ok(_rate_key("inv_mine"), limit=30, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        if _device_id_only() == "anon":
            return jsonify({"success": True, "items": []})
        db = get_db()
        try:
            rows = _fetch_mine_rows(db)
        except Exception as exc:
            print(f"[INVOICE] mine error: {exc}")
            return jsonify({"success": True, "items": [], "warning": str(exc)})
        items = [_row_to_mine_item(row) for row in rows]
        return jsonify({"success": True, "items": items})

    @app.route("/api/invoice/<token>", methods=["GET"])
    def api_invoice_get(token):
        token = (token or "").strip()
        if not token or len(token) < 16:
            return jsonify({"success": False, "error": "Invalid token"}), 404
        db = get_db()
        row = db.execute(
            "SELECT * FROM invoices WHERE public_token = ?", (token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Invoice not found"}), 404

        # Lazy expire
        if row["status"] == "unpaid":
            exp = datetime.fromisoformat(row["expires_at"])
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp <= datetime.now(timezone.utc):
                db.execute(
                    "UPDATE invoices SET status = 'expired' WHERE id = ?",
                    (row["id"],),
                )
                db.commit()
                row = db.execute(
                    "SELECT * FROM invoices WHERE id = ?", (row["id"],)
                ).fetchone()

        return jsonify({"success": True, "invoice": _row_public(row)})

    @app.route("/api/invoice/<token>/verify", methods=["POST"])
    def api_invoice_verify(token):
        _rate_global = deps.get("_rate_global")
        if _rate_global and not _rate_global("inv_verify", limit=120, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not _rate_ok(_rate_key("inv_verify"), limit=12, window=60):
            return jsonify({"success": False, "error": "Too many verification attempts"}), 429

        token = (token or "").strip()
        if HAS_FLASK:
            from flask import request as fr
            body = fr.get_json(silent=True) or {}
            tx_hash = (body.get("tx_hash") or fr.form.get("tx_hash") or "").strip()
        else:
            tx_hash = (request.form.get("tx_hash") or "").strip()

        if not _is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid transaction hash"}), 400

        db = get_db()
        row = db.execute(
            "SELECT * FROM invoices WHERE public_token = ?", (token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Invoice not found"}), 404

        if row["status"] == "paid":
            return jsonify({
                "success": True,
                "already_paid": True,
                "invoice": _row_public(row),
            })

        if row["status"] != "unpaid":
            return jsonify({
                "success": False,
                "error": f"Invoice is {row['status']}",
            }), 410

        exp = datetime.fromisoformat(row["expires_at"])
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            db.execute(
                "UPDATE invoices SET status = 'expired' WHERE id = ?", (row["id"],)
            )
            db.commit()
            return jsonify({"success": False, "error": "Invoice expired"}), 410

        # Anti-replay cross-product (mail + burn + invoice)
        tx_used = deps.get("_tx_already_used")
        if tx_used and tx_used(db, _normalize_txid(tx_hash)):
            return jsonify({
                "success": False,
                "error": "This transaction was already used.",
            }), 409

        try:
            chain = verify_nch(
                tx_hash,
                min_hours=int(row["amount_nch"]),
                expected_address=row["pay_to_address"],
            )
        except ExplorerUnavailable as exc:
            return jsonify(explorer_payload(exc)), 503
        except PaymentVerificationError as exc:
            return jsonify({"success": False, "error": str(exc)}), getattr(exc, "http_status", 400) or 400
        except Exception as exc:
            print(f"[INVOICE] verify error: {exc}")
            return jsonify({"success": False, "error": "Verification failed"}), 500

        txid = chain["txid"]
        received = int(chain["hours_received"])
        paid_at = datetime.now(timezone.utc).isoformat()

        claim = deps.get("_claim_tx")
        if claim and not claim(db, _normalize_txid(tx_hash), "invoice", amount_nch=received):
            return jsonify({"success": False, "error": "Transaction already used."}), 409


        try:
            db.execute(
                """UPDATE invoices
                   SET status = 'paid', tx_hash = ?, amount_received = ?, paid_at = ?
                   WHERE id = ? AND status = 'unpaid'""",
                (txid, received, paid_at, row["id"]),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({
                "success": False,
                "error": "This transaction was already used (anti-replay).",
            }), 409

        row = db.execute(
            "SELECT * FROM invoices WHERE id = ?", (row["id"],)
        ).fetchone()
        return jsonify({"success": True, "invoice": _row_public(row)})

    @app.route("/api/invoice/manage/<manage_token>/rotate", methods=["POST"])
    def api_invoice_rotate_manage(manage_token):
        """Rotate manage token (session hardening). Old token becomes invalid."""
        manage_token = (manage_token or "").strip()
        if not manage_token or len(manage_token) < 16:
            return jsonify({"success": False, "error": "Invalid manage token"}), 404
        db = get_db()
        row = db.execute(
            "SELECT * FROM invoices WHERE manage_token = ?", (manage_token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        new_mt = _new_token()
        db.execute(
            "UPDATE invoices SET manage_token = ? WHERE id = ?",
            (new_mt, row["id"]),
        )
        db.commit()
        return jsonify({
            "success": True,
            "manage_token": new_mt,
            "token": row["public_token"],
        })

    @app.route("/api/invoice/manage/<manage_token>/cancel", methods=["POST"])
    def api_invoice_cancel(manage_token):
        manage_token = (manage_token or "").strip()
        if not manage_token or len(manage_token) < 16:
            return jsonify({"success": False, "error": "Invalid manage token"}), 404
        db = get_db()
        row = db.execute(
            "SELECT * FROM invoices WHERE manage_token = ?", (manage_token,)
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        if row["status"] != "unpaid":
            return jsonify({"success": False, "error": f"Cannot cancel — status is {row['status']}"}), 400
        db.execute(
            "UPDATE invoices SET status = 'cancelled' WHERE id = ?", (row["id"],)
        )
        db.commit()
        return jsonify({"success": True, "status": "cancelled"})
