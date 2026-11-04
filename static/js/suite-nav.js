/* Shared suite navigation — TempMail / Burn (identical on every product page) */
(function () {
  function ensureNav() {
    if (document.getElementById("suite-root")) return;

    const root = document.createElement("div");
    root.id = "suite-root";
    root.innerHTML =
      '<button type="button" class="suite-burger" id="suite-burger" aria-label="Open suite menu" aria-expanded="false">' +
        '<span></span><span></span><span></span>' +
      "</button>" +
      '<div class="suite-backdrop" id="suite-backdrop" hidden></div>' +
      '<nav class="suite-drawer" id="suite-drawer" aria-hidden="true">' +
        '<div class="suite-drawer-head">NESS Suite</div>' +
        '<a class="suite-link" data-suite="mail" href="/">TempMail</a>' +
        '<a class="suite-link" data-suite="burn" href="/burn">Burn</a>' +
        '<a class="suite-link" data-suite="invoice" href="/invoice">Pay</a>' +
        '<a class="suite-link" data-suite="storage" href="/storage">Storage</a>' +
        '<a class="suite-link" data-suite="wormhole" href="/wormhole">Wormhole</a>' +
        '<p class="suite-drawer-foot">PrivateNess Network</p>' +
      "</nav>";
    document.body.appendChild(root);

    const path = location.pathname || "/";
    let active = "mail";
    if (path.indexOf("/burn") === 0) active = "burn";
    else if (path.indexOf("/invoice") === 0) active = "invoice";
    else if (path.indexOf("/storage") === 0) active = "storage";
    else if (path.indexOf("/wormhole") === 0) active = "wormhole";
    root.querySelectorAll(".suite-link").forEach(function (a) {
      const id = a.getAttribute("data-suite");
      if (id === active) {
        a.classList.add("is-active");
        a.setAttribute("aria-current", "page");
      }
    });

    const burger = document.getElementById("suite-burger");
    const drawer = document.getElementById("suite-drawer");
    const backdrop = document.getElementById("suite-backdrop");

    function open() {
      drawer.classList.add("open");
      backdrop.hidden = false;
      requestAnimationFrame(function () { backdrop.classList.add("open"); });
      burger.setAttribute("aria-expanded", "true");
      drawer.setAttribute("aria-hidden", "false");
    }
    function close() {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
      drawer.setAttribute("aria-hidden", "true");
      setTimeout(function () {
        if (!drawer.classList.contains("open")) backdrop.hidden = true;
      }, 200);
    }

    burger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (drawer.classList.contains("open")) close();
      else open();
    });
    backdrop.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    drawer.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureNav);
  } else {
    ensureNav();
  }
})();
