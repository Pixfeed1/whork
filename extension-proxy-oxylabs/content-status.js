// Voyant d'etat dans la page (domaines cibles uniquement).
// Vert = tu sors bien sur l'IP fixe du collectif.
// Rouge clignotant = protection coupee (tu es sur ta vraie IP), previens l'admin.
// Se branche sur l'etat reel du routage via le service worker (message page-status).
(function () {
  if (window.top !== window) return; // uniquement la fenetre principale

  var el = null, dot = null, txt = null, timer = null, last = null;

  function build() {
    if (el) return;
    el = document.createElement("div");
    el.id = "__hwc_status";
    el.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;" +
      "align-items:center;gap:8px;padding:8px 13px;border-radius:999px;color:#fff;" +
      "font:600 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;" +
      "box-shadow:0 6px 18px rgba(0,0,0,.28);user-select:none;pointer-events:none;";
    dot = document.createElement("span");
    dot.style.cssText = "width:9px;height:9px;min-width:9px;border-radius:50%;background:#fff;display:inline-block;";
    txt = document.createElement("span");
    el.appendChild(dot);
    el.appendChild(txt);
    (document.body || document.documentElement).appendChild(el);
  }

  function stopBlink() {
    if (timer) { clearInterval(timer); timer = null; }
    if (el) el.style.opacity = "1";
    if (dot) dot.style.opacity = "1";
  }

  function render(state) {
    if (state === "hide") { if (el) el.style.display = "none"; stopBlink(); last = state; return; }
    build();
    if (state === last) return; // evite de re-declencher l'animation en boucle
    last = state;
    el.style.display = "flex";
    stopBlink();
    var on = true;
    if (state === "ok") {
      el.style.background = "#16a34a";
      txt.textContent = "IP du collectif active";
      // clignotement doux de la pastille (tout va bien).
      timer = setInterval(function () { on = !on; dot.style.opacity = on ? "1" : "0.25"; }, 800);
    } else {
      el.style.background = "#dc2626";
      txt.textContent = "Protection coupee, previens l'admin";
      // clignotement franc de tout le voyant (alerte).
      timer = setInterval(function () { on = !on; el.style.opacity = on ? "1" : "0.4"; }, 550);
    }
  }

  function poll() {
    try {
      chrome.runtime.sendMessage({ type: "page-status", host: location.host }, function (r) {
        if (chrome.runtime.lastError || !r) return;
        if (!r.target) { render("hide"); return; }
        render(r.active ? "ok" : "ko");
      });
    } catch (e) { /* service worker indisponible : on reessaie au prochain tick */ }
  }

  poll();
  setInterval(poll, 5000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
})();
