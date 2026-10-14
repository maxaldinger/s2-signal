"use client";

// Small client-only stores backed by localStorage, shared across components via
// useSyncExternalStore. Two concerns:
//   - prospected: companies/contacts the rep has pushed to HubSpot (a task was
//     created). Used to badge them as "Prospected" everywhere.
//   - deepDiveScores: the authoritative ICP total from a generated brief, keyed
//     by company. Lets the signal cards show the real score (not the rougher
//     per-signal estimate) once a brief has been opened.

import { useSyncExternalStore } from "react";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// normCompany moved to lib/companyKey.ts (WS6) so the sync-event writer on the
// server normalizes identically to every client-side store. Re-exported so
// existing imports keep working.
import { normCompany } from "./companyKey";
export { normCompany };

// ---------------- Cross-device sync ----------------
// Each makeStore registers here so the sync layer can hydrate it from SingleStore
// (via /api/state) on load and push changes back — so prospecting from a phone
// and a desktop share the same state. Single-user, no auth.
type SyncEntry = { applyServer: (raw: unknown) => void; current: () => unknown };
const registry = new Map<string, SyncEntry>();
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Debounced upsert of one store's value to the server.
function schedulePush(key: string) {
  if (typeof window === "undefined") return;
  const prev = pushTimers.get(key);
  if (prev) clearTimeout(prev);
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key);
      const entry = registry.get(key);
      if (!entry) return;
      void fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store: key, value: entry.current() }),
      }).catch(() => {});
    }, 700),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
// Union-merge, used ONCE on first sync so neither device loses pre-existing
// local data. On a key conflict the server (latest) value wins.
function deepMerge(local: unknown, server: unknown): unknown {
  if (isPlainObject(local) && isPlainObject(server)) {
    const out: Record<string, unknown> = { ...local };
    for (const [k, v] of Object.entries(server)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  return server ?? local;
}

let pulling = false;
// Replace local stores with the server's values (server authoritative). Runs on
// tab focus so a change made on another device shows up here (and deletions —
// unmark / reset — propagate, which a union-merge can't do).
async function pullState() {
  if (typeof window === "undefined" || pulling) return;
  pulling = true;
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { state?: Record<string, unknown> };
    if (!data?.state) return;
    for (const [k, v] of Object.entries(data.state)) registry.get(k)?.applyServer(v);
  } catch {
    /* offline — keep local */
  } finally {
    pulling = false;
  }
}

/** Propagate prospected marks across every name an account is known by.
 *
 *  MUST run in the client, not as a server-side data fix. Each store is pushed
 *  to the database as ONE whole object, last writer wins, so anything written
 *  straight into the table is erased by the next push from any open tab —
 *  which is a debounced 700ms after the next mark, i.e. almost immediately.
 *  Two server-side backfills were silently reverted that way before this was
 *  understood. Applied through the store, the repair pushes like any other
 *  change and sticks.
 *
 *  Idempotent: markProspected() is a no-op on a name that already has a mark,
 *  and the whole pass writes nothing when there is nothing to add. */
async function repairProspectedAliases() {
  try {
    const res = await fetch("/api/company-aliases");
    if (!res.ok) return;
    const data = (await res.json()) as { groups?: string[][] };
    const groups = data?.groups ?? [];
    if (groups.length === 0) return;
    const map = prospected.get().companies;
    for (const group of groups) {
      // Earliest existing mark in the group wins, so the badge keeps saying
      // when the account was ACTUALLY first prospected.
      let earliest = 0;
      for (const name of group) {
        const k = matchingKey(map, "company", name);
        const ts = k ? map[k] : undefined;
        if (ts && (earliest === 0 || ts < earliest)) earliest = ts;
      }
      const anyMarked = group.some((n) => matchingKey(prospected.get().companies, "company", n));
      if (!anyMarked) continue;
      for (const name of group) markProspected("company", name, earliest);
    }
  } catch {
    /* offline, or the alias source is unavailable — marks still work as before */
  }
}

// Shared-browser guard: if a DIFFERENT user signs in on this browser, every
// local s2-* store is the previous user's data and must be dropped before
// the first sync — otherwise the union-merge would push one rep's marks into
// another rep's server rows. The uid is remembered un-versioned on purpose.
const UID_KEY = "s2-uid";
async function guardLocalOwner(): Promise<void> {
  try {
    const res = await fetch("/api/auth/status", { cache: "no-store" });
    const d = (await res.json()) as { signedIn?: boolean; email?: string };
    if (!d.signedIn) return; // middleware will redirect; nothing to guard
    const uid = d.email ?? "";
    const prev = localStorage.getItem(UID_KEY);
    if (prev && prev !== uid) {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("s2-") && k.endsWith(KEY_VERSION)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
    }
    localStorage.setItem(UID_KEY, uid);
  } catch {
    /* offline — local-only until the next load */
  }
}

// ---- WS4: row-per-entry write-through for the shared caches ----
type CacheKind =
  | "scores"
  | "blurbs"
  | "sweepCursor"
  | "blacklist"
  | "contactReviews"
  | "sweOverrides"
  | "briefSwe"
  | "spendOverrides";
function pushCacheEntry(kind: CacheKind, key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  void fetch("/api/cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, key, value }),
  }).catch(() => {});
}
function deleteCacheEntry(kind: CacheKind, key: string): void {
  if (typeof window === "undefined") return;
  void fetch("/api/cache", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, key }),
  }).catch(() => {});
}

/** Like pushCacheEntry/deleteCacheEntry but CONFIRMED: resolves true only when
 *  the server accepted the write. For entries where a silently lost write is
 *  not acceptable (review verdicts drive the credit-spending gate, and the
 *  focus-time pull is a full replace that would erase an unpersisted one). */
// Bumped on every confirmed write; pullSharedCaches discards a snapshot that
// was requested BEFORE the latest write (its table read may predate the
// upsert commit, and applying it would full-replace the fresh value away).
let sharedCacheWriteSeq = 0;
async function writeCacheEntryConfirmed(
  method: "POST" | "DELETE",
  kind: CacheKind,
  key: string,
  value?: unknown,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const res = await fetch("/api/cache", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(method === "POST" ? { kind, key, value } : { kind, key }),
    });
    if (res.ok) sharedCacheWriteSeq++;
    return res.ok;
  } catch {
    return false;
  }
}

/** Hydrate the four shared caches from their row-per-entry tables. Server is
 *  authoritative — same posture as pullState for per-user stores. */
async function pullSharedCaches(): Promise<void> {
  if (typeof window === "undefined") return;
  const seqAtStart = sharedCacheWriteSeq;
  try {
    const res = await fetch("/api/cache", { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as {
      ok?: boolean;
      scores?: Record<string, number>;
      blurbs?: Record<string, string>;
      sweepCursor?: Record<string, number>;
      blacklist?: Record<string, string>;
      contactReviews?: Record<string, "qualified" | "excluded">;
      sweOverrides?: Record<string, number>;
      briefSwe?: Record<string, number>;
      spendOverrides?: Record<string, number>;
    };
    if (!d.ok) return;
    // A confirmed write landed while this pull was in flight — the snapshot
    // may predate it; skip applying, the next focus pull re-syncs.
    if (seqAtStart !== sharedCacheWriteSeq) return;
    if (d.scores) scores.applyServer(d.scores);
    if (d.blurbs) companyBlurbs.applyServer(d.blurbs);
    if (d.sweepCursor) sweepCursor.applyServer(d.sweepCursor);
    if (d.blacklist) blacklist.applyServer(d.blacklist);
    if (d.contactReviews) contactReviews.applyServer(d.contactReviews);
    if (d.sweOverrides) sweOverrides.applyServer(d.sweOverrides);
    if (d.briefSwe) briefSwe.applyServer(d.briefSwe);
    if (d.spendOverrides) spendOverrides.applyServer(d.spendOverrides);
  } catch {
    /* offline — local copies serve */
  }
}

let synced = false;
/** Start cross-device sync: union-merge with the server once (so nothing is
 * lost on first run), push the merged result up, then re-pull on tab focus.
 * Idempotent — safe to call from a mount effect. */
export function initStateSync() {
  if (synced || typeof window === "undefined") return;
  synced = true;
  void (async () => {
    await guardLocalOwner();
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = res.ok ? ((await res.json()) as { state?: Record<string, unknown> }) : null;
      const server = data?.state ?? {};
      for (const [key, entry] of registry) {
        const serverVal = server[key];
        if (serverVal === undefined) {
          schedulePush(key); // nothing on the server yet → seed from this device
        } else {
          entry.applyServer(deepMerge(entry.current(), serverVal));
          schedulePush(key); // push the union back up
        }
      }
    } catch {
      /* offline — stay local-only */
    }
    await pullSharedCaches();
    await pullSyncEvents();
    // AFTER the merge, so it sees the server's marks and not just this
    // browser's. Runs on every load and is cheap when there is nothing to do.
    await repairProspectedAliases();
  })();
  const onFocus = () => {
    if (!document.hidden) {
      void pullState();
      void pullSharedCaches();
      void pullSyncEvents();
    }
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
}

// Generic localStorage-backed store with a stable snapshot reference. An
// optional `coerce` migrates whatever shape is on disk into the current one.
// Every store also registers for cross-device sync (see above).
//
// KEY VERSION: bumping this orphans ALL prior state everywhere at once — old
// localStorage keys are never read again and old gtm_state rows never match
// the registry, so a factory reset sticks without a per-device manual clear.
// (A plain server wipe would NOT stick: the load-time union-merge would push
// each device's localStorage right back up.) v2 = 2026-07-16 full reset.
// v3 = 2026-08-08 multi-tenant split: per-user stores moved to
// gtm_user_state under the signed-in user's id (migrated server-side), so
// local v2 blobs must never union-merge into a per-user store again.
const KEY_VERSION = ".v3";

function makeStore<T>(
  baseKey: string,
  empty: T,
  coerce?: (raw: unknown) => T,
  // WS4: shared caches opt OUT of the /api/state whole-blob sync — they are
  // served row-per-entry from /api/cache instead. localStorage stays as this
  // browser's working copy either way.
  serverSync = true,
) {
  const key = `${baseKey}${KEY_VERSION}`;
  let cache: T | null = null;
  const listeners = new Set<() => void>();

  function get(): T {
    if (cache === null) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || "null");
        cache = coerce ? coerce(raw) : ((raw as T) ?? empty);
      } catch {
        cache = empty;
      }
    }
    return cache;
  }
  // Update local cache + localStorage + subscribers, WITHOUT echoing to the server.
  function commit(next: T) {
    cache = next;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode / quota — in-memory only */
    }
    listeners.forEach((l) => l());
  }
  function set(next: T) {
    commit(next);
    schedulePush(key);
  }
  function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }
  function useStore(): T {
    return useSyncExternalStore(subscribe, get, () => empty);
  }
  // Register for cross-device sync. applyServer writes server data in locally
  // without scheduling a push back (no echo loop). Un-synced stores skip the
  // registry, which also makes their schedulePush calls no-ops.
  if (serverSync) {
    registry.set(key, {
      applyServer: (raw) => commit(coerce ? coerce(raw) : ((raw as T) ?? empty)),
      current: () => get(),
    });
  }
  return { get, set, useStore, applyServer: (raw: unknown) => commit(coerce ? coerce(raw) : ((raw as T) ?? empty)) };
}

// ---------------- Prospected ----------------
// Each entry maps a normalized key -> epoch-ms timestamp of when it was sent to
// HubSpot. 0 means "prospected, date unknown" (a legacy entry stored before we
// tracked dates).
type DateMap = Record<string, number>;
type Prospected = { companies: DateMap; contacts: DateMap };

// Coerce the on-disk value into the date-map shape. Older builds stored plain
// string arrays (no dates) — migrate those to timestamp 0.
function asDateMap(raw: unknown): DateMap {
  const out: DateMap = {};
  if (Array.isArray(raw)) {
    for (const k of raw) if (typeof k === "string") out[k] = 0;
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = typeof v === "number" && v > 0 ? v : 0;
    }
  }
  return out;
}

const prospected = makeStore<Prospected>(
  "s2-prospected",
  { companies: {}, contacts: {} },
  (raw) => {
    const r = (raw ?? {}) as { companies?: unknown; contacts?: unknown };
    return { companies: asDateMap(r.companies), contacts: asDateMap(r.contacts) };
  },
);

const normFor = (kind: "company" | "contact", v: string) =>
  kind === "company" ? normCompany(v) : norm(v);

// Find the actual stored key that matches `key` under this kind's normalization.
function matchingKey(map: DateMap, kind: "company" | "contact", key: string): string | undefined {
  const target = normFor(kind, key);
  return Object.keys(map).find((v) => normFor(kind, v) === target);
}

export function markProspected(kind: "company" | "contact", key: string, at?: number): void {
  if (!key) return;
  const cur = prospected.get();
  const field = kind === "company" ? "companies" : "contacts";
  // Already prospected → keep the original date, don't overwrite it.
  if (matchingKey(cur[field], kind, key)) return;
  const k = normFor(kind, key);
  prospected.set({ ...cur, [field]: { ...cur[field], [k]: at && at > 0 ? at : Date.now() } });
}

export function unmarkProspected(kind: "company" | "contact", key: string): void {
  if (!key) return;
  const cur = prospected.get();
  const field = kind === "company" ? "companies" : "contacts";
  const k = matchingKey(cur[field], kind, key);
  if (!k) return;
  const next = { ...cur[field] };
  delete next[k];
  prospected.set({ ...cur, [field]: next });
}

/** Wipe every prospected mark (companies + contacts). Used to clear marks left
 * behind by the old buggy "check" that stamped records it merely found. */
export function clearAllProspected(): void {
  prospected.set({ companies: {}, contacts: {} });
}

/** Total number of prospected marks currently stored, across companies + contacts. */
export function useProspectedCount(): number {
  const s = prospected.useStore();
  return Object.keys(s.companies).length + Object.keys(s.contacts).length;
}

export function useIsProspected(kind: "company" | "contact", key: string): boolean {
  const s = prospected.useStore();
  if (!key) return false;
  return matchingKey(kind === "company" ? s.companies : s.contacts, kind, key) !== undefined;
}

/** Epoch-ms when this was sent to HubSpot, or undefined if not prospected / date unknown. */
export function useProspectedAt(kind: "company" | "contact", key: string): number | undefined {
  const s = prospected.useStore();
  if (!key) return undefined;
  const map = kind === "company" ? s.companies : s.contacts;
  const k = matchingKey(map, kind, key);
  const ts = k ? map[k] : 0;
  return ts && ts > 0 ? ts : undefined;
}

// ---------------- Contact review verdicts (shared) ----------------
// The Stage-6 gate's missing half: UNRESOLVED means "review the profile" —
// this records the review's outcome, shared with the whole team, so a card
// someone already judged never comes back locked (or worked) on a later pull.
// Keyed by Apollo id when the contact has one, else normalized name — the
// same convention as prospected contact marks.
type ContactReviews = Record<string, "qualified" | "excluded">;
const contactReviews = makeStore<ContactReviews>("s2-contact-reviews", {}, undefined, false);

/** Record a review verdict. SERVER-FIRST, unlike the other cache writes: the
 *  verdict unlocks the credit-spending email reveal, and the focus-time
 *  hydration is a full replace — an optimistic local set whose POST quietly
 *  failed would unlock the card, spend the credit, then vanish on the next
 *  tab focus. Local state only changes once the server has the row.
 *  Returns false when the write didn't stick — the caller says so. */
export async function setContactReview(
  key: string,
  verdict: "qualified" | "excluded",
): Promise<boolean> {
  if (!key) return false;
  const k = normFor("contact", key);
  const ok = await writeCacheEntryConfirmed("POST", "contactReviews", k, verdict);
  if (ok) contactReviews.set({ ...contactReviews.get(), [k]: verdict });
  return ok;
}

export async function clearContactReview(key: string): Promise<boolean> {
  if (!key) return false;
  const k = normFor("contact", key);
  const cur = contactReviews.get();
  if (cur[k] === undefined) return true;
  const ok = await writeCacheEntryConfirmed("DELETE", "contactReviews", k);
  if (ok) {
    const next = { ...cur };
    delete next[k];
    contactReviews.set(next);
  }
  return ok;
}

export function useContactReview(key: string): "qualified" | "excluded" | undefined {
  const s = contactReviews.useStore();
  if (!key) return undefined;
  return s[normFor("contact", key)];
}

// ---------------- Engineering headcount overrides (shared) ----------------
// The rep-confirmed engineer count for an account, set from the brief once the
// real number comes up on a call. Overrides the modeled estimate everywhere the
// account renders and feeds the personalized proposal's ROI. SERVER-FIRST like
// review verdicts: the focus-time hydration is a full replace, so an optimistic
// value whose POST quietly failed would show in the UI, feed a proposal, then
// vanish on the next tab focus.
const sweOverrides = makeStore<Record<string, number>>("s2-swe-overrides", {}, undefined, false);

/** Returns false when the write didn't stick — the caller says so. */
export async function setSweOverride(company: string, swe: number): Promise<boolean> {
  if (!company || !Number.isFinite(swe) || swe < 1) return false;
  const k = normCompany(company);
  const v = Math.round(swe);
  const ok = await writeCacheEntryConfirmed("POST", "sweOverrides", k, v);
  if (ok) sweOverrides.set({ ...sweOverrides.get(), [k]: v });
  return ok;
}

export async function clearSweOverride(company: string): Promise<boolean> {
  if (!company) return false;
  const k = normCompany(company);
  const cur = sweOverrides.get();
  if (cur[k] === undefined) return true;
  const ok = await writeCacheEntryConfirmed("DELETE", "sweOverrides", k);
  if (ok) {
    const next = { ...cur };
    delete next[k];
    sweOverrides.set(next);
  }
  return ok;
}

export function useSweOverride(company: string): number | undefined {
  const s = sweOverrides.useStore();
  return company ? companyValue(s, company) : undefined;
}

/** Raw override map for list views (one hook per row would break the rules of
 *  hooks in loops — use companyValue against this instead). */
export function useSweOverrides(): Record<string, number> {
  return sweOverrides.useStore();
}

// ---------------- Data-infrastructure spend overrides (shared) ----------------
// The account's actual monthly spend on the systems SingleStore could
// consolidate (serving DBs and replicas, real-time analytics store, cache,
// search, vector DB, ETL/CDC), learned on a call, in USD THOUSANDS per month.
// Replaces the proposal ROI's modeled engineers × $250/mo default assumption.
// SERVER-FIRST like headcount overrides: it feeds a cached document, so an
// optimistic value whose POST quietly failed must never show as saved.
const spendOverrides = makeStore<Record<string, number>>("s2-spend-overrides", {}, undefined, false);

/** Returns false when the write didn't stick — the caller says so. The
 *  100,000 ($K/mo, i.e. $100M/mo) ceiling matches the proposal route's clamp
 *  so a saved value can never be silently dropped downstream. */
export async function setSpendOverride(company: string, spendMo: number): Promise<boolean> {
  if (!company || !Number.isFinite(spendMo) || spendMo < 1 || spendMo > 100_000) return false;
  const k = normCompany(company);
  const v = Math.round(spendMo);
  const ok = await writeCacheEntryConfirmed("POST", "spendOverrides", k, v);
  if (ok) spendOverrides.set({ ...spendOverrides.get(), [k]: v });
  return ok;
}

export async function clearSpendOverride(company: string): Promise<boolean> {
  if (!company) return false;
  const k = normCompany(company);
  const cur = spendOverrides.get();
  if (cur[k] === undefined) return true;
  const ok = await writeCacheEntryConfirmed("DELETE", "spendOverrides", k);
  if (ok) {
    const next = { ...cur };
    delete next[k];
    spendOverrides.set(next);
  }
  return ok;
}

export function useSpendOverride(company: string): number | undefined {
  const s = spendOverrides.useStore();
  return company ? companyValue(s, company) : undefined;
}

// ---------------- Brief engineering-headcount estimates (shared) ----------------
// The researched engineering headcount from a generated intel brief — corrects the raw
// Apollo engineering-dept number the rows carry (that dept count includes
// mechanical engineers at industrial firms: Donaldson's dept says ~1.1K, the
// brief's research says ~120 software engineers). Written when a brief lands,
// exactly like the brief's ICP score below; the rep's call-confirmed override
// still outranks it everywhere. Fire-and-forget like scores — a lost write is
// benign, the next brief open re-pushes.
const briefSwe = makeStore<Record<string, number>>("s2-brief-swe", {}, undefined, false);

export function setBriefSwe(company: string, swe: number): void {
  if (!company || !Number.isFinite(swe) || swe < 1) return;
  const cur = briefSwe.get();
  const k = normCompany(company);
  const v = Math.round(swe);
  if (cur[k] === v) return;
  briefSwe.set({ ...cur, [k]: v });
  pushCacheEntry("briefSwe", k, v);
}

/** A regenerated brief that no longer carries a headcount estimate must RETRACT
 *  the old one — otherwise cards keep claiming "researched by the brief"
 *  forever while the brief header shows nothing. */
export function clearBriefSwe(company: string): void {
  if (!company) return;
  const cur = briefSwe.get();
  const k = Object.keys(cur).find((kk) => normCompany(kk) === normCompany(company));
  if (k === undefined) return;
  const next = { ...cur };
  delete next[k];
  briefSwe.set(next);
  deleteCacheEntry("briefSwe", k);
}

export function useBriefSwe(company: string): number | undefined {
  const s = briefSwe.useStore();
  return company ? companyValue(s, company) : undefined;
}

/** Raw map for list views (no hooks in loops — use companyValue against it). */
export function useBriefSweMap(): Record<string, number> {
  return briefSwe.useStore();
}

// ---------------- Deep-dive ICP scores ----------------
type Scores = Record<string, number>;
const scores = makeStore<Scores>("s2-deepdive-scores", {}, undefined, false);

export function setDeepDiveScore(company: string, score: number): void {
  if (!company) return;
  const cur = scores.get();
  const k = normCompany(company);
  if (cur[k] === score) return;
  scores.set({ ...cur, [k]: score });
  pushCacheEntry("scores", k, score);
}

export function useDeepDiveScore(company: string): number | undefined {
  const s = scores.useStore();
  if (!company) return undefined;
  const target = normCompany(company);
  // Match across normalization so a card ("Instabug") finds a brief score
  // stored under its canonical name ("Instabug, Inc.").
  for (const [k, v] of Object.entries(s)) {
    if (normCompany(k) === target) return v;
  }
  return undefined;
}

// ---------------- Low priority (minimized cards) ----------------
// Companies the rep has minimized on the feed — collapsed to just the name so
// they're out of the way without being hidden. Keyed by normalized company.
type LowPriority = Record<string, number>;
const lowPriority = makeStore<LowPriority>("s2-lowpriority", {}, (raw) => {
  const out: LowPriority = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of Object.keys(raw as Record<string, unknown>)) out[normCompany(k)] = 1;
  }
  return out;
});

export function toggleLowPriority(company: string): void {
  if (!company) return;
  const cur = lowPriority.get();
  const target = normCompany(company);
  const existing = Object.keys(cur).find((k) => normCompany(k) === target);
  if (existing) {
    const next = { ...cur };
    delete next[existing];
    lowPriority.set(next);
  } else {
    lowPriority.set({ ...cur, [target]: 1 });
  }
}

export function useIsLowPriority(company: string): boolean {
  const s = lowPriority.useStore();
  if (!company) return false;
  const target = normCompany(company);
  return Object.keys(s).some((k) => normCompany(k) === target);
}

// ---------------- Collapsed (minimized, but NOT deprioritized) ----------------
// A plain visual collapse: the card shrinks to a slim row but KEEPS its place in
// the sort. (Low-priority also collapses, but additionally sinks to the bottom.)
type Collapsed = Record<string, number>;
const collapsed = makeStore<Collapsed>("s2-collapsed", {}, (raw) => {
  const out: Collapsed = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of Object.keys(raw as Record<string, unknown>)) out[normCompany(k)] = 1;
  }
  return out;
});

export function collapseCard(company: string): void {
  if (!company) return;
  const cur = collapsed.get();
  const target = normCompany(company);
  if (Object.keys(cur).some((k) => normCompany(k) === target)) return;
  collapsed.set({ ...cur, [target]: 1 });
}

export function useIsCollapsed(company: string): boolean {
  const s = collapsed.useStore();
  if (!company) return false;
  const target = normCompany(company);
  return Object.keys(s).some((k) => normCompany(k) === target);
}

// Restore a card to full size, clearing BOTH collapse and low-priority state.
export function restoreCard(company: string): void {
  if (!company) return;
  const target = normCompany(company);
  const clear = (store: { get: () => Record<string, number>; set: (v: Record<string, number>) => void }) => {
    const cur = store.get();
    const k = Object.keys(cur).find((kk) => normCompany(kk) === target);
    if (k) {
      const next = { ...cur };
      delete next[k];
      store.set(next);
    }
  };
  clear(collapsed);
  clear(lowPriority);
}

// ---------------- Bulk lookups (for sorting the whole feed) ----------------
// Hooks return the raw store map (stable reference between writes, so they're
// safe useMemo deps). The pure helpers do normalized membership/value lookups
// against those maps — used to sort a list without one hook per row.
export function useDeepDiveScores(): Record<string, number> {
  return scores.useStore();
}
export function useProspectedCompanies(): Record<string, number> {
  return prospected.useStore().companies;
}
export function useLowPriorityCompanies(): Record<string, number> {
  return lowPriority.useStore();
}

export function companyInMap(map: Record<string, unknown>, company: string): boolean {
  if (!company) return false;
  const target = normCompany(company);
  for (const k in map) if (normCompany(k) === target) return true;
  return false;
}
export function companyValue(map: Record<string, number>, company: string): number | undefined {
  if (!company) return undefined;
  const target = normCompany(company);
  for (const k in map) if (normCompany(k) === target) return map[k];
  return undefined;
}

// ---------------- HubSpot live presence ----------------
// Filled by the card's HubSpot auto-check: 1 = found in HubSpot, 0 = checked &
// not found, absent = not checked yet. Lets the feed sort by the LIVE result
// (not just the local prospected flag). Re-checks on each card mount keep it
// fresh, so persisting it only avoids a flash on reload.
type Presence = Record<string, number>;
const hubspotPresence = makeStore<Presence>("s2-hs-presence", {});

export function setHubspotPresence(company: string, found: boolean): void {
  if (!company) return;
  const cur = hubspotPresence.get();
  const k = normCompany(company);
  const v = found ? 1 : 0;
  if (cur[k] === v) return;
  hubspotPresence.set({ ...cur, [k]: v });
}

export function useHubspotPresence(): Record<string, number> {
  return hubspotPresence.useStore();
}

// ---------------- Blacklist (not-a-fit) ----------------
// Companies the rep marked as not a fit (e.g. an OSS project, not a buyer).
// Hidden from the feed entirely and kept hidden across pulls. Stores the display
// name (value) keyed by normalized name (key) for a restore list.
const blacklist = makeStore<Record<string, string>>("s2-blacklist", {}, undefined, false);

export function toggleBlacklist(company: string): void {
  if (!company) return;
  const cur = blacklist.get();
  const k = normCompany(company);
  if (cur[k] !== undefined) {
    const next = { ...cur };
    delete next[k];
    blacklist.set(next);
    deleteCacheEntry("blacklist", k);
  } else {
    blacklist.set({ ...cur, [k]: company });
    pushCacheEntry("blacklist", k, company);
  }
}

export function removeFromBlacklist(company: string): void {
  if (!company) return;
  const cur = blacklist.get();
  const k = normCompany(company);
  if (cur[k] === undefined) return;
  const next = { ...cur };
  delete next[k];
  blacklist.set(next);
  deleteCacheEntry("blacklist", k);
}

export function useIsBlacklisted(company: string): boolean {
  const s = blacklist.useStore();
  return company ? companyInMap(s, company) : false;
}

export function useBlacklist(): Record<string, string> {
  return blacklist.useStore();
}

// ---------------- Reviewed ----------------
// Companies the rep has triaged. Auto-set when a brief is opened, and toggleable
// per card — drives the "reviewed / not reviewed" filter so you can work through
// the feed without re-covering the same accounts.
const reviewed = makeStore<Record<string, number>>("s2-reviewed", {});

export function markReviewed(company: string): void {
  if (!company) return;
  const cur = reviewed.get();
  const k = normCompany(company);
  if (Object.keys(cur).some((kk) => normCompany(kk) === k)) return;
  reviewed.set({ ...cur, [k]: 1 });
}

export function toggleReviewed(company: string): void {
  if (!company) return;
  const cur = reviewed.get();
  const k = normCompany(company);
  const existing = Object.keys(cur).find((kk) => normCompany(kk) === k);
  if (existing) {
    const next = { ...cur };
    delete next[existing];
    reviewed.set(next);
  } else {
    reviewed.set({ ...cur, [k]: 1 });
  }
}

export function useIsReviewed(company: string): boolean {
  const s = reviewed.useStore();
  return company ? companyInMap(s, company) : false;
}

export function useReviewedCompanies(): Record<string, number> {
  return reviewed.useStore();
}

// ---------------- Favorites ----------------
// Companies the rep starred for quick access ("hot caching"). Surfaced in the
// dedicated "Signal favorites" tab. Stores display name keyed by normalized name.
const favorites = makeStore<Record<string, string>>("s2-favorites", {});

export function toggleFavorite(company: string): void {
  if (!company) return;
  const cur = favorites.get();
  const k = normCompany(company);
  if (cur[k] !== undefined) {
    const next = { ...cur };
    delete next[k];
    favorites.set(next);
  } else {
    favorites.set({ ...cur, [k]: company });
  }
}

export function useIsFavorite(company: string): boolean {
  const s = favorites.useStore();
  return company ? companyInMap(s, company) : false;
}

export function useFavorites(): Record<string, string> {
  return favorites.useStore();
}

// ---------------- Last task due date ----------------
// Remembers the due date last picked in a HubSpot task, so scheduling across
// several contacts stays on that date instead of resetting each time.
const lastDue = makeStore<{ date?: string }>("s2-last-due", {});

export function getLastDueDate(): string | undefined {
  return lastDue.get().date;
}

export function setLastDueDate(date: string): void {
  if (date) lastDue.set({ date });
}

// ---------------- Apollo sweep cursor ----------------
// The page the next Apollo ICP sweep should fetch, per region. Persisted so the
// cursor marches forward across pulls instead of restarting (which would
// re-fetch page 1 and return only duplicates).
const sweepCursor = makeStore<Record<string, number>>("s2-sweep-cursor", {}, undefined, false);

export function getSweepPage(region: string): number | undefined {
  const v = sweepCursor.get()[region];
  return typeof v === "number" && v >= 1 ? v : undefined;
}

export function setSweepPage(region: string, page: number): void {
  if (!region || !(page >= 1)) return;
  const clamped = Math.min(100, Math.floor(page));
  sweepCursor.set({ ...sweepCursor.get(), [region]: clamped });
  pushCacheEntry("sweepCursor", region, clamped);
}

// ---------------- Company blurb cache ----------------
// Caches the generated "what the company does" blurb per company so a card that
// already fetched one doesn't re-fetch (Apollo/web) on re-render or re-page.
const companyBlurbs = makeStore<Record<string, string>>("s2-company-blurbs", {}, undefined, false);

export function getCompanyBlurb(company: string): string | undefined {
  if (!company) return undefined;
  const s = companyBlurbs.get();
  const target = normCompany(company);
  for (const [k, v] of Object.entries(s)) if (normCompany(k) === target) return v;
  return undefined;
}

export function setCompanyBlurb(company: string, blurb: string): void {
  if (!company || !blurb) return;
  const cur = companyBlurbs.get();
  const k = normCompany(company);
  if (cur[k] === blurb) return;
  companyBlurbs.set({ ...cur, [k]: blurb });
  pushCacheEntry("blurbs", k, blurb);
}

// ---------------- Apollo reveal cache ----------------
// Caches revealed email/phone/name per Apollo person id so the auto-reveal on a
// stakeholder card doesn't re-spend a credit every time a brief is reopened.
export type ApolloReveal = {
  name?: string;
  email?: string;
  emailStatus?: string;
  phone?: string;
  country?: string;
  /** The real profile URL. people/match returns it; the people SEARCH usually
   *  does not, which is why task notes read "PROFILE: UNRESOLVED" for people
   *  whose email had already been revealed. */
  linkedinUrl?: string;
};
// Local-only latency cache now: the AUTHORITATIVE reveal cache is server-side
// (gtm_reveal_cache, consulted by the person route before any Apollo spend).
const apolloReveals = makeStore<Record<string, ApolloReveal>>("s2-apollo-reveals", {}, undefined, false);

export function getReveal(apolloId: string): ApolloReveal | undefined {
  return apolloId ? apolloReveals.get()[apolloId] : undefined;
}

export function mergeReveal(apolloId: string, patch: ApolloReveal): void {
  if (!apolloId) return;
  const cur = apolloReveals.get();
  const next = { ...(cur[apolloId] ?? {}), ...patch };
  apolloReveals.set({ ...cur, [apolloId]: next });
}

// ---------------- Sync events (WS6) ----------------
// Shared, attributed "who pushed what to their HubSpot" — read-only on the
// client (the server writes events on every successful task create). Local-only
// store (no /api/state sync); hydrated from /api/sync-events on load + focus.
export type SyncEvent = { by: string; user: string; at: string };
type SyncEvents = { me?: string; companies: Record<string, SyncEvent>; contacts: Record<string, SyncEvent> };
const syncEvents = makeStore<SyncEvents>(
  "s2-sync-events",
  { companies: {}, contacts: {} },
  (raw) => {
    const r = (raw ?? {}) as Partial<SyncEvents>;
    return { me: r.me, companies: r.companies ?? {}, contacts: r.contacts ?? {} };
  },
  false,
);

export async function pullSyncEvents(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch("/api/sync-events", { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { ok?: boolean } & Partial<SyncEvents>;
    if (d.ok) syncEvents.applyServer({ me: d.me, companies: d.companies, contacts: d.contacts });
  } catch {
    /* offline — chips just don't render */
  }
}

/** Latest sync event for a company (normalized matching), with `mine` so the
 *  UI can suppress the chip when the viewer is the one who synced it. */
export function useCompanySyncEvent(company: string): (SyncEvent & { mine: boolean }) | undefined {
  const s = syncEvents.useStore();
  if (!company) return undefined;
  const target = normCompany(company);
  for (const [k, v] of Object.entries(s.companies)) {
    if (normCompany(k) === target) return { ...v, mine: v.user === s.me };
  }
  return undefined;
}

/** Latest sync event for a contact (exact key: apolloId || name). */
export function useContactSyncEvent(key: string): (SyncEvent & { mine: boolean }) | undefined {
  const s = syncEvents.useStore();
  if (!key) return undefined;
  const v = s.contacts[key] ?? s.contacts[key.toLowerCase()];
  return v ? { ...v, mine: v.user === s.me } : undefined;
}

/** Companies map for the feed's "in HubSpot" union (key -> epoch ms). */
export function useSyncEventCompanies(): Record<string, number> {
  const s = syncEvents.useStore();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.companies)) out[k] = new Date(v.at).getTime();
  return out;
}
