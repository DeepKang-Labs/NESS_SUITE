"""
NESS Wormhole — paid access licenses for client-side tools (DPO / Offline).

No payload storage. Payment follows suite contracts:
  intent → verify_nch → _tx_already_used → _claim_tx → grant license.
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta, timezone

from config import NCH_PAYMENT_ADDRESS, WORMHOLE_TOOLS

_ALPH = string.ascii_letters + string.digits + "-_"


def _now():
    return datetime.now(timezone.utc)


def _new_id(n=24):
    return "".join(secrets.choice(_ALPH) for _ in range(n))


def _device_key(deps):
    fn = deps.get("_client_device_id")
    if not fn:
        return ""
    try:
        d = (fn() or "").strip()
    except Exception:
        d = ""
    if not d or d == "anon":
        return ""
    return d


def _init_schema(get_db):
    db = get_db()
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS wormhole_licenses (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tool          TEXT NOT NULL,
            device_id     TEXT NOT NULL,
            tx_hash       TEXT,
            amount_nch    INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            expires_at    TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'active'
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_wh_lic_device_tool "
        "ON wormhole_licenses(device_id, tool, status, expires_at)"
    )
    db.commit()


def _active_license(db, tool: str, device_id: str):
    now = _now().isoformat()
    return db.execute(
        """
        SELECT * FROM wormhole_licenses
         WHERE tool = ? AND device_id = ? AND status = 'active'
           AND expires_at > ?
         ORDER BY expires_at DESC LIMIT 1
        """,
        (tool, device_id, now),
    ).fetchone()


def register(app, deps: dict):
    get_db = deps["get_db"]
    jsonify = deps["jsonify"]
    request = deps["request"]
    HAS_FLASK = deps["HAS_FLASK"]
    render_template = deps.get("render_template")
    rate_ok = deps["_rate_ok"]
    rate_key = deps["_rate_key"]
    rate_global = deps.get("_rate_global")
    claim_tx = deps["_claim_tx"]
    tx_already = deps["_tx_already_used"]
    verify_nch = deps["verify_nch_payment_on_chain"]
    ExplorerUnavailable = deps["ExplorerUnavailable"]
    PaymentVerificationError = deps["PaymentVerificationError"]
    normalize_txid = deps["_normalize_txid"]
    is_plausible_txid = deps["_is_plausible_txid"]
    explorer_payload = deps.get("_explorer_unavailable_payload")

    _schema_ready = {"ok": False}

    def _ensure_schema():
        if _schema_ready["ok"]:
            return
        try:
            db = get_db()
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS wormhole_licenses (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool          TEXT NOT NULL,
                    device_id     TEXT NOT NULL,
                    tx_hash       TEXT,
                    amount_nch    INTEGER NOT NULL DEFAULT 0,
                    created_at    TEXT NOT NULL,
                    expires_at    TEXT NOT NULL,
                    status        TEXT NOT NULL DEFAULT 'active'
                )
                """
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_wh_lic_device_tool "
                "ON wormhole_licenses(device_id, tool, status, expires_at)"
            )
            # payment_intents.product may be missing on older DBs
            try:
                cols = [r[1] for r in db.execute("PRAGMA table_info(payment_intents)").fetchall()]
                if cols and "product" not in cols:
                    db.execute(
                        "ALTER TABLE payment_intents "
                        "ADD COLUMN product TEXT NOT NULL DEFAULT 'mail'"
                    )
            except Exception:
                pass
            db.commit()
            _schema_ready["ok"] = True
        except Exception as exc:
            print(f"[WORMHOLE] schema init: {exc}")

    try:
        if HAS_FLASK:
            with app.app_context():
                _ensure_schema()
        else:
            _ensure_schema()
    except Exception as exc:
        print(f"[WORMHOLE] schema boot: {exc}")

    def _tool_or_400(tool: str):
        tool = (tool or "").strip().lower()
        if tool not in WORMHOLE_TOOLS:
            return None, (jsonify({"success": False, "error": "Unknown wormhole tool"}), 400)
        return tool, None

    @app.route("/api/wormhole/catalog", methods=["GET"])
    def api_wormhole_catalog():
        _ensure_schema()
        items = []
        for k, v in WORMHOLE_TOOLS.items():
            items.append({
                "id": v["id"],
                "label": v["label"],
                "price_nch": int(v["price_nch"]),
                "ttl_minutes": int(v["ttl_minutes"]),
                "tagline": v.get("tagline") or "",
                "free": int(v["price_nch"]) <= 0,
            })
        return jsonify({
            "success": True,
            "tools": items,
            "pay_address": NCH_PAYMENT_ADDRESS,
        })

    @app.route("/api/wormhole/access", methods=["GET"])
    def api_wormhole_access():
        _ensure_schema()
        tool = (request.args.get("tool") or "").strip().lower()
        tool, err = _tool_or_400(tool)
        if err:
            return err
        meta = WORMHOLE_TOOLS[tool]
        price = int(meta["price_nch"])
        if price <= 0:
            return jsonify({
                "success": True,
                "allowed": True,
                "free": True,
                "tool": tool,
                "price_nch": 0,
                "expires_at": None,
            })
        device = _device_key(deps)
        if not device:
            return jsonify({
                "success": True,
                "allowed": False,
                "free": False,
                "tool": tool,
                "price_nch": price,
                "error": "Device identity required",
                "need_device": True,
            })
        db = get_db()
        row = _active_license(db, tool, device)
        if row:
            return jsonify({
                "success": True,
                "allowed": True,
                "free": False,
                "tool": tool,
                "price_nch": price,
                "expires_at": row["expires_at"],
                "ttl_minutes": int(meta["ttl_minutes"]),
            })
        return jsonify({
            "success": True,
            "allowed": False,
            "free": False,
            "tool": tool,
            "price_nch": price,
            "ttl_minutes": int(meta["ttl_minutes"]),
            "pay_address": NCH_PAYMENT_ADDRESS,
        })

    @app.route("/api/wormhole/intent", methods=["POST"])
    def api_wormhole_intent():
        _ensure_schema()
        if rate_global and not rate_global("wh_intent", limit=40, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("wh_intent"), limit=12, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        tool = (request.form.get("tool") or "").strip().lower()
        tool, err = _tool_or_400(tool)
        if err:
            return err
        meta = WORMHOLE_TOOLS[tool]
        price = int(meta["price_nch"])
        if price <= 0:
            return jsonify({"success": False, "error": "This tool is free — no payment required"}), 400
        device = _device_key(deps)
        if not device:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        intent_id = _new_id(32)
        now = _now()
        expires = now + timedelta(minutes=30)
        db = get_db()
        db.execute(
            """
            INSERT INTO payment_intents
              (intent_id, plan, amount_nch, pay_address, status, created_at, expires_at, product)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, 'wormhole')
            """,
            (
                intent_id,
                f"wormhole:{tool}",
                price,
                NCH_PAYMENT_ADDRESS,
                now.isoformat(),
                expires.isoformat(),
            ),
        )
        db.commit()
        return jsonify({
            "success": True,
            "intent_id": intent_id,
            "tool": tool,
            "amount_nch": price,
            "pay_address": NCH_PAYMENT_ADDRESS,
            "expires_at": expires.isoformat(),
            "ttl_minutes": int(meta["ttl_minutes"]),
        })

    @app.route("/api/wormhole/verify", methods=["POST"])
    def api_wormhole_verify():
        _ensure_schema()
        if rate_global and not rate_global("wh_verify", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("wh_verify"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        tool = (request.form.get("tool") or "").strip().lower()
        tool, err = _tool_or_400(tool)
        if err:
            return err
        meta = WORMHOLE_TOOLS[tool]
        price = int(meta["price_nch"])
        if price <= 0:
            return jsonify({"success": True, "allowed": True, "free": True, "tool": tool})
        device = _device_key(deps)
        if not device:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        tx_hash = normalize_txid(request.form.get("tx_hash") or "")
        if not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid transaction hash"}), 400
        intent_id = (request.form.get("intent_id") or "").strip()
        if not intent_id:
            return jsonify({"success": False, "error": "Missing payment intent"}), 400

        db = get_db()
        # Already licensed?
        existing = _active_license(db, tool, device)
        if existing:
            return jsonify({
                "success": True,
                "allowed": True,
                "tool": tool,
                "expires_at": existing["expires_at"],
                "already": True,
            })

        if tx_already and tx_already(db, tx_hash):
            return jsonify({"success": False, "error": "Transaction already used"}), 409

        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'wormhole'",
            (intent_id,),
        ).fetchone()
        if not intent:
            return jsonify({"success": False, "error": "Payment intent not found or already used"}), 404
        if (intent["plan"] or "") != f"wormhole:{tool}":
            return jsonify({"success": False, "error": "Tool mismatch"}), 400
        required_nch = int(intent["amount_nch"])
        try:
            intent_exp = datetime.fromisoformat(intent["expires_at"])
            if intent_exp.tzinfo is None:
                intent_exp = intent_exp.replace(tzinfo=timezone.utc)
            if intent_exp <= _now():
                return jsonify({"success": False, "error": "Payment intent expired"}), 410
        except Exception:
            pass

        try:
            verify_nch(
                tx_hash,
                expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch,
                exact_amount=False,
            )
        except ExplorerUnavailable as e:
            if explorer_payload:
                return jsonify(explorer_payload(e)), 503
            return jsonify({"success": False, "error": str(e), "explorer_ok": False}), 503
        except PaymentVerificationError as e:
            return jsonify({"success": False, "error": str(e)}), 400
        except Exception as e:
            return jsonify({"success": False, "error": f"Verification failed: {e}"}), 502

        if not claim_tx(db, tx_hash, "wormhole", amount_nch=required_nch, ref_id=f"{tool}:{device[:16]}"):
            return jsonify({"success": False, "error": "Transaction already used"}), 409

        now = _now()
        expires = now + timedelta(minutes=int(meta["ttl_minutes"]))
        # Renew: stack remaining time if any leftover license (edge)
        prev = db.execute(
            """
            SELECT expires_at FROM wormhole_licenses
             WHERE tool = ? AND device_id = ? AND status = 'active'
             ORDER BY expires_at DESC LIMIT 1
            """,
            (tool, device),
        ).fetchone()
        if prev:
            try:
                prev_exp = datetime.fromisoformat(prev["expires_at"])
                if prev_exp.tzinfo is None:
                    prev_exp = prev_exp.replace(tzinfo=timezone.utc)
                if prev_exp > now:
                    expires = prev_exp + timedelta(minutes=int(meta["ttl_minutes"]))
            except Exception:
                pass

        db.execute(
            """
            INSERT INTO wormhole_licenses
              (tool, device_id, tx_hash, amount_nch, created_at, expires_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'active')
            """,
            (tool, device, tx_hash, required_nch, now.isoformat(), expires.isoformat()),
        )
        try:
            db.execute(
                "UPDATE payment_intents SET status = 'consumed' WHERE intent_id = ?",
                (intent_id,),
            )
        except Exception:
            pass
        db.commit()
        return jsonify({
            "success": True,
            "allowed": True,
            "tool": tool,
            "expires_at": expires.isoformat(),
            "amount_nch": required_nch,
            "txid": tx_hash,
        })

    # Page routes (templates already exist; inject catalog server-side)
    if HAS_FLASK and render_template:
        @app.route("/wormhole")
        def wormhole_hub():
            try:
                from app import build_og_meta
                meta = build_og_meta("wormhole", path="/wormhole")
            except Exception:
                meta = {}
            return render_template(
                "wormhole.html",
                tools=WORMHOLE_TOOLS,
                pay_address=NCH_PAYMENT_ADDRESS,
                **meta,
            )

        @app.route("/wormhole/dpo")
        def wormhole_dpo():
            try:
                from app import build_og_meta
                meta = build_og_meta("wormhole", path="/wormhole/dpo")
            except Exception:
                meta = {}
            return render_template(
                "wormhole_dpo.html",
                tool=WORMHOLE_TOOLS["dpo"],
                pay_address=NCH_PAYMENT_ADDRESS,
                **meta,
            )

        @app.route("/wormhole/offline")
        def wormhole_offline():
            try:
                from app import build_og_meta
                meta = build_og_meta("wormhole", path="/wormhole/offline")
            except Exception:
                meta = {}
            return render_template(
                "wormhole_offline.html",
                tool=WORMHOLE_TOOLS["offline"],
                pay_address=NCH_PAYMENT_ADDRESS,
                **meta,
            )
