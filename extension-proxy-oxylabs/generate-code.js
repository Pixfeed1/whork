// Generateur de "code de groupe" — page autonome (aucune API chrome).
// Le code encode toute la config du groupe (mot de passe inclus) en une
// chaine "OXY1:..." que le consultant colle dans l'extension.

const FP_PROFILE = {
  fpUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  fpAcceptLanguage: "fr-FR,fr;q=0.9",
  fpSecChUa: '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  fpSecChUaMobile: "?0",
  fpUaPlatform: "Windows",
  fpPlatformVersion: "10.0.0",
  fpUaFullVersion: "126.0.0.0",
  fpArch: "x86",
  fpBitness: "64",
  fpPlatform: "Win32",
  fpLanguages: "fr-FR,fr",
  fpTimezone: "Europe/Paris",
  fpScreenW: 1920,
  fpScreenH: 1080
};

const $ = (id) => document.getElementById(id);

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function encodeCode(cfg) {
  return "OXY1:" + b64urlEncode(JSON.stringify(cfg));
}

function prefillFp() {
  Object.keys(FP_PROFILE).forEach((k) => { if ($(k)) $(k).value = FP_PROFILE[k]; });
}

function generate() {
  const domains = $("domains").value
    .split("\n")
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

  const cfg = {
    username: $("username").value.trim(),
    password: $("password").value,
    proxyHost: $("proxyHost").value.trim() || "pr.oxylabs.io",
    proxyPort: parseInt($("proxyPort").value, 10) || 7777,
    domains: domains.length ? domains : ["hellowork.com"],
    alignFingerprint: $("alignFingerprint").checked
  };

  // On n'embarque le profil fingerprint que s'il est active (code plus court sinon).
  if (cfg.alignFingerprint) {
    Object.keys(FP_PROFILE).forEach((k) => {
      cfg[k] = $(k).value.trim() !== "" ? $(k).value.trim() : FP_PROFILE[k];
    });
    cfg.fpScreenW = parseInt($("fpScreenW").value, 10) || FP_PROFILE.fpScreenW;
    cfg.fpScreenH = parseInt($("fpScreenH").value, 10) || FP_PROFILE.fpScreenH;
  }

  $("code").value = encodeCode(cfg);
  $("copyStatus").textContent = "";
}

async function copy() {
  const code = $("code").value;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    $("copyStatus").textContent = "Copie.";
  } catch (e) {
    $("code").select();
    document.execCommand("copy");
    $("copyStatus").textContent = "Copie.";
  }
}

document.addEventListener("DOMContentLoaded", prefillFp);
$("gen").addEventListener("click", generate);
$("copy").addEventListener("click", copy);
