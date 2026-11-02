
function setPayBtnBusy($btn, busy, idleLabel) {
  if (!$btn || !$btn.length) return;
  if (busy) {
    if (!$btn.data("idleLabel")) $btn.data("idleLabel", $btn.text());
    $btn.prop("disabled", true).addClass("is-busy")
      .html('<span class="btn-spinner" aria-hidden="true"></span> Verifying…');
  } else {
    $btn.prop("disabled", false).removeClass("is-busy")
      .text(idleLabel || $btn.data("idleLabel") || "Verify");
  }
}

function formatQuotaMb(mb){mb=Number(mb)||0;if(mb>=1024)return(mb/1024).toFixed(mb%1024===0?0:1)+' GB';return mb+' MB';}
var pendingIntentId = null;
var pendingIntentAmount = null;
/* NESS Burn — same design system & interaction grammar as TempMail */

let selectedPlanId = "free";
let planLocked = false;
let selectedFiles = [];
let lastVoiceFileName = null;
let activeWaAudio = null;

const BURN_DRAFT_KEY = "ness_burn_draft_v1";
const BURN_ACTIVE_KEY = "ness_burn_active_v1";
const BURN_IDB_NAME = "ness_burn_idb";
const BURN_IDB_STORE = "files";

let activeDrop = null;
let timerInterval = null;

function toast(msg, type) {
  type = type || "ok";
  const $t = $('<div class="toast ' + type + '"></div>').text(msg);
  $("#toasts").append($t);
  requestAnimationFrame(function () { $t.addClass("show"); });
  setTimeout(function () {
    $t.removeClass("show");
    setTimeout(function () { $t.remove(); }, 280);
  }, 3800);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function formatDuration(mins) {
  mins = Number(mins) || 0;
  if (mins < 60) return mins + " min";
  if (mins < 1440) return Math.round(mins / 60) + " h";
  return Math.round(mins / 1440) + " day" + (mins >= 2880 ? "s" : "");
}

function formatPrice(n) {
  n = Number(n) || 0;
  if (n <= 0) return "Free";
  return n.toLocaleString("en-US") + " NCH";
}

function formatRemain(iso) {
  const end = new Date(iso).getTime();
  const ms = end - Date.now();
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 48) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m " + sec + "s";
}

function deviceId() {
  const k = "ness-device-id";
  let v = localStorage.getItem(k) || localStorage.getItem("ness_device_id") || localStorage.getItem("ness-tempmail-device");
  if (!v || v.length < 16) {
    v = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
    localStorage.setItem(k, v);
    try { localStorage.setItem("ness_device_id", v); } catch (e) {}
    try { localStorage.setItem("ness-tempmail-device", v); } catch (e) {}
  }
  return v;
}

function ajaxHeaders() {
  return { "X-Device-Id": deviceId() };
}


function idbOpen() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(BURN_IDB_NAME, 1);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(BURN_IDB_STORE)) {
        db.createObjectStore(BURN_IDB_STORE);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
  });
}

async function idbSaveFiles(files) {
  const db = await idbOpen();
  if (!db) return;
  if (window.NessVault && !NessVault.isUnlocked()) {
    await NessVault.ensureVault();
  }
  const payloads = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const buf = await f.arrayBuffer();
    let sealed = null;
    if (window.NessVault && NessVault.isUnlocked()) {
      sealed = await NessVault.encryptArrayBuffer(buf);
    } else {
      // Should not happen if vault init ran; refuse plaintext file cache
      console.warn("[burn] vault locked — skip file persist");
      continue;
    }
    payloads.push({
      name: f.name,
      type: f.type || "application/octet-stream",
      lastModified: f.lastModified || Date.now(),
      sealed: sealed,
    });
  }
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readwrite");
    tx.objectStore(BURN_IDB_STORE).put({ v: 2, enc: true, files: payloads }, "draft_files");
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { resolve(); };
  });
}

async function idbLoadFiles() {
  const db = await idbOpen();
  if (!db) return [];
  if (window.NessVault && !NessVault.isUnlocked()) {
    await NessVault.ensureVault();
  }
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readonly");
    const req = tx.objectStore(BURN_IDB_STORE).get("draft_files");
    req.onsuccess = async function () {
      try {
        const row = req.result;
        if (!row) { resolve([]); return; }
        // Legacy plaintext format (array of {buffer})
        if (Array.isArray(row)) {
          resolve([]); // drop legacy plaintext — force re-attach
          return;
        }
        const list = row.files || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!r.sealed) continue;
          const buf = await NessVault.decryptToArrayBuffer(r.sealed);
          out.push(new File([buf], r.name, { type: r.type, lastModified: r.lastModified }));
        }
        resolve(out);
      } catch (e) {
        console.warn("[burn] decrypt files failed", e);
        resolve([]);
      }
    };
    req.onerror = function () { resolve([]); };
  });
}

async function idbClearFiles() {
  const db = await idbOpen();
  if (!db) return;
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readwrite");
    tx.objectStore(BURN_IDB_STORE).delete("draft_files");
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { resolve(); };
  });
}

function saveBurnDraft() {
  (async function () {
    try {
      if (window.NessVault && !NessVault.isUnlocked()) {
        await NessVault.ensureVault();
      }
      const noteEl = document.getElementById("note-editor");
      const payload = {
        plan: selectedPlanId,
        planLocked: planLocked,
        noteHtml: noteEl ? noteEl.innerHTML : "",
        allow_view: $("#opt-allow-view").length ? $("#opt-allow-view").is(":checked") : true,
        allow_download: $("#opt-allow-download").length ? $("#opt-allow-download").is(":checked") : true,
        burn_after: $("#opt-burn-after").length ? $("#opt-burn-after").is(":checked") : true,
        voice_anon: $("#opt-voice-anon").length ? $("#opt-voice-anon").is(":checked") : true,
        saved_at: Date.now(),
      };
      if (window.NessVault && NessVault.isUnlocked()) {
        const sealed = await NessVault.encryptJson(payload);
        localStorage.setItem(BURN_DRAFT_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      }
    } catch (e) {
      console.warn("[burn] draft save", e);
    }
    if (selectedFiles.length) {
      idbSaveFiles(selectedFiles).catch(function () {});
    } else {
      idbClearFiles().catch(function () {});
    }
  })();
}

function clearBurnDraft() {
  try { localStorage.removeItem(BURN_DRAFT_KEY); } catch (e) {}
  idbClearFiles().catch(function () {});
}

function saveBurnActive(data) {
  (async function () {
    try {
      if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
      const payload = {
        token: data.token,
        plan: data.plan,
        plan_label: data.plan_label,
        path: data.path || ("/burn/d/" + data.token),
        expires_at: data.expires_at,
        max_downloads: data.max_downloads,
        burn_after: data.burn_after,
        files: data.files || [],
        badge_class: data.badge_class || "",
        saved_at: Date.now(),
      };
      if (window.NessVault && NessVault.isUnlocked()) {
        const sealed = await NessVault.encryptJson(payload);
        localStorage.setItem(BURN_ACTIVE_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      }
    } catch (e) {}
  })();
}

function loadBurnActiveSyncMeta() {
  try {
    const raw = localStorage.getItem(BURN_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc) return { enc: true };
    if (parsed && parsed.token) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

async function loadBurnActive() {
  try {
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    const raw = localStorage.getItem(BURN_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc && parsed.sealed) {
      return await NessVault.decryptJson(parsed.sealed);
    }
    if (parsed && parsed.token && !parsed.enc) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

function clearBurnActive() {
  try { localStorage.removeItem(BURN_ACTIVE_KEY); } catch (e) {}
}

async function restoreBurnDraft() {
  let draft = null;
  try {
    if (window.NessVault && !NessVault.isUnlocked()) {
      await NessVault.ensureVault();
    }
    const raw = JSON.parse(localStorage.getItem(BURN_DRAFT_KEY) || "null");
    if (raw && raw.enc && raw.sealed && window.NessVault) {
      draft = await NessVault.decryptJson(raw.sealed);
    } else if (raw && raw.plan && !raw.enc) {
      draft = raw;
    }
  } catch (e) {
    draft = null;
  }
  if (!draft || !draft.plan) return false;
  if (!TIERS[draft.plan]) return false;

  selectedPlanId = draft.plan;
  renderPlans();
  selectPlan(draft.plan);

  let restoredFiles = [];
  try {
    restoredFiles = await idbLoadFiles();
  } catch (e) {
    restoredFiles = [];
  }
  if (restoredFiles && restoredFiles.length) {
    selectedFiles = restoredFiles;
    lastVoiceFileName = null;
    restoredFiles.forEach(function (f) {
      if (f.name && String(f.name).indexOf("voice-") === 0) lastVoiceFileName = f.name;
    });
    renderFileList();
  }

  const noteEl = document.getElementById("note-editor");
  if (noteEl && draft.noteHtml) {
    noteEl.innerHTML = sanitizeNoteHtml(draft.noteHtml || "");
    updateNoteCount();
  }
  if ($("#opt-allow-view").length) $("#opt-allow-view").prop("checked", draft.allow_view !== false);
  if ($("#opt-allow-download").length) $("#opt-allow-download").prop("checked", draft.allow_download !== false);
  if ($("#opt-burn-after").length && !$("#opt-burn-after").prop("disabled")) {
    $("#opt-burn-after").prop("checked", !!draft.burn_after);
  }
  if ($("#opt-voice-anon").length && !$("#opt-voice-anon").prop("disabled")) {
    $("#opt-voice-anon").prop("checked", draft.voice_anon !== false);
  }

  const hasFiles = !!(restoredFiles && restoredFiles.length);
  const noteHtml = draft.noteHtml || "";
  const noteText = noteHtml.replace(/<[^>]*>/g, "").replace(/\u200B/g, "").trim();
  const hasInlineImg = noteHtml.indexOf("<img") !== -1;
  const hasNote = noteText.length > 0 || hasInlineImg;
  // Only auto-open compose when there is real work in progress
  if (draft.planLocked && (hasFiles || hasNote)) {
    showCompose();
    return true;
  }
  return false;
}

function restoreBurnActive() {
  loadBurnActive().then(function (saved) {
  if (!saved || !saved.token) return;
  const pathTok = (location.pathname || "").match(/\/burn\/d\/([A-Za-z0-9_\-]+)/);
  if (pathTok) return;

  $.ajax({
    url: "/api/burn/" + encodeURIComponent(saved.token),
    headers: ajaxHeaders(),
  })
    .done(function (data) {
      if (!data || !data.success) {
        clearBurnActive();
        return;
      }
      showActive({
        token: saved.token,
        plan: data.plan || saved.plan,
        plan_label: saved.plan_label || data.plan,
        path: "/burn/d/" + saved.token,
        expires_at: data.expires_at || saved.expires_at,
        max_downloads: data.max_downloads != null ? data.max_downloads : saved.max_downloads,
        burn_after: data.burn_after != null ? data.burn_after : saved.burn_after,
        files: data.files || saved.files || [],
        badge_class: saved.badge_class || "",
      });
    })
    .fail(function () {
      if (saved.expires_at && new Date(saved.expires_at).getTime() > Date.now()) {
        showActive(saved);
      } else {
        clearBurnActive();
      }
    });
  });
}

function initThemeToggle() {
  $("#theme-toggle").on("click", function () {
    const cur = document.documentElement.getAttribute("data-theme");
    if (cur === "light") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("ness_theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("ness_theme", "light");
    }
  });
}

/** TempMail-identical plan grid */
function renderPlans() {
  const order = ["free", "flash", "session", "day", "week", "month"];
  let html = "";
  order.forEach(function (id) {
    const t = TIERS[id];
    if (!t) return;
    const rec = id === "day" ? " recommended" : "";
    const sel = id === selectedPlanId ? " selected" : "";
    const feats = [];
    feats.push("<strong>" + formatDuration(t.ttl_minutes) + "</strong> lifetime");
    feats.push("<strong>" + formatQuotaMb(t.max_size_mb) + "</strong> · " + (Number(t.max_files) > 0 ? (t.max_files + " file" + (t.max_files > 1 ? "s" : "")) : "Unlimited files"));
    feats.push("<strong>" + t.max_downloads + "</strong> downloads");
    if (t.max_audio_seconds) {
      const as = t.max_audio_seconds;
      feats.push("Voice ≤ " + (as >= 60 ? Math.round(as / 60) + " min" : as + "s"));
    }
    if (t.password) feats.push("Passphrase");
    if (t.burn_after_download) feats.push("Auto-burn");
    html +=
      '<div class="plan' + sel + rec + '" data-plan="' + id + '">' +
        '<div class="plan-name">' + escapeHtml(t.label) + "</div>" +
        '<div class="plan-price">' + formatPrice(t.price_nch) + "</div>" +
        '<div class="plan-meta">' + feats.join("<br>") + "</div>" +
      "</div>";
  });
  $("#plans").html(html);
}

function selectPlan(id) {
  if (!TIERS[id]) return;
  selectedPlanId = id;
  $(".plan").removeClass("selected");
  $('.plan[data-plan="' + id + '"]').addClass("selected");
  const $actions = $("#plan-actions");
  if ($actions.length && !planLocked) {
    const rect = $actions[0].getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom > vh - 24 || rect.top < 80) {
      $actions[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function syncComposeFromPlan() {
  const t = TIERS[selectedPlanId];
  if (!t) return;
  $("#compose-badge").attr("class", "badge " + (t.badge_class || "plan-free")).text(t.label);
  $("#compose-limits").text(
    t.max_size_mb + " MB · " + t.max_files + " file(s) · " + t.max_downloads + " DL · voice " +
    (t.max_audio_seconds >= 60
      ? Math.round(t.max_audio_seconds / 60) + " min"
      : t.max_audio_seconds + "s")
  );
  if (t.burn_after_download) {
    $("#opt-burn-after").prop("checked", true).prop("disabled", true);
  } else {
    $("#opt-burn-after").prop("disabled", false);
  }
  if (t.password) {
    $("#opt-password-wrap").prop("hidden", false).show();
  } else {
    $("#opt-password-wrap").prop("hidden", true).hide();
    $("#opt-password").val("");
  }
  const sec = t.max_audio_seconds || 60;
  $("#audio-limit-hint").text("Up to " + (sec >= 60 ? Math.round(sec / 60) + " min" : sec + "s") + " on " + t.label);
  if (t.voice_anonymize === false) {
    $("#opt-voice-anon").prop("checked", false).prop("disabled", true);
  } else {
    $("#opt-voice-anon").prop("disabled", false);
  }
  const nc = t.max_note_chars || 500;
  $("#note-limit-hint").text(nc.toLocaleString("en-US") + " characters max");
  updateNoteCount();
}

function showPlansOnly(opts) {
  opts = opts || {};
  planLocked = false;
  $("#plans-card").show();
  $("#compose-card").hide();
  $("#active-card").hide();
  $("#download-card").hide();
  stopRecordingQuiet();
  discardPendingAudio();
  // Never persist on boot — that would wipe IndexedDB before restoreBurnDraft.
  // Only persist when leaving compose intentionally (e.g. Change plan).
  if (opts.persistDraft === true) {
    try { saveBurnDraft(); } catch (e) {}
  }
}

function showCompose() {
  planLocked = true;
  saveBurnDraft();
  syncComposeFromPlan();
  $("#plans-card").hide();
  $("#compose-card").show();
  $("#active-card").hide();
  $("#download-card").hide();
  const el = document.getElementById("compose-card");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showActive(data) {
  activeDrop = data;
  saveBurnActive(data);
  clearBurnDraft();
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#download-card").hide();
  $("#active-card").show();
  $("#active-badge").attr("class", "badge " + (data.badge_class || "")).text(data.plan_label || data.plan);
  const link = location.origin + (data.path || ("/burn/d/" + data.token));
  $("#active-link").text(link);
  $("#active-cap").text(
    (data.max_downloads || "—") + " DL" + (data.burn_after ? " · burn" : "")
  );
  const $fl = $("#active-files").empty();
  (data.files || []).forEach(function (f) {
    $fl.append(
      "<li><span class=\"fname\">" + escapeHtml(f.filename) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + "</span></li>"
    );
  });
  if (timerInterval) clearInterval(timerInterval);
  function tick() {
    $("#active-timer").text(formatRemain(data.expires_at));
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function renderFileList() {
  const $ul = $("#file-list").empty();
  selectedFiles.forEach(function (f, i) {
    $ul.append(
      "<li><span class=\"fname\">" + escapeHtml(f.name) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) +
      ' <button type="button" class="btn btn-ghost btn-sm rm" data-i="' + i + '">Remove</button></span></li>'
    );
  });
}

function tokenFromPath() {
  const m = location.pathname.match(/^\/burn\/d\/([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

function openPay() {
  const t = TIERS[selectedPlanId] || {};
  pendingIntentId = null;
  pendingIntentAmount = null;
  $("#pay-title").text("Activate " + (t.label || "plan"));
  $("#pay-sub").text("Preparing payment…");
  $("#pay-address").text(typeof PAY_ADDRESS !== "undefined" ? PAY_ADDRESS : "—");
  $("#pay-amount").html("…");
  $("#tx-hash").val("");
  $("#pay-modal").addClass("open");
  $.post("/api/payment/intent", { product: "burn", plan: selectedPlanId })
    .done(function (data) {
      if (!data || !data.success) {
        toast((data && data.error) || "Could not create payment intent", "err");
        closePay();
        return;
      }
      pendingIntentId = data.intent_id;
      try {
        sessionStorage.setItem("ness_pay_intent_burn", JSON.stringify({
          intent_id: data.intent_id,
          amount_nch: data.amount_nch,
          plan: data.plan,
          expires_at: data.expires_at,
          pay_address: data.pay_address
        }));
      } catch (e) {}
      pendingIntentAmount = data.amount_nch;
      $("#pay-sub").text(
        "Send at least " + Number(data.amount_nch).toLocaleString() +
        " NCH, then paste the transaction hash."
      );
      $("#pay-address").text(data.pay_address || PAY_ADDRESS);
      $("#pay-amount").html(Number(data.amount_nch).toLocaleString() + " <span>NCH</span>");
    })
    .fail(function () {
      toast("Could not create payment intent", "err");
      closePay();
    });
}


var burnRenewMode = false;

function closePay() {
  $("#pay-modal").removeClass("open").hide();
  try { $("#pay-modal").css("display", "none"); } catch (e) {}
  burnRenewMode = false;
}

function validateFilesAgainstPlan() {
  const t = TIERS[selectedPlanId];
  if (!t) return "No plan selected";
  const noteLen = getNotePlainLength();
  if (!selectedFiles.length && !hasNoteContent()) return "Add a file, voice note, or text note";
  const maxNote = (t.max_note_chars || 500);
  if (noteLen > maxNote) return "Note exceeds " + maxNote + " characters for this plan";
  const items = countPayloadItems();
  if (items > planCapacity()) {
    return "This plan allows " + planCapacity() + " item(s) — you have " + items + " (each file/voice and the note count as 1)";
  }
  let total = 0;
  selectedFiles.forEach(function (f) { total += f.size || 0; });
  const maxB = t.max_size_mb * 1024 * 1024;
  if (total > maxB) return "Total size exceeds " + t.max_size_mb + " MB for this plan";
  return null;
}


function hasNoteContent() {
  const el = document.getElementById("note-editor");
  if (!el) return false;
  const text = (el.innerText || "").replace(/\u200B/g, "").trim();
  if (text.length > 0) return true;
  return (el.innerHTML || "").indexOf("<img") !== -1;
}

function countPayloadItems() {
  // Each selected file counts as 1; secure note (text and/or inline images) counts as 1
  return selectedFiles.length + (hasNoteContent() ? 1 : 0);
}

function planCapacity() {
  const t = TIERS[selectedPlanId] || {};
  return Math.max(1, parseInt(t.max_files || 1, 10));
}

function assertCanAddFile() {
  // Adding one more binary file
  const next = selectedFiles.length + 1 + (hasNoteContent() ? 1 : 0);
  if (next > planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove something or upgrade.", "warn");
    return false;
  }
  return true;
}

function assertCanAddNote() {
  // Note counts as one item if not already present
  if (hasNoteContent()) return true;
  const next = selectedFiles.length + 1;
  if (next > planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to write a note.", "warn");
    return false;
  }
  return true;
}

function assertCanAddVoice() {
  // Voice replaces other voice-* but still one file slot among selectedFiles
  const withoutVoice = selectedFiles.filter(function (f) {
    return !(f && f.name && String(f.name).indexOf("voice-") === 0);
  });
  const next = withoutVoice.length + 1 + (hasNoteContent() ? 1 : 0);
  if (next > planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove the note or a file to record.", "warn");
    return false;
  }
  return true;
}

function getNotePlainLength() {
  const el = document.getElementById("note-editor");
  if (!el) return 0;
  return (el.innerText || "").replace(/\u200B/g, "").trim().length;
}

function updateNoteCount() {
  const t = TIERS[selectedPlanId] || {};
  const max = t.max_note_chars || 500;
  const n = getNotePlainLength();
  const $c = $("#note-count");
  $c.text(n + " / " + max);
  $c.toggleClass("is-over", n > max);
}


/** Re-encode raster images on-device to drop EXIF/GPS (journalism / anti-doxxing). */
function stripImageMetadata(file) {
  return new Promise(function (resolve) {
    if (!file || !file.type || file.type.indexOf("image/") !== 0) {
      resolve(file);
      return;
    }
    if (file.type === "image/svg+xml") {
      resolve(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      try {
        const max = 4096;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > max || h > max) {
          const s = Math.min(max / w, max / h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) {
            resolve(file);
            return;
          }
          // Neutral filename — no original name leakage
          const safe = "image-" + Date.now() + ".jpg";
          resolve(new File([blob], safe, { type: "image/jpeg", lastModified: Date.now() }));
        }, "image/jpeg", 0.92);
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(file);
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

function sanitizeAttachmentName(name) {
  const base = String(name || "file").split(/[/\\\\]/).pop();
  // Drop path, collapse identity-like long names to generic
  const ext = (base.match(/(\.[a-zA-Z0-9]{1,8})$/) || [])[1] || "";
  return "file-" + Date.now().toString(36) + ext.toLowerCase();
}

function insertImageAtCursor(file) {
  if (!file || !file.type || file.type.indexOf("image/") !== 0) {
    toast("Choose an image file", "warn");
    return;
  }
  if (!hasNoteContent() && selectedFiles.length >= planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to add a note/image.", "warn");
    return;
  }
  stripImageMetadata(file).then(function (clean) {
    _insertImageAtCursorClean(clean);
  });
}

function _insertImageAtCursorClean(file) {
  if (file.size > 1.5 * 1024 * 1024) {
    toast("Inline image max 1.5 MB", "warn");
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    const ed = document.getElementById("note-editor");
    ed.focus();
    const img = document.createElement("img");
    img.src = reader.result;
    img.alt = file.name || "image";
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (ed.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        ed.appendChild(img);
      }
    } else {
      ed.appendChild(img);
    }
    updateNoteCount();
  };
  reader.readAsDataURL(file);
}

function buildNoteFileIfAny() {
  const el = document.getElementById("note-editor");
  if (!el) return null;
  const text = (el.innerText || "").replace(/\u200B/g, "").trim();
  const html = (el.innerHTML || "").trim();
  if (!text && html.indexOf("<img") === -1) return null;
  const doc =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<title>NESS Burn note</title>" +
    "<style>body{font-family:Newsreader,Georgia,serif;font-size:1.125rem;line-height:1.8;color:#111;max-width:40rem;margin:2rem auto;padding:0 1rem}" +
    "img{max-width:100%;height:auto;border-radius:6px}</style></head><body>" +
    html +
    "</body></html>";
  return new File([doc], "secure-note.html", { type: "text/html;charset=utf-8" });
}

function filesForUpload() {
  const list = selectedFiles.slice();
  const note = buildNoteFileIfAny();
  if (note) list.push(note);
  return list;
}

function createFree() {
  const err = validateFilesAgainstPlan();
  if (err) { toast(err, "warn"); return; }
  const fd = new FormData();
  fd.append("plan", selectedPlanId);
  filesForUpload().forEach(function (f) { fd.append("files", f); });
  if ($("#opt-burn-after").is(":checked")) fd.append("burn_after", "1");
  fd.append("allow_view", $("#opt-allow-view").is(":checked") ? "1" : "0");
  fd.append("allow_download", $("#opt-allow-download").is(":checked") ? "1" : "0");
  const planForPw = TIERS[selectedPlanId] || {};
  const pw = (planForPw.password ? ($("#opt-password").val() || "").trim() : "");
  if (pw) fd.append("password", pw);
  const $btn = $("#btn-burn-go").prop("disabled", true).text("Publishing…");
  $.ajax({
    url: "/api/burn/create",
    method: "POST",
    data: fd,
    processData: false,
    contentType: false,
    headers: ajaxHeaders(),
  })
    .done(function (data) {
      $btn.prop("disabled", false).text("Publish");
      if (!data.success) { toast(data.error || "Failed", "err"); return; }
      toast("Published — link is live", "ok");
      selectedFiles = [];
      renderFileList();
      showActive(data);
      history.pushState({}, "", data.path);
    })
    .fail(function (xhr) {
      $btn.prop("disabled", false).text("Publish");
      let msg = "Upload failed";
      try {
        const b = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
        if (b.error) msg = b.error;
      } catch (e) {}
      toast(msg, "err");
    });
}

function payAndUpload() {
  if (!pendingIntentId) {
    try {
      var _pi = JSON.parse(sessionStorage.getItem("ness_pay_intent_burn") || "null");
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
  const tx = ($("#tx-hash").val() || "").trim();
  if (!tx) { toast("Paste the transaction hash", "warn"); return; }

  // Renew existing active drop (remaining time + plan TTL)
  if (typeof burnRenewMode !== "undefined" && burnRenewMode && activeDrop && activeDrop.token) {
    if (tx.length < 16) { toast("Transaction hash looks too short", "warn"); return; }
    const $btn = $("#btn-pay-confirm");
    if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, true);
    else $btn.prop("disabled", true).text("Renewing…");
    const fd = new FormData();
    fd.append("plan", selectedPlanId);
    fd.append("tx_hash", tx);
    fd.append("intent_id", pendingIntentId);
    $.ajax({
      url: "/api/burn/" + encodeURIComponent(activeDrop.token) + "/renew",
      method: "POST",
      data: fd,
      processData: false,
      contentType: false,
      headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
    }).done(function (data) {
      if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, false, "Verify & upload");
      else $btn.prop("disabled", false).text("Verify & upload");
      if (!data || !data.success) {
        toast((data && data.error) || "Renew failed", "err");
        return;
      }
      burnRenewMode = false;
      closePay();
      activeDrop.expires_at = data.expires_at;
      if (data.plan) activeDrop.plan = data.plan;
      if (typeof showActive === "function") showActive(activeDrop);
      else if (typeof restoreBurnActive === "function") restoreBurnActive();
      if (typeof saveBurnActive === "function") saveBurnActive(activeDrop);
      try { sessionStorage.removeItem("ness_pay_intent_burn"); } catch (e) {}
      toast("Drop renewed · time remaining kept", "ok");
    }).fail(function (xhr) {
      if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, false, "Verify & upload");
      else $btn.prop("disabled", false).text("Verify & upload");
      var msg = "Renew failed";
      try { msg = (xhr.responseJSON && xhr.responseJSON.error) || msg; } catch (e) {}
      toast(msg, "err");
    });
    return;
  }

  const err = validateFilesAgainstPlan();
  if (err) { toast(err, "warn"); return; }
  const fd = new FormData();
  fd.append("plan", selectedPlanId);
  if (pendingIntentId) fd.append("intent_id", pendingIntentId);
  fd.append("tx_hash", tx);
  filesForUpload().forEach(function (f) { fd.append("files", f); });
  if ($("#opt-burn-after").is(":checked")) fd.append("burn_after", "1");
  fd.append("allow_view", $("#opt-allow-view").is(":checked") ? "1" : "0");
  fd.append("allow_download", $("#opt-allow-download").is(":checked") ? "1" : "0");
  const planForPw = TIERS[selectedPlanId] || {};
  const pw = (planForPw.password ? ($("#opt-password").val() || "").trim() : "");
  if (pw) fd.append("password", pw);
  const $btn = $("#btn-pay-confirm").each(function(){ setPayBtnBusy($(this), true); });
  $.ajax({
    url: "/api/burn/pay",
    method: "POST",
    data: fd,
    processData: false,
    contentType: false,
    headers: ajaxHeaders(),
  })
    .done(function (data) {
      $btn.prop("disabled", false).text("Publish");
      if (!data.success) {
        if (data.connectivity === "offline") {
          toast(data.error || "No internet connection — verify your network and try again", "err");
        } else if (data.explorer_ok === false) {
          toast(data.error || "PrivateNess explorer is down", "err");
        } else {
          toast(data.error || "Payment failed", "err");
        }
        return;
      }
      closePay();
      try { sessionStorage.removeItem("ness_pay_intent_burn"); } catch (e) {}
      toast("Payment verified · content is live", "ok");
      selectedFiles = [];
      renderFileList();
      showActive(data);
      history.pushState({}, "", data.path);
    })
    .fail(function (xhr) {
      $btn.prop("disabled", false).text("Publish");
      let msg = "Verification failed";
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        msg = "No internet connection — verify your network and try again";
      } else {
        try {
          const b = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
          if (b.error) msg = b.error;
        } catch (e) {}
      }
      toast(msg, "err");
    });
}

/* ── Voice (only while compose is open / plan locked) ── */
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = 0;
let pendingAudioBlob = null;
let pendingAudioUrl = null;

function maxAudioSeconds() {
  const t = TIERS[selectedPlanId] || {};
  return Math.max(15, parseInt(t.max_audio_seconds || 60, 10));
}

function formatRecClock(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function pickMime() {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (let i = 0; i < cands.length; i++) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) {
      return cands[i];
    }
  }
  return "";
}

function assertPlanForAudio() {
  if (!planLocked) {
    toast("Select a plan first", "warn");
    return false;
  }
  return true;
}

function playRecBeep() {
  return new Promise(function (resolve) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.16);
      setTimeout(function () {
        try { ctx.close(); } catch (e) {}
        resolve();
      }, 180);
    } catch (e) {
      resolve();
    }
  });
}

async function startRecording() {
  if (!assertPlanForAudio()) return;
  if (!assertCanAddVoice()) return;
  await playRecBeep();
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    toast("Microphone needs HTTPS (or localhost). Open via 127.0.0.1 not a LAN IP.", "err");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Microphone API unavailable in this browser", "err");
    return;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  try {
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    });
    // Premium cleanup chain: high-pass + light compression → recorder
    try {
      const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = actx.createMediaStreamSource(rawStream);
      const high = actx.createBiquadFilter();
      high.type = "highpass";
      high.frequency.value = 85;
      high.Q.value = 0.7;
      const low = actx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 12000;
      low.Q.value = 0.7;
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -32;
      comp.knee.value = 18;
      comp.ratio.value = 3;
      comp.attack.value = 0.005;
      comp.release.value = 0.12;
      const dest = actx.createMediaStreamDestination();
      src.connect(high);
      high.connect(low);
      low.connect(comp);
      comp.connect(dest);
      mediaStream = dest.stream;
      mediaStream.__rawTracks = rawStream.getTracks();
      mediaStream.__audioCtx = actx;
    } catch (procErr) {
      console.warn(procErr);
      mediaStream = rawStream;
    }
  } catch (err) {
    const name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      toast("Microphone blocked — allow mic for this site in browser settings, then retry", "err");
    } else if (name === "NotFoundError") {
      toast("No microphone found on this device", "err");
    } else if (name === "NotReadableError") {
      toast("Microphone is busy in another app", "err");
    } else {
      toast("Microphone error: " + (err.message || name || "unknown"), "err");
    }
    return;
  }
  recChunks = [];
  const mime = pickMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(mediaStream);
  } catch (e) {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = function (ev) {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  };
  mediaRecorder.onstop = function () { finishRecording(); };
  mediaRecorder.start(250);
  recStartedAt = Date.now();
  $("#btn-rec").attr("aria-pressed", "true").attr("title", "Recording…");
  $("#btn-rec-stop").prop("disabled", false);
  if (recTimer) clearInterval(recTimer);
  recTimer = setInterval(function () {
    const elapsed = Date.now() - recStartedAt;
    $("#rec-timer").text(formatRecClock(elapsed));
    if (elapsed >= maxAudioSeconds() * 1000) {
      stopRecording();
      toast("Audio limit for this plan reached", "warn");
    }
  }, 200);
}

function stopRecordingQuiet() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $("#btn-rec").attr("aria-pressed", "false").attr("title", "Record");
  $("#btn-rec-stop").prop("disabled", true);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.onstop = null; mediaRecorder.stop(); } catch (e) {}
  }
  if (mediaStream) {
    try { (mediaStream.__rawTracks || []).forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { if (mediaStream.__audioCtx) mediaStream.__audioCtx.close(); } catch (e) {}
    mediaStream = null;
  }
  mediaRecorder = null;
}

function stopRecording() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $("#btn-rec").attr("aria-pressed", "false").attr("title", "Record");
  $("#btn-rec-stop").prop("disabled", true);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (e) {}
  } else if (mediaStream) {
    mediaStream.getTracks().forEach(function (tr) { tr.stop(); });
    mediaStream = null;
  }
}

async function finishRecording() {
  if (mediaStream) {
    try { (mediaStream.__rawTracks || []).forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { if (mediaStream.__audioCtx) mediaStream.__audioCtx.close(); } catch (e) {}
    mediaStream = null;
  }
  if (!recChunks.length) {
    toast("No audio captured", "warn");
    return;
  }
  const rawType = (recChunks[0] && recChunks[0].type) || "audio/webm";
  let blob = new Blob(recChunks, { type: rawType });
  recChunks = [];
  if ($("#opt-voice-anon").is(":checked")) {
    try {
      blob = await anonymizeVoiceBlob(blob);
      toast("Voice anonymized on-device", "ok");
    } catch (e) {
      console.warn(e);
      toast("Anonymize failed — using cleaned capture", "warn");
    }
  }
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
  }
  pendingAudioBlob = blob;
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
  }
  pendingAudioUrl = URL.createObjectURL(blob);
  $("#audio-preview").prop("hidden", false);
  const mount = document.getElementById("audio-player-mount");
  if (mount) mountWaPlayer(mount, pendingAudioUrl);
  // Auto-attach so voice is not lost if user only hits Create drop
  attachPendingAudio();
}

async function anonymizeVoiceBlob(blob) {
  const semitones = 5;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const arr = await blob.arrayBuffer();
  const decoded = await ctx.decodeAudioData(arr.slice(0));
  const ratio = Math.pow(2, semitones / 12);
  const srcLen = decoded.length;
  const outLen = Math.floor(srcLen / ratio);
  const offline = new OfflineAudioContext(1, Math.max(1, outLen), decoded.sampleRate);
  const mono = offline.createBuffer(1, srcLen, decoded.sampleRate);
  const outCh = mono.getChannelData(0);
  const nCh = decoded.numberOfChannels;
  for (let i = 0; i < srcLen; i++) {
    let s = 0;
    for (let c = 0; c < nCh; c++) s += decoded.getChannelData(c)[i];
    outCh[i] = s / nCh;
  }
  const source = offline.createBufferSource();
  source.buffer = mono;
  source.playbackRate.value = ratio;
  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 120;
  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 3800;
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  await ctx.close();
  return encodeWavBlob(rendered);
}

function encodeWavBlob(buffer) {
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const len = samples.length;
  const dataSize = len * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  function str(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  str(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}


function mountWaPlayer(container, srcUrl) {
  if (!container) return null;
  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "wa-player";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wa-play";
  btn.setAttribute("aria-label", "Play");
  const iconPlay = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const iconPause = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  btn.innerHTML = iconPlay;
  const wave = document.createElement("div");
  wave.className = "wa-wave";
  for (let i = 0; i < 22; i++) {
    const s = document.createElement("span");
    s.style.height = (18 + Math.abs((i % 7) - 3) * 12) + "%";
    wave.appendChild(s);
  }
  const time = document.createElement("div");
  time.className = "wa-time";
  time.textContent = "0:00";
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = srcUrl;
  audio.style.display = "none";
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }
  function syncTime() {
    const d = isFinite(audio.duration) ? audio.duration : 0;
    time.textContent = fmt(audio.currentTime) + (d ? " / " + fmt(d) : "");
  }
  btn.addEventListener("click", function () {
    if (audio.paused) {
      if (activeWaAudio && activeWaAudio !== audio) {
        try { activeWaAudio.pause(); } catch (e) {}
      }
      activeWaAudio = audio;
      audio.play().then(function () {
        root.classList.add("is-playing");
        btn.innerHTML = iconPause;
        btn.setAttribute("aria-label", "Pause");
      }).catch(function () {
        toast("Unable to play audio", "err");
      });
    } else {
      audio.pause();
      root.classList.remove("is-playing");
      btn.innerHTML = iconPlay;
      btn.setAttribute("aria-label", "Play");
    }
  });
  audio.addEventListener("timeupdate", syncTime);
  audio.addEventListener("loadedmetadata", syncTime);
  audio.addEventListener("ended", function () {
    root.classList.remove("is-playing");
    btn.innerHTML = iconPlay;
    btn.setAttribute("aria-label", "Play");
    audio.currentTime = 0;
    syncTime();
  });
  wave.addEventListener("click", function (e) {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  });
  root.appendChild(btn);
  root.appendChild(wave);
  root.appendChild(time);
  root.appendChild(audio);
  container.appendChild(root);
  return audio;
}

function attachPendingAudio() {
  if (!assertPlanForAudio()) return;
  if (!pendingAudioBlob) return;
  // One voice attachment only — drop any prior voice-* files
  selectedFiles = selectedFiles.filter(function (f) {
    return !(f && f.name && String(f.name).indexOf("voice-") === 0);
  });
  const ext = pendingAudioBlob.type.indexOf("wav") >= 0 ? "wav" : "webm";
  const name = "voice-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "." + ext;
  lastVoiceFileName = name;
  selectedFiles.push(new File([pendingAudioBlob], name, {
    type: pendingAudioBlob.type || "audio/webm",
    lastModified: Date.now(),
  }));
  renderFileList();
  saveBurnDraft();
  toast("Voice note attached", "ok");
}

function discardPendingAudio() {
  // Fully detach from drop payload
  if (lastVoiceFileName) {
    selectedFiles = selectedFiles.filter(function (f) { return f.name !== lastVoiceFileName; });
    lastVoiceFileName = null;
    renderFileList();
  }
  pendingAudioBlob = null;
  if (activeWaAudio) {
    try { activeWaAudio.pause(); } catch (e) {}
    activeWaAudio = null;
  }
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
    pendingAudioUrl = null;
  }
  const mount = document.getElementById("audio-player-mount");
  if (mount) mount.innerHTML = "";
  $("#audio-preview").prop("hidden", true);
  $("#rec-timer").text("0:00");
}

function loadDownload(token) {
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#active-card").hide();
  $("#download-card").show();
  $("#dl-status").text("Loading…");
  $("#dl-files").empty();
  $("#dl-preview").prop("hidden", true).empty();
  $("#dl-password-wrap").prop("hidden", true);

  window.__burnDlToken = token;
  window.__burnDlMeta = null;
  window.__burnPreviewIdx = null;

  $.ajax({ url: "/api/burn/" + encodeURIComponent(token), headers: ajaxHeaders() })
    .done(function (data) {
      if (!data.success) {
        $("#dl-status").text(data.error || "Unavailable");
        return;
      }
      window.__burnDlMeta = data;
      const bits = [];
      if (data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
      bits.push(formatBytes(data.total_bytes));
      if (data.allow_view === false) bits.push("view off");
      if (data.allow_download === false) bits.push("download off");
      $("#dl-status").text(bits.join(" · "));
      if (timerInterval) clearInterval(timerInterval);
      function tick() { $("#dl-timer").text(formatRemain(data.expires_at)); }
      tick();
      timerInterval = setInterval(tick, 1000);

      // Passphrase UI only when author set one on a plan that supports it
      $("#dl-password-wrap").prop("hidden", true).hide();
      if (data.password_required === true) {
        $("#dl-password-wrap").prop("hidden", false).show();
        $("#dl-files").empty();
        $("#dl-preview").prop("hidden", true).empty();
        $("#btn-dl-unlock").off("click").on("click", function () {
          const pw = ($("#dl-password").val() || "").trim();
          if (!pw) { toast("Enter the passphrase", "warn"); return; }
          const $btn = $(this).prop("disabled", true).text("Unlocking…");
          unlockBurnView(token, pw)
            .done(function (viewToken) {
              $("#dl-password-wrap").prop("hidden", true);
              $("#dl-password").val("");
              renderDropAccess(token, data, viewToken);
              toast("Unlocked", "ok");
            })
            .fail(function (xhr) {
              let msg = "Invalid passphrase";
              try {
                const b = (xhr && xhr.responseJSON) || {};
                if (b.error) msg = b.error;
                if (b.retry_after) msg = msg + " (" + b.retry_after + "s)";
              } catch (e) {}
              toast(msg, "err");
            })
            .always(function () {
              $btn.prop("disabled", false).text("Unlock");
            });
        });
      } else {
        $("#dl-password-wrap").prop("hidden", true);
        $("#dl-password").val("");
        unlockBurnView(token, "")
          .done(function (viewToken) {
            renderDropAccess(token, data, viewToken);
          })
          .fail(function () {
            renderDropAccess(token, data, "");
          });
      }
    })
    .fail(function (xhr) {
      let msg = "Drop unavailable";
      try {
        const b = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
        if (b.error) msg = b.error;
      } catch (e) {}
      $("#dl-status").text(msg);
    });
}

function fileUrl(token, idx, viewToken, inline) {
  let url = "/api/burn/" + encodeURIComponent(token) + "/file/" + idx + "?";
  const q = [];
  if (inline) q.push("inline=1");
  if (viewToken) q.push("view_token=" + encodeURIComponent(viewToken));
  return url + q.join("&");
}

function unlockBurnView(token, password) {
  return $.ajax({
    url: "/api/burn/" + encodeURIComponent(token) + "/unlock",
    method: "POST",
    data: { password: password || "" },
    headers: ajaxHeaders(),
  }).then(function (data) {
    if (data && data.success && data.view_token) return data.view_token;
    return $.Deferred().reject({ responseJSON: data }).promise();
  });
}

function renderDropAccess(token, data, viewToken) {
  const $fl = $("#dl-files").empty();
  $("#dl-preview").empty().prop("hidden", true);
  window.__burnPreviewIdx = null;
  const allowView = data.allow_view !== false;
  const allowDl = data.allow_download !== false;
  const files = data.files || [];

  // Public list: Download button only (no View — content auto-shows when allowed)
  files.forEach(function (f, idx) {
    let actions = "";
    if (allowDl) {
      actions += ' <button type="button" class="btn btn-sm dl" data-idx="' + idx + '">Download</button>';
    } else if (!allowView) {
      actions = ' <span class="fmeta">No access</span>';
    }
    $fl.append(
      "<li data-file-idx=\"" + idx + "\"><span class=\"fname\">" + escapeHtml(f.filename) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + actions + "</span></li>"
    );
  });

  $fl.find("button.dl").on("click", function () {
    const idx = $(this).data("idx");
    const vt = viewToken || "";
    if (vt) {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/api/burn/" + encodeURIComponent(token) + "/file/" + idx;
      const inp = document.createElement("input");
      inp.type = "hidden";
      inp.name = "view_token";
      inp.value = vt;
      form.appendChild(inp);
      document.body.appendChild(form);
      form.submit();
      form.remove();
    } else {
      window.location.href = fileUrl(token, idx, "", false);
    }
  });

  // Author enabled in-browser view → show all readable content automatically
  if (allowView && files.length) {
    const $stack = $("#dl-preview").empty().prop("hidden", false);
    files.forEach(function (f, idx) {
      const k = f.kind || "file";
      const ct = f.content_type || "";
      const name = f.filename || "";
      if (
        k === "note" || k === "audio" || k === "image" ||
        name.endsWith(".html") ||
        ct.indexOf("audio/") === 0 ||
        ct.indexOf("image/") === 0
      ) {
        appendInlineBlock($stack, token, f, idx, viewToken);
      }
    });
    if (!$stack.children().length) {
      $stack.prop("hidden", true);
    }
  }
}


function sanitizeNoteHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  doc.querySelectorAll("script, iframe, object, embed, form, link[rel=import], meta, base").forEach(function (n) {
    n.remove();
  });
  doc.querySelectorAll("*").forEach(function (el) {
    Array.from(el.attributes).forEach(function (attr) {
      const n = attr.name.toLowerCase();
      const v = (attr.value || "").trim().toLowerCase();
      if (n.startsWith("on")) {
        el.removeAttribute(attr.name);
        return;
      }
      if (
        (n === "href" || n === "src" || n === "xlink:href" || n === "action") &&
        (v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html"))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body ? doc.body.innerHTML : "";
}

async function appendInlineBlock($stack, token, file, idx, viewToken) {
  const block = $('<div class="preview-block"></div>');
  block.append('<div class="preview-label">' + escapeHtml(file.filename) + "</div>");
  $stack.append(block);
  const url = fileUrl(token, idx, viewToken, true);
  const kind = file.kind || "file";
  const ct = file.content_type || "";

  if (kind === "audio" || ct.indexOf("audio/") === 0) {
    const hold = document.createElement("div");
    block.append(hold);
    mountWaPlayer(hold, url);
    return;
  }
  if (kind === "image" || ct.indexOf("image/") === 0) {
    const img = document.createElement("img");
    img.className = "preview-img";
    img.src = url;
    img.alt = file.filename || "image";
    block.append(img);
    return;
  }
  if (kind === "note" || (file.filename || "").endsWith(".html")) {
    try {
      const res = await fetch(url, { headers: ajaxHeaders() });
      if (!res.ok) {
        let msg = "Unable to open note";
        try {
          const b = await res.json();
          if (b.error) msg = b.error;
        } catch (e) {}
        block.append('<p style="color:var(--muted);font-size:0.9rem;">' + escapeHtml(msg) + "</p>");
        return;
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, iframe, object, embed").forEach(function (n) { n.remove(); });
      const wrap = document.createElement("div");
      wrap.className = "note-view";
      wrap.innerHTML = sanitizeNoteHtml(doc.body ? doc.body.innerHTML : "");
      block.append(wrap);
    } catch (e) {
      block.append('<p style="color:var(--muted);font-size:0.9rem;">Unable to open note</p>');
    }
  }
}


function openAuthorPreview() {
  // Exact recipient reading experience from current editor + pending files
  const t = TIERS[selectedPlanId];
  if (!t) { toast("Select a plan first", "warn"); return; }
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#active-card").hide();
  $("#download-card").show();
  $("#dl-password-wrap").prop("hidden", true);
  $("#dl-status").text("Author preview · not published yet");
  $("#dl-timer").text(formatDuration(t.ttl_minutes));
  $("#dl-badge").text(t.label);
  const $prev = $("#dl-preview").empty().prop("hidden", false);
  const $fl = $("#dl-files").empty();

  const noteHtml = ($("#note-editor").html() || "").trim();
  const noteText = getNotePlainLength();
  if (noteText > 0 || noteHtml.indexOf("<img") >= 0) {
    $fl.append('<li><span class="fname">secure-note.html</span><span class="fmeta">note</span></li>');
    $prev.append('<div class="preview-label">secure-note.html</div>');
    const wrap = document.createElement("div");
    wrap.className = "note-view";
    wrap.innerHTML = sanitizeNoteHtml(noteHtml);
    $prev.append(wrap);
  }
  selectedFiles.forEach(function (f) {
    $fl.append(
      "<li><span class=\"fname\">" + escapeHtml(f.name) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + "</span></li>"
    );
    if ((f.type || "").indexOf("audio/") === 0) {
      const url = URL.createObjectURL(f);
      $prev.append('<div class="preview-label" style="margin-top:1rem;">' + escapeHtml(f.name) + "</div>");
      const hold = document.createElement("div");
      $prev.append(hold);
      mountWaPlayer(hold, url);
    }
  });
  if (!$prev.children().length) {
    $prev.append('<p style="color:var(--muted)">Nothing to preview yet.</p>');
  }
  $prev.append(
    '<div style="margin-top:1rem;"><button type="button" class="btn btn-ghost btn-sm" id="btn-preview-back">Back to editor</button></div>'
  );
  $("#btn-preview-back").on("click", function () {
    $("#download-card").hide();
    $("#compose-card").show();
  });
}

$(function () {
  initThemeToggle();

  // Restore published drop or in-progress draft after reload
  const pathTokBoot = (location.pathname || "").match(/\/burn\/d\/([A-Za-z0-9_\-]+)/);
  const vaultBoot = (window.NessVault ? NessVault.ensureVault() : Promise.resolve({ ok: true }));
  vaultBoot.then(function () {
    if (!pathTokBoot) {
      loadBurnActive().then(function (savedActive) {
        if (savedActive && savedActive.token) {
          restoreBurnActive();
        } else {
          restoreBurnDraft().then(function () { /* compose draft restored */ });
        }
      });
    }
  });

  $("#note-editor").on("blur", function () { saveBurnDraft(); });
  $("#opt-allow-view, #opt-allow-download, #opt-burn-after").on("change", saveBurnDraft);

  function bootPlans() {
    const keys = (typeof TIERS === "object" && TIERS) ? Object.keys(TIERS) : [];
    if (keys.length) {
      renderPlans();
      return;
    }
    $.getJSON("/api/burn/tiers")
      .done(function (data) {
        if (data && data.tiers) {
          window.TIERS = data.tiers;
        }
        renderPlans();
      })
      .fail(function () {
        toast("Unable to load plans", "err");
      });
  }
  bootPlans();
  $("#burn-dot").css("background", "var(--accent)");
  $("#burn-status-label").text("Ready");

  $("#plans").on("click", ".plan", function () {
    selectPlan($(this).data("plan"));
  });

  $("#btn-continue-plan").on("click", function () {
    if (!TIERS[selectedPlanId]) {
      toast("Select a plan", "warn");
      return;
    }
    showCompose();
  });

  $("#btn-change-plan").on("click", function () {
    var doChange = function () {
      selectedFiles = [];
      renderFileList();
      stopRecordingQuiet();
      discardPendingAudio();
      if (typeof clearBurnDraft === "function") clearBurnDraft();
      showPlansOnly({ persistDraft: true });
    };
    var hasContent = (selectedFiles && selectedFiles.length) ||
      (typeof hasNoteContent === "function" && hasNoteContent());
    if (hasContent && typeof nessConfirm === "function") {
      nessConfirm({
        title: "Change plan and clear draft?",
        message: "Your current files and note will be discarded. This cannot be undone.",
        confirmLabel: "Change plan",
        danger: true,
      }).then(function (ok) { if (ok) doChange(); });
    } else {
      doChange();
    }
  });

  const dz = document.getElementById("dropzone");
  if (dz) {
    dz.addEventListener("click", function (e) {
      if (e.target.closest(".rm")) return;
      if (!planLocked) { toast("Select a plan first", "warn"); return; }
      $("#file-input").trigger("click");
    });
    dz.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (planLocked) dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault();
      dz.classList.remove("drag");
      if (!planLocked) { toast("Select a plan first", "warn"); return; }
      const incoming = Array.from(e.dataTransfer.files || []);
      (async function () {
        for (let i = 0; i < incoming.length; i++) {
          if (!assertCanAddFile()) break;
          let f = incoming[i];
          if ((f.type || "").indexOf("image/") === 0) {
            f = await stripImageMetadata(f);
            toast("Image metadata stripped", "ok");
          } else {
            f = new File([f], sanitizeAttachmentName(f.name), { type: f.type, lastModified: f.lastModified });
          }
          selectedFiles.push(f);
        }
        renderFileList();
        saveBurnDraft();
      })();
    });
  }
  $("#file-input").on("change", function () {
    if (!planLocked) { toast("Select a plan first", "warn"); this.value = ""; return; }
    const incoming = Array.from(this.files || []);
    const inputEl = this;
    (async function () {
      for (let i = 0; i < incoming.length; i++) {
        if (!assertCanAddFile()) break;
        let f = incoming[i];
        if ((f.type || "").indexOf("image/") === 0) {
          f = await stripImageMetadata(f);
          toast("Image metadata stripped", "ok");
        } else {
          f = new File([f], sanitizeAttachmentName(f.name), { type: f.type, lastModified: f.lastModified });
        }
        selectedFiles.push(f);
      }
      inputEl.value = "";
      renderFileList();
      saveBurnDraft();
    })();
  });
  $("#file-list").on("click", ".rm", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    var i = parseInt($(this).data("i"), 10);
    if (isNaN(i) || !selectedFiles[i]) return;
    var f = selectedFiles[i];
    if (typeof nessConfirm === "function") {
      var ok = await nessConfirm({
        title: "Remove file from draft?",
        message: f.name ? ("'" + f.name + "' will be removed from this draft.") : "Remove this file?",
        confirmLabel: "Remove",
        danger: false,
      });
      if (!ok) return;
    }
    selectedFiles.splice(i, 1);
    renderFileList();
    saveBurnDraft();
  });

  $("#btn-author-preview").on("click", function () { openAuthorPreview(); });

  $("#btn-burn-go").on("click", function () {
    const t = TIERS[selectedPlanId];
    if (!t) return;
    if (t.price_nch > 0) openPay();
    else createFree();
  });

  $("#btn-pay-cancel").on("click", closePay);
  $("#btn-pay-confirm").on("click", payAndUpload);
  $("#btn-copy-pay").on("click", function () {
    const a = $("#pay-address").text();
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () { toast("Address copied", "ok"); });
  });
  $("#btn-copy-link").on("click", function () {
    const a = $("#active-link").text();
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () { toast("Link copied", "ok"); });
  });
  burnRenewMode = false;
  $("#btn-renew-drop").on("click", function () {
    if (!activeDrop || !activeDrop.token) {
      toast("No active drop to renew", "warn");
      return;
    }
    if (!TIERS[selectedPlanId] || Number(TIERS[selectedPlanId].price_nch) <= 0) {
      // pick first paid plan
      var keys = Object.keys(TIERS);
      for (var i = 0; i < keys.length; i++) {
        if (Number(TIERS[keys[i]].price_nch) > 0) { selectedPlanId = keys[i]; break; }
      }
      renderPlans();
    }
    burnRenewMode = true;
    openPay();
  });
  $("#btn-new-drop").on("click", function () {
    var go = function () {
      activeDrop = null;
      selectedFiles = [];
      clearBurnActive();
      clearBurnDraft();
      renderFileList();
      const noteEl = document.getElementById("note-editor");
      if (noteEl) noteEl.innerHTML = "";
      history.pushState({}, "", "/burn");
      showPlansOnly();
    };
    if (typeof nessConfirm === "function") {
      nessConfirm({
        title: "Start a new drop?",
        message: "Your published drop stays live with its current link until it expires.",
        confirmLabel: "New drop",
        danger: false,
      }).then(function (ok) { if (ok) go(); });
    } else {
      go();
    }
  });

  $("#note-editor").on("input", function () {
    if (hasNoteContent() && selectedFiles.length >= planCapacity()) {
      // note would be an extra item beyond capacity
      const withoutNote = selectedFiles.length;
      if (withoutNote >= planCapacity()) {
        toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to keep a note.", "warn");
        const el = document.getElementById("note-editor");
        if (el) el.innerHTML = "";
      }
    }
    updateNoteCount();
  });
  $("#note-editor").on("paste", function () {
    setTimeout(function () {
      if (hasNoteContent() && selectedFiles.length >= planCapacity()) {
        toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to keep a note.", "warn");
        const el = document.getElementById("note-editor");
        if (el) el.innerHTML = "";
      }
      updateNoteCount();
    }, 0);
  });
  $("#btn-note-image").on("click", function () {
    $("#note-image-input").trigger("click");
  });
  $("#note-image-input").on("change", function () {
    const f = this.files && this.files[0];
    if (f) insertImageAtCursor(f);
    this.value = "";
  });

  $("#btn-rec").on("click", function () {
    if ($(this).attr("aria-pressed") === "true") return;
    startRecording();
  });
  $("#btn-rec-stop").on("click", function () { stopRecording(); });
  $("#btn-audio-discard").on("click", async function () {
    if (typeof pendingAudioBlob !== "undefined" && pendingAudioBlob && typeof nessConfirm === "function") {
      var ok = await nessConfirm({
        title: "Discard voice note?",
        message: "The recording will be lost.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    discardPendingAudio();
  });

  const tok = tokenFromPath();
  if (tok) loadDownload(tok);
  else showPlansOnly();
});


