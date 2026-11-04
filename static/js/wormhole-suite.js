/* Suite chrome for Wormhole pages: theme toggle + intelligent back */
(function () {
  "use strict";

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      localStorage.setItem("ness_theme", theme === "light" ? "light" : "dark");
    } catch (e) {}
  }

  function currentTheme() {
    try {
      return localStorage.getItem("ness_theme") === "light" ? "light" : "dark";
    } catch (e) {
      return "dark";
    }
  }

  function bindTheme() {
    var btn = document.getElementById("theme-toggle");
    if (!btn || btn.getAttribute("data-bound") === "1") return;
    btn.setAttribute("data-bound", "1");
    btn.addEventListener("click", function () {
      applyTheme(currentTheme() === "light" ? "dark" : "light");
    });
  }

  /** Same-origin suite paths we may safely history.back() into. */
  function isSuitePath(pathname) {
    if (!pathname) return false;
    var p = String(pathname).split("?")[0].split("#")[0];
    if (p === "/") return true;
    return (
      p.indexOf("/burn") === 0 ||
      p.indexOf("/invoice") === 0 ||
      p.indexOf("/storage") === 0 ||
      p.indexOf("/wormhole") === 0
    );
  }

  function pathOnly() {
    return (location.pathname || "/").split("?")[0].split("#")[0];
  }

  /**
   * Hierarchy:
   *   /wormhole/dpo|offline  →  /wormhole
   *   /wormhole              →  history.back() if previous is suite, else /
   * Prefer history when the referrer is same-origin suite and deeper navigation
   * would not skip the hub incorrectly.
   */
  function resolveBackTarget() {
    var path = pathOnly();
    var onTool = path === "/wormhole/dpo" || path === "/wormhole/offline" ||
      path.indexOf("/wormhole/dpo/") === 0 || path.indexOf("/wormhole/offline/") === 0;
    var onHub = path === "/wormhole" || path === "/wormhole/";

    var refPath = "";
    try {
      if (document.referrer) {
        var u = new URL(document.referrer, location.href);
        if (u.origin === location.origin) refPath = u.pathname || "";
      }
    } catch (e) {}

    if (onTool) {
      // Always land on hub from a tool — predictable product hierarchy
      return { mode: "assign", href: "/wormhole", label: "Back to Wormhole" };
    }

    if (onHub) {
      if (refPath && isSuitePath(refPath) && refPath.indexOf("/wormhole") !== 0) {
        // Came from TempMail / Burn / Pay / Storage
        if (window.history.length > 1) {
          return { mode: "back", href: null, label: "Back" };
        }
        return { mode: "assign", href: refPath, label: "Back" };
      }
      if (window.history.length > 1 && refPath && isSuitePath(refPath)) {
        return { mode: "back", href: null, label: "Back" };
      }
      return { mode: "assign", href: "/", label: "Back to TempMail" };
    }

    // Fallback
    return { mode: "assign", href: "/wormhole", label: "Back to Wormhole" };
  }

  function bindBack() {
    var btn = document.getElementById("btn-suite-back");
    if (!btn) return;

    var target = resolveBackTarget();
    btn.setAttribute("aria-label", target.label);
    btn.setAttribute("title", target.label);

    if (btn.getAttribute("data-bound") === "1") return;
    btn.setAttribute("data-bound", "1");

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var t = resolveBackTarget();
      if (t.mode === "back") {
        try {
          history.back();
          return;
        } catch (err) { /* fall through */ }
      }
      if (t.href) {
        window.location.assign(t.href);
        return;
      }
      window.location.assign("/wormhole");
    });

    // Keyboard: when focused, Enter already activates button; Esc = same as back
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      // Do not steal Esc from open suite drawer / modal
      if (document.querySelector(".suite-drawer.open")) return;
      if (document.querySelector(".overlay[style*='display: block'], .overlay.open")) return;
      var active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }
      btn.click();
    });
  }

  function boot() {
    bindTheme();
    bindBack();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
