"""
NESS Storage — private personal vault (not a share product; Burn is for sharing).

- Ownership: X-Device-Id (creator_key). List/get/delete fail-closed without it.
- Bytes on server are opaque (client encrypts via NessVault before upload).
- Backends: local disk (default) or IPFS HTTP API (STORAGE_BACKEND=ipfs).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from config import (
    DB_PATH,
    NCH_PAYMENT_ADDRESS,
    STORAGE_BACKEND,
    STORAGE_DIR,
    STORAGE_IPFS_API,
    STORAGE_IPFS_GATEWAY,
    STORAGE_IPFS_TIMEOUT,
    STORAGE_TIERS,
)

_deps = {}
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{16,64}$")

PBKDF2_ITERATIONS = 100_000
PBKDF2_LEGACY_ITERATIONS = 600_000


def register(app, deps: dict):
    global _deps
    _deps = deps
    Path(STORAGE_DIR).mkdir(parents=True, exist_ok=True)
    _init_schema()
    _mount_routes(app, deps)


def _init_schema():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS storage_objects (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            public_token     TEXT UNIQUE NOT NULL,
            plan             TEXT NOT NULL,
            created_at       TEXT NOT NULL,
            expires_at       TEXT NOT NULL,
            max_downloads    INTEGER NOT NULL DEFAULT 0,
            download_count   INTEGER NOT NULL DEFAULT 0,
            password_hash    TEXT,
            transaction_hash TEXT UNIQUE,
            amount_nch       REAL,
            status           TEXT NOT NULL DEFAULT 'active',
            total_bytes      INTEGER NOT NULL DEFAULT 0,
            files_json       TEXT NOT NULL DEFAULT '[]',
            creator_key      TEXT NOT NULL,
            label            TEXT,
            backend          TEXT NOT NULL DEFAULT 'local'
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_storage_creator ON storage_objects(creator_key)"
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(storage_objects)").fetchall()}
    if "backend" not in cols:
        conn.execute(
            "ALTER TABLE storage_objects ADD COLUMN backend TEXT NOT NULL DEFAULT 'local'"
        )
    conn.commit()
    conn.close()


def _public_tiers():
    return {
        k: {
            "id": v["id"],
            "label": v["label"],
            "ttl_minutes": v["ttl_minutes"],
            "max_objects": v["max_objects"],
            "max_size_mb": v["max_size_mb"],
            "max_downloads": v["max_downloads"],
            "password": False,  # private vault: device vault, not share passphrase
            "price_nch": v["price_nch"],
            "badge_class": v["badge_class"],
            "tagline": v["tagline"],
        }
        for k, v in STORAGE_TIERS.items()
    }


def _safe_plan(pid):
    pid = (pid or "").strip().lower()
    return pid if pid in STORAGE_TIERS else None


def _sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "file.bin")
    name = re.sub(r"[^\w.\- ()\[\]]+", "_", name).strip("._") or "file.bin"
    return name[:180]


# ── Backends ─────────────────────────────────────────────────────────────

class LocalEncryptedBackend:
    name = "local"

    def put(self, token: str, filename: str, data: bytes) -> dict:
        d = Path(STORAGE_DIR) / token
        d.mkdir(parents=True, exist_ok=True)
        safe = _sanitize_filename(filename)
        dest = d / safe
        n = 1
        while dest.exists():
            stem, ext = os.path.splitext(safe)
            dest = d / f"{stem}_{n}{ext}"
            n += 1
        dest.write_bytes(data)
        return {"filename": dest.name, "ref": dest.name, "backend": self.name}

    def get(self, token: str, ref: str) -> bytes | None:
        path = Path(STORAGE_DIR) / token / _sanitize_filename(ref)
        if not path.is_file():
            return None
        return path.read_bytes()

    def delete_all(self, token: str):
        d = Path(STORAGE_DIR) / token
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)


class IpfsBackend:
    """HTTP client for Kubo-style /api/v0/add and gateway fetch. Optional."""

    name = "ipfs"

    def __init__(self):
        if not STORAGE_IPFS_API:
            raise RuntimeError("STORAGE_IPFS_API is not configured")

    def put(self, token: str, filename: str, data: bytes) -> dict:
        # multipart add
        boundary = "----NESS" + secrets.token_hex(8)
        safe = _sanitize_filename(filename)
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
        req = urllib.request.Request(
            f"{STORAGE_IPFS_API}/api/v0/add?pin=true&cid-version=1",
            data=body,
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "NESS-Suite/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=STORAGE_IPFS_TIMEOUT) as resp:
            out = json.loads(resp.read().decode("utf-8"))
        cid = out.get("Hash") or out.get("Cid") or out.get("cid")
        if not cid:
            raise RuntimeError("IPFS add returned no CID")
        return {"filename": safe, "ref": cid, "backend": self.name, "cid": cid}

    def get(self, token: str, ref: str) -> bytes | None:
        # prefer gateway; fall back to API cat
        urls = []
        if STORAGE_IPFS_GATEWAY:
            urls.append(f"{STORAGE_IPFS_GATEWAY}/ipfs/{ref}")
        urls.append(f"{STORAGE_IPFS_API}/api/v0/cat?arg={ref}")
        last = None
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "NESS-Suite/1.0"})
                if "api/v0/cat" in url:
                    req = urllib.request.Request(
                        url, data=b"", method="POST",
                        headers={"User-Agent": "NESS-Suite/1.0"},
                    )
                with urllib.request.urlopen(req, timeout=STORAGE_IPFS_TIMEOUT) as resp:
                    return resp.read()
            except Exception as exc:
                last = exc
                continue
        if last:
            print(f"[STORAGE] ipfs get failed: {last}")
        return None

    def delete_all(self, token: str):
        # Best-effort unpin if files_json CIDs were passed via side-channel is not available here.
        # IPFS is experimental: expiry marks SQLite expired; pin GC is operator responsibility.
        # Prefer STORAGE_BACKEND=local for true destroy-on-expiry.
        pass



def _active_bytes(db, creator_key):
    row = db.execute(
        "SELECT COALESCE(SUM(total_bytes), 0) AS s FROM storage_objects "
        "WHERE creator_key = ? AND status = 'active' AND expires_at > ?",
        (creator_key, datetime.now(timezone.utc).isoformat()),
    ).fetchone()
    return int(row[0] if row else 0)


_disk_cache = {"at": 0.0, "mb": 0.0}
_disk_lock = __import__("threading").Lock()

def _disk_usage_mb() -> float:
    try:
        total = 0
        root = Path(STORAGE_DIR)
        if not root.is_dir():
            return 0.0
        for dirpath, _, files in os.walk(root):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except Exception:
                    pass
        return total / (1024 * 1024)
    except Exception:
        return 0.0


STORAGE_HARD_DISK_CAP_MB = int(os.environ.get("STORAGE_HARD_DISK_CAP_MB", "10000") or "10000")
FREE_TIER_DEVICE_BYTES = int(os.environ.get("STORAGE_FREE_DEVICE_MB", "150") or "150") * 1024 * 1024
FREE_TIER_DEVICE_OBJECTS = int(os.environ.get("STORAGE_FREE_DEVICE_OBJECTS", "3") or "3")

def get_backend():
    mode = (STORAGE_BACKEND or "local").lower()
    if mode == "ipfs":
        try:
            return IpfsBackend()
        except Exception as exc:
            print(f"[STORAGE] IPFS backend unavailable ({exc}); refusing silent local fallback")
            raise
    return LocalEncryptedBackend()


def cleanup_expired_storage():
    try:
        try:
            # Log at most once per 15 minutes (cleanup runs often)
            _du = _disk_usage_mb()
            _now = time.time()
            _last = getattr(cleanup_expired_storage, "_last_log_at", 0.0)
            if _now - _last >= 900:
                print(f"[STORAGE] disk usage {_du:.1f} MB / {STORAGE_HARD_DISK_CAP_MB} MB")
                cleanup_expired_storage._last_log_at = _now
        except Exception:
            pass
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        now = datetime.now(timezone.utc).isoformat()
        rows = conn.execute(
            "SELECT public_token, backend FROM storage_objects "
            "WHERE status='active' AND expires_at < ?",
            (now,),
        ).fetchall()
        backend = None
        try:
            backend = get_backend()
        except Exception:
            backend = LocalEncryptedBackend()
        for r in rows:
            try:
                backend.delete_all(r["public_token"])
            except Exception:
                LocalEncryptedBackend().delete_all(r["public_token"])
            conn.execute(
                "UPDATE storage_objects SET status='expired' WHERE public_token=?",
                (r["public_token"],),
            )
        conn.commit()
        conn.close()
    except Exception as exc:
        print(f"[STORAGE] cleanup error: {exc}")


def _device_key(deps) -> str | None:
    fn = deps.get("_client_device_id")
    if not callable(fn):
        return None
    try:
        d = fn() or ""
    except Exception:
        return None
    if not d or d == "anon" or len(d) < 16:
        return None
    return f"stg:{d}"


def _mount_routes(app, deps):
    get_db = deps["get_db"]
    jsonify = deps["jsonify"]
    HAS_FLASK = deps["HAS_FLASK"]
    render_template = deps.get("render_template")
    rate_ok = deps["_rate_ok"]
    rate_key = deps["_rate_key"]
    rate_global = deps.get("_rate_global")
    claim_tx = deps.get("_claim_tx")
    tx_already = deps.get("_tx_already_used")
    verify_nch = deps["verify_nch_payment_on_chain"]
    ExplorerUnavailable = deps["ExplorerUnavailable"]
    PaymentVerificationError = deps["PaymentVerificationError"]
    normalize_txid = deps["_normalize_txid"]
    is_plausible_txid = deps["_is_plausible_txid"]

    @app.route("/storage")
    def storage_shell():
        if HAS_FLASK and render_template:
            try:
                from app import build_og_meta
                meta = build_og_meta("storage", path="/storage")
            except Exception:
                meta = {}
            return render_template(
                "storage.html",
                pay_address=NCH_PAYMENT_ADDRESS,
                tiers=_public_tiers(),
                storage_backend=(STORAGE_BACKEND or "local"),
                **meta,
            )
        return ("Storage UI requires Flask templates", 500)

    # No anonymous public object page — private vault only
    @app.route("/storage/o/<token>")
    def storage_legacy_public(token):
        return jsonify({
            "success": False,
            "error": "NESS Storage is a private vault. Use the Storage app while signed in on your device. For shareable encrypted drops, use NESS Burn.",
        }), 404

    @app.route("/api/storage/health", methods=["GET"])
    def api_storage_health():
        return jsonify({
            "success": True,
            "product": "storage",
            "backend": STORAGE_BACKEND or "local",
            "private": True,
        })

    def _read_blobs(tier, fr):
        uploaded = fr.files.getlist("files") or []
        if not uploaded:
            return None, (jsonify({"success": False, "error": "No file provided"}), 400)
        max_n = int(tier.get("max_objects") or 0)  # 0 = unlimited
        max_bytes = int(tier["max_size_mb"]) * 1024 * 1024
        if fr.content_length and fr.content_length > max_bytes + 512 * 1024:
            return None, (jsonify({
                "success": False,
                "error": f"Request too large (max {tier['max_size_mb']} MB).",
            }), 413)
        total = 0
        blobs = []
        for f in uploaded:
            data = f.read()
            total += len(data)
            if total > max_bytes:
                return None, (jsonify({
                    "success": False,
                    "error": f"Total size exceeds {tier['max_size_mb']} MB.",
                }), 400)
            fname = _sanitize_filename(getattr(f, "filename", None) or "object.bin")
            mime = getattr(f, "mimetype", None) or "application/octet-stream"
            blobs.append((fname, data, mime))
        return blobs, None

    def _active_count(db, creator_key):
        row = db.execute(
            "SELECT COUNT(*) AS c FROM storage_objects "
            "WHERE creator_key = ? AND status = 'active' AND expires_at > ?",
            (creator_key, datetime.now(timezone.utc).isoformat()),
        ).fetchone()
        return int(row[0] if row else 0)

    def _store(db, creator_key, plan_id, tier, blobs, tx_hash, amount, label):
        backend = get_backend()
        token = secrets.token_urlsafe(18)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(minutes=int(tier["ttl_minutes"]))
        meta = []
        total = 0
        try:
            for fname, data, mime in blobs:
                put = backend.put(token, fname, data)
                meta.append({
                    "filename": put.get("filename") or fname,
                    "ref": put.get("ref") or put.get("filename"),
                    "size": len(data),
                    "content_type": mime,
                    "cid": put.get("cid"),
                })
                total += len(data)
            import json as _json
            db.execute(
                """INSERT INTO storage_objects
                   (public_token, plan, expires_at, transaction_hash, amount_nch,
                    status, total_bytes, files_json, creator_key, label, backend)
                   VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)""",
                (
                    token,
                    plan_id,
                    expires.isoformat(),
                    tx_hash,
                    amount,
                    total,
                    _json.dumps(meta),
                    creator_key,
                    label or None,
                    getattr(backend, "name", "local"),
                ),
            )
            db.commit()
            return {
                "success": True,
                "token": token,
                "plan": plan_id,
                "expires_at": expires.isoformat(),
                "files": meta,
                "badge_class": tier.get("badge_class") or "",
                "backend": getattr(backend, "name", "local"),
                "private": True,
            }
        except Exception:
            try:
                backend.delete_all(token)
            except Exception:
                pass
            raise


    @app.route("/api/storage/create", methods=["POST"])
    def api_storage_create():
        if rate_global and not rate_global("stg_create", limit=60, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("stg_create"), limit=6, window=60):
            return jsonify({"success": False, "error": "Too many uploads. Slow down."}), 429
        creator = _device_key(deps)
        if not creator:
            return jsonify({
                "success": False,
                "error": "Device identity required for private storage.",
            }), 400
        if not HAS_FLASK:
            return jsonify({"success": False, "error": "Flask required"}), 503
        from flask import request as fr
        plan_id = _safe_plan(fr.form.get("plan") or "spark") or "spark"
        tier = STORAGE_TIERS[plan_id]
        if int(tier["price_nch"]) > 0:
            return jsonify({
                "success": False,
                "error": "This plan requires NCH payment.",
            }), 402
        db = get_db()
        if _disk_usage_mb() >= STORAGE_HARD_DISK_CAP_MB:
            return jsonify({"success": False, "error": "Storage is at capacity. Try again later."}), 503
        if plan_id == "spark":
            if _active_count(db, creator) >= FREE_TIER_DEVICE_OBJECTS:
                return jsonify({"success": False, "error": "Free tier allows 3 active objects. Upgrade or delete."}), 400
            if _active_bytes(db, creator) >= FREE_TIER_DEVICE_BYTES:
                return jsonify({"success": False, "error": "Free tier storage is full. Upgrade or delete."}), 400
        _mo = int(tier.get("max_objects") or 0)
        if _mo > 0 and _active_count(db, creator) >= _mo:
            return jsonify({
                "success": False,
                "error": f"Plan allows at most {_mo} active object(s).",
            }), 400
        blobs, err = _read_blobs(tier, fr)
        if err:
            return err
        label = (fr.form.get("label") or "").strip()[:120]
        try:
            return jsonify(_store(db, creator, plan_id, tier, blobs, None, None, label))
        except Exception as exc:
            print(f"[STORAGE] create: {exc}")
            return jsonify({"success": False, "error": "Could not store object"}), 500

    @app.route("/api/storage/pay", methods=["POST"])
    def api_storage_pay():
        if rate_global and not rate_global("stg_pay", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy, try again later"}), 503
        if not rate_ok(rate_key("stg_pay"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        creator = _device_key(deps)
        if not creator:
            return jsonify({
                "success": False,
                "error": "Device identity required for private storage.",
            }), 400
        if not HAS_FLASK:
            return jsonify({"success": False, "error": "Flask required"}), 503
        from flask import request as fr
        plan_id = _safe_plan(fr.form.get("plan"))
        if not plan_id or int(STORAGE_TIERS[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Invalid paid plan"}), 400
        tier = STORAGE_TIERS[plan_id]
        tx_hash = normalize_txid(fr.form.get("tx_hash") or "")
        if not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid transaction hash"}), 400
        intent_id = (fr.form.get("intent_id") or "").strip()
        if not intent_id:
            return jsonify({"success": False, "error": "Missing payment intent"}), 400
        db = get_db()
        if tx_already and tx_already(db, tx_hash):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'storage'",
            (intent_id,),
        ).fetchone()
        if not intent:
            return jsonify({"success": False, "error": "Payment intent not found or already used"}), 404
        if (intent["plan"] or "") != plan_id:
            return jsonify({"success": False, "error": "Plan mismatch"}), 400
        required_nch = int(intent["amount_nch"])
        try:
            verify_nch(
                tx_hash,
                expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch,
                exact_amount=False,
            )
        except ExplorerUnavailable as e:
            payload_fn = deps.get("_explorer_unavailable_payload")
            if payload_fn:
                return jsonify(payload_fn(e)), 503
            return jsonify({"success": False, "error": str(e), "explorer_ok": False}), 503
        except PaymentVerificationError as e:
            return jsonify({
                "success": False, "error": str(e), "explorer_ok": True,
            }), getattr(e, "http_status", 400)

        # All business validation BEFORE claim (never consume NCH on quota/upload failure)
        if _disk_usage_mb() >= STORAGE_HARD_DISK_CAP_MB:
            return jsonify({
                "success": False,
                "error": "Storage is at capacity. Try again later.",
            }), 503
        _mo = int(tier.get("max_objects") or 0)
        if _mo > 0 and _active_count(db, creator) >= _mo:
            return jsonify({
                "success": False,
                "error": f"Plan allows at most {_mo} active object(s).",
            }), 400
        blobs, err = _read_blobs(tier, fr)
        if err:
            return err
        label = (fr.form.get("label") or "").strip()[:120]

        if claim_tx and not claim_tx(db, tx_hash, "storage", amount_nch=required_nch):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        try:
            db.execute(
                "UPDATE payment_intents SET status='paid', tx_hash=?, verified_at=? WHERE intent_id=?",
                (tx_hash, datetime.now(timezone.utc).isoformat(), intent_id),
            )
        except Exception:
            pass
        try:
            return jsonify(_store(
                db, creator, plan_id, tier, blobs,
                tx_hash, float(tier["price_nch"]), label,
            ))
        except Exception as exc:
            print(f"[STORAGE] pay: {exc}")
            # Roll back claim so the user can retry without losing NCH
            try:
                db.execute("DELETE FROM used_transactions WHERE tx_hash = ?", (tx_hash,))
                db.execute(
                    "UPDATE payment_intents SET status='pending', tx_hash=NULL, verified_at=NULL WHERE intent_id=?",
                    (intent_id,),
                )
                db.commit()
            except Exception as rb:
                print(f"[STORAGE] claim rollback failed: {rb}")
            return jsonify({
                "success": False,
                "error": "Storage failed after payment check — retry, charge not kept.",
            }), 500

    @app.route("/api/storage/mine", methods=["GET"])
    def api_storage_mine():
        creator = _device_key(deps)
        if not creator:
            return jsonify({"success": True, "items": []})
        if not rate_ok(rate_key("stg_mine"), limit=30, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        db = get_db()
        now = datetime.now(timezone.utc).isoformat()
        rows = db.execute(
            "SELECT public_token, plan, created_at, expires_at, total_bytes, "
            "files_json, label, backend, status "
            "FROM storage_objects WHERE creator_key = ? AND status = 'active' "
            "AND expires_at > ? ORDER BY created_at DESC LIMIT 100",
            (creator, now),
        ).fetchall()
        items = []
        for r in rows:
            files = json.loads(r[5] or "[]")
            items.append({
                "token": r[0],
                "plan": r[1],
                "created_at": r[2],
                "expires_at": r[3],
                "total_bytes": r[4],
                "files": files,
                "label": r[6] or "",
                "backend": r[7] or "local",
            })
        return jsonify({"success": True, "items": items})

    @app.route("/api/storage/<token>", methods=["GET"])
    def api_storage_get(token):
        token = (token or "").strip()
        if not _TOKEN_RE.match(token):
            return jsonify({"success": False, "error": "Not found"}), 404
        creator = _device_key(deps)
        if not creator:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        db = get_db()
        row = db.execute(
            "SELECT * FROM storage_objects WHERE public_token = ? AND creator_key = ?",
            (token, creator),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        if row["status"] != "active":
            return jsonify({"success": False, "error": "Expired or deleted"}), 410
        files = json.loads(row["files_json"] or "[]")
        return jsonify({
            "success": True,
            "token": token,
            "plan": row["plan"],
            "label": row["label"] or "",
            "expires_at": row["expires_at"],
            "files": files,
            "total_bytes": row["total_bytes"],
            "backend": row["backend"] if "backend" in row.keys() else "local",
            "private": True,
        })

    @app.route("/api/storage/<token>/file/<int:idx>", methods=["GET"])
    def api_storage_file(token, idx):
        token = (token or "").strip()
        if not _TOKEN_RE.match(token):
            return jsonify({"success": False, "error": "Not found"}), 404
        creator = _device_key(deps)
        if not creator:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        if not rate_ok(rate_key("stg_get"), limit=60, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        db = get_db()
        row = db.execute(
            "SELECT * FROM storage_objects WHERE public_token = ? AND creator_key = ? AND status = 'active'",
            (token, creator),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        files = json.loads(row["files_json"] or "[]")
        if idx < 0 or idx >= len(files):
            return jsonify({"success": False, "error": "File not found"}), 404
        meta = files[idx]
        ref = meta.get("ref") or meta.get("filename")
        try:
            backend = get_backend()
        except Exception as exc:
            print(f"[STORAGE] backend unavailable: {exc}")
            if (STORAGE_BACKEND or "local").lower() == "ipfs":
                return jsonify({
                    "success": False,
                    "error": "Storage backend temporarily unavailable. Try again shortly.",
                }), 503
            backend = LocalEncryptedBackend()
        data = backend.get(token, ref)
        if data is None and getattr(backend, "name", "") != "local":
            data = LocalEncryptedBackend().get(token, ref)
        if data is None:
            return jsonify({"success": False, "error": "File missing"}), 404
        if HAS_FLASK:
            from flask import Response
            return Response(
                data,
                mimetype="application/octet-stream",
                headers={
                    "Content-Disposition": f'attachment; filename="{meta.get("filename") or "object.bin"}"',
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        return data

    @app.route("/api/storage/<token>/renew", methods=["POST"])
    def api_storage_renew(token):
        """Extend object TTL: remaining + full plan duration after paid intent."""
        token = (token or "").strip()
        if not _TOKEN_RE.match(token):
            return jsonify({"success": False, "error": "Not found"}), 404
        if not rate_ok(rate_key("stg_renew"), limit=10, window=60):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        if rate_global and not rate_global("stg_renew", limit=30, window=60):
            return jsonify({"success": False, "error": "Service busy"}), 503
        creator = _device_key(deps)
        if not creator:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        if not HAS_FLASK:
            return jsonify({"success": False, "error": "Flask required"}), 503
        from flask import request as fr
        plan_id = _safe_plan(fr.form.get("plan"))
        intent_id = (fr.form.get("intent_id") or "").strip()
        tx_hash = normalize_txid(fr.form.get("tx_hash") or "")
        if not plan_id or not intent_id or not is_plausible_txid(tx_hash):
            return jsonify({"success": False, "error": "Invalid renew request"}), 400
        if int(STORAGE_TIERS[plan_id]["price_nch"]) <= 0:
            return jsonify({"success": False, "error": "Renew requires a paid plan"}), 400
        db = get_db()
        row = db.execute(
            "SELECT * FROM storage_objects WHERE public_token = ? AND creator_key = ? AND status = 'active'",
            (token, creator),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        intent = db.execute(
            "SELECT * FROM payment_intents WHERE intent_id = ? AND status = 'pending' AND product = 'storage'",
            (intent_id,),
        ).fetchone()
        if not intent or (intent["plan"] or "") != plan_id:
            return jsonify({"success": False, "error": "Invalid payment intent"}), 404
        required_nch = int(intent["amount_nch"])
        if tx_already and tx_already(db, tx_hash):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        try:
            verify_nch(
                tx_hash, expected_address=NCH_PAYMENT_ADDRESS,
                min_hours=required_nch, exact_amount=False,
            )
        except ExplorerUnavailable as e:
            payload_fn = deps.get("_explorer_unavailable_payload")
            if payload_fn:
                return jsonify(payload_fn(e)), 503
            return jsonify({"success": False, "error": str(e)}), 503
        except PaymentVerificationError as e:
            return jsonify({"success": False, "error": str(e)}), getattr(e, "http_status", 400)
        if claim_tx and not claim_tx(db, tx_hash, "storage", amount_nch=required_nch):
            return jsonify({"success": False, "error": "Transaction already used"}), 409
        now = datetime.now(timezone.utc)
        try:
            exp = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
        except Exception:
            exp = now
        remaining = max(0.0, (exp - now).total_seconds())
        new_exp = now + timedelta(seconds=remaining) + timedelta(
            minutes=int(STORAGE_TIERS[plan_id]["ttl_minutes"])
        )
        db.execute(
            "UPDATE storage_objects SET expires_at = ?, plan = ? WHERE public_token = ?",
            (new_exp.isoformat(), plan_id, token),
        )
        try:
            db.execute(
                "UPDATE payment_intents SET status='paid', tx_hash=?, verified_at=? WHERE intent_id=?",
                (tx_hash, now.isoformat(), intent_id),
            )
            db.commit()
        except Exception:
            pass
        return jsonify({"success": True, "expires_at": new_exp.isoformat(), "plan": plan_id})

    @app.route("/api/storage/<token>", methods=["DELETE"])
    def api_storage_delete(token):
        token = (token or "").strip()
        if not _TOKEN_RE.match(token):
            return jsonify({"success": False, "error": "Not found"}), 404
        creator = _device_key(deps)
        if not creator:
            return jsonify({"success": False, "error": "Device identity required"}), 400
        if not rate_ok(rate_key("stg_del"), limit=20, window=60):
            return jsonify({"success": False, "error": "Too many requests"}), 429
        db = get_db()
        row = db.execute(
            "SELECT * FROM storage_objects WHERE public_token = ? AND creator_key = ?",
            (token, creator),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "Not found"}), 404
        try:
            get_backend().delete_all(token)
        except Exception:
            LocalEncryptedBackend().delete_all(token)
        db.execute(
            "UPDATE storage_objects SET status='deleted' WHERE public_token = ?",
            (token,),
        )
        try:
            db.commit()
        except Exception:
            pass
        return jsonify({"success": True})
