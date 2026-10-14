// SingleStore data layer for the signal feed, intel briefs, the Signal 2000
// directory and legacy shared state. Same function signatures the Supabase
// build exported (lib/supabase.ts), now plain SQL over the MySQL protocol.
//
// One row per (account, type) in gtm_signals: scans upsert, so repeat sightings
// refresh title/strength/last_seen_at while history accumulates. Unconfigured
// deployments degrade gracefully: callers get configured:false and the feed
// falls back to ephemeral (scan-only) mode. Nothing here throws.

import { randomUUID } from "node:crypto";
import { q, s2Configured, toSqlValue } from "./s2/db";
import { indexBrief } from "./briefVectors";
import type { CompanyIntel, DirectoryEntry, Signal, SegmentId, SignalTypeId } from "./types";
import type { RegionId } from "./data";

export function dbConfigured(): boolean {
  return s2Configured();
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface SignalRow {
  id: string;
  account: string;
  segment: string;
  type: string;
  strength: number;
  title: string;
  description: string;
  tags: unknown;
  source: string;
  url: string | null;
  event_date: string | null;
  swe_estimate: number | null;
  codebase_hint: string | null;
  created_at: string;
  last_seen_at: string;
}

function rowToSignal(r: SignalRow): Signal {
  let tags: unknown = r.tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  return {
    id: r.id,
    account: r.account,
    segment: r.segment as SegmentId,
    type: r.type as SignalTypeId,
    strength: r.strength,
    title: r.title,
    description: r.description,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    source: r.source,
    url: r.url ?? undefined,
    date: r.event_date ?? r.created_at.slice(0, 10),
    firstSeenAt: r.created_at,
    sweEstimate: r.swe_estimate ?? undefined,
    codebaseHint: r.codebase_hint ?? undefined,
  };
}

/** Upsert scan results; merge on (account, type). Never throws. */
export async function upsertSignals(signals: Signal[], region: RegionId): Promise<{ ok: boolean; error?: string }> {
  if (!dbConfigured()) return { ok: false, error: "SingleStore not configured" };
  if (signals.length === 0) return { ok: true };
  const now = new Date().toISOString();
  const cols = ["id", "region", "account", "segment", "type", "strength", "title", "description", "tags", "source", "url", "event_date", "swe_estimate", "codebase_hint", "last_seen_at"];
  // The same (account, type) twice in one batch would make the later row
  // overwrite the earlier one inside the statement; keep the strongest.
  const byKey = new Map<string, Signal>();
  for (const s of signals) {
    const k = `${s.account}\u0000${s.type}`;
    const prev = byKey.get(k);
    if (!prev || s.strength > prev.strength) byKey.set(k, s);
  }
  const rows = [...byKey.values()].map((s) => [
    randomUUID(), region, s.account, s.segment, s.type, Math.max(0, Math.min(99, Math.round(s.strength))), s.title, s.description ?? "",
    JSON.stringify(s.tags ?? []), s.source ?? "", s.url ?? null, /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : null,
    s.sweEstimate ?? null, s.codebaseHint ?? null, toSqlValue(now),
  ]);
  const update = cols.filter((c) => c !== "id" && c !== "account" && c !== "type").map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await q(
        `INSERT INTO gtm_signals (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(", ")}
         ON DUPLICATE KEY UPDATE ${update}`,
        chunk.flat(),
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore upsert failed: ${errMsg(e)}` };
  }
}

/** Persist enriched fields onto the cached signal row(s) for (account, type). */
export async function updateSignalRow(
  account: string,
  type: SignalTypeId,
  fields: { title?: string; description?: string; url?: string },
): Promise<void> {
  if (!dbConfigured() || !account) return;
  const set = Object.entries(fields).filter(([k, v]) => v && ["title", "description", "url"].includes(k));
  if (!set.length) return;
  try {
    await q(`UPDATE gtm_signals SET ${set.map(([k]) => `\`${k}\` = ?`).join(", ")} WHERE account = ? AND type = ?`, [
      ...set.map(([, v]) => v),
      account,
      type,
    ]);
  } catch {
    /* non-fatal — the value still returns to the client */
  }
}

/** Most recently seen accounts for one signal type, with the event date we hold. */
export async function fetchRecentAccounts(type: SignalTypeId, region: RegionId, limit = 60): Promise<{ account: string; date?: string }[]> {
  if (!dbConfigured()) return [];
  try {
    const r = await q<{ account: string; event_date: string | null }>(
      `SELECT account, event_date FROM gtm_signals WHERE type = ? AND region = ? ORDER BY last_seen_at DESC LIMIT ?`,
      [type, region, limit],
    );
    return r.rows.map((x) => ({ account: x.account, date: x.event_date ?? undefined }));
  } catch {
    return [];
  }
}

/** Exact row count for one signal type — drives sweep page rotation. */
export async function countSignalsByType(type: SignalTypeId, region: RegionId): Promise<number> {
  if (!dbConfigured()) return 0;
  try {
    const r = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_signals WHERE type = ? AND region = ?`, [type, region]);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Intel-brief cache — one row per company; persists until "Update brief".
// ---------------------------------------------------------------------------

const briefKey = (company: string) => company.trim().toLowerCase();

export async function fetchBrief(company: string): Promise<CompanyIntel | null> {
  if (!dbConfigured()) return null;
  try {
    const r = await q<{ intel: unknown }>(`SELECT intel FROM gtm_briefs WHERE company_key = ? LIMIT 1`, [briefKey(company)]);
    const v = r.rows[0]?.intel;
    if (!v) return null;
    return (typeof v === "string" ? JSON.parse(v) : v) as CompanyIntel;
  } catch {
    return null;
  }
}

export async function upsertBrief(company: string, intel: CompanyIntel): Promise<{ ok: boolean; error?: string }> {
  if (!dbConfigured()) return { ok: false, error: "SingleStore not configured" };
  try {
    await q(
      `INSERT INTO gtm_briefs (company_key, company, intel, generated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE company = VALUES(company), intel = VALUES(intel), generated_at = VALUES(generated_at)`,
      [briefKey(company), company.trim(), JSON.stringify(intel), toSqlValue(new Date())],
    );
    // Keep the semantic index in step with the brief (never fails the save).
    await indexBrief(company, intel);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore brief upsert failed: ${errMsg(e)}` };
  }
}

/** Merges serialised per brief, so sections expanded in parallel can't
 *  overwrite each other (read-modify-write on one JSON document). */
const briefLocks = new Map<string, Promise<unknown>>();

/** Apply `mutate` to a cached brief and save it. The brief is found by its
 *  cache key (the name the rep searched) or, failing that, by the resolved
 *  company name inside the JSON document (`intel::$name`), since on-demand
 *  sections are requested with the resolved name ("Coinbase Global, Inc.")
 *  while the cache is keyed by the query ("coinbase"). Never throws. */
export async function mergeIntoBrief(company: string, mutate: (brief: CompanyIntel) => void): Promise<boolean> {
  if (!dbConfigured() || !company.trim()) return false;
  let key = briefKey(company);
  try {
    const hit = await q<{ company_key: string }>(
      `SELECT company_key FROM gtm_briefs WHERE company_key = ? OR intel::$name = ? ORDER BY (company_key = ?) DESC, generated_at DESC LIMIT 1`,
      [key, company.trim(), key],
    );
    if (!hit.rows.length) return false;
    key = hit.rows[0].company_key;
  } catch {
    return false;
  }
  const prev = briefLocks.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const r = await q<{ company: string; intel: unknown }>(`SELECT company, intel FROM gtm_briefs WHERE company_key = ?`, [key]);
    const row = r.rows[0];
    if (!row) return false;
    const brief = (typeof row.intel === "string" ? JSON.parse(row.intel) : row.intel) as CompanyIntel;
    mutate(brief);
    await q(`UPDATE gtm_briefs SET intel = ? WHERE company_key = ?`, [JSON.stringify(brief), key]);
    // Expanded sections (pain points, why SingleStore) enrich the research
    // text, so re-embed the account.
    await indexBrief(row.company, brief, key);
    return true;
  });
  const settled = run.catch(() => false);
  briefLocks.set(key, settled);
  const ok = await settled;
  if (briefLocks.get(key) === settled) briefLocks.delete(key);
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// Legacy shared state (gtm_state) — one row per store.
// ---------------------------------------------------------------------------

export async function fetchState(): Promise<{ configured: boolean; ok: boolean; state: Record<string, unknown> }> {
  if (!dbConfigured()) return { configured: false, ok: false, state: {} };
  try {
    const r = await q<{ store: string; value: unknown }>(`SELECT store, value FROM gtm_state`);
    const state: Record<string, unknown> = {};
    for (const row of r.rows) state[row.store] = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return { configured: true, ok: true, state };
  } catch {
    return { configured: true, ok: false, state: {} };
  }
}

export async function upsertState(store: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!dbConfigured()) return { ok: false, error: "SingleStore not configured" };
  try {
    await q(
      `INSERT INTO gtm_state (store, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [store, JSON.stringify(value ?? {}), toSqlValue(new Date())],
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore state upsert failed: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Signal 2000 directory — the standing prospecting universe.
// ---------------------------------------------------------------------------

interface DirectoryRow {
  company_key: string;
  company: string;
  domain: string | null;
  region: string | null;
  segment: string | null;
  swe_estimate: number | null;
  short_brief: string | null;
  employee_band: string | null;
  estimated_employees: number | null;
  website_url: string | null;
  linkedin_url: string | null;
  strength: number | null;
  source: string | null;
}

function rowToDirectory(r: DirectoryRow): DirectoryEntry {
  return {
    companyKey: r.company_key,
    company: r.company,
    domain: r.domain ?? undefined,
    region: r.region === "in" ? "in" : "us",
    segment: (r.segment as SegmentId) || "enterprise",
    sweEstimate: r.swe_estimate ?? undefined,
    shortBrief: r.short_brief ?? "",
    employeeBand: r.employee_band ?? undefined,
    estimatedEmployees: r.estimated_employees ?? undefined,
    websiteUrl: r.website_url ?? undefined,
    linkedinUrl: r.linkedin_url ?? undefined,
    strength: r.strength ?? 0,
    source: r.source ?? "directory",
  };
}

export async function upsertDirectory(entries: DirectoryEntry[]): Promise<{ ok: boolean; error?: string }> {
  if (!dbConfigured()) return { ok: false, error: "SingleStore not configured" };
  if (entries.length === 0) return { ok: true };
  const cols = ["company_key", "company", "domain", "region", "segment", "swe_estimate", "short_brief", "employee_band", "estimated_employees", "website_url", "linkedin_url", "strength", "source", "last_seen_at"];
  const now = toSqlValue(new Date());
  const dedup = new Map(entries.map((e) => [e.companyKey, e]));
  const rows = [...dedup.values()].map((e) => [
    e.companyKey, e.company, e.domain ?? null, e.region ?? "us", e.segment, e.sweEstimate ?? null, e.shortBrief || null, e.employeeBand ?? null,
    e.estimatedEmployees ?? null, e.websiteUrl ?? null, e.linkedinUrl ?? null, e.strength, e.source, now,
  ]);
  const update = cols.filter((c) => c !== "company_key").map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await q(
        `INSERT INTO gtm_directory (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES ${chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(", ")}
         ON DUPLICATE KEY UPDATE ${update}`,
        chunk.flat(),
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore directory upsert failed: ${errMsg(e)}` };
  }
}

/** One region's directory, strongest-fit first (no row cap to page around). */
export async function fetchDirectory(
  region: RegionId = "us",
  cap = 2500,
): Promise<{ configured: boolean; ok: boolean; error?: string; entries: DirectoryEntry[]; total: number }> {
  if (!dbConfigured()) return { configured: false, ok: false, error: "SingleStore not configured", entries: [], total: 0 };
  try {
    const [rows, count] = await Promise.all([
      q<DirectoryRow>(`SELECT * FROM gtm_directory WHERE region = ? ORDER BY strength DESC, company ASC LIMIT ?`, [region, cap]),
      q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_directory WHERE region = ?`, [region]),
    ]);
    return { configured: true, ok: true, entries: rows.rows.map(rowToDirectory), total: Number(count.rows[0]?.n ?? 0) };
  } catch (e) {
    return { configured: true, ok: false, error: `SingleStore directory read failed: ${errMsg(e)}`, entries: [], total: 0 };
  }
}

export async function countDirectory(): Promise<number> {
  if (!dbConfigured()) return 0;
  try {
    const r = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_directory`);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export interface SignalPage {
  configured: boolean;
  ok: boolean;
  error?: string;
  signals: Signal[];
  total: number;
  /** True when the cache exceeded `cap` and only the most-recent rows loaded. */
  capped?: boolean;
}

/** The whole cache for a region (newest-seen first) so the client can
 *  sort/filter/paginate globally. */
export async function fetchAllSignals(region: RegionId, cap = 5000): Promise<SignalPage> {
  if (!dbConfigured()) return { configured: false, ok: false, error: "SingleStore not configured", signals: [], total: 0 };
  try {
    const [rows, count] = await Promise.all([
      q<SignalRow>(`SELECT * FROM gtm_signals WHERE region = ? ORDER BY last_seen_at DESC, strength DESC LIMIT ?`, [region, cap]),
      q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_signals WHERE region = ?`, [region]),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    return { configured: true, ok: true, signals: rows.rows.map(rowToSignal), total, capped: total > rows.rows.length };
  } catch (e) {
    return { configured: true, ok: false, error: `SingleStore read failed: ${errMsg(e)}`, signals: [], total: 0 };
  }
}

/** One page of cached signals, newest-seen first, with an exact total. */
export async function fetchSignalPage(page: number, pageSize: number, region: RegionId): Promise<SignalPage> {
  if (!dbConfigured()) return { configured: false, ok: false, error: "SingleStore not configured", signals: [], total: 0 };
  const p = Math.max(1, Math.floor(page));
  const size = Math.max(1, Math.min(100, Math.floor(pageSize)));
  try {
    const [rows, count] = await Promise.all([
      q<SignalRow>(`SELECT * FROM gtm_signals WHERE region = ? ORDER BY last_seen_at DESC, strength DESC LIMIT ? OFFSET ?`, [region, size, (p - 1) * size]),
      q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_signals WHERE region = ?`, [region]),
    ]);
    return { configured: true, ok: true, signals: rows.rows.map(rowToSignal), total: Number(count.rows[0]?.n ?? 0) };
  } catch (e) {
    return { configured: true, ok: false, error: `SingleStore read failed: ${errMsg(e)}`, signals: [], total: 0 };
  }
}

// ---------------------------------------------------------------------------
// Company alias groups — every set of names that refer to ONE company, derived
// from evidence already stored: a brief proves its row name and its resolved
// name are the same company; directory rows sharing a domain are one company.
// ---------------------------------------------------------------------------

export interface AliasGroupsResult {
  ok: boolean;
  configured: boolean;
  error?: string;
  groups: string[][];
}

export async function fetchCompanyAliasGroups(): Promise<AliasGroupsResult> {
  if (!dbConfigured()) return { ok: false, configured: false, groups: [] };
  try {
    const [briefs, directory] = await Promise.all([
      // The resolved name is pulled out of the JSON document server-side.
      q<{ company: string; resolved: string | null }>(`SELECT company, intel::$name AS resolved FROM gtm_briefs LIMIT 5000`),
      q<{ company: string; domain: string | null }>(`SELECT company, domain FROM gtm_directory WHERE domain IS NOT NULL AND domain <> '' LIMIT 20000`),
    ]);

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string;
      parent.set(x, r);
      return r;
    };
    const union = (a?: string | null, b?: string | null) => {
      if (!a || !b || a === b) return;
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    for (const row of briefs.rows) union(row.company?.trim(), row.resolved?.trim());
    const byDomain = new Map<string, string[]>();
    for (const row of directory.rows) {
      const d = row.domain?.trim().toLowerCase();
      const c = row.company?.trim();
      if (!d || !c) continue;
      const list = byDomain.get(d) ?? [];
      list.push(c);
      byDomain.set(d, list);
    }
    for (const names of byDomain.values()) for (let i = 1; i < names.length; i++) union(names[0], names[i]);

    const grouped = new Map<string, Set<string>>();
    for (const name of parent.keys()) {
      const root = find(name);
      const set = grouped.get(root) ?? new Set<string>();
      set.add(name);
      grouped.set(root, set);
    }
    return { ok: true, configured: true, groups: [...grouped.values()].map((s) => [...s]).filter((g) => g.length > 1) };
  } catch (e) {
    return { ok: false, configured: true, error: errMsg(e), groups: [] };
  }
}
