#!/usr/bin/env node
// Compte d'administration interne (tests), en SSH :
//   npm run compte -- pixfeed     crée le compte « pixfeed » (ou change son mot de passe)
// Le compte appartient à l'entreprise « Pixfeed (administration) », sans limite d'études ni abonnement.
// Connexion sur la page « Connexion » : identifiant « pixfeed » à la place de l'e-mail.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import bcrypt from "bcryptjs";

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const db = new DatabaseSync(process.env.DB_PATH ?? join(dataDir, "metretoit.db"));
const hasTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasTables) {
  console.error("Base introuvable : lancez d'abord l'application une fois (npm start), puis recommencez.");
  process.exit(1);
}

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

const login = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[a-z0-9._@-]{2,60}$/.test(login)) {
  console.error("Usage : npm run compte -- <identifiant>   (lettres minuscules, chiffres, . _ -)");
  process.exit(1);
}
const p1 = await ask(`Mot de passe pour « ${login} » (10 caractères minimum, invisible à la saisie) : `);
if (p1.length < 10) {
  rl?.close();
  console.error("Mot de passe trop court.");
  process.exit(1);
}
const p2 = await ask("Confirmez le mot de passe : ");
rl?.close();
if (p1 !== p2) {
  console.error("Les deux mots de passe ne correspondent pas.");
  process.exit(1);
}
const hash = bcrypt.hashSync(p1, 10);
const now = new Date().toISOString();
const existing = db.prepare("SELECT id, org_id FROM users WHERE email = ? COLLATE NOCASE").get(login);
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'owner' WHERE id = ?").run(hash, existing.id);
  db.prepare("UPDATE organizations SET plan = 'interne', plan_status = 'active' WHERE id = ?").run(existing.org_id);
  console.log(`OK : mot de passe du compte « ${login} » modifié.`);
} else {
  const orgId = randomUUID();
  db.prepare("INSERT INTO organizations(id, name, plan, plan_status, created_at) VALUES(?, ?, 'interne', 'active', ?)").run(orgId, "Pixfeed (administration)", now);
  db.prepare("INSERT INTO users(id, org_id, email, name, password_hash, role, created_at) VALUES(?, ?, ?, ?, ?, 'owner', ?)").run(randomUUID(), orgId, login, "Pixfeed", hash, now);
  console.log(`OK : compte « ${login} » créé (entreprise « Pixfeed (administration) », sans limite d'études).`);
}
console.log("Connexion : page « Connexion », identifiant à la place de l'e-mail.");
