// Base SQLite embarquée (module natif node:sqlite, aucune dépendance).
// Fichier : DATA_DIR/metretoit.db (par défaut ./data)
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH ?? join(DATA_DIR, "metretoit.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  postcode TEXT DEFAULT '',
  city TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  website TEXT DEFAULT '',
  siret TEXT DEFAULT '',
  report_footer TEXT DEFAULT '',
  waste_pct REAL DEFAULT 10,
  logo BLOB,
  logo_mime TEXT,
  plan TEXT DEFAULT 'trial',
  plan_status TEXT DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  report_seq INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  address TEXT NOT NULL,
  client_name TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  lon REAL NOT NULL,
  lat REAL NOT NULL,
  model TEXT NOT NULL,
  total_area REAL DEFAULT 0,
  face_count INTEGER DEFAULT 0,
  edited INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studies_org ON studies(org_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  number TEXT NOT NULL,
  address TEXT NOT NULL,
  summary TEXT NOT NULL,
  pdf BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_org ON reports(org_id, created_at DESC);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_org ON usage_events(org_id, kind, created_at);
CREATE TABLE IF NOT EXISTS thumbs (
  study_id TEXT PRIMARY KEY REFERENCES studies(id) ON DELETE CASCADE,
  img BLOB NOT NULL,
  bbox TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);
`);

// migrations : colonnes ajoutées après la première version
function addColumn(table: string, col: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn("organizations", "report_3d", "INTEGER DEFAULT 0");

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();

export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function getSetting(key: string): string | undefined {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value;
}
export function setSetting(key: string, value: string) {
  run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

export function logUsage(orgId: string, kind: string) {
  run("INSERT INTO usage_events(org_id, kind, created_at) VALUES(?, ?, ?)", orgId, kind, now());
}
export function usageThisMonth(orgId: string, kind: string): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return (
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ? AND kind = ? AND created_at >= ?",
      orgId,
      kind,
      start.toISOString(),
    )?.n ?? 0
  );
}
export function usageTotal(orgId: string, kind: string): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ? AND kind = ?", orgId, kind)?.n ?? 0;
}
