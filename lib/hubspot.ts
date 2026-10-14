// HubSpot CRM client — search companies/contacts and create tasks.
//
// Auth: a Private App access token in HUBSPOT_TOKEN (bearer). Create one at
// Settings → Integrations → Private Apps with these scopes:
//   crm.objects.companies.read, crm.objects.companies.write,
//   crm.objects.contacts.read,  crm.objects.contacts.write,
//   crm.objects.tasks.read,     crm.objects.tasks.write
// A timeline Note is also logged on each push. Notes have no dedicated scope —
// they're covered by the CRM object write scopes above — so no extra scope is
// needed. If a note ever fails it's reported via noteError; the task still lands.
//
// Project rule (shared with the enrichment layer): never fabricate data — every
// function returns either real HubSpot fields or an honest error.

import { plainToHtml } from "./format";

const BASE = "https://api.hubapi.com";
const TIMEOUT_MS = 15_000;

// HubSpot CRM object type ids (for building record deep-links).
const OBJ_CONTACT = "0-1";
const OBJ_COMPANY = "0-2";
const OBJ_TASK = "0-27";

// HubSpot default association type ids (task → object).
const TASK_TO_CONTACT = 204;
const TASK_TO_COMPANY = 192;
// …and (note → object), so the same context also logs as a timeline Note.
const NOTE_TO_CONTACT = 202;
const NOTE_TO_COMPANY = 190;

export type HsKind = "company" | "contact";
export type HsTaskType = "CALL" | "EMAIL" | "TODO";

export interface HsRecord {
  id: string;
  name?: string;
  /** domain (company) or email (contact) when present. */
  detail?: string;
  url?: string;
}

export interface HsSearchResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  found: boolean;
  /** Validated matches only (capped); first is the best guess. Full-text hits
   *  that do not actually name the queried person/company are removed. */
  records: HsRecord[];
  /** Set when full-text hits were discarded as name mismatches — surfaced so a
   *  silently-empty result is distinguishable from "HubSpot had nothing". */
  note?: string;
  /** STAGE 7. "exact" = matched on email (contact) or domain (company), which
   *  is a confirmed match. "name" = full-text name hit, which is a CANDIDATE
   *  and must be confirmed by a human before anything is written to it.
   *  "none" = no match. */
  matchedBy?: HsMatchedBy;
}

export interface HsTaskResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  taskId?: string;
  taskUrl?: string;
  /** Set when a timeline Note with the same body was also logged. */
  noteId?: string;
  /** Why the note couldn't be logged (the task still succeeded), if it failed. */
  noteError?: string;
  /** Which CRM record the task was linked to, and whether we had to create it. */
  linkedTo?: HsRecord & { kind: HsKind; created: boolean };
}

// HUBSPOT_TOKEN may be either:
//   - a Private App access token ("pat-na1-…") — used directly as a Bearer; or
//   - a Personal Access Key (the CLI credential) — which is exchanged here for a
//     short-lived OAuth access token via HubSpot's local-dev auth endpoint.
const PAK_REFRESH_URL = "https://api.hubapi.com/localdevauth/v1/auth/refresh";
let accessTokenCache: { token: string; expiresAt: number } | undefined;

export interface HsAuthContext {
  /** App user id — use THIS user's OAuth connection (WS5). Absent = the
   *  env HUBSPOT_TOKEN (the weekly cron, which stays on Max's private app). */
  asUser?: string;
  /** Owner id resolved alongside the token — assigned to tasks/notes so they
   *  land in the acting user's own queue. */
  ownerId?: string;
}

async function resolveAccessToken(ctx?: HsAuthContext): Promise<
  { ok: true; token: string; ownerId?: string } | { ok: false; configured: boolean; error: string }
> {
  if (ctx?.asUser) {
    const { resolveUserAccessToken } = await import("./hubspotOAuth");
    const r = await resolveUserAccessToken(ctx.asUser);
    if (!r.ok || !r.token) return { ok: false, configured: true, error: r.error ?? "HubSpot not connected" };
    ctx.ownerId = r.ownerId;
    return { ok: true, token: r.token, ownerId: r.ownerId };
  }
  const raw = process.env.HUBSPOT_TOKEN?.trim();
  if (!raw)
    return { ok: false, configured: false, error: "HUBSPOT_TOKEN not set — add it to .env.local / Vercel env" };

  // Private App token — usable as-is.
  if (raw.startsWith("pat-")) return { ok: true, token: raw };

  // Personal Access Key — exchange for a cached short-lived access token.
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expiresAt - 60_000 > now) {
    return { ok: true, token: accessTokenCache.token };
  }
  try {
    const res = await fetch(PAK_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ encodedOAuthRefreshToken: raw }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return { ok: false, configured: true, error: statusError(res.status, "personal-access-key exchange") };
    }
    const j = (await res.json()) as {
      oauthAccessToken?: string;
      expiresAtMillis?: number;
      hubId?: number;
    };
    if (!j.oauthAccessToken)
      return { ok: false, configured: true, error: "HubSpot PAK exchange returned no access token" };
    accessTokenCache = { token: j.oauthAccessToken, expiresAt: j.expiresAtMillis ?? now + 25 * 60_000 };
    // The exchange already tells us the portal — skip the account-info call.
    if (j.hubId && portalIdCache === undefined) portalIdCache = String(j.hubId);
    return { ok: true, token: j.oauthAccessToken };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      error: isTimeout(e) ? "HubSpot PAK exchange timed out" : "HubSpot PAK exchange failed",
    };
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

// Registrable-ish root of a domain ("us.experian.com" -> "experian.com"), so a
// subdomain email still matches its company. Good enough for our gate.
function rootDomain(d?: string | null): string {
  if (!d) return "";
  const clean = d.toLowerCase().trim().replace(/^www\./, "");
  const parts = clean.split(".").filter(Boolean);
  return parts.length <= 2 ? clean : parts.slice(-2).join(".");
}

function statusError(status: number, what: string): string {
  if (status === 401) return `HubSpot 401 on ${what} — HUBSPOT_TOKEN is invalid or expired`;
  if (status === 403)
    return `HubSpot 403 on ${what} — token is missing a required CRM write scope. A Personal Access Key (CLI key) can't be granted write scopes; use a Private App token (pat-na1-…) with companies/contacts/tasks read+write.`;
  if (status === 429) return `HubSpot 429 on ${what} — rate limited, retry shortly`;
  return `HubSpot HTTP ${status} on ${what}`;
}

async function hsFetch(
  path: string,
  init: { method: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown },
  key: string
): Promise<{ status: number; body: unknown }> {
  // HubSpot search caps at ~4 req/s; on a busy feed we trip it. Retry 429s a
  // couple of times with a short backoff so a transient rate-limit doesn't fail
  // the whole task (and the internal record lookups still find existing rows).
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429 && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Math.min(3000, (Number.isFinite(retryAfter) ? retryAfter : attempt + 1) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }
}

// portalId is needed to build app.hubspot.com record links. Fetched once and
// cached for the lifetime of the serverless instance.
let portalIdCache: string | null | undefined;
async function portalId(key: string): Promise<string | null> {
  if (portalIdCache !== undefined) return portalIdCache;
  try {
    const { status, body } = await hsFetch("/account-info/v3/details", { method: "GET" }, key);
    portalIdCache =
      status === 200 ? String((body as { portalId?: number })?.portalId ?? "") || null : null;
  } catch {
    portalIdCache = null;
  }
  return portalIdCache;
}

function recordUrl(pid: string | null, objType: string, id: string): string | undefined {
  return pid ? `https://app.hubspot.com/contacts/${pid}/record/${objType}/${id}` : undefined;
}

interface HsObject {
  id: string;
  properties?: Record<string, string | null | undefined>;
}

// --------- Name-match validation ---------
//
// HubSpot's `query` parameter is FULL-TEXT: it OR-matches tokens across
// searchable properties. Searching "Rich Sauser" happily returns "Sarah Rich"
// on the shared "rich" token. Nothing downstream re-checked the result, and the
// first row became the record a task was ATTACHED to — so one collision wrote a
// contact's outreach onto a different, real person's timeline.
//
// These helpers re-validate every full-text hit against what was actually
// asked for. Exact-key searches (email EQ / domain EQ) skip validation: they
// are already precise.

const LEGAL_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|llc|l l c|ltd|limited|gmbh|plc|sa|ag|nv|bv|pte|pvt|holdings?|group|the)\b/g;
/** Personal-name noise that must not count as a surname. */
const NAME_NOISE = /\b(jr|sr|ii|iii|iv|phd|md|mba|cpa|pe|esq)\b/g;

function nameTokens(s: string, stripLegal: boolean): string[] {
  let t = String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents so "José" == "Jose"
    .replace(/[^a-z0-9\s]/g, " ");
  t = t.replace(NAME_NOISE, " ");
  if (stripLegal) t = t.replace(LEGAL_SUFFIX, " ");
  return t.split(/\s+/).filter(Boolean);
}

/** Would a person searching `queried` accept `found` as the same PERSON?
 *  Surname-anchored: the last token must match (or be a clear nickname/prefix
 *  of it), which is exactly what "Rich Sauser" vs "Sarah Rich" fails. */
export function personNameMatches(queried: string, found: string): boolean {
  const q = nameTokens(queried, false);
  const f = nameTokens(found, false);
  if (q.length === 0 || f.length === 0) return false;

  const qLast = q[q.length - 1];
  const fLast = f[f.length - 1];
  // Surnames must agree. One may be a prefix of the other (hyphenated or
  // truncated forms), but only when it is substantial — a 3-char prefix would
  // re-open the collision this function exists to close.
  const surnameOk =
    qLast === fLast ||
    (qLast.length >= 4 && fLast.startsWith(qLast)) ||
    (fLast.length >= 4 && qLast.startsWith(fLast));
  if (!surnameOk) return false;

  // A surname alone is not enough — "J Sauser" vs "Rich Sauser" could be
  // different people, but a matching first initial plus surname is the
  // strongest signal available without an email.
  const qFirst = q[0];
  const fFirst = f[0];
  if (q.length === 1 || f.length === 1) return true; // only a surname supplied
  return (
    qFirst === fFirst ||
    qFirst.startsWith(fFirst) || // "rich" vs "richard" (nickname)
    fFirst.startsWith(qFirst) ||
    qFirst[0] === fFirst[0] // initial-only records ("R Sauser")
  );
}

/** Would a rep accept `found` as the same COMPANY? Token-prefix, so "Ally"
 *  matches "Ally Financial" but not "Rally Software". */
export function companyNameMatches(queried: string, found: string): boolean {
  const q = nameTokens(queried, true);
  const f = nameTokens(found, true);
  if (q.length === 0 || f.length === 0) return false;
  const shorter = q.length <= f.length ? q : f;
  const longer = q.length <= f.length ? f : q;
  return shorter.every((tok, i) => longer[i] === tok);
}

/** Search HubSpot for a company (by domain, else name) or contact (by email, else name). */
export async function hubspotSearch(
  kind: HsKind,
  opts: { name?: string; domain?: string; email?: string },
  ctx?: HsAuthContext
): Promise<HsSearchResult> {
  const fail = (configured: boolean, error: string): HsSearchResult => ({
    configured,
    ok: false,
    error,
    found: false,
    records: [],
  });

  const auth = await resolveAccessToken(ctx);
  if (!auth.ok) return fail(auth.configured, auth.error);
  const key = auth.token;

  const objType = kind === "company" ? "companies" : "contacts";
  const properties =
    kind === "company"
      ? ["name", "domain", "website"]
      : ["firstname", "lastname", "email", "jobtitle"];

  // Exact filter when we have a strong key (domain/email); else full-text query.
  let payload: Record<string, unknown>;
  /** Set only on the full-text path — the results then need name validation. */
  let fullTextQuery: string | undefined;
  if (kind === "company" && opts.domain) {
    payload = {
      filterGroups: [
        { filters: [{ propertyName: "domain", operator: "EQ", value: opts.domain }] },
      ],
      properties,
      limit: 5,
    };
  } else if (kind === "contact" && opts.email) {
    payload = {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: opts.email }] }],
      properties,
      limit: 5,
    };
  } else {
    const q = opts.name?.trim();
    if (!q) return fail(true, `Provide a ${kind === "company" ? "company name/domain" : "contact name/email"}`);
    payload = { query: q, properties, limit: 5 };
    // Full-text: every hit MUST be re-validated below before it can be treated
    // as a match, because HubSpot OR-matches tokens across properties.
    fullTextQuery = q;
  }

  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await hsFetch(`/crm/v3/objects/${objType}/search`, { method: "POST", body: payload }, key));
  } catch (e) {
    return fail(true, isTimeout(e) ? "HubSpot search timed out after 15s" : "HubSpot search failed");
  }
  if (status !== 200) return fail(true, statusError(status, `${kind} search`));

  const results = (body as { results?: HsObject[] } | undefined)?.results ?? [];
  const pid = await portalId(key);
  const all: HsRecord[] = results.map((r) => {
    const p = r.properties ?? {};
    const name =
      kind === "company"
        ? p.name ?? undefined
        : [p.firstname, p.lastname].filter(Boolean).join(" ") || undefined;
    const detail = kind === "company" ? p.domain ?? p.website ?? undefined : p.email ?? undefined;
    return {
      id: r.id,
      name: name ?? undefined,
      detail: detail ?? undefined,
      url: recordUrl(pid, kind === "company" ? OBJ_COMPANY : OBJ_CONTACT, r.id),
    };
  });

  // Validate full-text hits. A row that does not actually name the person or
  // company we asked for is DISCARDED, not demoted — callers take records[0]
  // and attach tasks to it, so a plausible-looking wrong row is worse than no
  // row at all. No match now correctly reports "not in HubSpot", and the task
  // push creates a fresh record instead of writing onto a stranger's timeline.
  let records = all;
  let rejected = 0;
  if (fullTextQuery) {
    const matches = kind === "company" ? companyNameMatches : personNameMatches;
    records = all.filter((r) => (r.name ? matches(fullTextQuery, r.name) : false));
    rejected = all.length - records.length;
  }

  // STAGE 7 — report HOW we matched, not just whether. An email/domain hit is a
  // confirmed match; a full-text name hit is a CANDIDATE and must never render
  // as a confirmed badge. This is the distinction that produced the "Rich
  // Sauser" -> "Sarah Rich" collision: HubSpot OR-matches tokens across
  // properties, so a first- or last-name overlap looked like the same person.
  const matchedBy: HsMatchedBy = records.length === 0 ? "none" : fullTextQuery ? "name" : "exact";
  return {
    configured: true,
    ok: true,
    found: records.length > 0,
    matchedBy,
    records,
    ...(rejected > 0
      ? { note: `${rejected} full-text hit${rejected === 1 ? "" : "s"} discarded as name mismatches` }
      : {}),
  };
}

export type HsMatchedBy = "exact" | "name" | "none";

// HubSpot default association: Contact → Company (primary).
const CONTACT_TO_COMPANY = 279;

async function createObject(
  objType: "companies" | "contacts",
  properties: Record<string, string>,
  key: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { status, body } = await hsFetch(`/crm/v3/objects/${objType}`, { method: "POST", body: { properties } }, key);
  if (status !== 201 && status !== 200) return { ok: false, error: statusError(status, `create ${objType}`) };
  const id = (body as { id?: string } | undefined)?.id;
  return id ? { ok: true, id } : { ok: false, error: `HubSpot create ${objType} returned no id` };
}

// Best-effort field fill on an existing record — never throws, so enrichment
// failures don't block task creation.
async function patchObject(
  objType: "companies" | "contacts",
  id: string,
  properties: Record<string, string>,
  key: string
): Promise<void> {
  if (Object.keys(properties).length === 0) return;
  try {
    await hsFetch(`/crm/v3/objects/${objType}/${id}`, { method: "PATCH", body: { properties } }, key);
  } catch {
    /* non-fatal */
  }
}

// Pin an engagement to a record's timeline ONLY when the record has no pinned
// activity yet — an existing pin is a deliberate choice we never overwrite.
// Best-effort: if the current pin can't be read, skip rather than risk clobbering.
async function pinIfUnpinned(
  objType: "companies" | "contacts",
  id: string,
  engagementId: string,
  key: string
): Promise<void> {
  try {
    const { status, body } = await hsFetch(
      `/crm/v3/objects/${objType}/${id}?properties=hs_pinned_engagement_id`,
      { method: "GET" },
      key
    );
    if (status !== 200) return;
    const current = (body as { properties?: { hs_pinned_engagement_id?: string | null } } | undefined)
      ?.properties?.hs_pinned_engagement_id;
    if (current) return; // something is already pinned — leave it alone
    await patchObject(objType, id, { hs_pinned_engagement_id: engagementId }, key);
  } catch {
    /* non-fatal — the task itself already landed */
  }
}

async function associateDefault(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  key: string
): Promise<void> {
  try {
    await hsFetch(
      `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
      { method: "PUT" },
      key
    );
  } catch {
    /* non-fatal — the task still lands on the primary record */
  }
}

function contactProps(opts: { name?: string; email?: string; phone?: string; jobtitle?: string }): Record<string, string> {
  const p: Record<string, string> = {};
  if (opts.email) p.email = opts.email;
  if (opts.phone) p.phone = opts.phone;
  if (opts.jobtitle) p.jobtitle = opts.jobtitle;
  if (opts.name) {
    const [first, ...rest] = opts.name.split(" ");
    if (first) p.firstname = first;
    if (rest.length) p.lastname = rest.join(" ");
  }
  return p;
}

// Resolve (objectId → search → create) a company, returning its id + record.
async function resolveCompany(
  opts: { name?: string; domain?: string; objectId?: string },
  key: string,
  ctx?: HsAuthContext
): Promise<{ ok: boolean; error?: string; id?: string; record?: HsRecord; created?: boolean }> {
  if (!opts.objectId && !opts.name && !opts.domain) return { ok: true }; // nothing to link
  if (opts.objectId) return { ok: true, id: opts.objectId, record: { id: opts.objectId, name: opts.name } };
  const search = await hubspotSearch("company", { name: opts.name, domain: opts.domain }, ctx);
  if (!search.ok) return { ok: false, error: search.error };
  if (search.found) return { ok: true, id: search.records[0].id, record: search.records[0], created: false };
  const props: Record<string, string> = {};
  if (opts.name) props.name = opts.name;
  if (opts.domain) props.domain = opts.domain;
  const c = await createObject("companies", props, key);
  if (!c.ok || !c.id) return { ok: false, error: c.error };
  const pid = await portalId(key);
  return {
    ok: true,
    id: c.id,
    created: true,
    record: { id: c.id, name: opts.name, detail: opts.domain, url: recordUrl(pid, OBJ_COMPANY, c.id) },
  };
}

/**
 * Create a HubSpot task with a fully-populated CRM record behind it.
 *
 * For a contact: resolves/creates the parent company, resolves/creates the
 * contact while writing email + phone + job title into its standard fields
 * (filling them on an existing contact too), links the contact to the company,
 * then creates the task associated to BOTH the contact and the company.
 * For a company: resolves/creates the company and associates the task to it.
 * Records are never orphaned and never fabricated beyond the fields provided.
 */
export async function hubspotCreateTask(input: {
  kind: HsKind;
  objectId?: string;
  // contact fields
  name?: string;
  email?: string;
  phone?: string;
  jobtitle?: string;
  // company (linkage for a contact, or the target for a company task)
  companyName?: string;
  companyDomain?: string;
  companyObjectId?: string;
  // company-task target (kind === "company")
  domain?: string;
  // task
  subject: string;
  body: string;
  dueDateMs: number;
  taskType?: HsTaskType;
}, ctx?: HsAuthContext): Promise<HsTaskResult> {
  const fail = (configured: boolean, error: string): HsTaskResult => ({ configured, ok: false, error });

  const auth = await resolveAccessToken(ctx);
  if (!auth.ok) return fail(auth.configured, auth.error);
  const key = auth.token;
  const actingOwnerId = auth.ownerId ?? process.env.HUBSPOT_OWNER_ID?.trim();
  if (!input.subject?.trim()) return fail(true, "A task subject is required");
  if (!Number.isFinite(input.dueDateMs)) return fail(true, "A valid due date is required");

  // Association ids of the records this task should appear on.
  const taskAssociations: { id: string; typeId: number }[] = [];
  let primary: (HsRecord & { kind: HsKind; created: boolean }) | undefined;

  if (input.kind === "company") {
    const co = await resolveCompany(
      { name: input.name, domain: input.domain, objectId: input.objectId },
      key,
      ctx
    );
    if (!co.ok || !co.id) return fail(true, co.error || "Could not resolve the company in HubSpot");
    taskAssociations.push({ id: co.id, typeId: TASK_TO_COMPANY });
    primary = { ...(co.record as HsRecord), kind: "company", created: Boolean(co.created) };
  } else {
    // Guard: never push a contact with a WRONG-company email (off-domain) — that
    // mis-associates the contact in HubSpot. A MISSING email is fine: we create
    // the contact by name and log a LinkedIn-connect task (see the task route /
    // the client, which frames it accordingly).
    if (input.companyDomain && input.email) {
      const compDom = rootDomain(input.companyDomain);
      const emailDom = rootDomain(input.email.split("@")[1]);
      if (compDom && emailDom && emailDom !== compDom) {
        return fail(
          true,
          `Not pushed: ${input.email} isn't on ${compDom}. The contact's email domain must match the company, or HubSpot would link it to the wrong account.`,
        );
      }
    }

    // 1. Parent company (so the contact + task hang off it). Best-effort: a
    // failed lookup/create here (e.g. a 429 or a duplicate-company 400) must NOT
    // kill the contact task — we just skip the company association.
    const co = await resolveCompany(
      { name: input.companyName, domain: input.companyDomain, objectId: input.companyObjectId },
      key,
      ctx
    );

    // 2. Contact — find or create, then fill email/phone/jobtitle.
    let contactId = input.objectId;
    let contactRecord: HsRecord | undefined;
    let contactCreated = false;
    if (!contactId) {
      const search = await hubspotSearch("contact", { name: input.name, email: input.email }, ctx);
      if (!search.ok) return fail(true, search.error || "HubSpot contact lookup failed");
      if (search.found) {
        contactId = search.records[0].id;
        contactRecord = search.records[0];
      }
    }
    if (contactId) {
      // Enrich an existing contact: set phone/jobtitle (and email only if we have
      // one and it's safe — HubSpot keys identity on email, so we never blank it).
      const patch: Record<string, string> = {};
      if (input.phone) patch.phone = input.phone;
      if (input.jobtitle) patch.jobtitle = input.jobtitle;
      await patchObject("contacts", contactId, patch, key);
    } else {
      const props = contactProps({
        name: input.name,
        email: input.email,
        phone: input.phone,
        jobtitle: input.jobtitle,
      });
      if (!props.email && !props.firstname) return fail(true, "Contact needs a name or email");
      const c = await createObject("contacts", props, key);
      if (!c.ok || !c.id) return fail(true, c.error || "Could not create the contact in HubSpot");
      contactId = c.id;
      contactCreated = true;
    }

    const pid = await portalId(key);
    contactRecord = contactRecord ?? {
      id: contactId,
      name: input.name,
      detail: input.email,
      url: recordUrl(pid, OBJ_CONTACT, contactId),
    };

    // 3. Link contact → company, and put the task on both records.
    if (co.id) {
      await associateDefault("contacts", contactId, "companies", co.id, key);
      taskAssociations.push({ id: co.id, typeId: TASK_TO_COMPANY });
    }
    taskAssociations.push({ id: contactId, typeId: TASK_TO_CONTACT });
    primary = { ...contactRecord, kind: "contact", created: contactCreated };
  }

  // Create the task, associated to every resolved record. Assign it to the
  // ACTING user's owner id (their OAuth connection), falling back to the
  // legacy env owner — without an owner the task is created unassigned and
  // hidden from the default Tasks view.
  const ownerId = actingOwnerId;
  const payload = {
    properties: {
      hs_task_subject: input.subject.trim(),
      // HubSpot renders the body as rich text/HTML — convert our plain-text note
      // (markdown-stripped, line breaks preserved) so it isn't one wall of text.
      hs_task_body: plainToHtml(input.body ?? ""),
      hs_timestamp: input.dueDateMs,
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "MEDIUM",
      hs_task_type: input.taskType ?? "CALL",
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
    },
    associations: taskAssociations.map((a) => ({
      to: { id: a.id },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }],
    })),
  };

  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await hsFetch("/crm/v3/objects/tasks", { method: "POST", body: payload }, key));
  } catch (e) {
    return fail(true, isTimeout(e) ? "HubSpot task create timed out after 15s" : "HubSpot task create failed");
  }
  if (status !== 201 && status !== 200) return fail(true, statusError(status, "create task"));

  const taskId = (body as { id?: string } | undefined)?.id;
  const pid = await portalId(key);

  // Also log the same context as a timeline Note on the same record(s). The task
  // is the action item; the note makes the intel visible in the activity feed
  // and on the record's Notes tab. Best-effort: a note failure (e.g. missing
  // crm.objects.notes.write scope) must not undo the task that already landed.
  const note = await createNote(
    plainToHtml(input.body ?? ""),
    taskAssociations.map((a) => ({
      id: a.id,
      typeId: a.typeId === TASK_TO_COMPANY ? NOTE_TO_COMPANY : NOTE_TO_CONTACT,
    })),
    key,
    actingOwnerId,
  );

  // Pin the task to the top of each linked record's timeline (best-effort) —
  // but ONLY if the record has nothing pinned yet. HubSpot allows one pinned
  // activity per record, and an existing pin (manual or from a prior push) is
  // someone's deliberate choice — never overwrite it.
  if (taskId) {
    await Promise.all(
      taskAssociations.map((a) =>
        pinIfUnpinned(a.typeId === TASK_TO_COMPANY ? "companies" : "contacts", a.id, taskId, key),
      ),
    );
  }

  return {
    configured: true,
    ok: true,
    taskId,
    taskUrl: taskId ? recordUrl(pid, OBJ_TASK, taskId) : undefined,
    noteId: note.id,
    noteError: note.error,
    linkedTo: primary,
  };
}

/** Create a timeline Note with `bodyHtml`, associated to the given records.
 * Best-effort — returns the new note id, or an error string if it couldn't be
 * created (the caller has already created the task, so this never throws). */
async function createNote(
  bodyHtml: string,
  associations: { id: string; typeId: number }[],
  key: string,
  actingOwnerId?: string,
): Promise<{ id?: string; error?: string }> {
  if (!bodyHtml.trim() || associations.length === 0) return {};
  const ownerId = actingOwnerId ?? process.env.HUBSPOT_OWNER_ID?.trim();
  const payload = {
    properties: {
      hs_note_body: bodyHtml,
      hs_timestamp: Date.now(),
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
    },
    associations: associations.map((a) => ({
      to: { id: a.id },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }],
    })),
  };
  try {
    const { status, body } = await hsFetch("/crm/v3/objects/notes", { method: "POST", body: payload }, key);
    if (status !== 201 && status !== 200) return { error: statusError(status, "create note") };
    return { id: (body as { id?: string } | undefined)?.id };
  } catch (e) {
    return { error: isTimeout(e) ? "note create timed out after 15s" : "note create failed" };
  }
}

// ---------------------------------------------------------------------------
// Enrollment suppression — SEQUENCER_ROADMAP.md, "three states, not binary".
//
// Prospecting into open accounts is DELIBERATE (Amar runs Wells Fargo while Max
// opens parallel threads; Guidewire is in POC and still gets multi-threaded), so
// an open opportunity is a warning, never a block. Only a live thread with THIS
// person blocks.
//
// Read from HubSpot rather than the dashboard's own sync events: Amar sends by
// hand and never touches this app, so his activity is visible only in the CRM.
// ---------------------------------------------------------------------------

/** How recently someone must have been contacted to count as a live thread. */
const ACTIVE_THREAD_DAYS = 30;

export interface HsSuppression {
  configured: boolean;
  ok: boolean;
  error?: string;
  /** block = live thread with this person. warn = open opp at the account. */
  verdict: "block" | "warn" | "allow";
  reason?: string;
  contactId?: string;
  contactUrl?: string;
  /** ISO timestamp of the last logged sales activity on the contact. */
  lastActivityAt?: string;
  lastActivityOwner?: string;
  openDeals?: { name: string; stage: string; owner?: string }[];
}

async function ownerName(id: string | undefined, key: string): Promise<string | undefined> {
  if (!id) return undefined;
  try {
    const { status, body } = await hsFetch(`/crm/v3/owners/${encodeURIComponent(id)}`, { method: "GET" }, key);
    if (status !== 200) return undefined;
    const o = body as { firstName?: string; lastName?: string; email?: string };
    return [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || undefined;
  } catch {
    return undefined;
  }
}

export async function hubspotSuppression(
  opts: { email?: string; companyDomain?: string },
  ctx?: HsAuthContext
): Promise<HsSuppression> {
  const fail = (configured: boolean, error: string): HsSuppression => ({
    configured,
    ok: false,
    error,
    // A FAILED check is not an all-clear. The caller decides what to do with an
    // unknown, but it must never read as "allow".
    verdict: "block",
    reason: "HubSpot suppression check failed — cannot confirm this contact is safe to enroll",
  });

  const auth = await resolveAccessToken(ctx);
  if (!auth.ok) return fail(auth.configured, auth.error);
  const key = auth.token;
  const pid = await portalId(key);

  // 1. BLOCK — is this person already in a live thread with someone here?
  let contactId: string | undefined;
  let lastActivityAt: string | undefined;
  let lastActivityOwner: string | undefined;
  if (opts.email) {
    try {
      const { status, body } = await hsFetch(
        "/crm/v3/objects/contacts/search",
        {
          method: "POST",
          body: {
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: opts.email }] }],
            properties: [
              "email",
              "notes_last_contacted",
              "hs_last_sales_activity_timestamp",
              "hubspot_owner_id",
            ],
            limit: 1,
          },
        },
        key
      );
      if (status !== 200) return fail(true, statusError(status, "contact suppression search"));
      const hit = (body as { results?: HsObject[] } | undefined)?.results?.[0];
      if (hit) {
        contactId = hit.id;
        const p = hit.properties ?? {};
        // Either property can be null; take the more recent of the two.
        const stamps = [p.notes_last_contacted, p.hs_last_sales_activity_timestamp]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map((v) => new Date(v).getTime())
          .filter((n) => Number.isFinite(n));
        const newest = stamps.length ? Math.max(...stamps) : 0;
        if (newest > 0) {
          lastActivityAt = new Date(newest).toISOString();
          const ageDays = (Date.now() - newest) / 86_400_000;
          if (ageDays <= ACTIVE_THREAD_DAYS) {
            lastActivityOwner = await ownerName(p.hubspot_owner_id ?? undefined, key);
            return {
              configured: true,
              ok: true,
              verdict: "block",
              reason:
                `Live thread: last contacted ${Math.round(ageDays)} day(s) ago` +
                `${lastActivityOwner ? ` by ${lastActivityOwner}` : ""}`,
              contactId,
              contactUrl: recordUrl(pid, OBJ_CONTACT, contactId),
              lastActivityAt,
              lastActivityOwner,
            };
          }
        }
      }
    } catch (e) {
      return fail(true, isTimeout(e) ? "HubSpot suppression check timed out" : "HubSpot suppression check failed");
    }
  }

  // 2. WARN — net-new contact at an account with an open opportunity.
  const openDeals: { name: string; stage: string; owner?: string }[] = [];
  const domain = rootDomain(opts.companyDomain);
  if (domain) {
    try {
      const co = await hsFetch(
        "/crm/v3/objects/companies/search",
        {
          method: "POST",
          body: {
            filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
            properties: ["name", "domain"],
            limit: 1,
          },
        },
        key
      );
      const companyId = (co.body as { results?: HsObject[] } | undefined)?.results?.[0]?.id;
      if (co.status === 200 && companyId) {
        const deals = await hsFetch(
          "/crm/v3/objects/deals/search",
          {
            method: "POST",
            body: {
              filterGroups: [
                {
                  filters: [
                    { propertyName: "associations.company", operator: "EQ", value: companyId },
                    { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
                  ],
                },
              ],
              properties: ["dealname", "dealstage", "hubspot_owner_id"],
              limit: 5,
            },
          },
          key
        );
        if (deals.status === 200) {
          const rows = (deals.body as { results?: HsObject[] } | undefined)?.results ?? [];
          for (const d of rows) {
            const p = d.properties ?? {};
            openDeals.push({
              name: p.dealname ?? "(unnamed deal)",
              stage: p.dealstage ?? "unknown stage",
              owner: await ownerName(p.hubspot_owner_id ?? undefined, key),
            });
          }
        }
      }
    } catch {
      // A deal lookup failure downgrades to "allow with no warning" rather than
      // blocking: the BLOCK check above already passed, and multi-threading an
      // open account is explicitly sanctioned. Surfaced as a note, not an error.
    }
  }

  if (openDeals.length > 0) {
    const d = openDeals[0];
    return {
      configured: true,
      ok: true,
      verdict: "warn",
      reason:
        `Open opportunity at this account: "${d.name}" (${d.stage})` +
        `${d.owner ? ` owned by ${d.owner}` : ""}`,
      contactId,
      contactUrl: contactId ? recordUrl(pid, OBJ_CONTACT, contactId) : undefined,
      lastActivityAt,
      openDeals,
    };
  }

  return {
    configured: true,
    ok: true,
    verdict: "allow",
    contactId,
    contactUrl: contactId ? recordUrl(pid, OBJ_CONTACT, contactId) : undefined,
    lastActivityAt,
  };
}
