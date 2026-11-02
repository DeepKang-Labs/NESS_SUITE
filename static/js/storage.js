/* NESS Storage — private vault; plan-first; encrypted drafts; no restore after intentional clear */
(function () {
  "use strict";

  var PLAN_ORDER = ["spark", "flash", "day", "week", "month"];
  var selectedPlanId = "spark";
  var selectedFiles = [];
  var pendingIntentId = null;
  var pendingIntentAmount = null;
  var STG_DRAFT_KEY = "ness_stg_draft_v1";
  var STG_IDB_NAME = "ness_stg_idb";
  var STG_IDB_STORE = "files";
  var STG_INTENT_KEY = "ness_pay_intent_storage";
  var draftRestoring = false;

  function el(id) { return document.getElementById(id); }

  function setPayBtnBusy(btn, busy, idleLabel) {
    if (!btn) return;
    if (busy) {
      if (!btn.getAttribute("data-idle-label")) btn.setAttribute("data-idle-label", btn.textContent);
      btn.disabled = true;
      btn.classList.add("is-busy");
      btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Verifying…';
    } else {
      btn.disabled = false;
      btn.classList.remove("is-busy");
      btn.textContent = idleLabel || btn.getAttribute("data-idle-label") || "Verify & store";
    }
  }



  function toast(msg, type) {
    type = type || "ok";
    var root = el("toasts");
    if (!root) return;
    var node = document.createElement("div");
    node.className = "toast " + type;
    node.textContent = msg;
    root.appendChild(node);
    requestAnimationFrame(function () { node.classList.add("show"); });
    setTimeout(function () {
      node.classList.remove("show");
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 280);
    }, 3800);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function formatQuotaMb(mb) {
    mb = Number(mb) || 0;
    if (mb >= 1024) return (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1) + " GB";
    return mb + " MB";
  }

  function formatPrice(n) {
    n = Number(n) || 0;
    return n <= 0 ? "Free" : n.toLocaleString("en-US") + " NCH";
  }

  function formatRemain(iso) {
    if (!iso) return "—";
    var ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "Expired";
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return d + "d " + (h % 24) + "h";
    if (h > 0) return h + "h " + (m % 60) + "m";
    return (m % 60) + "m";
  }

  function deviceId() {
    if (window.NessVault && NessVault.deviceId) return NessVault.deviceId();
    try {
      var id = localStorage.getItem("ness-device-id");
      if (id && /^[A-Za-z0-9_\-]{16,64}$/.test(id)) return id;
      id = "d_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("ness-device-id", id);
      return id;
    } catch (e) { return "anon"; }
  }

  function ajaxHeaders() {
    return { "X-Device-Id": deviceId(), "X-Requested-With": "XMLHttpRequest" };
  }

  function ensureVault() {
    if (!window.NessVault) return Promise.reject(new Error("Vault unavailable"));
    return NessVault.ensureVault().then(function (r) {
      if (r && r.ok === false && r.needPassphrase) {
        throw new Error("Unlock your NESS vault to use private storage");
      }
      if (!NessVault.isUnlocked()) throw new Error("Vault locked");
      return r;
    });
  }

  function initThemeToggle() {
    var btn = el("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (document.documentElement.getAttribute("data-theme") === "light") {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.setItem("ness_theme", "dark"); } catch (e) {}
      } else {
        document.documentElement.setAttribute("data-theme", "light");
        try { localStorage.setItem("ness_theme", "light"); } catch (e) {}
      }
    });
  }

  function showOnly(id) {
    ["plans-card", "compose-card", "library-card"].forEach(function (c) {
      var n = el(c);
      if (n) n.style.display = c === id ? "" : "none";
    });
  }

  function orderedPlanIds() {
    var ids = PLAN_ORDER.filter(function (id) { return TIERS[id]; });
    Object.keys(TIERS || {}).forEach(function (id) {
      if (ids.indexOf(id) < 0) ids.push(id);
    });
    return ids;
  }

  function renderPlans() {
    var root = el("plans");
    if (!root || typeof TIERS === "undefined") return;
    root.innerHTML = "";
    orderedPlanIds().forEach(function (id) {
      var t = TIERS[id];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "plan" + (id === selectedPlanId ? " selected" : "");
      btn.setAttribute("data-plan", id);
      btn.innerHTML =
        '<span class="badge ' + escapeHtml(t.badge_class || "") + '">' + escapeHtml(t.label || id) + "</span>" +
        '<span class="plan-price">' + escapeHtml(formatPrice(t.price_nch)) + "</span>" +
        '<span class="plan-meta">' + escapeHtml(formatQuotaMb(t.max_size_mb)) + (Number(t.max_objects) > 0 ? " · " + escapeHtml(String(t.max_objects)) + " objects" : " · unlimited files") + "</span>" +
        '<span class="plan-tag">' + escapeHtml(t.tagline || "") + "</span>";
      btn.addEventListener("click", function () {
        selectedPlanId = id;
        renderPlans();
      });
      root.appendChild(btn);
    });
  }

  /* ── IndexedDB encrypted file draft (mirrors Burn rules) ── */
  function idbOpen() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req = indexedDB.open(STG_IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STG_IDB_STORE)) {
          db.createObjectStore(STG_IDB_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }

  async function idbSaveFiles(files) {
    var db = await idbOpen();
    if (!db) return;
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    var payloads = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var buf = await f.arrayBuffer();
      if (!window.NessVault || !NessVault.isUnlocked()) continue;
      var sealed = await NessVault.encryptArrayBuffer(buf);
      payloads.push({
        name: f.name,
        type: f.type || "application/octet-stream",
        lastModified: f.lastModified || Date.now(),
        sealed: sealed,
      });
    }
    return new Promise(function (resolve) {
      var tx = db.transaction(STG_IDB_STORE, "readwrite");
      tx.objectStore(STG_IDB_STORE).put({ v: 1, enc: true, files: payloads }, "draft_files");
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  async function idbLoadFiles() {
    var db = await idbOpen();
    if (!db) return [];
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    return new Promise(function (resolve) {
      var tx = db.transaction(STG_IDB_STORE, "readonly");
      var req = tx.objectStore(STG_IDB_STORE).get("draft_files");
      req.onsuccess = async function () {
        var row = req.result;
        if (!row || !row.files || !row.files.length) return resolve([]);
        var out = [];
        for (var i = 0; i < row.files.length; i++) {
          var item = row.files[i];
          try {
            var buf = await NessVault.decryptToArrayBuffer(item.sealed);
            out.push(new File([buf], item.name, {
              type: item.type || "application/octet-stream",
              lastModified: item.lastModified || Date.now(),
            }));
          } catch (e) {}
        }
        resolve(out);
      };
      req.onerror = function () { resolve([]); };
    });
  }

  async function idbClearFiles() {
    var db = await idbOpen();
    if (!db) return;
    return new Promise(function (resolve) {
      var tx = db.transaction(STG_IDB_STORE, "readwrite");
      tx.objectStore(STG_IDB_STORE).delete("draft_files");
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }

  function clearStorageDraft() {
    try { localStorage.removeItem(STG_DRAFT_KEY); } catch (e) {}
    idbClearFiles().catch(function () {});
  }

  function saveStorageDraft() {
    if (draftRestoring) return;
    (async function () {
      try {
        if (window.NessVault && !NessVault.isUnlocked()) {
          await NessVault.ensureVault();
        }
        var label = (el("obj-label") && el("obj-label").value) || "";
        var hasContent = selectedFiles.length > 0 || (label && label.trim());
        // Only persist when there is meaningful content (Burn I-3 pattern)
        if (!hasContent) {
          clearStorageDraft();
          return;
        }
        var payload = {
          plan: selectedPlanId,
          label: label,
          stage: "compose",
          saved_at: Date.now(),
        };
        if (window.NessVault && NessVault.isUnlocked()) {
          var sealed = await NessVault.encryptJson(payload);
          localStorage.setItem(STG_DRAFT_KEY, JSON.stringify({ v: 1, enc: true, sealed: sealed }));
        }
        await idbSaveFiles(selectedFiles);
      } catch (e) {}
    })();
  }

  async function restoreStorageDraft() {
    var draft = null;
    try {
      if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
      var raw = JSON.parse(localStorage.getItem(STG_DRAFT_KEY) || "null");
      if (raw && raw.enc && raw.sealed && window.NessVault) {
        draft = await NessVault.decryptJson(raw.sealed);
      }
    } catch (e) {
      draft = null;
    }
    if (!draft || !draft.plan || !TIERS[draft.plan]) return false;

    var files = [];
    try { files = await idbLoadFiles(); } catch (e) { files = []; }
    var label = draft.label || "";
    var hasContent = (files && files.length) || (label && String(label).trim());
    if (!hasContent) {
      clearStorageDraft();
      return false;
    }

    draftRestoring = true;
    selectedPlanId = draft.plan;
    selectedFiles = files || [];
    renderPlans();
    if (el("obj-label")) el("obj-label").value = label;
    var t = TIERS[selectedPlanId] || {};
    if (el("compose-plan-hint")) {
      el("compose-plan-hint").textContent =
        (t.label || selectedPlanId) + " · " + (t.max_size_mb || 0) + " MB · " + formatPrice(t.price_nch);
    }
    renderFileList();
    showOnly("compose-card");
    draftRestoring = false;
    return true;
  }

  function renderFileList() {
    var ul = el("file-list");
    if (!ul) return;
    ul.innerHTML = "";
    selectedFiles.forEach(function (f, i) {
      var li = document.createElement("li");
      li.innerHTML =
        '<span class="file-name">' + escapeHtml(f.name) + "</span>" +
        '<span class="file-size">' + escapeHtml(formatBytes(f.size)) + "</span>" +
        '<button type="button" class="btn btn-ghost btn-sm rm" data-i="' + i + '" aria-label="Remove">×</button>';
      ul.appendChild(li);
    });
    ul.querySelectorAll(".rm").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedFiles.splice(parseInt(btn.getAttribute("data-i"), 10), 1);
        renderFileList();
        saveStorageDraft();
      });
    });
    var pub = el("btn-publish");
    if (pub) pub.disabled = !selectedFiles.length;
  }

  function addFiles(list) {
    var t = TIERS[selectedPlanId] || {};
    var maxN = Number(t.max_objects);
    if (!maxN || maxN < 0 || !isFinite(maxN)) maxN = Infinity;
    var maxBytes = (Number(t.max_size_mb) || 5) * 1024 * 1024;
    var total = selectedFiles.reduce(function (s, f) { return s + f.size; }, 0);
    Array.prototype.forEach.call(list || [], function (f) {
      if (selectedFiles.length >= maxN) {
        toast("At most " + maxN + " file(s) for this plan", "warn");
        return;
      }
      if (total + f.size > maxBytes) {
        toast("Exceeds " + t.max_size_mb + " MB", "warn");
        return;
      }
      selectedFiles.push(f);
      total += f.size;
    });
    renderFileList();
    saveStorageDraft();
  }

  function loadLibrary() {
    fetch("/api/storage/mine", { headers: ajaxHeaders(), credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = (data && data.items) || [];
        var ul = el("library-list");
        var empty = el("library-empty");
        if (!ul) return;
        ul.innerHTML = "";
        if (!items.length) {
          if (empty) empty.style.display = "";
          return;
        }
        if (empty) empty.style.display = "none";
        items.forEach(function (it) {
          var li = document.createElement("li");
          var names = (it.files || []).map(function (f) { return f.filename; }).join(", ");
          li.innerHTML =
            '<div class="lib-main">' +
              '<span class="file-name">' + escapeHtml(it.label || names || it.token) + "</span>" +
              '<span class="file-size">' + escapeHtml(formatBytes(it.total_bytes)) +
                " · " + escapeHtml(formatRemain(it.expires_at)) + "</span>" +
            "</div>" +
            '<button type="button" class="btn btn-sm lib-dl" data-token="' + escapeHtml(it.token) + '">Download</button>' +
            '<button type="button" class="btn btn-ghost btn-sm lib-renew" data-token="' + escapeHtml(it.token) + '" data-plan="' + escapeHtml(it.plan || "") + '">Renew</button>' +
            '<button type="button" class="btn btn-ghost btn-sm lib-del" data-token="' + escapeHtml(it.token) + '" aria-label="Delete">Delete</button>';
          ul.appendChild(li);
        });
        ul.querySelectorAll(".lib-dl").forEach(function (btn) {
          btn.addEventListener("click", function () { downloadObject(btn.getAttribute("data-token")); });
        });
        ul.querySelectorAll(".lib-renew").forEach(function (btn) {
          btn.addEventListener("click", function () {
            openRenewFlow(btn.getAttribute("data-token"), btn.getAttribute("data-plan"));
          });
        });
        ul.querySelectorAll(".lib-del").forEach(function (btn) {
          btn.addEventListener("click", function () { deleteObject(btn.getAttribute("data-token")); });
        });
      })
      .catch(function () {});
  }

  function fileToEncryptedBlob(file) {
    return file.arrayBuffer().then(function (buf) {
      return NessVault.encryptArrayBuffer(buf).then(function (payload) {
        var envelope = JSON.stringify({
          v: 1, name: file.name, type: file.type || "application/octet-stream", enc: payload,
        });
        return new Blob([envelope], { type: "application/json" });
      });
    });
  }

  function buildEncryptedForm(extra) {
    return ensureVault().then(function () {
      return Promise.all(selectedFiles.map(function (f) {
        return fileToEncryptedBlob(f).then(function (blob) {
          return { name: f.name + ".ness", blob: blob };
        });
      })).then(function (parts) {
        var fd = new FormData();
        fd.append("plan", selectedPlanId);
        var label = (el("obj-label") && el("obj-label").value) || "";
        if (label) fd.append("label", label.trim().slice(0, 120));
        parts.forEach(function (p) { fd.append("files", p.blob, p.name); });
        if (extra) Object.keys(extra).forEach(function (k) { fd.append(k, extra[k]); });
        return fd;
      });
    });
  }

  function afterSuccessfulStore() {
    selectedFiles = [];
    clearStorageDraft();
    try { sessionStorage.removeItem(STG_INTENT_KEY); } catch (e) {}
    pendingIntentId = null;
    pendingIntentAmount = null;
    showOnly("library-card");
    loadLibrary();
  }

  function storeFree() {
    var btn = el("btn-publish");
    if (btn) btn.disabled = true;
    buildEncryptedForm()
      .then(function (fd) {
        return fetch("/api/storage/create", {
          method: "POST", headers: ajaxHeaders(), body: fd, credentials: "same-origin",
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) btn.disabled = false;
        if (!data || !data.success) {
          toast((data && data.error) || "Store failed", "err");
          return;
        }
        toast("Stored privately", "ok");
        afterSuccessfulStore();
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        toast(e.message || "Store failed", "err");
      });
  }

  function openPay() {
    pendingIntentId = null;
    pendingIntentAmount = null;
    var t = TIERS[selectedPlanId] || {};
    el("pay-title").textContent = "Activate " + (t.label || "plan");
    el("pay-sub").textContent = "Preparing payment…";
    el("pay-address").textContent = typeof PAY_ADDRESS !== "undefined" ? PAY_ADDRESS : "—";
    el("pay-amount").innerHTML = "…";
    el("tx-hash").value = "";
    el("pay-modal").style.display = "flex";
    // Persist compose before leaving to pay
    saveStorageDraft();
    var fd = new FormData();
    fd.append("product", "storage");
    fd.append("plan", selectedPlanId);
    fetch("/api/payment/intent", { method: "POST", headers: ajaxHeaders(), body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          toast((data && data.error) || "Could not create payment intent", "err");
          el("pay-modal").style.display = "none";
          return;
        }
        pendingIntentId = data.intent_id;
        pendingIntentAmount = data.amount_nch;
        try {
          sessionStorage.setItem(STG_INTENT_KEY, JSON.stringify({
            intent_id: data.intent_id,
            amount_nch: data.amount_nch,
            plan: data.plan,
            expires_at: data.expires_at,
            pay_address: data.pay_address,
          }));
        } catch (e) {}
        el("pay-sub").textContent =
          "Send at least " + Number(data.amount_nch).toLocaleString() +
          " NCH to the address below, then paste the transaction hash.";
        el("pay-address").textContent = data.pay_address || PAY_ADDRESS;
        el("pay-amount").innerHTML = Number(data.amount_nch).toLocaleString() + " <span>NCH</span>";
      })
      .catch(function () {
        toast("Could not create payment intent", "err");
        el("pay-modal").style.display = "none";
      });
  }

  function storePaid(tx) {
    if (!pendingIntentId) {
      try {
        var _pi = JSON.parse(sessionStorage.getItem(STG_INTENT_KEY) || "null");
        if (_pi && _pi.intent_id && (!_pi.expires_at || new Date(_pi.expires_at).getTime() > Date.now())) {
          pendingIntentId = _pi.intent_id;
          pendingIntentAmount = _pi.amount_nch;
        }
      } catch (e) {}
    }
    if (!pendingIntentId) {
      toast("Payment session expired — reopen payment", "warn");
      return;
    }
    var btn = el("btn-pay-confirm");
    setPayBtnBusy(btn, true);
    buildEncryptedForm({ tx_hash: tx, intent_id: pendingIntentId })
      .then(function (fd) {
        return fetch("/api/storage/pay", {
          method: "POST", headers: ajaxHeaders(), body: fd, credentials: "same-origin",
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setPayBtnBusy(btn, false, "Verify & store");
        if (!data || !data.success) {
          toast((data && data.error) || "Payment failed", "err");
          return;
        }
        el("pay-modal").style.display = "none";
        try { sessionStorage.removeItem(STG_INTENT_KEY); } catch (e) {}
        toast("Payment verified · stored privately", "ok");
        afterSuccessfulStore();
      })
      .catch(function (e) {
        setPayBtnBusy(btn, false, "Verify & store");
        toast(e.message || "Store failed", "err");
      });
  }

  function downloadObject(token) {
    ensureVault()
      .then(function () {
        return fetch("/api/storage/" + encodeURIComponent(token), {
          headers: ajaxHeaders(), credentials: "same-origin",
        }).then(function (r) { return r.json(); });
      })
      .then(function (meta) {
        if (!meta || !meta.success) throw new Error((meta && meta.error) || "Not found");
        var chain = Promise.resolve();
        (meta.files || []).forEach(function (f, idx) {
          chain = chain.then(function () {
            return fetch("/api/storage/" + encodeURIComponent(token) + "/file/" + idx, {
              headers: ajaxHeaders(), credentials: "same-origin",
            }).then(function (r) {
              if (!r.ok) throw new Error("Download failed");
              return r.text();
            }).then(function (text) {
              var env = JSON.parse(text);
              if (!env.enc) throw new Error("Not an encrypted NESS object");
              return NessVault.decryptToArrayBuffer(env.enc).then(function (buf) {
                var blob = new Blob([buf], { type: env.type || "application/octet-stream" });
                var a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = env.name || f.filename || "file.bin";
                document.body.appendChild(a);
                a.click();
                a.remove();
              });
            });
          });
        });
        return chain;
      })
      .then(function () { toast("Decrypted on this device", "ok"); })
      .catch(function (e) { toast(e.message || "Download failed", "err"); });
  }

  function deleteObject(token) {
    var run = function () {
      fetch("/api/storage/" + encodeURIComponent(token), {
        method: "DELETE", headers: ajaxHeaders(), credentials: "same-origin",
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || !data.success) toast((data && data.error) || "Delete failed", "err");
        else { toast("Deleted", "ok"); loadLibrary(); }
      });
    };
    if (typeof nessConfirm === "function") {
      nessConfirm({
        title: "Delete private object?",
        message: "Removes ciphertext from the server. Cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      }).then(function (ok) { if (ok) run(); });
    } else if (window.confirm("Delete this private object?")) {
      run();
    }
  }

  function goPlansClearingDraft(confirmIfContent) {
    var go = function () {
      selectedFiles = [];
      if (el("obj-label")) el("obj-label").value = "";
      clearStorageDraft();
      renderFileList();
      showOnly("plans-card");
    };
    if (confirmIfContent && selectedFiles.length && typeof nessConfirm === "function") {
      nessConfirm({
        title: "Discard draft?",
        message: "Selected files will be cleared from this form.",
        confirmLabel: "Discard",
        danger: true,
      }).then(function (ok) { if (ok) go(); });
    } else {
      go();
    }
  }


  var renewToken = null;

  function openRenewFlow(token, plan) {
    renewToken = token;
    selectedPlanId = plan && TIERS[plan] ? plan : selectedPlanId;
    if (!TIERS[selectedPlanId] || Number(TIERS[selectedPlanId].price_nch) <= 0) {
      // Prefer first paid plan for free objects
      var ids = orderedPlanIds();
      for (var i = 0; i < ids.length; i++) {
        if (Number(TIERS[ids[i]].price_nch) > 0) { selectedPlanId = ids[i]; break; }
      }
    }
    pendingIntentId = null;
    pendingIntentAmount = null;
    var t = TIERS[selectedPlanId] || {};
    el("pay-title").textContent = "Renew · " + (t.label || "plan");
    el("pay-sub").textContent = "Remaining time is kept and the new plan duration is added.";
    el("pay-address").textContent = typeof PAY_ADDRESS !== "undefined" ? PAY_ADDRESS : "—";
    el("pay-amount").innerHTML = "…";
    el("tx-hash").value = "";
    el("pay-modal").style.display = "flex";
    var fd = new FormData();
    fd.append("product", "storage");
    fd.append("plan", selectedPlanId);
    fetch("/api/payment/intent", { method: "POST", headers: ajaxHeaders(), body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          toast((data && data.error) || "Could not create payment intent", "err");
          el("pay-modal").style.display = "none";
          renewToken = null;
          return;
        }
        pendingIntentId = data.intent_id;
        pendingIntentAmount = data.amount_nch;
        try {
          sessionStorage.setItem(STG_INTENT_KEY, JSON.stringify({
            intent_id: data.intent_id,
            amount_nch: data.amount_nch,
            plan: data.plan,
            expires_at: data.expires_at,
            pay_address: data.pay_address,
            renew_token: renewToken,
          }));
        } catch (e) {}
        el("pay-sub").textContent =
          "Send at least " + Number(data.amount_nch).toLocaleString() +
          " NCH. Remaining time will be added to the new period.";
        el("pay-address").textContent = data.pay_address || PAY_ADDRESS;
        el("pay-amount").innerHTML = Number(data.amount_nch).toLocaleString() + " <span>NCH</span>";
      })
      .catch(function () {
        toast("Could not create payment intent", "err");
        el("pay-modal").style.display = "none";
        renewToken = null;
      });
  }

  function confirmRenew(tx) {
    if (!renewToken) {
      try {
        var _pi = JSON.parse(sessionStorage.getItem(STG_INTENT_KEY) || "null");
        if (_pi && _pi.renew_token) renewToken = _pi.renew_token;
        if (_pi && _pi.intent_id) pendingIntentId = _pi.intent_id;
      } catch (e) {}
    }
    if (!renewToken || !pendingIntentId) {
      toast("Renew session expired — try again", "warn");
      return;
    }
    var btn = el("btn-pay-confirm");
    setPayBtnBusy(btn, true);
    if (btn) btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Renewing…';
    var fd = new FormData();
    fd.append("plan", selectedPlanId);
    fd.append("tx_hash", tx);
    fd.append("intent_id", pendingIntentId);
    fetch("/api/storage/" + encodeURIComponent(renewToken) + "/renew", {
      method: "POST", headers: ajaxHeaders(), body: fd, credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setPayBtnBusy(btn, false, "Verify & store");
        if (!data || !data.success) {
          toast((data && data.error) || "Renew failed", "err");
          return;
        }
        el("pay-modal").style.display = "none";
        renewToken = null;
        pendingIntentId = null;
        try { sessionStorage.removeItem(STG_INTENT_KEY); } catch (e) {}
        toast("Renewed · time remaining was kept", "ok");
        loadLibrary();
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        toast("Renew failed", "err");
      });
  }

  function bind() {
    initThemeToggle();
    renderPlans();

    var vaultBoot = window.NessVault ? NessVault.ensureVault() : Promise.resolve({ ok: true });
    vaultBoot.then(function () {
      return restoreStorageDraft();
    }).then(function (restored) {
      if (!restored) showOnly("plans-card");
    }).catch(function () {
      showOnly("plans-card");
    });

    el("btn-continue-plan").addEventListener("click", function () {
      var t = TIERS[selectedPlanId] || {};
      el("compose-plan-hint").textContent =
        (t.label || selectedPlanId) + " · " + (t.max_size_mb || 0) + " MB · " + formatPrice(t.price_nch);
      // Keep existing files if same session; only reset when empty
      if (!selectedFiles.length && el("obj-label")) {
        /* leave label */
      }
      renderFileList();
      showOnly("compose-card");
      // Do not save empty draft on mere plan continue
    });

    el("btn-back-plans").addEventListener("click", function () {
      goPlansClearingDraft(true);
    });

    el("btn-view-library").addEventListener("click", function () {
      showOnly("library-card");
      loadLibrary();
    });
    el("btn-back-from-lib").addEventListener("click", function () {
      showOnly("plans-card");
    });
    el("btn-add-from-lib").addEventListener("click", function () {
      showOnly("plans-card");
    });

    var dz = el("dropzone"), fin = el("file-input");
    if (dz && fin) {
      dz.addEventListener("click", function () { fin.click(); });
      dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
      dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
      dz.addEventListener("drop", function (e) {
        e.preventDefault(); dz.classList.remove("drag"); addFiles(e.dataTransfer.files);
      });
      fin.addEventListener("change", function () { addFiles(fin.files); fin.value = ""; });
    }

    if (el("obj-label")) {
      el("obj-label").addEventListener("blur", function () { saveStorageDraft(); });
    }

    el("btn-publish").addEventListener("click", function () {
      if (!selectedFiles.length) { toast("Add a file", "warn"); return; }
      saveStorageDraft();
      var t = TIERS[selectedPlanId] || {};
      if (Number(t.price_nch) > 0) openPay();
      else storeFree();
    });

    el("btn-pay-cancel").addEventListener("click", function () {
      el("pay-modal").style.display = "none";
      // Keep draft — user may retry payment
    });
    el("btn-pay-confirm").addEventListener("click", function () {
      var tx = (el("tx-hash").value || "").trim();
      if (tx.length < 16) { toast("Paste a valid tx hash", "warn"); return; }
      if (renewToken) confirmRenew(tx);
      else storePaid(tx);
    });
    el("btn-copy-pay").addEventListener("click", function () {
      var a = el("pay-address").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () { toast("Address copied", "ok"); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
