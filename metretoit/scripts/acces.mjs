#!/usr/bin/env node
// Gestion de la page d'accès verrouillée, en SSH.
//   npm run acces -- ridha     définit l'identifiant « ridha » et demande le mot de passe
//   npm run acces -- --statut  affiche l'état
//   npm run acces -- --off     supprime le verrou (site public)
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import bcrypt from "bcryptjs";

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH ?? join(dataDir, "metretoit.db"));
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const set = (k, v) => db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
const get = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value;

// une seule interface de lecture pour toutes les questions (saisie masquée)
let rl = null;
const pending = [];
const answers = [];
function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let muted = false;
    const orig = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => {
      if (!muted || s.startsWith("\n") || s.startsWith("\r\n")) orig ? orig(s) : process.stdout.write(s);
    };
    rl.setMuted = (m) => (muted = m);
    rl.on("line", (l) => {
      const r = pending.shift();
      if (r) r(l);
      else answers.push(l);
    });
  }
  process.stdout.write(question);
  rl.setMuted(true);
  return new Promise((resolve) => {
    const done = (a) => {
      rl.setMuted(false);
      process.stdout.write("\n");
      resolve(a);
    };
    if (answers.length) done(answers.shift());
    else pending.push(done);
  });
}

const arg = process.argv[2];
if (!arg || arg === "--statut") {
  const u = get("gate_user");
  console.log(u ? `Accès verrouillé. Identifiant : ${u}` : "Accès libre (aucun verrou).");
  if (!arg) console.log("Usage : npm run acces -- <identifiant>   |   --statut   |   --off");
  process.exit(0);
}
if (arg === "--off") {
  db.prepare("DELETE FROM settings WHERE key IN ('gate_user', 'gate_hash')").run();
  console.log("Verrou supprimé : le site est de nouveau public.");
  process.exit(0);
}
const user = arg.trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(user)) {
  console.error("Identifiant invalide (lettres minuscules, chiffres, . _ -).");
  process.exit(1);
}
const p1 = await ask("Mot de passe (10 caractères minimum, invisible à la saisie) : ");
if (p1.length < 10) {
  rl?.close();
  console.error("Mot de passe trop court.");
  process.exit(1);
}
const p2 = await ask("Confirmez le mot de passe : ");
if (p1 !== p2) {
  rl?.close();
  console.error("Les deux mots de passe ne correspondent pas.");
  process.exit(1);
}
rl?.close();
set("gate_user", user);
set("gate_hash", bcrypt.hashSync(p1, 12));
console.log(`OK : le site est verrouillé. Identifiant « ${user} ». Effet immédiat, sans redémarrage.`);
