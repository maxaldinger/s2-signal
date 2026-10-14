// SingleStore store for the GitHub prospecting tables:
//   gtm_monitored_repos   — curated watchlist of repos SingleStore buyers touch
//   gtm_github_signals    — one row per (person, repo, action, timestamp)
//   gtm_enriched_contacts — resolved + enriched people for the dashboard
//
// Server-side only, never throws, and an unconfigured deployment degrades to
// { configured: false } results. Ported from the PostgREST build: the in-list
// chunking and 1000-row paging it needed are gone — one SQL statement returns
// the whole result.

import { randomUUID } from "node:crypto";
import { q, s2Configured, toSqlValue } from "../s2/db";
import {
  isGitHubAction,
  type GitHubAction,
  type GitHubSignalEvent,
  type MonitoredRepo,
  type Prospect,
  type ProspectSignal,
  type ProspectStatus,
} from "./types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asJson = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// --------- Watchlist ---------

interface RepoRow {
  repo_key: string;
  owner: string;
  name: string;
  category: string;
  why_matters: string;
  active: boolean;
  stars: number | null;
  poll_cursor: unknown;
  last_polled_at: string | null;
}

function rowToRepo(r: RepoRow): MonitoredRepo {
  const cursor = (r.poll_cursor ?? {}) as Record<string, unknown>;
  const iso = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    repoKey: r.repo_key,
    owner: r.owner,
    name: r.name,
    category: r.category,
    whyMatters: r.why_matters,
    active: r.active,
    stars: r.stars ?? undefined,
    pollCursor: {
      starsAt: iso(cursor.starsAt),
      forksAt: iso(cursor.forksAt),
      commitsAt: iso(cursor.commitsAt),
      prsAt: iso(cursor.prsAt),
    },
    lastPolledAt: r.last_polled_at ?? undefined,
  };
}

export async function fetchMonitoredRepos(): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
  repos: MonitoredRepo[];
}> {
  if (!s2Configured()) return { configured: false, ok: false, error: "SingleStore not configured", repos: [] };
  try {
    const r = await q<RepoRow>(`SELECT * FROM gtm_monitored_repos ORDER BY (last_polled_at IS NULL) DESC, last_polled_at ASC`);
    return {
      configured: true,
      ok: true,
      repos: r.rows.map((row) => rowToRepo({ ...row, active: Boolean(Number(row.active)), poll_cursor: asJson(row.poll_cursor) })),
    };
  } catch (e) {
    return { configured: true, ok: false, error: `SingleStore repos read failed: ${errMsg(e)}`, repos: [] };
  }
}

/** Persist a repo's incremental cursor + metadata after a poll. Never throws. */
export async function updateRepoCursor(
  repoKey: string,
  fields: { pollCursor?: MonitoredRepo["pollCursor"]; stars?: number; active?: boolean },
): Promise<void> {
  if (!s2Configured()) return;
  const set: [string, unknown][] = [["last_polled_at", toSqlValue(new Date())]];
  if (fields.pollCursor) set.push(["poll_cursor", JSON.stringify(fields.pollCursor)]);
  if (typeof fields.stars === "number") set.push(["stars", fields.stars]);
  if (typeof fields.active === "boolean") set.push(["active", fields.active]);
  try {
    await q(`UPDATE gtm_monitored_repos SET ${set.map(([c]) => `${c} = ?`).join(", ")} WHERE repo_key = ?`, [...set.map(([, v]) => v), repoKey]);
  } catch {
    /* non-fatal — the cursor just replays a little history next run */
  }
}

// --------- Raw signals ---------

/** Insert collected events; duplicates (same person/repo/action/timestamp) are
 * silently ignored so incremental runs stay idempotent. Never throws. */
export async function insertGitHubSignals(
  events: GitHubSignalEvent[],
): Promise<{ ok: boolean; error?: string }> {
  if (!s2Configured()) return { ok: false, error: "SingleStore not configured" };
  if (events.length === 0) return { ok: true };
  try {
    for (let i = 0; i < events.length; i += 300) {
      const chunk = events.slice(i, i + 300);
      // INSERT IGNORE on the (login, repo_key, action, action_at) unique key
      // keeps incremental runs idempotent.
      await q(
        `INSERT IGNORE INTO gtm_github_signals (id, login, repo_key, action, action_at, weight, detail, url) VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?)").join(", ")}`,
        chunk.flatMap((e) => [randomUUID(), e.login, e.repoKey, e.action, toSqlValue(e.actionAt), e.weight, e.detail ?? null, e.url ?? null]),
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore signals insert failed: ${errMsg(e)}` };
  }
}

interface SignalRow {
  login: string;
  repo_key: string;
  action: string;
  action_at: string;
  weight: number;
  detail: string | null;
  url: string | null;
}

/** All stored signal rows for a set of logins (for score re-aggregation).
 * Returns null when any read fails or truncates — callers must NOT overwrite
 * existing aggregates from a partial read. */
export async function fetchSignalsForLogins(
  logins: string[],
): Promise<GitHubSignalEvent[] | null> {
  if (!s2Configured()) return null;
  if (logins.length === 0) return [];
  const out: GitHubSignalEvent[] = [];
  try {
    for (let i = 0; i < logins.length; i += 500) {
      const chunk = logins.slice(i, i + 500);
      const r = await q<SignalRow>(
        `SELECT login, repo_key, action, action_at, weight, detail, url FROM gtm_github_signals
         WHERE login IN (${chunk.map(() => "?").join(",")}) ORDER BY action_at DESC`,
        chunk,
      );
      for (const row of r.rows) {
        if (!isGitHubAction(row.action)) continue;
        out.push({
          login: row.login,
          repoKey: row.repo_key,
          action: row.action,
          actionAt: row.action_at,
          weight: row.weight,
          detail: row.detail ?? undefined,
          url: row.url ?? undefined,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Exact row count in gtm_github_signals (dashboard metric). */
export async function countGitHubSignals(): Promise<number> {
  if (!s2Configured()) return 0;
  try {
    const r = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_github_signals`);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

// --------- Prospects ---------

interface ProspectRow {
  login: string;
  name: string | null;
  avatar_url: string | null;
  github_url: string | null;
  location: string | null;
  company: string | null;
  company_domain: string | null;
  resolution_source: string | null;
  status: string;
  suppressed_reason: string | null;
  email: string | null;
  title: string | null;
  seniority: string | null;
  linkedin_url: string | null;
  headcount: number | null;
  hubspot_contact_id: string | null;
  hubspot_company_id: string | null;
  score: number;
  best_action: string | null;
  best_repo: string | null;
  signal_summary: unknown;
  opener: string | null;
  last_signal_at: string | null;
  updated_at: string;
}

const VALID_STATUSES: ProspectStatus[] = ["new", "resolved", "enriched", "no_match", "suppressed"];

function rowToProspect(r: ProspectRow): Prospect {
  const summary: ProspectSignal[] = Array.isArray(r.signal_summary)
    ? (r.signal_summary as unknown[])
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.repo === "string" && isGitHubAction(s.action))
        .map((s) => ({
          repo: String(s.repo),
          action: s.action as GitHubAction,
          at: typeof s.at === "string" ? s.at : "",
          url: typeof s.url === "string" ? s.url : undefined,
        }))
    : [];
  return {
    login: r.login,
    name: r.name ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    githubUrl: r.github_url ?? undefined,
    location: r.location ?? undefined,
    company: r.company ?? undefined,
    companyDomain: r.company_domain ?? undefined,
    resolutionSource: r.resolution_source ?? undefined,
    status: (VALID_STATUSES as string[]).includes(r.status) ? (r.status as ProspectStatus) : "new",
    suppressedReason: r.suppressed_reason ?? undefined,
    email: r.email ?? undefined,
    title: r.title ?? undefined,
    seniority: r.seniority ?? undefined,
    linkedinUrl: r.linkedin_url ?? undefined,
    headcount: r.headcount ?? undefined,
    hubspotContactId: r.hubspot_contact_id ?? undefined,
    hubspotCompanyId: r.hubspot_company_id ?? undefined,
    score: r.score,
    bestAction: isGitHubAction(r.best_action) ? r.best_action : undefined,
    bestRepo: r.best_repo ?? undefined,
    signals: summary,
    opener: r.opener ?? undefined,
    lastSignalAt: r.last_signal_at ?? undefined,
    updatedAt: r.updated_at,
  };
}

/** Fetch prospects, contribution-weighted first, up to `cap`. */
export async function fetchProspects(cap = 3000): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
  prospects: Prospect[];
}> {
  if (!s2Configured()) return { configured: false, ok: false, error: "SingleStore not configured", prospects: [] };
  try {
    const r = await q<ProspectRow>(
      `SELECT * FROM gtm_enriched_contacts ORDER BY score DESC, (last_signal_at IS NULL) ASC, last_signal_at DESC LIMIT ?`,
      [cap],
    );
    return { configured: true, ok: true, prospects: r.rows.map(toProspect) };
  } catch (e) {
    return { configured: true, ok: false, error: `SingleStore prospects read failed: ${errMsg(e)}`, prospects: [] };
  }
}

const toProspect = (r: ProspectRow) => rowToProspect({ ...r, signal_summary: asJson(r.signal_summary) });

/** Highest-score prospects awaiting a pipeline step (contributors first, so
 * merged-PR people always enrich before stargazers). */
/** Multi-label public suffixes. Without these, "monite.co.uk" collapses to
 *  "co.uk" — and every unrelated UK company then shares one key, producing
 *  false Signal 2000 matches (observed: monite.co.uk matching Universal Display
 *  via a bare "co.uk" root). Not the full Public Suffix List, just the ccTLD
 *  second-levels that actually occur in corporate domains. */
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.nz", "com.br", "com.mx", "com.ar", "com.co", "com.pe",
  "com.cn", "com.hk", "com.tw", "com.sg", "com.my", "com.ph", "com.vn",
  "co.in", "co.id", "co.kr", "co.th", "co.il", "co.za", "com.tr", "com.sa",
  "com.ua", "com.pl", "com.es", "com.pt", "co.at",
]);

/** Registrable root of a domain ("us.experian.com" → "experian.com") so a
 *  prospect on a regional subdomain still matches the directory's root entry. */
export function rootDomain(d: string): string {
  const parts = String(d || "").toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  // "foo.co.uk" needs three labels to stay a company; "us.experian.com" needs two.
  if (MULTI_SUFFIX.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/** Why a company counts as a target, strongest intent first. */
export type TargetKind = "prospected" | "researched" | "directory";

export interface DirectoryMatch {
  company: string;
  employees?: number;
  sweEstimate?: number;
  segment?: string;
  kind: TargetKind;
}

const TARGET_RANK: Record<TargetKind, number> = { prospected: 0, researched: 1, directory: 2 };

// Mirrors normCompany() in lib/clientStore.ts EXACTLY — the prospected store is
// keyed with it, so any divergence silently stops those matches working.
const COMPANY_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|gmbh|plc|sa|ag|nv|bv|pte|pvt|private|holdings)\b/g;
export function normCompanyName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(COMPANY_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Domain- and name-keyed lookups over every target source. */
export interface TargetIndex {
  byDomain: Map<string, DirectoryMatch>;
  byName: Map<string, DirectoryMatch>;
  size: number;
}

/** Keep the strongest-intent entry when several sources name the same company. */
function offer(map: Map<string, DirectoryMatch>, key: string, m: DirectoryMatch) {
  if (!key) return;
  const cur = map.get(key);
  if (!cur || TARGET_RANK[m.kind] < TARGET_RANK[cur.kind]) map.set(key, m);
}

/** Every target account, from all three sources, keyed by BOTH root domain and
 *  normalized name:
 *
 *    prospected  — pushed to HubSpot from the feed (strongest: real intent)
 *    researched  — an intel brief exists (carries domain + SWE estimate)
 *    directory   — the standing Signal 2000 universe
 *
 *  Name keys matter because prospected marks store only company names, and many
 *  GitHub prospects resolve to a name without a domain. */
export async function fetchTargetIndex(): Promise<TargetIndex> {
  const byDomain = new Map<string, DirectoryMatch>();
  const byName = new Map<string, DirectoryMatch>();
  if (!s2Configured()) return { byDomain, byName, size: 0 };

  const addDomain = (domain: string | undefined | null, m: DirectoryMatch) => {
    if (!domain) return;
    const key = rootDomain(domain);
    // Never key on a bare public suffix or single label.
    if (!key || !key.includes(".") || MULTI_SUFFIX.has(key)) return;
    offer(byDomain, key, m);
  };

  // --- Briefs: researched companies, the best source of domain + headcount.
  // Both fields are extracted from the JSON document inside SingleStore.
  try {
    const r = await q<{ company: string; domain: string | null; swe: number | null }>(
      `SELECT company, intel::$domain AS domain, intel::%sweEstimate AS swe FROM gtm_briefs LIMIT 5000`,
    );
    for (const row of r.rows) {
      const m: DirectoryMatch = {
        company: row.company,
        sweEstimate: typeof row.swe === "number" && row.swe > 0 ? row.swe : undefined,
        kind: "researched",
      };
      addDomain(row.domain || undefined, m);
      offer(byName, normCompanyName(row.company), m);
    }
  } catch {
    /* best effort */
  }

  // --- Prospected marks (any rep's): names only, but the strongest intent. ---
  try {
    const r = await q<{ value: unknown }>(`SELECT value FROM gtm_user_state WHERE store LIKE '%-prospected.v%'`);
    for (const row of r.rows) {
      const value = asJson(row.value) as { companies?: Record<string, unknown> } | null;
      for (const key of Object.keys(value?.companies ?? {})) {
        // Keys are ALREADY normCompany'd by the client store.
        const existing = byName.get(key);
        offer(byName, key, {
          company: existing?.company ?? key,
          sweEstimate: existing?.sweEstimate,
          employees: existing?.employees,
          kind: "prospected",
        });
        for (const [dk, dv] of byDomain)
          if (normCompanyName(dv.company) === key) byDomain.set(dk, { ...dv, kind: "prospected" });
      }
    }
  } catch {
    /* best effort */
  }

  // --- Signal 2000 directory (rows with a domain). ---
  try {
    const r = await q<{ company: string; domain: string | null; estimated_employees: number | null; swe_estimate: number | null; segment: string | null }>(
      `SELECT company, domain, estimated_employees, swe_estimate, segment FROM gtm_directory WHERE domain IS NOT NULL AND domain <> ''`,
    );
    for (const row of r.rows) {
      const m: DirectoryMatch = {
        company: row.company,
        employees: typeof row.estimated_employees === "number" ? row.estimated_employees : undefined,
        sweEstimate: typeof row.swe_estimate === "number" ? row.swe_estimate : undefined,
        segment: row.segment ?? undefined,
        kind: "directory",
      };
      addDomain(row.domain, m);
      offer(byName, normCompanyName(row.company), m);
    }
  } catch {
    // Index is an enhancement — an empty map just means no boosting this run.
  }
  return { byDomain, byName, size: byDomain.size + byName.size };
}

/** Match a prospect to a target account: domain first (precise), then company
 *  name (catches prospected marks, which store no domain). */
export function matchTarget(
  idx: TargetIndex,
  companyDomain?: string,
  company?: string,
): DirectoryMatch | undefined {
  if (companyDomain) {
    const hit = idx.byDomain.get(rootDomain(companyDomain));
    if (hit) return hit;
  }
  if (company) {
    const key = normCompanyName(company);
    if (key) return idx.byName.get(key);
  }
  return undefined;
}

/** People suppressed ONLY for company size who now clear `floor` — the set to
 *  re-queue when the size bar drops (e.g. an enterprise → mid-market pivot).
 *  Matched on the size reason prefix so HubSpot-dedupe and active-sequence
 *  suppressions are never resurrected by a threshold change. */
export async function fetchSizeSuppressedAbove(
  floor: number,
  limit: number,
): Promise<Prospect[]> {
  if (!s2Configured()) return [];
  try {
    // Clears the floor OR was never sized (unknown-size rows must re-queue
    // too; the enrich pass re-judges them).
    const r = await q<ProspectRow>(
      `SELECT * FROM gtm_enriched_contacts
       WHERE status = 'suppressed' AND (headcount >= ? OR headcount IS NULL) AND suppressed_reason LIKE 'Company size%'
       ORDER BY score DESC, (last_signal_at IS NULL) ASC, last_signal_at DESC LIMIT ?`,
      [floor, limit],
    );
    return r.rows.map(toProspect);
  } catch {
    return [];
  }
}

export async function fetchProspectsByStatus(
  statuses: ProspectStatus[],
  limit: number,
): Promise<Prospect[]> {
  if (!s2Configured() || statuses.length === 0) return [];
  try {
    const r = await q<ProspectRow>(
      `SELECT * FROM gtm_enriched_contacts WHERE status IN (${statuses.map(() => "?").join(",")})
       ORDER BY score DESC, (last_signal_at IS NULL) ASC, last_signal_at DESC LIMIT ?`,
      [...statuses, limit],
    );
    return r.rows.map(toProspect);
  } catch {
    return [];
  }
}

/** Upsert per-login signal aggregates. Only aggregate columns are written, so
 * enrichment fields on existing rows survive; brand-new rows get status "new"
 * from the column default. Never throws. */
export async function upsertProspectAggregates(
  aggregates: {
    login: string;
    score: number;
    bestAction: GitHubAction;
    bestRepo: string;
    signals: ProspectSignal[];
    lastSignalAt: string;
  }[],
): Promise<{ ok: boolean; error?: string }> {
  if (!s2Configured()) return { ok: false, error: "SingleStore not configured" };
  if (aggregates.length === 0) return { ok: true };
  try {
    const now = toSqlValue(new Date());
    for (let i = 0; i < aggregates.length; i += 300) {
      const chunk = aggregates.slice(i, i + 300);
      // Only aggregate columns are written, so enrichment fields on existing
      // rows survive; new rows get status 'new' from the column default.
      await q(
        `INSERT INTO gtm_enriched_contacts (login, github_url, score, best_action, best_repo, signal_summary, last_signal_at, updated_at)
         VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?)").join(", ")}
         ON DUPLICATE KEY UPDATE github_url = VALUES(github_url), score = VALUES(score), best_action = VALUES(best_action),
           best_repo = VALUES(best_repo), signal_summary = VALUES(signal_summary), last_signal_at = VALUES(last_signal_at), updated_at = VALUES(updated_at)`,
        chunk.flatMap((a) => [a.login, `https://github.com/${a.login}`, a.score, a.bestAction, a.bestRepo, JSON.stringify(a.signals), toSqlValue(a.lastSignalAt), now]),
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore aggregate upsert failed: ${errMsg(e)}` };
  }
}

/** Patch one prospect's pipeline fields (resolution / enrichment / opener). */
export async function updateProspect(
  login: string,
  fields: Partial<{
    name: string;
    avatarUrl: string;
    githubUrl: string;
    location: string;
    company: string;
    companyDomain: string;
    resolutionSource: string;
    status: ProspectStatus;
    suppressedReason: string;
    email: string;
    title: string;
    seniority: string;
    linkedinUrl: string;
    headcount: number;
    hubspotContactId: string;
    hubspotCompanyId: string;
    opener: string;
  }>,
): Promise<{ ok: boolean; error?: string }> {
  if (!s2Configured()) return { ok: false, error: "SingleStore not configured" };
  const map: Record<string, string> = {
    name: "name",
    avatarUrl: "avatar_url",
    githubUrl: "github_url",
    location: "location",
    company: "company",
    companyDomain: "company_domain",
    resolutionSource: "resolution_source",
    status: "status",
    suppressedReason: "suppressed_reason",
    email: "email",
    title: "title",
    seniority: "seniority",
    linkedinUrl: "linkedin_url",
    headcount: "headcount",
    hubspotContactId: "hubspot_contact_id",
    hubspotCompanyId: "hubspot_company_id",
    opener: "opener",
  };
  const body: Record<string, unknown> = { updated_at: toSqlValue(new Date()) };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && map[k]) body[map[k]] = v;
  }
  try {
    const cols = Object.keys(body);
    await q(`UPDATE gtm_enriched_contacts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE login = ?`, [...cols.map((c) => body[c]), login]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `SingleStore prospect update failed: ${errMsg(e)}` };
  }
}
