// Parcours complet dans un navigateur réel (Playwright).
// Usage : BASE=http://localhost:3000 npx tsx scripts/e2e.ts [dossier-captures]
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "/tmp/metretoit-e2e";
mkdirSync(OUT, { recursive: true });
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;

const browser = await chromium.launch({ proxy });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/tile|Failed to load resource/i.test(m.text()) && errors.push(m.text()));
const step = (s: string) => console.log(`→ ${s}`);
page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && console.log("  API", r.status(), r.url()));
process.on("unhandledRejection", async (e) => {
  await page.screenshot({ path: `${OUT}/echec.png` }).catch(() => {});
  console.error(e);
  process.exit(1);
});

step("accueil + inscription");
await page.goto(BASE);
await page.getByRole("link", { name: "Créer un compte" }).click();
const email = `e2e-${Date.now()}@exemple.fr`;
await page.getByLabel("Entreprise").fill("Guérin Couverture (test)");
await page.getByLabel("Votre nom").fill("Testeur");
await page.getByLabel("E-mail").fill(email);
await page.getByLabel(/Mot de passe/).fill("motdepasse-e2e");
await page.getByRole("button", { name: "Créer mon compte" }).click();
await page.waitForURL(/entreprise/);
await page.getByLabel("Téléphone").fill("05 46 00 00 00");
await page.getByLabel("Ville").fill("Saint-Martin-de-Ré");
await page.getByRole("button", { name: "Enregistrer" }).click();
await page.getByText("Coordonnées enregistrées").waitFor();
await page.screenshot({ path: `${OUT}/01-entreprise.png` });

step("nouvelle étude par adresse");
await page.getByRole("link", { name: "+ Nouvelle étude" }).click();
await page.waitForURL(/nouvelle/);
await page.getByRole("heading", { name: "Nouvelle étude" }).waitFor();
await page.getByLabel("Adresse").fill("Rue des Dunes 17580 Le Bois-Plage-en-Ré");
await page.locator(".addr-results li").first().waitFor({ timeout: 15000 });
await page.locator(".addr-results li").first().click();
await page.getByText(/bâtiment sélectionné/).waitFor({ timeout: 20000 });
await page.waitForTimeout(2500); // tuiles
await page.screenshot({ path: `${OUT}/02-selection.png` });
await page.getByRole("button", { name: "Lancer le métrage automatique" }).click();
await page.waitForURL(/etudes\//, { timeout: 60000 });
await page.getByTestId("total-area").waitFor();
await page.waitForTimeout(3000);
const area1 = await page.getByTestId("total-area").textContent();
console.log("  surface détectée :", area1);
await page.screenshot({ path: `${OUT}/03-editeur.png` });

step("sélection d'un pan et changement de pente");
await page.locator(".table.compact tbody tr").first().click();
await page.getByRole("heading", { name: /Pan 1/ }).waitFor();
const pitch = page.getByLabel("Pente (°)");
await pitch.fill("40");
await page.waitForTimeout(300);
const area2 = await page.getByTestId("total-area").textContent();
console.log("  surface après pente 40° sur le pan 1 :", area2);
if (area1 === area2) throw new Error("la surface n'a pas changé");
await page.screenshot({ path: `${OUT}/04-pan.png` });

step("annuler (Ctrl+Z)");
await page.locator("body").click({ position: { x: 5, y: 300 } }).catch(() => {});
await page.getByTitle("Annuler (Ctrl+Z)").click();
await page.waitForTimeout(300);
const area3 = await page.getByTestId("total-area").textContent();
console.log("  après annulation :", area3);
if (area3 !== area1) throw new Error("annulation incorrecte");

step("dessin d'un pan à la main");
await page.getByTitle("Dessiner un pan").click();
const map = page.getByTestId("editor-map");
const box = (await map.boundingBox())!;
const pts = [
  [0.1, 0.1],
  [0.2, 0.1],
  [0.2, 0.2],
  [0.1, 0.2],
];
for (const [x, y] of pts) await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
await page.getByRole("button", { name: "Terminer le pan" }).click();
await page.waitForTimeout(2500);
const nRows = await page.locator(".table.compact tbody tr").count();
console.log("  nombre de pans :", nRows);
await page.screenshot({ path: `${OUT}/05-dessin.png` });
await page.getByRole("button", { name: "Supprimer le pan" }).click();

step("changement de type d'arête");
await page.getByTitle("Sélection / déplacer").click();
await page.waitForTimeout(500);

step("enregistrement automatique");
await page.getByText("Enregistré", { exact: true }).waitFor({ timeout: 15000 });

step("rapport PDF");
const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 60000 }),
  page.getByRole("button", { name: "Générer le rapport PDF" }).click(),
]);
await popup.close().catch(() => {});
await page.getByRole("button", { name: /Rapports \(1\)/ }).waitFor({ timeout: 30000 });
const resp = await page.request.get(`${BASE}/api/reports`);
const reports = await resp.json();
const pdf = await page.request.get(`${BASE}/api/reports/${reports[0].id}/pdf`);
console.log("  PDF :", pdf.headers()["content-type"], (await pdf.body()).length, "octets");
await page.screenshot({ path: `${OUT}/06-rapports.png` });

step("historique");
await page.goto(`${BASE}/app/rapports`);
await page.getByText(reports[0].number).waitFor();
await page.goto(`${BASE}/app`);
await page.locator("tbody tr").first().waitFor();
await page.screenshot({ path: `${OUT}/07-etudes.png` });

step("mobile");
const mctx = await browser.newContext({ ...devices["iPhone 13"], ignoreHTTPSErrors: true, storageState: await ctx.storageState() });
const m = await mctx.newPage();
await m.goto(`${BASE}/app/etudes/${reports[0].studyId}`);
await m.getByTestId("total-area").waitFor();
await m.waitForTimeout(2500);
await m.screenshot({ path: `${OUT}/08-mobile.png`, fullPage: false });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log("  débordement horizontal mobile :", overflow);

await browser.close();
if (errors.length) {
  console.log("Erreurs navigateur :", errors);
  process.exit(1);
}
console.log("OK : parcours complet réussi");
