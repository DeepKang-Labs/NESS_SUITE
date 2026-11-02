/* NESS shared confirm modal — replaces native confirm() for destructive actions.
 * Usage: const ok = await nessConfirm({ title, message, confirmLabel, danger });
 */
(function (global) {
  "use strict";

  function nessConfirm(opts) {
    opts = opts || {};
    var title = opts.title || "Confirm";
    var message = opts.message || "Are you sure?";
    var confirmLabel = opts.confirmLabel || "Confirm";
    var cancelLabel = opts.cancelLabel || "Cancel";
    var danger = opts.danger !== false;

    return new Promise(function (resolve) {
      var existing = document.getElementById("ness-confirm-modal");
      if (existing) existing.remove();

      var root = document.createElement("div");
      root.id = "ness-confirm-modal";
      root.className = "confirm-overlay";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-labelledby", "ness-confirm-title");

      var modal = document.createElement("div");
      modal.className = "confirm-modal";

      var h = document.createElement("h3");
      h.className = "confirm-title";
      h.id = "ness-confirm-title";
      h.textContent = title;

      var p = document.createElement("p");
      p.className = "confirm-message";
      p.textContent = message;

      var actions = document.createElement("div");
      actions.className = "confirm-actions";

      var btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.className = "btn btn-ghost btn-sm confirm-cancel";
      btnCancel.textContent = cancelLabel;

      var btnOk = document.createElement("button");
      btnOk.type = "button";
      btnOk.className = "btn btn-sm confirm-ok" + (danger ? " btn-danger" : "");
      btnOk.textContent = confirmLabel;

      actions.appendChild(btnCancel);
      actions.appendChild(btnOk);
      modal.appendChild(h);
      modal.appendChild(p);
      modal.appendChild(actions);
      root.appendChild(modal);
      document.body.appendChild(root);
      requestAnimationFrame(function () {
        root.classList.add("show");
      });

      var closed = false;
      function close(confirmed) {
        if (closed) return;
        closed = true;
        root.classList.remove("show");
        document.removeEventListener("keydown", onKey);
        setTimeout(function () {
          if (root.parentNode) root.remove();
        }, 200);
        resolve(confirmed);
      }
      function onKey(e) {
        if (e.key === "Escape") close(false);
        else if (e.key === "Enter") close(true);
      }
      document.addEventListener("keydown", onKey);
      btnCancel.onclick = function () {
        close(false);
      };
      btnOk.onclick = function () {
        close(true);
      };
      root.addEventListener("click", function (e) {
        if (e.target === root) close(false);
      });
      requestAnimationFrame(function () {
        btnOk.focus();
      });
    });
  }

  global.nessConfirm = nessConfirm;
})(typeof window !== "undefined" ? window : globalThis);
