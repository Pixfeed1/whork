const $ = (id) => document.getElementById(id);

function extractGroup(username) {
  const m = /sessid-([^-]+)/i.exec(username || "");
  return m ? m[1] : (username ? "configure" : "-");
}

async function refreshStatus() {
  const st = await chrome.runtime.sendMessage({ type: "get-status" });
  $("group").textContent = extractGroup(st.username);
  $("domains").textContent = (st.domains || []).join(", ") || "-";

  const dot = $("dot");
  dot.className = "dot";
  if (!st.configured) {
    dot.classList.add("off");
    $("statusText").textContent = "Non configure";
    $("test").disabled = true;
  } else if (st.suspended) {
    dot.classList.add("ko");
    $("statusText").textContent = "Routage suspendu (erreur proxy)";
    $("test").textContent = "Corriger puis reactiver (test)";
    $("test").disabled = false;
  } else {
    dot.classList.add("ok");
    $("statusText").textContent = "Routage actif";
    $("test").textContent = "Tester la connexion";
    $("test").disabled = false;
  }
}

$("test").addEventListener("click", async () => {
  const btn = $("test");
  const result = $("result");
  btn.disabled = true;
  result.className = "";
  result.textContent = "Test en cours...";

  const r = await chrome.runtime.sendMessage({ type: "test-connection" });
  if (r && r.ok) {
    result.className = "ok";
    const loc = [r.city, r.org].filter(Boolean).join(", ");
    result.textContent = `IP du groupe : ${r.ip}${loc ? " (" + loc + ")" : ""}`;
  } else {
    result.className = "ko";
    result.textContent = (r && r.error) || "Echec du test.";
  }
  btn.disabled = false;
  refreshStatus();
});

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refreshStatus();
