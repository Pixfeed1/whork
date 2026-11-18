import type { RoofModel } from "../../shared/roof";

export class ApiError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const ct = r.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? `Erreur ${r.status}`);
  return data as T;
}

export interface Me {
  user: { id: string; orgId: string; email: string; name: string; role: "owner" | "member" } | null;
  org?: Org;
  features?: { google: boolean; billing: boolean };
  quota?: Quota;
}
export interface Quota {
  enforced: boolean;
  plan: string;
  allowed: boolean;
  used: number;
  limit: number;
  period?: string;
}
export interface Org {
  id: string;
  name: string;
  address: string;
  postcode: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  siret: string;
  reportFooter: string;
  wastePct: number;
  hasLogo: boolean;
  plan: string;
  planStatus: string;
}
export interface Study {
  id: string;
  title: string;
  address: string;
  clientName: string;
  notes: string;
  lon: number;
  lat: number;
  totalArea: number;
  faceCount: number;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
  reportCount?: number;
  model?: RoofModel;
}
export interface Report {
  id: string;
  studyId: string;
  number: string;
  address: string;
  summary: { area: number; faceCount: number; meanPitchDeg: number; lengths: Record<string, number> };
  createdAt: string;
  author?: string | null;
}
export interface GeoResult {
  label: string;
  lon: number;
  lat: number;
  score: number;
  city?: string;
  postcode?: string;
  type?: string;
}

export const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
export const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
