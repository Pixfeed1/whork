// =====================================================================
// Hellowork du collectif - service worker (Manifest V3, Chrome 108+)
// v1.2.1
//
//  1. chrome.proxy en mode "pac_script" : seuls les domaines cibles
//     (+ ip.oxylabs.io, endpoint de diagnostic) passent par le proxy,
//     tout le reste est en DIRECT.
//  2. onAuthRequired (asyncBlocking, webRequestAuthProvider) : les
//     credentials sont lus depuis chrome.storage AU MOMENT du
//     challenge (robuste a la suspension du service worker).
//  3. Failsafe : sur echecs de tunnel repetes, le routage est coupe
//     automatiquement, l'utilisateur est notifie, la navigation
//     repasse en direct. Reactivation via popup ou Options.
//  4. Alignement optionnel du fingerprint du groupe sur les domaines
//     cibles. v1.2.1 : COHERENCE COMPLETE UA <-> client hints.
//       - reseau : User-Agent, Accept-Language, Sec-CH-UA (+ mobile,
//         platform, platform-version, arch, bitness, full-version[-list]).
//       - JS : navigator.userAgent/appVersion/platform/languages,
//         navigator.userAgentData (brands + getHighEntropyValues),
//         timezone, ecran.
//     => un vrai Mac force en profil Windows n'expose plus son OS via
//        userAgentData (le trou principal des extensions "UA only").
// =====================================================================

// Profil cible coherent par defaut (Windows 10 / Chrome 126 / fr-FR).
// Tous les consultants partagent CE profil => empreinte identique.
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

const DEFAULTS = {
  proxyHost: "isp.oxylabs.io",
  proxyPort: 8001,
  username: "",
  password: "",
  domains: ["hellowork.com"],
  suspended: false,

  // Bloque la fuite de l'IP reelle via WebRTC (recommande).
  blockWebRtcLeak: true,

  // --- Alignement fingerprint du groupe (optionnel) ---
  alignFingerprint: false,
  ...FP_PROFILE
};

// Endpoint de diagnostic, toujours route via le proxy.
const DIAG_DOMAIN = "ip.oxylabs.io";
const DIAG_URL = "https://ip.oxylabs.io/location";

// --- Configuration -----------------------------------------------------

async function getConfig() {
  return await chrome.storage.local.get(DEFAULTS);
}

async function applyFromStorage() {
  const cfg = await getConfig();
  const active = Boolean(cfg.username && cfg.password && !cfg.suspended);

  if (!active) {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } else {
    await chrome.proxy.settings.set({
      value: { mode: "pac_script", pacScript: { data: buildPacScript(cfg) } },
      scope: "regular"
    });
  }

  // L'alignement fingerprint ne s'applique que quand le routage est actif.
  const fpOn = active && Boolean(cfg.alignFingerprint);
  await updateHeaderRules(cfg, fpOn);
  updateFpScript(fpOn);

  // Anti-fuite WebRTC : quand le routage est actif, WebRTC ne doit pas
  // exposer la vraie IP en contournant le proxy.
  await updateWebRtc(active && cfg.blockWebRtcLeak !== false);
}

async function updateWebRtc(on) {
  try {
    if (on) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    } else {
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    }
  } catch (e) { /* API indisponible : non bloquant */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  const watched = [
    "username", "password", "proxyHost", "proxyPort", "domains", "suspended",
    "blockWebRtcLeak", "alignFingerprint", ...Object.keys(FP_PROFILE)
  ];
  if (keys.some(k => watched.includes(k))) {
    applyFromStorage();
  }
});

chrome.runtime.onInstalled.addListener(applyFromStorage);
chrome.runtime.onStartup.addListener(applyFromStorage);
applyFromStorage();

// --- PAC ---------------------------------------------------------------

function buildPacScript(cfg) {
  const proxy = `PROXY ${cfg.proxyHost}:${cfg.proxyPort}`;
  const domains = [...new Set([...(cfg.domains || []), DIAG_DOMAIN])]
    .map(d => String(d).trim().toLowerCase())
    .filter(Boolean);

  const conditions = domains
    .map(d => `(host === "${d}" || dnsDomainIs(host, ".${d}"))`)
    .join(" || ");

  return `function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (${conditions || "false"}) {
    return "${proxy}";
  }
  return "DIRECT";
}`;
}

// --- Injection des credentials (challenge 407 du proxy) -----------------

const pendingAuthRequests = new Set();

chrome.webRequest.onAuthRequired.addListener(
  (details, asyncCallback) => {
    // Uniquement les challenges du proxy (407), jamais les 401 de
    // sites web : les credentials Oxylabs ne sortent jamais ailleurs.
    if (!details.isProxy) {
      asyncCallback({});
      return;
    }
    if (pendingAuthRequests.has(details.requestId)) {
      pendingAuthRequests.delete(details.requestId);
      asyncCallback({ cancel: true });
      return;
    }
    pendingAuthRequests.add(details.requestId);
    chrome.storage.local
      .get({ username: "", password: "" })
      .then(creds => {
        if (!creds.username || !creds.password) {
          asyncCallback({ cancel: true });
          return;
        }
        asyncCallback({
          authCredentials: { username: creds.username, password: creds.password }
        });
      })
      .catch(() => asyncCallback({ cancel: true }));
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

function clearPending(details) {
  pendingAuthRequests.delete(details.requestId);
}
chrome.webRequest.onCompleted.addListener(clearPending, { urls: ["<all_urls>"] });

// --- Failsafe : coupure auto sur echecs de tunnel repetes ----------------

const FAIL_WINDOW_MS = 30000;
const FAIL_THRESHOLD = 2;
let failTimestamps = [];

async function isTargetHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const cfg = await getConfig();
    const domains = [...(cfg.domains || []), DIAG_DOMAIN].map(d => d.toLowerCase());
    return domains.some(d => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

chrome.webRequest.onErrorOccurred.addListener(async details => {
  clearPending(details);
  if (details.error !== "net::ERR_TUNNEL_CONNECTION_FAILED") return;
  if (!(await isTargetHost(details.url))) return;

  const now = Date.now();
  failTimestamps = failTimestamps.filter(t => now - t < FAIL_WINDOW_MS);
  failTimestamps.push(now);

  const cfg = await getConfig();
  if (failTimestamps.length >= FAIL_THRESHOLD && !cfg.suspended) {
    failTimestamps = [];
    await chrome.storage.local.set({ suspended: true });
    chrome.notifications.create("proxy-suspended", {
      type: "basic",
      iconUrl: "icon128.png",
      title: "Hellowork du collectif : routage suspendu",
      message:
        "Le proxy refuse la connexion (identifiants invalides ou quota epuise). " +
        "La navigation continue en direct. Ouvrez l'extension pour corriger et reactiver.",
      priority: 2
    });
  }
}, { urls: ["<all_urls>"] });

// --- Alignement fingerprint : en-tetes reseau (declarativeNetRequest) --------

const DNR_RULE_ID = 1001;

function parseBrands(secChUa) {
  const brands = [];
  const re = /"([^"]*)";v="([^"]*)"/g;
  let m;
  while ((m = re.exec(secChUa || "")) !== null) {
    brands.push({ brand: m[1], version: m[2] });
  }
  return brands;
}

function fullVersionListHeader(brands, fullVersion) {
  return brands.map(b => `"${b.brand}";v="${fullVersion}"`).join(", ");
}

async function updateHeaderRules(cfg, on) {
  const removeRuleIds = [DNR_RULE_ID];
  const domains = (cfg.domains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);

  if (!on || !domains.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => {});
    return;
  }

  const brands = parseBrands(cfg.fpSecChUa);
  const set = (header, value) => (value ? { header, operation: "set", value } : null);

  const headers = [
    set("user-agent", cfg.fpUserAgent),
    set("accept-language", cfg.fpAcceptLanguage),
    set("sec-ch-ua", cfg.fpSecChUa),
    set("sec-ch-ua-mobile", cfg.fpSecChUaMobile),
    set("sec-ch-ua-platform", cfg.fpUaPlatform ? `"${cfg.fpUaPlatform}"` : ""),
    set("sec-ch-ua-platform-version", cfg.fpPlatformVersion ? `"${cfg.fpPlatformVersion}"` : ""),
    set("sec-ch-ua-arch", cfg.fpArch ? `"${cfg.fpArch}"` : ""),
    set("sec-ch-ua-bitness", cfg.fpBitness ? `"${cfg.fpBitness}"` : ""),
    set("sec-ch-ua-full-version", cfg.fpUaFullVersion ? `"${cfg.fpUaFullVersion}"` : ""),
    set("sec-ch-ua-full-version-list", brands.length ? fullVersionListHeader(brands, cfg.fpUaFullVersion) : "")
  ].filter(Boolean);

  const addRules = headers.length
    ? [{
        id: DNR_RULE_ID,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: headers },
        // requestDomains couvre automatiquement les sous-domaines.
        condition: {
          requestDomains: domains,
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "image", "font", "other"]
        }
      }]
    : [];

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }).catch(() => {});
}

// --- Alignement fingerprint : niveau JS (world MAIN) -------------------------

let fpNavListenerBound = false;

// Injectee dans le contexte de la page sur les domaines cibles.
function fpSpoof(c) {
  try {
    const def = (o, p, v) => { try { Object.defineProperty(o, p, { get: () => v, configurable: true }); } catch (e) {} };

    if (c.ua) {
      def(navigator, "userAgent", c.ua);
      def(navigator, "appVersion", c.ua.replace(/^Mozilla\//, ""));
    }
    if (c.platform) def(navigator, "platform", c.platform);
    if (c.langs && c.langs.length) {
      def(navigator, "languages", Object.freeze(c.langs.slice()));
      def(navigator, "language", c.langs[0]);
    }
    if (c.sw) { def(screen, "width", c.sw); def(screen, "availWidth", c.sw); }
    if (c.sh) { def(screen, "height", c.sh); def(screen, "availHeight", c.sh); }
    if (c.tz) {
      const RDTF = Intl.DateTimeFormat;
      const origRO = RDTF.prototype.resolvedOptions;
      RDTF.prototype.resolvedOptions = function () {
        const o = origRO.call(this);
        o.timeZone = c.tz;
        return o;
      };
    }

    // Client hints JS (navigator.userAgentData) : c'est ici que le vrai OS
    // fuyait dans une extension "UA only". On remplace l'objet entier.
    if (c.uaData) {
      const u = c.uaData;
      const high = {
        architecture: u.architecture,
        bitness: u.bitness,
        brands: u.brands,
        fullVersionList: u.fullVersionList,
        mobile: u.mobile,
        model: u.model,
        platform: u.platform,
        platformVersion: u.platformVersion,
        uaFullVersion: u.uaFullVersion,
        wow64: u.wow64
      };
      const fake = {
        brands: u.brands,
        mobile: u.mobile,
        platform: u.platform,
        getHighEntropyValues: (hints) => Promise.resolve((() => {
          const r = { brands: u.brands, mobile: u.mobile, platform: u.platform };
          (hints || []).forEach(h => { if (h in high) r[h] = high[h]; });
          return r;
        })()),
        toJSON: () => ({ brands: u.brands, mobile: u.mobile, platform: u.platform })
      };
      def(navigator, "userAgentData", fake);
    }
  } catch (e) { /* non bloquant */ }
}

function updateFpScript(on) {
  if (on && !fpNavListenerBound) {
    chrome.webNavigation.onCommitted.addListener(onNavCommitted);
    fpNavListenerBound = true;
  } else if (!on && fpNavListenerBound) {
    chrome.webNavigation.onCommitted.removeListener(onNavCommitted);
    fpNavListenerBound = false;
  }
}

async function onNavCommitted(d) {
  if (!(await isTargetHost(d.url))) return;

  const cfg = await getConfig();
  if (!cfg.alignFingerprint || cfg.suspended) return;

  const brands = parseBrands(cfg.fpSecChUa);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: d.tabId, frameIds: [d.frameId] },
      world: "MAIN",
      injectImmediately: true,
      func: fpSpoof,
      args: [{
        ua: cfg.fpUserAgent,
        platform: cfg.fpPlatform,
        langs: String(cfg.fpLanguages || "").split(",").map(s => s.trim()).filter(Boolean),
        tz: cfg.fpTimezone,
        sw: Number(cfg.fpScreenW) || 0,
        sh: Number(cfg.fpScreenH) || 0,
        uaData: {
          brands,
          mobile: cfg.fpSecChUaMobile === "?1",
          platform: cfg.fpUaPlatform,
          platformVersion: cfg.fpPlatformVersion,
          uaFullVersion: cfg.fpUaFullVersion,
          fullVersionList: brands.map(b => ({ brand: b.brand, version: cfg.fpUaFullVersion })),
          architecture: cfg.fpArch,
          bitness: cfg.fpBitness,
          model: "",
          wow64: false
        }
      }]
    });
  } catch (e) { /* CSP stricte ou onglet ferme : non bloquant */ }
}

// --- Test de connexion (utilise par Options et le popup) -----------------

async function testConnection() {
  const cfg = await getConfig();
  if (!cfg.username || !cfg.password) {
    return { ok: false, error: "Identifiants non renseignes." };
  }
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: buildPacScript(cfg) } },
    scope: "regular"
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(DIAG_URL, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, error: `Reponse inattendue du diagnostic (HTTP ${resp.status}).` };
    }
    const data = await resp.json();
    const geo = data.providers?.maxmind || data.providers?.ip2location || {};
    return { ok: true, ip: data.ip || "inconnue", org: geo.org_name || "", city: geo.city || "" };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "Delai depasse : proxy injoignable ou identifiants refuses."
        : "Connexion refusee par le proxy : verifiez identifiants et quota Oxylabs."
    };
  } finally {
    clearTimeout(timer);
    const after = await getConfig();
    if (after.suspended) {
      const res = await chrome.proxy.settings.get({});
      if (res) await applyFromStorage();
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "test-connection") {
    testConnection().then(async result => {
      if (result.ok) {
        await chrome.storage.local.set({ suspended: false });
        failTimestamps = [];
      } else {
        await applyFromStorage();
      }
      sendResponse(result);
    });
    return true;
  }
  if (msg && msg.type === "get-status") {
    getConfig().then(cfg => {
      sendResponse({
        configured: Boolean(cfg.username && cfg.password),
        suspended: Boolean(cfg.suspended),
        username: cfg.username || "",
        domains: cfg.domains || [],
        alignFingerprint: Boolean(cfg.alignFingerprint)
      });
    });
    return true;
  }
});
