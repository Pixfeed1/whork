const DEFAULTS = {
  proxyHost: "pr.oxylabs.io",
  proxyPort: 7777,
  username: "",
  password: "",
  domains: ["hellowork.com"],

  alignFingerprint: false,
  fpUserAgent: "",
  fpAcceptLanguage: "fr-FR,fr;q=0.9",
  fpUaPlatform: "Windows",
  fpLanguages: "fr-FR,fr",
  fpPlatform: "Win32",
  fpTimezone: "Europe/Paris",
  fpScreenW: 1920,
  fpScreenH: 1080
};

const $ = (id) => document.getElementById(id);

function syncFpDisabled() {
  $("fpFields").disabled = !$("alignFingerprint").checked;
}

async function restore() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $("username").value = cfg.username;
  $("password").value = cfg.password;
  $("proxyHost").value = cfg.proxyHost;
  $("proxyPort").value = cfg.proxyPort;
  $("domains").value = (cfg.domains || []).join("\n");

  $("alignFingerprint").checked = !!cfg.alignFingerprint;
  $("fpUserAgent").value = cfg.fpUserAgent;
  $("fpAcceptLanguage").value = cfg.fpAcceptLanguage;
  $("fpUaPlatform").value = cfg.fpUaPlatform;
  $("fpLanguages").value = cfg.fpLanguages;
  $("fpPlatform").value = cfg.fpPlatform;
  $("fpTimezone").value = cfg.fpTimezone;
  $("fpScreenW").value = cfg.fpScreenW;
  $("fpScreenH").value = cfg.fpScreenH;
  syncFpDisabled();
}

async function saveAndTest() {
  const btn = $("save");
  const status = $("status");
  btn.disabled = true;
  status.className = "";
  status.textContent = "Enregistrement...";

  const domains = $("domains").value
    .split("\n")
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

  await chrome.storage.local.set({
    username: $("username").value.trim(),
    password: $("password").value,
    proxyHost: $("proxyHost").value.trim() || DEFAULTS.proxyHost,
    proxyPort: parseInt($("proxyPort").value, 10) || DEFAULTS.proxyPort,
    domains: domains.length ? domains : DEFAULTS.domains,

    alignFingerprint: $("alignFingerprint").checked,
    fpUserAgent: $("fpUserAgent").value.trim(),
    fpAcceptLanguage: $("fpAcceptLanguage").value.trim() || DEFAULTS.fpAcceptLanguage,
    fpUaPlatform: $("fpUaPlatform").value.trim() || DEFAULTS.fpUaPlatform,
    fpLanguages: $("fpLanguages").value.trim() || DEFAULTS.fpLanguages,
    fpPlatform: $("fpPlatform").value.trim() || DEFAULTS.fpPlatform,
    fpTimezone: $("fpTimezone").value.trim() || DEFAULTS.fpTimezone,
    fpScreenW: parseInt($("fpScreenW").value, 10) || DEFAULTS.fpScreenW,
    fpScreenH: parseInt($("fpScreenH").value, 10) || DEFAULTS.fpScreenH
  });

  status.textContent = "Test de la connexion proxy...";
  const r = await chrome.runtime.sendMessage({ type: "test-connection" });

  if (r && r.ok) {
    status.className = "ok";
    const loc = [r.city, r.org].filter(Boolean).join(", ");
    status.textContent = `Configuration validee. IP du groupe : ${r.ip}${loc ? " (" + loc + ")" : ""}`;
  } else {
    status.className = "ko";
    status.textContent = `Echec : ${(r && r.error) || "test refuse."} Verifiez l'identifiant et le mot de passe.`;
  }
  btn.disabled = false;
}

document.addEventListener("DOMContentLoaded", restore);
$("alignFingerprint").addEventListener("change", syncFpDisabled);
$("save").addEventListener("click", saveAndTest);
