const DEFAULTS = {
  proxyHost: "pr.oxylabs.io",
  proxyPort: 7777,
  username: "",
  password: "",
  domains: ["hellowork.com"],

  alignFingerprint: false,
  fpUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  fpAcceptLanguage: "fr-FR,fr;q=0.9",
  fpSecChUa: '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  fpSecChUaMobile: "?0",
  fpUaPlatform: "Windows",
  fpPlatformVersion: "10.0.0",
  fpUaFullVersion: "126.0.0.0",
  fpArch: "x86",
  fpBitness: "64",
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
  $("fpSecChUa").value = cfg.fpSecChUa;
  $("fpSecChUaMobile").value = cfg.fpSecChUaMobile;
  $("fpUaPlatform").value = cfg.fpUaPlatform;
  $("fpPlatformVersion").value = cfg.fpPlatformVersion;
  $("fpUaFullVersion").value = cfg.fpUaFullVersion;
  $("fpArch").value = cfg.fpArch;
  $("fpBitness").value = cfg.fpBitness;
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
    fpUserAgent: $("fpUserAgent").value.trim() || DEFAULTS.fpUserAgent,
    fpAcceptLanguage: $("fpAcceptLanguage").value.trim() || DEFAULTS.fpAcceptLanguage,
    fpSecChUa: $("fpSecChUa").value.trim() || DEFAULTS.fpSecChUa,
    fpSecChUaMobile: $("fpSecChUaMobile").value.trim() || DEFAULTS.fpSecChUaMobile,
    fpUaPlatform: $("fpUaPlatform").value.trim() || DEFAULTS.fpUaPlatform,
    fpPlatformVersion: $("fpPlatformVersion").value.trim() || DEFAULTS.fpPlatformVersion,
    fpUaFullVersion: $("fpUaFullVersion").value.trim() || DEFAULTS.fpUaFullVersion,
    fpArch: $("fpArch").value.trim() || DEFAULTS.fpArch,
    fpBitness: $("fpBitness").value.trim() || DEFAULTS.fpBitness,
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
