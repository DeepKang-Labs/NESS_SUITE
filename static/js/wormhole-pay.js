/* NESS Wormhole — access gate + NCH payment (intent → verify → license) */
(function () {
  "use strict";

  function deviceId() {
    try {
      var id = localStorage.getItem("ness-device-id");
      if (id && /^[A-Za-z0-9_-]{16,64}$/.test(id)) return id;
      var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
      id = "";
      var a = new Uint8Array(24);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (var i = 0; i < a.length; i++) id += chars[a[i] % chars.length];
      localStorage.setItem("ness-device-id", id);
      return id;
    } catch (e) {
      return "";
    }
  }

  function headers() {
    var h = {};
    var d = deviceId();
    if (d) h["X-Device-Id"] = d;
    return h;
  }

  function toast(msg, kind) {
    var root = document.getElementById("toasts");
    if (!root) return;
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () {
      try { el.remove(); } catch (e) {}
    }, 4200);
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function toolFromPath() {
    var p = (location.pathname || "").replace(/\/+$/, "");
    if (p.indexOf("/wormhole/dpo") === 0) return "dpo";
    if (p.indexOf("/wormhole/offline") === 0) return "offline";
    return "";
  }

  function fmtExpiry(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function setToolsVisible(on) {
    var gate = qs("#wh-pay-gate");
    var tools = qs("#wh-tool-body");
    if (gate) gate.style.display = on ? "none" : "";
    if (tools) tools.style.display = on ? "" : "none";
    document.querySelectorAll("[data-wh-requires-access]").forEach(function (el) {
      el.style.display = on ? "" : "none";
    });
  }

  function renderAccessMeta(data) {
    var label = qs("#wh-access-label");
    if (!label) return;
    if (data.free) {
      label.textContent = "Free access";
      return;
    }
    if (data.allowed && data.expires_at) {
      label.textContent = "Licensed until " + fmtExpiry(data.expires_at);
      return;
    }
    label.textContent = (data.price_nch || "?") + " NCH · access license";
  }

  var pendingIntent = null;
  var currentTool = toolFromPath();

  function openPay(tool) {
    currentTool = tool || currentTool;
    if (!currentTool) return;
    var modal = qs("#wh-pay-modal");
    if (modal) modal.style.display = "flex";
    var btn = qs("#wh-btn-verify");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("busy");
    }
    var fd = new FormData();
    fd.append("tool", currentTool);
    fetch("/api/wormhole/intent", { method: "POST", headers: headers(), body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("busy");
        }
        if (!res.j || !res.j.success) {
          toast((res.j && res.j.error) || "Could not create payment intent", "err");
          if (modal) modal.style.display = "none";
          return;
        }
        pendingIntent = res.j;
        try {
          sessionStorage.setItem("ness_pay_intent_wormhole_" + currentTool, JSON.stringify({
            intent_id: res.j.intent_id,
            amount_nch: res.j.amount_nch,
            expires_at: res.j.expires_at,
            tool: currentTool,
          }));
        } catch (e) {}
        var addr = qs("#wh-pay-address");
        var amt = qs("#wh-pay-amount");
        if (addr) addr.textContent = res.j.pay_address || "—";
        if (amt) amt.textContent = res.j.amount_nch + " NCH";
        var sub = qs("#wh-pay-sub");
        if (sub) {
          sub.textContent = "Send exactly the amount (or more) in NCH, then paste the transaction hash. Access lasts " +
            (res.j.ttl_minutes >= 1440
              ? Math.round(res.j.ttl_minutes / 1440) + " day(s)"
              : res.j.ttl_minutes + " min") + ".";
        }
      })
      .catch(function () {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("busy");
        }
        toast("Network error creating intent", "err");
        if (modal) modal.style.display = "none";
      });
  }

  function verifyPay() {
    var txEl = qs("#wh-tx-hash");
    var tx = (txEl && txEl.value || "").trim();
    if (!tx || tx.length < 16) {
      toast("Paste a valid transaction hash", "warn");
      return;
    }
    if (!pendingIntent || !pendingIntent.intent_id) {
      try {
        var raw = sessionStorage.getItem("ness_pay_intent_wormhole_" + currentTool);
        if (raw) pendingIntent = JSON.parse(raw);
      } catch (e) {}
    }
    if (!pendingIntent || !pendingIntent.intent_id) {
      toast("Start payment again — intent missing", "warn");
      openPay(currentTool);
      return;
    }
    var btn = qs("#wh-btn-verify");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("busy");
      btn.textContent = "Verifying…";
    }
    var fd = new FormData();
    fd.append("tool", currentTool);
    fd.append("tx_hash", tx);
    fd.append("intent_id", pendingIntent.intent_id);
    fetch("/api/wormhole/verify", { method: "POST", headers: headers(), body: fd, credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (res) {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("busy");
          btn.textContent = "Verify & unlock";
        }
        var j = res.j || {};
        if (!j.success) {
          var msg = j.error || "Verification failed";
          if (j.connectivity === "offline") msg = "Check your network connection";
          else if (j.explorer_ok === false) msg = "PrivateNess explorer is down — try again later";
          toast(msg, "err");
          return;
        }
        try { sessionStorage.removeItem("ness_pay_intent_wormhole_" + currentTool); } catch (e) {}
        pendingIntent = null;
        var modal = qs("#wh-pay-modal");
        if (modal) modal.style.display = "none";
        toast("Access unlocked", "ok");
        setToolsVisible(true);
        renderAccessMeta(j);
        // Hub: enable product cards
        document.querySelectorAll(".suite-product-card[data-tool]").forEach(function (a) {
          if (a.getAttribute("data-tool") === currentTool || !currentTool) {
            a.classList.remove("is-locked");
          }
        });
        checkAccess(currentTool);
      })
      .catch(function () {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("busy");
          btn.textContent = "Verify & unlock";
        }
        toast("Network error during verification", "err");
      });
  }

  function checkAccess(tool) {
    tool = tool || currentTool;
    if (!tool) {
      // Hub: check both
      Promise.all(["dpo", "offline"].map(function (t) {
        return fetch("/api/wormhole/access?tool=" + encodeURIComponent(t), {
          headers: headers(),
          credentials: "same-origin",
        }).then(function (r) { return r.json(); }).then(function (j) {
          return { tool: t, j: j };
        });
      })).then(function (rows) {
        rows.forEach(function (row) {
          var card = qs('.suite-product-card[data-tool="' + row.tool + '"]');
          if (!card) return;
          var j = row.j || {};
          var badge = card.querySelector(".spc-price");
          if (badge) {
            badge.textContent = j.free ? "Free" : ((j.price_nch || "?") + " NCH");
          }
          if (j.allowed) {
            card.classList.remove("is-locked");
            card.setAttribute("href", card.getAttribute("data-href") || card.href);
          } else {
            card.classList.add("is-locked");
          }
        });
      }).catch(function () {});
      return;
    }
    fetch("/api/wormhole/access?tool=" + encodeURIComponent(tool), {
      headers: headers(),
      credentials: "same-origin",
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.success) {
          setToolsVisible(false);
          return;
        }
        renderAccessMeta(j);
        if (j.allowed) {
          setToolsVisible(true);
        } else {
          setToolsVisible(false);
          var priceEl = qs("#wh-gate-price");
          if (priceEl) priceEl.textContent = (j.price_nch || "?") + " NCH";
          var ttlEl = qs("#wh-gate-ttl");
          if (ttlEl && j.ttl_minutes) {
            ttlEl.textContent = j.ttl_minutes >= 1440
              ? Math.round(j.ttl_minutes / 1440) + " day access"
              : j.ttl_minutes + " min access";
          }
        }
      })
      .catch(function () {
        setToolsVisible(false);
        toast("Could not check access", "err");
      });
  }

  function bindUi() {
    deviceId();
    var copyBtn = qs("#wh-btn-copy-pay");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var addr = (qs("#wh-pay-address") || {}).textContent || "";
        if (!addr || addr === "—") return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(addr).then(function () { toast("Address copied", "ok"); });
        } else {
          toast("Copy manually", "warn");
        }
      });
    }
    var closeBtn = qs("#wh-pay-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        var modal = qs("#wh-pay-modal");
        if (modal) modal.style.display = "none";
      });
    }
    var verifyBtn = qs("#wh-btn-verify");
    if (verifyBtn) verifyBtn.addEventListener("click", verifyPay);
    var unlockBtn = qs("#wh-btn-unlock");
    if (unlockBtn) {
      unlockBtn.addEventListener("click", function () {
        openPay(currentTool || unlockBtn.getAttribute("data-tool"));
      });
    }
    // Hub cards: intercept locked
    document.querySelectorAll(".suite-product-card[data-tool]").forEach(function (a) {
      a.setAttribute("data-href", a.getAttribute("href") || "");
      a.addEventListener("click", function (e) {
        if (!a.classList.contains("is-locked")) return;
        e.preventDefault();
        currentTool = a.getAttribute("data-tool");
        openPay(currentTool);
      });
    });
    checkAccess(currentTool);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindUi);
  } else {
    bindUi();
  }
})();
