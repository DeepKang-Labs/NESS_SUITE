/* NESS local vault — AES-GCM only. No plaintext-at-rest fallback.
 *
 * Modes:
 * - device (default): DEK wrapped by a device secret also in localStorage.
 *   Protects casual inspection / partial dumps. Does NOT protect XSS or full
 *   profile theft (attacker with localStorage has wrap secret + blob).
 * - passphrase: DEK wrapped via PBKDF2(passphrase). Real protection at rest
 *   when passphrase is not stored. Requires unlock prompt after reload.
 */
(function (global) {
  "use strict";

  var META_KEY = "ness_vault_meta_v1";
  var DEVICE_WRAP_KEY = "ness_vault_device_wrap_v1";
  var PBKDF2_ITERATIONS = 120000;
  var TEXT_ENCODER = new TextEncoder();
  var TEXT_DECODER = new TextDecoder();

  var _dek = null;
  var _unlocked = false;

  function hasWebCrypto() {
    return !!(global.crypto && crypto.subtle && crypto.getRandomValues);
  }

  function b64encode(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64decode(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function randomBytes(n) {
    var u = new Uint8Array(n);
    crypto.getRandomValues(u);
    return u;
  }

  async function importAesKey(raw) {
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function generateDek() {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }

  async function exportRaw(key) {
    return crypto.subtle.exportKey("raw", key);
  }

  async function deriveWrapKey(passphrase, saltBuf) {
    var base = await crypto.subtle.importKey(
      "raw",
      TEXT_ENCODER.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBuf,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function wrapDek(dek, wrapKey) {
    var iv = randomBytes(12);
    var raw = await exportRaw(dek);
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, wrapKey, raw);
    return { iv: b64encode(iv), ct: b64encode(ct) };
  }

  async function unwrapDek(blob, wrapKey) {
    var iv = new Uint8Array(b64decode(blob.iv));
    var ct = b64decode(blob.ct);
    var raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, wrapKey, ct);
    return importAesKey(raw);
  }

  function readMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function writeMeta(meta) {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function getOrCreateDeviceSecret() {
    var existing = localStorage.getItem(DEVICE_WRAP_KEY);
    if (existing && existing.length >= 32) return existing;
    var bytes = randomBytes(32);
    var s = b64encode(bytes);
    localStorage.setItem(DEVICE_WRAP_KEY, s);
    return s;
  }

  async function ensureVault(passphrase) {
    if (!hasWebCrypto()) {
      _dek = null;
      _unlocked = false;
      return { ok: false, error: "WebCrypto unavailable — cannot encrypt local data" };
    }

    var meta = readMeta();
    var pass = (passphrase || "").trim();

    if (!meta) {
      var dek = await generateDek();
      var salt = randomBytes(16);
      // MVP: device mode only for auto-boot. Passphrase mode requires explicit setPassphrase + unlock.
      var wrapKey = await deriveWrapKey(getOrCreateDeviceSecret(), salt);
      var wrapped = await wrapDek(dek, wrapKey);
      writeMeta({
        v: 1,
        mode: "device",
        salt: b64encode(salt),
        wrapped: wrapped,
        created: Date.now(),
      });
      _dek = dek;
      _unlocked = true;
      return { ok: true, mode: "device" };
    }

    if (meta.mode === "passphrase") {
      if (!pass) {
        _dek = null;
        _unlocked = false;
        return { ok: false, needPassphrase: true, error: "Vault passphrase required" };
      }
      try {
        var saltBuf = b64decode(meta.salt);
        var wrapKeyP = await deriveWrapKey(pass, saltBuf);
        _dek = await unwrapDek(meta.wrapped, wrapKeyP);
        _unlocked = true;
        return { ok: true, mode: "passphrase" };
      } catch (e) {
        _dek = null;
        _unlocked = false;
        return { ok: false, needPassphrase: true, error: "Invalid passphrase" };
      }
    }

    // device mode
    try {
      var saltBuf2 = b64decode(meta.salt);
      var wrapKeyD = await deriveWrapKey(getOrCreateDeviceSecret(), saltBuf2);
      _dek = await unwrapDek(meta.wrapped, wrapKeyD);
      _unlocked = true;
      return { ok: true, mode: "device" };
    } catch (e) {
      _dek = null;
      _unlocked = false;
      return { ok: false, error: "Vault corrupted or device secret missing" };
    }
  }

  async function setPassphrase(newPass) {
    // Disabled until unlock UI ships — refuse to strand users.
    return {
      ok: false,
      error: "Passphrase vault UI not enabled yet. Device mode only.",
    };
  }

  async function clearPassphraseToDevice() {
    if (!_unlocked || !_dek) return { ok: false, error: "Vault locked" };
    var salt = randomBytes(16);
    var wrapKey = await deriveWrapKey(getOrCreateDeviceSecret(), salt);
    var wrapped = await wrapDek(_dek, wrapKey);
    writeMeta({
      v: 1,
      mode: "device",
      salt: b64encode(salt),
      wrapped: wrapped,
      created: Date.now(),
    });
    return { ok: true, mode: "device" };
  }

  function isUnlocked() {
    return _unlocked && !!_dek;
  }

  function vaultMode() {
    var m = readMeta();
    return m ? m.mode : null;
  }

  async function encryptBytes(bytes) {
    if (!hasWebCrypto()) {
      throw new Error("WebCrypto unavailable — cannot encrypt");
    }
    if (!_dek) {
      throw new Error("Vault locked — unlock before encrypting");
    }
    var iv = randomBytes(12);
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, _dek, bytes);
    return { v: 1, alg: "AES-GCM", iv: b64encode(iv), ct: b64encode(ct) };
  }

  async function decryptBytes(payload) {
    if (!payload) throw new Error("empty payload");
    if (payload.plaintext || payload.v === 0) {
      // Legacy plaintext envelopes — read once for migration only
      return b64decode(payload.data);
    }
    if (!_dek) throw new Error("Vault locked");
    var iv = new Uint8Array(b64decode(payload.iv));
    var ct = b64decode(payload.ct);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, _dek, ct);
  }

  async function encryptJson(obj) {
    return encryptBytes(TEXT_ENCODER.encode(JSON.stringify(obj)));
  }

  async function decryptJson(payload) {
    var bytes = await decryptBytes(payload);
    return JSON.parse(TEXT_DECODER.decode(bytes));
  }

  async function encryptArrayBuffer(buf) {
    return encryptBytes(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
  }

  async function decryptToArrayBuffer(payload) {
    return decryptBytes(payload);
  }

  var DEVICE_ID_KEYS = ["ness-device-id", "ness_device_id", "ness-tempmail-device"];

  function deviceId() {
    var id = null;
    for (var i = 0; i < DEVICE_ID_KEYS.length; i++) {
      try {
        var v = localStorage.getItem(DEVICE_ID_KEYS[i]);
        if (v && /^[A-Za-z0-9_\-]{16,64}$/.test(v)) { id = v; break; }
      } catch (e) {}
    }
    if (!id) {
      id = "d_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    for (var j = 0; j < DEVICE_ID_KEYS.length; j++) {
      try { localStorage.setItem(DEVICE_ID_KEYS[j], id); } catch (e) {}
    }
    return id;
  }

  global.NessVault = {
    ensureVault: ensureVault,
    setPassphrase: setPassphrase,
    clearPassphraseToDevice: clearPassphraseToDevice,
    isUnlocked: isUnlocked,
    vaultMode: vaultMode,
    encryptJson: encryptJson,
    decryptJson: decryptJson,
    encryptArrayBuffer: encryptArrayBuffer,
    decryptToArrayBuffer: decryptToArrayBuffer,
    hasWebCrypto: hasWebCrypto,
    deviceId: deviceId,
  };
})(typeof window !== "undefined" ? window : globalThis);
