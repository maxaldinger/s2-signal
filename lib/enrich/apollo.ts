// Apollo.io enrichment client.
// Docs (verified 2026-06): https://docs.apollo.io/reference/organization-enrichment
//   - GET /api/v1/organizations/enrich (consumes credits)
//   - POST /api/v1/mixed_companies/search (org search by name)
//   - POST /api/v1/mixed_people/api_search (people search; MASTER api key required,
//     query-string params, returns no emails/phones — last names may be obfuscated
//     on lower plans). The old /mixed_people/search path 403s on most plans.
// Auth: x-api-key header.

import { accountExcluded, classifyProfiles, hardExclude } from "../icpClassifier";
import { isMergerEvent, type ApolloEvent } from "../sweepEvents";
import type { ApolloData, EnrichContact, ProviderResult } from "./types";
import { pickAiDevTools } from "./types";
import type { RegionId } from "../data";

const BASE = "https://api.apollo.io/api/v1";
const TIMEOUT_MS = 15_000;

interface ApolloOrg {
  id?: string;
  name?: string;
  primary_domain?: string;
  website_url?: string;
  linkedin_url?: string;
  industry?: string;
  short_description?: string;
  seo_description?: string;
  estimated_num_employees?: number;
  /** LinkedIn-function-derived headcount per department (engineering,
   *  information_technology, sales, …) — the measured basis for tight engineering
   *  estimates. */
  departmental_head_count?: Record<string, number>;
  annual_revenue?: number;
  city?: string;
  state?: string;
  country?: string;
  total_funding?: number;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  /** Every round Apollo knows, newest usually first: date, type ("Series E",
   *  "Merger / Acquisition", …), printed amount, investors, source article. */
  funding_events?: { date?: string; type?: string; amount?: string; investors?: string; news_url?: string }[];
  /** Company-wide headcount growth as a fraction (0.21 = +21%). */
  organization_headcount_six_month_growth?: number;
  organization_headcount_twelve_month_growth?: number;
  technology_names?: string[];
  current_technologies?: { name?: string }[];
}

interface ApolloPerson {
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  last_name_obfuscated?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  email_status?: string | null;
  seniority?: string | null;
  departments?: string[] | null;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  /** Search tells you WHETHER a field exists without giving you the value.
   *  has_email is the useful one: it lets a card refuse to spend a reveal
   *  credit on someone Apollo has no address for. */
  has_email?: boolean | null;
  /** Present on search results. The company-scoped searches ignore it (the org
   *  is already known); the cross-company title search needs it, because there
   *  a person without an employer is unusable. */
  organization?: ApolloOrg | null;
}

// Data and engineering people we want on the stakeholder map, mapped to
// SingleStore's buying group: economic buyers (CTO, VP Eng, CDO, VP Data),
// champions (heads of data engineering / data platform / infrastructure /
// databases / ML platform) and the people who feel the pain (staff/principal
// data engineers, database architects, DBAs and SREs on hot OLTP clusters).
// Kept broad so data- or ML-heavy orgs still surface a full map, not one lone
// match. Apollo ORs these person_titles.
const ENG_TITLES = [
  // Economic buyers
  "CTO",
  "Chief Technology Officer",
  "Chief Data Officer",
  "Chief Information Officer",
  "VP of Engineering",
  "VP Engineering",
  "SVP Engineering",
  "VP of Data",
  "VP Data",
  "VP Analytics",
  // Champions
  "Head of Data",
  "Head of Data Engineering",
  "Head of Data Platform",
  "Head of Platform",
  "Head of Infrastructure",
  "Head of Machine Learning",
  "Director of Data Engineering",
  "Director of Data Platform",
  "Director of Engineering",
  "Director of Infrastructure",
  "Engineering Manager",
  // Feel the pain
  "Principal Data Engineer",
  "Staff Data Engineer",
  "Principal Engineer",
  "Staff Engineer",
  "Data Architect",
  "Database Architect",
  "Database Engineer",
  "Database Administrator",
  "Data Engineer",
  "Machine Learning Engineer",
  "Site Reliability Engineer",
  "Platform Engineer",
];

// Decision-makers ("gates the deal") are found by Apollo SENIORITY, not literal
// titles — enterprise leaders title themselves uniquely ("Chief Digital
// Technology Officer", "EVP CTO Walmart International"), which a fixed title list
// misses. Empirically the seniority facet lifts leader hits ~30x (Starbucks
// 32 -> 1,005; Walmart 145 -> 5,555). Seniority alone also returns Finance/HR/
// Legal VPs, so we keep only the engineering/technology leaders via TECH_LEADER_RE.
// owner/founder/partner included so founder-CTOs at smaller orgs are fetched —
// Apollo files them under `founder`, not `c_suite`, and the client's own
// DECISION_SENIORITY already accepts them. They used to arrive via the deleted
// ENG_TITLES query; without them here nothing would replace that path.
const DM_SENIORITIES = ["c_suite", "vp", "head", "director", "owner", "founder", "partner"];
// Engineering- and data-LEADERSHIP titles for the second search. Apollo ORs
// these and matches them loosely, so "data" catches "VP, Data & Analytics",
// "Director, Data Platform" and so on. person_departments[] was tested and is
// silently ignored by mixed_people/api_search — titles are the only
// server-side lever that actually narrows to the buying group.
// "site reliability" and "database" are here because SRE / DBA leads on hot
// OLTP clusters feel the scaling pain first; the seniority floor below keeps
// this to director-and-above. "architecture" surfaces "VP Data Architecture"
// and database-architecture leads.
const ENG_LEADER_TITLES = [
  "engineering",
  "software engineering",
  "data",
  "data engineering",
  "data platform",
  "data infrastructure",
  "database",
  "analytics",
  "platform engineering",
  "infrastructure",
  "site reliability",
  "machine learning",
  "ai platform",
  "technology",
  "chief technology officer",
  "chief data officer",
  "chief information officer",
  "architecture",
];
// TECH_LEADER_RE moved to lib/icpClassifier as NON_TECHNICAL (Aug 2026). It was
// used here to DELETE non-technical people from the search result; it now
// labels them PASS / NOT_ENGINEERING instead, at the same zero token cost. The
// regex itself is unchanged, including the two-group split — acronyms need BOTH
// word boundaries or "ai" matches "Aircraft", while stems need only a leading
// one, which is what once made it reject "Chief Technology Officer" outright.

function apiHeaders(key: string): Record<string, string> {
  return {
    "x-api-key": key,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Cache-Control": "no-cache",
  };
}

function statusError(status: number, what: string): string {
  if (status === 401) return `Apollo 401 on ${what} — APOLLO_API_KEY is invalid`;
  if (status === 403)
    return `Apollo 403 on ${what} — key lacks endpoint access or plan gate (people search requires a MASTER api key)`;
  if (status === 404) return `Apollo 404 on ${what} — company not found`;
  if (status === 422) return `Apollo 422 on ${what} — invalid/unmatchable company parameters`;
  if (status === 429) return `Apollo 429 on ${what} — rate limited, retry later`;
  return `Apollo HTTP ${status} on ${what}`;
}

async function apolloJson(
  url: string,
  key: string,
  method: "GET" | "POST"
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: apiHeaders(key),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Run async tasks with a fixed concurrency cap (avoids bursting rate limits).
async function runPooled<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function toContact(p: ApolloPerson): EnrichContact | undefined {
  const name =
    str(p.name) ??
    [str(p.first_name), str(p.last_name) ?? str(p.last_name_obfuscated)].filter(Boolean).join(" ");
  if (!name) return undefined;
  // Apollo search returns placeholder emails ("email_not_unlocked@...") until enriched — drop those.
  const rawEmail = str(p.email);
  const email =
    rawEmail && rawEmail.includes("@") && !rawEmail.startsWith("email_not_unlocked")
      ? rawEmail
      : undefined;
  return {
    name,
    apolloId: str(p.id),
    title: str(p.title),
    email,
    emailStatus: str(p.email_status),
    linkedinUrl: str(p.linkedin_url),
    seniority: str(p.seniority),
    department: Array.isArray(p.departments) ? str(p.departments[0]) : undefined,
    country: str(p.country),
  };
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function enrichApollo(
  company: string,
  domain?: string
): Promise<ProviderResult<ApolloData>> {
  const fail = (configured: boolean, error: string): ProviderResult<ApolloData> => ({
    provider: "apollo",
    configured,
    ok: false,
    error,
    fetchedAt: new Date().toISOString(),
  });

  const key = process.env.APOLLO_API_KEY;
  if (!key) return fail(false, "APOLLO_API_KEY not set — add it to .env.local / Vercel env");

  const notes: string[] = [];
  let org: ApolloOrg | undefined;

  try {
    if (domain) {
      const qs = new URLSearchParams({ domain });
      const { status, body } = await apolloJson(`${BASE}/organizations/enrich?${qs}`, key, "GET");
      if (status !== 200) return fail(true, statusError(status, "organization enrichment"));
      org = (body as { organization?: ApolloOrg } | undefined)?.organization;
      if (!org) return fail(true, `Apollo: company not found for domain "${domain}"`);
    } else {
      const qs = new URLSearchParams({ q_organization_name: company, page: "1", per_page: "10" });
      const { status, body } = await apolloJson(`${BASE}/mixed_companies/search?${qs}`, key, "POST");
      if (status !== 200) return fail(true, statusError(status, "organization search"));
      const orgs = (body as { organizations?: ApolloOrg[] } | undefined)?.organizations ?? [];
      if (orgs.length === 0) return fail(true, `Apollo: company not found by name "${company}"`);
      const exact = orgs.find((o) => normName(o.name ?? "") === normName(company));
      org = exact ?? orgs[0];
      if (!exact && orgs.length > 1)
        notes.push(`name search matched ${orgs.length} orgs; used first result "${org?.name ?? "?"}"`);
      // Search hits lack tech/funding detail — enrich the matched domain when we
      // have one. This refinement is optional: a throw here must not discard the
      // successful search record, so it gets its own try/catch.
      const matchedDomain = str(org?.primary_domain);
      if (matchedDomain) {
        try {
          const eqs = new URLSearchParams({ domain: matchedDomain });
          const enr = await apolloJson(`${BASE}/organizations/enrich?${eqs}`, key, "GET");
          const enriched = (enr.body as { organization?: ApolloOrg } | undefined)?.organization;
          if (enr.status === 200 && enriched) org = enriched;
          else notes.push(statusError(enr.status, "follow-up enrichment (kept search record)"));
        } catch (e) {
          notes.push(
            isTimeout(e)
              ? "follow-up enrichment timed out (kept search record)"
              : "follow-up enrichment failed (kept search record)",
          );
        }
      }
    }
  } catch (e) {
    if (isTimeout(e)) return fail(true, "Apollo organization lookup timed out after 15s");
    return fail(true, `Apollo organization lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!org) return fail(true, "Apollo: company not found");

  let people: EnrichContact[] = [];
  try {
    const qs = new URLSearchParams({ page: "1", per_page: "10" });
    for (const t of ENG_TITLES) qs.append("person_titles[]", t);
    const orgId = str(org.id);
    const orgDomain = str(org.primary_domain) ?? (domain ? domain : undefined);
    if (orgId) qs.append("organization_ids[]", orgId);
    else if (orgDomain) qs.append("q_organization_domains_list[]", orgDomain);
    if (orgId || orgDomain) {
      const { status, body } = await apolloJson(`${BASE}/mixed_people/api_search?${qs}`, key, "POST");
      if (status === 200) {
        const b = body as { people?: ApolloPerson[]; contacts?: ApolloPerson[] } | undefined;
        const raw = [...(b?.people ?? []), ...(b?.contacts ?? [])].slice(0, 10);
        people = raw.map(toContact).filter((c): c is EnrichContact => c !== undefined);
      } else {
        notes.push(statusError(status, "people search"));
      }
    } else {
      notes.push("people search skipped — no org id or domain to filter on");
    }
  } catch (e) {
    notes.push(isTimeout(e) ? "people search timed out after 15s" : "people search failed");
  }

  const techStack = Array.from(
    new Set(
      org.technology_names ??
        (org.current_technologies ?? [])
          .map((t) => t.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
    )
  );

  const data: ApolloData = {
    name: str(org.name),
    domain: str(org.primary_domain),
    websiteUrl: str(org.website_url),
    linkedinUrl: str(org.linkedin_url),
    industry: str(org.industry),
    estimatedEmployees: num(org.estimated_num_employees),
    annualRevenueUsd: num(org.annual_revenue),
    city: str(org.city),
    state: str(org.state),
    country: str(org.country),
    techStack,
    aiDevTools: pickAiDevTools(techStack),
    people,
    fundingTotalUsd: num(org.total_funding),
    latestFundingRound: str(org.latest_funding_stage),
    latestFundingDate: str(org.latest_funding_round_date),
  };

  return {
    provider: "apollo",
    configured: true,
    ok: true,
    error: notes.length > 0 ? notes.join("; ") : undefined,
    data,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Single-person contact reveal — used by the stakeholder cards to pull a
// verified email or a phone number for one named person on demand.
//
// Endpoint: POST /api/v1/people/match (consumes credits when reveal_* flags are
// set). Docs: https://docs.apollo.io/reference/people-enrichment
//   - reveal_personal_emails=true  → unlocks `email` / `personal_emails`
//   - reveal_phone_number=true     → unlocks `phone_numbers[]` (Apollo delivers
//     phone async via webhook on some plans; we surface whatever comes back
//     inline and report an honest note when nothing did).
// ---------------------------------------------------------------------------

// "profile" is NOT a reveal: people/match with no reveal_* flag consumes no
// credit and still returns linkedin_url, the real name, the employer domain and
// employment_history. Measured Aug 2026 — the profile URL the task notes kept
// reporting as UNRESOLVED was free the whole time.
export type RevealKind = "email" | "phone" | "profile";

export interface ApolloPersonContact {
  configured: boolean;
  ok: boolean;
  error?: string;
  name?: string;
  title?: string;
  /** Populated for reveal "email". */
  email?: string;
  emailStatus?: string;
  /** Populated for reveal "phone". */
  phone?: string;
  linkedinUrl?: string;
  /** Person's country, from the richer match response (search is often thin). */
  country?: string;
  /** Employer domain from the match response. The title SEARCH does not return
   *  it, so without this the on-domain check downstream could never pass and a
   *  perfectly good revealed address would read as "off company domain". */
  companyDomain?: string;
}

interface ApolloPhoneNumber {
  raw_number?: string | null;
  sanitized_number?: string | null;
  type?: string | null;
}

interface ApolloMatchPerson extends ApolloPerson {
  personal_emails?: string[] | null;
  phone_numbers?: ApolloPhoneNumber[] | null;
  /** The match response carries the org too, plus a switchboard number the
   *  search response has no reason to return. */
  organization?: (ApolloOrg & { phone?: string | null }) | null;
}

/**
 * Reveal one contact field (email OR phone) for a single person.
 * @param opts.id  Apollo person id — the exact, reliable matcher (from a prior
 *   people search). Strongly preferred; name+company matching is a fuzzy fallback.
 * @param opts.name  Full name, used only when no id is available.
 * @param opts.company / opts.domain  Disambiguate the right person for name matching.
 * @param opts.linkedinUrl  Strong matcher when available.
 * @param opts.reveal  Which field to spend a credit unlocking.
 */
export async function apolloPersonContact(opts: {
  id?: string;
  name?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  reveal: RevealKind;
}): Promise<ApolloPersonContact> {
  const fail = (configured: boolean, error: string): ApolloPersonContact => ({
    configured,
    ok: false,
    error,
  });

  const key = process.env.APOLLO_API_KEY;
  if (!key) return fail(false, "APOLLO_API_KEY not set — add it to .env.local / Vercel env");
  if (!opts.id && !opts.name)
    return fail(true, "An Apollo person id or name is required for a lookup");

  const qs = new URLSearchParams();
  if (opts.id) {
    // Exact match — no obfuscation, no wrong-person risk.
    qs.set("id", opts.id);
  } else {
    if (opts.name) qs.set("name", opts.name);
    if (opts.linkedinUrl) qs.set("linkedin_url", opts.linkedinUrl);
    if (opts.domain) qs.set("domain", opts.domain);
    if (opts.company) qs.set("organization_name", opts.company);
  }
  // Only these two flags cost anything. "profile" deliberately sets neither.
  if (opts.reveal === "email") qs.set("reveal_personal_emails", "true");
  else if (opts.reveal === "phone") qs.set("reveal_phone_number", "true");

  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await apolloJson(`${BASE}/people/match?${qs}`, key, "POST"));
  } catch (e) {
    return fail(
      true,
      isTimeout(e) ? "Apollo people match timed out after 15s" : "Apollo people match failed"
    );
  }

  if (status !== 200) return fail(true, statusError(status, "people match"));

  const person = (body as { person?: ApolloMatchPerson } | undefined)?.person;
  if (!person)
    return fail(true, `Apollo: no person matched for "${opts.name ?? opts.id ?? "?"}"`);

  const fullName =
    str(person.name) ??
    [str(person.first_name), str(person.last_name)].filter(Boolean).join(" ");
  const base: ApolloPersonContact = {
    configured: true,
    ok: true,
    name: fullName || opts.name,
    title: str(person.title),
    linkedinUrl: str(person.linkedin_url),
    country: str(person.country),
    companyDomain: str(person.organization?.primary_domain),
  };

  // "profile" asked for nothing behind a paywall, so `base` IS the answer:
  // name, title, linkedin_url, country, employer domain. Also carries whatever
  // email Apollo already unlocked for this team on a previous reveal, which is
  // how a contact revealed before the URL was captured gets repaired for free.
  if (opts.reveal === "profile") {
    const already = str(person.email);
    const usable = already && already.includes("@") && !already.startsWith("email_not_unlocked");
    return usable ? { ...base, email: already, emailStatus: str(person.email_status) } : base;
  }

  if (opts.reveal === "email") {
    const raw =
      str(person.email) ??
      (Array.isArray(person.personal_emails) ? str(person.personal_emails[0]) : undefined);
    const email =
      raw && raw.includes("@") && !raw.startsWith("email_not_unlocked") ? raw : undefined;
    if (!email)
      return {
        ...base,
        ok: false,
        error: raw
          ? "Apollo returned a locked-email placeholder — you may be out of email credits"
          : "Apollo matched this person but has no email on file for them",
      };
    return { ...base, email, emailStatus: str(person.email_status) };
  }

  // reveal === "phone"
  const phones = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
  const phone =
    phones.map((p) => str(p?.sanitized_number) ?? str(p?.raw_number)).find(Boolean) ??
    str(person.organization?.phone);
  if (!phone)
    return {
      ...base,
      ok: false,
      error:
        "Apollo matched the person but returned no phone number (may be delivered async / plan-gated)",
    };
  return { ...base, phone };
}

// ---------------------------------------------------------------------------
// Org description — a grounded "what the company does" blurb from Apollo's org
// data (short_description / seo_description). Free, no credits. Prefers a domain
// (direct enrich); falls back to a name search, then enriches the resolved
// domain when the search record is thin. Returns undefined when Apollo has none
// (caller then falls back to web search).
// ---------------------------------------------------------------------------
export async function apolloOrgBlurb(company: string, domain?: string): Promise<string | undefined> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return undefined;

  const enrichByDomain = async (d: string): Promise<ApolloOrg | undefined> => {
    const qs = new URLSearchParams({ domain: d });
    const { status, body } = await apolloJson(`${BASE}/organizations/enrich?${qs}`, key, "GET");
    if (status !== 200) return undefined;
    return (body as { organization?: ApolloOrg } | undefined)?.organization;
  };

  try {
    let org: ApolloOrg | undefined;
    if (domain) org = await enrichByDomain(domain);
    if (!org) {
      const qs = new URLSearchParams({ q_organization_name: company, page: "1", per_page: "1" });
      const { status, body } = await apolloJson(`${BASE}/mixed_companies/search?${qs}`, key, "POST");
      if (status === 200) {
        const list =
          (body as { organizations?: ApolloOrg[]; accounts?: ApolloOrg[] } | undefined)
            ?.organizations ?? [];
        org = list[0];
      }
    }
    let desc = str(org?.short_description) ?? str(org?.seo_description);
    // Thin search record → enrich the resolved domain to get a real blurb.
    if (!desc && org?.primary_domain) {
      const enriched = await enrichByDomain(str(org.primary_domain)!);
      desc = str(enriched?.short_description) ?? str(enriched?.seo_description);
    }
    return desc;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// People-by-title search — free (no credits), returns REAL engineering and data leaders
// with stable Apollo ids. Last names arrive obfuscated ("Go***l") on every plan;
// the per-person reveal (apolloPersonContact by id) un-obfuscates on demand.
// This is what drives the stakeholder cards in a deep dive.
// ---------------------------------------------------------------------------

export interface ApolloPeopleResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  /** Resolved org name Apollo matched (may differ from the query). */
  orgName?: string;
  people: EnrichContact[];
  /** Whether another page of people likely exists (for "pull more contacts"). */
  hasMore?: boolean;
  /** A specific person looked up by name (the motion's first-move contact). */
  pinned?: EnrichContact;
  /** STAGE 1: the whole account was excluded, so no contacts were pulled. */
  accountExcluded?: { reason: string; code: string };
  /** STAGE 2: how many surfaced titles were dropped, by reason code. Excluded
   *  is not the same as silent — the UI states the count and the rule. */
  excludedCounts?: Record<string, number>;
  /** How many people the search returned before title exclusion. */
  surfaced?: number;
}

/**
 * Find engineering- and data-leadership people at a company by title. Resolves the org
 * from `domain` (preferred — direct, no extra call) or by `company` name.
 * `pinName` additionally looks up one specific person by name within the org
 * (so a motion's named contact can be pinned into the list).
 */
export async function apolloPeopleByTitle(
  company: string,
  domain?: string,
  page = 1,
  pinName?: string,
  /** The brief's "what I saw" signal, so the ICP classifier can judge this
   *  specific account instead of paraphrasing job titles. */
  signal?: string,
  /** Set when deliberately targeting a SOFTWARE DIVISION of a hardware parent.
   *  The spec allows those, scoped to the division. */
  division?: string,
  /** Rep override: pull despite an account-level exclusion. The category call
   *  is a heuristic and it misfires (NetApp, with a strong brief and a live
   *  signal, was blocked by name); the rep looking at the evidence outranks it. */
  force?: boolean
): Promise<ApolloPeopleResult> {
  const fail = (configured: boolean, error: string): ApolloPeopleResult => ({
    configured,
    ok: false,
    error,
    people: [],
  });

  // STAGE 1 — account-level exclusion, BEFORE any Apollo call. A hardware-primary
  // account costs one string comparison here instead of two searches, a
  // classifier pass and a page of cards that each want a reveal credit.
  const acct = force ? undefined : accountExcluded(company, signal, division);
  if (acct) {
    return {
      configured: true,
      ok: true,
      people: [],
      hasMore: false,
      accountExcluded: { reason: acct.reason, code: acct.code },
    };
  }

  const key = process.env.APOLLO_API_KEY;
  if (!key) return fail(false, "APOLLO_API_KEY not set — add it to .env.local / Vercel env");
  if (!company && !domain) return fail(true, "Pass a company name and/or domain");

  let orgId: string | undefined;
  let orgDomain = domain;
  let orgName: string | undefined;
  // Company-level context for the ICP classifier. Division matters more than
  // the logo at big diversified groups (Thermo Fisher, Danaher), so headcount
  // sharpens ACCOUNT_ANCHOR vs REJECT materially.
  let orgEmployees: number | undefined;

  // Without a domain we must resolve the org by name to get a filter handle.
  if (!orgDomain) {
    try {
      const sq = new URLSearchParams({ q_organization_name: company, page: "1", per_page: "5" });
      const { status, body } = await apolloJson(`${BASE}/mixed_companies/search?${sq}`, key, "POST");
      if (status !== 200) return fail(true, statusError(status, "organization search"));
      const orgs =
        (body as { organizations?: ApolloOrg[]; accounts?: ApolloOrg[] } | undefined)
          ?.organizations ?? [];
      const exact = orgs.find((o) => normName(o.name ?? "") === normName(company)) ?? orgs[0];
      if (!exact) return fail(true, `Apollo: company not found by name "${company}"`);
      orgId = str(exact.id);
      orgDomain = str(exact.primary_domain);
      orgName = str(exact.name);
      const emp = (exact as { estimated_num_employees?: unknown }).estimated_num_employees;
      if (typeof emp === "number" && Number.isFinite(emp)) orgEmployees = emp;
    } catch (e) {
      return fail(true, isTimeout(e) ? "Apollo org lookup timed out" : "Apollo org lookup failed");
    }
  }

  // Look up the motion's named contact by name within the org (best-effort).
  //
  // people/match FIRST: it is Apollo's purpose-built name+company matcher and
  // is FREE without reveal flags. The old q_keywords people-search shape
  // returned NOTHING for names Apollo demonstrably has (probe, Aug 28:
  // Entergy's Andy Quick — q_keywords+org_ids found nobody, people/match
  // found him with title and LinkedIn), which is why nearly every first-move
  // card rendered as UNCONFIRMED with HubSpot push disabled.
  const rootDom = (d: string) => {
    const parts = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
    return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
  };
  const findPinned = async (): Promise<EnrichContact | undefined> => {
    if (!pinName) return undefined;
    try {
      const mq = new URLSearchParams({ name: pinName });
      if (orgDomain) mq.set("domain", orgDomain);
      else mq.set("organization_name", orgName || company);
      // No reveal_* flags — this match consumes no credits.
      const { status, body } = await apolloJson(`${BASE}/people/match?${mq}`, key, "POST");
      if (status === 200) {
        const person = (body as { person?: ApolloPerson } | undefined)?.person;
        if (person) {
          // people/match is fuzzy — accept only a person whose employer IS
          // this account. A wrong-company pin is worse than an unconfirmed one.
          const pOrg = (person as { organization?: { primary_domain?: string | null; name?: string | null } })
            .organization;
          const pDom = str(pOrg?.primary_domain);
          const domOk = !!orgDomain && !!pDom && rootDom(pDom) === rootDom(orgDomain);
          const pOrgName = str(pOrg?.name);
          const nameOk = !!pOrgName && normName(pOrgName) === normName(orgName || company);
          if (domOk || nameOk) {
            const c = toContact(person);
            if (c) return c;
          }
        }
      }
    } catch {
      /* fall through to the search shape */
    }
    try {
      const pq = new URLSearchParams({ page: "1", per_page: "5", q_keywords: pinName });
      if (orgId) pq.append("organization_ids[]", orgId);
      else if (orgDomain) pq.append("q_organization_domains_list[]", orgDomain);
      const { status, body } = await apolloJson(`${BASE}/mixed_people/api_search?${pq}`, key, "POST");
      if (status !== 200) return undefined;
      const b = body as { people?: ApolloPerson[]; contacts?: ApolloPerson[] } | undefined;
      const raw = [...(b?.people ?? []), ...(b?.contacts ?? [])];
      const target = normName(pinName);
      // Prefer an exact-ish name match, else the first result.
      const match =
        raw.find((p) => normName(str(p.name) ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`).includes(target)) ??
        raw[0];
      return match ? toContact(match) : undefined;
    } catch {
      return undefined;
    }
  };

  try {
    const perPage = 30;
    const pageNum = String(Math.max(1, Math.min(100, page)));
    const orgFilter = (qs: URLSearchParams) => {
      if (orgId) qs.append("organization_ids[]", orgId);
      else if (orgDomain) qs.append("q_organization_domains_list[]", orgDomain);
    };

    // TWO queries, because seniority alone is far too thin at a large
    // non-tech-titled enterprise. Measured on BlackRock: the seniority sweep
    // returned 60 people of whom only 9 were engineering — the rest were
    // Talent Acquisition, Wealth, Energy and investment leadership, discarded
    // by the regex below. The same 60 slots spent on engineering- and
    // data-LEADERSHIP titles returned 60 technical leaders.
    //
    // Both are org-scoped SEARCHES, which consume no Apollo credits, so this
    // widens the pool for free. Credit spend is bounded by how many CARDS
    // render (each auto-reveals one email), not by how many people we find.
    const dmQs = new URLSearchParams({ page: pageNum, per_page: String(perPage) });
    for (const s of DM_SENIORITIES) dmQs.append("person_seniorities[]", s);
    orgFilter(dmQs);

    // Engineering / data titles AND the same seniority floor. The seniority
    // filter is load-bearing: title keywords alone match "Data Engineer II",
    // "Site Reliability Engineer", "Cloud Engineer III" — individual
    // contributors, and every rendered card spends a reveal credit.
    // Constrained this way the query returns only director-and-above
    // engineering and data leaders.
    const titleQs = new URLSearchParams({ page: pageNum, per_page: String(perPage) });
    for (const t of ENG_LEADER_TITLES) titleQs.append("person_titles[]", t);
    for (const s of DM_SENIORITIES) titleQs.append("person_seniorities[]", s);
    orgFilter(titleQs);

    const [dmRes, titleRes, pinned] = await Promise.all([
      apolloJson(`${BASE}/mixed_people/api_search?${dmQs}`, key, "POST"),
      apolloJson(`${BASE}/mixed_people/api_search?${titleQs}`, key, "POST"),
      findPinned(),
    ]);
    // Only a total failure of BOTH is fatal — either alone still yields people.
    if (dmRes.status !== 200 && titleRes.status !== 200)
      return fail(true, statusError(dmRes.status, "people search"));

    const peopleOf = (r: { body: unknown }): ApolloPerson[] => {
      const b = r.body as { people?: ApolloPerson[]; contacts?: ApolloPerson[] } | undefined;
      return [...(b?.people ?? []), ...(b?.contacts ?? [])];
    };
    // NOTHING IS DROPPED HERE ANY MORE.
    //
    // This line used to be `.filter(p => TECH_LEADER_RE.test(p.title))`, which
    // deleted every non-technical title on the server, before the client saw a
    // thing and before any tier was assigned. It was the last silent
    // suppression in the pipeline and it survived three rounds of "stop hiding
    // contacts" fixes, because all three were in the UI and this is not.
    //
    // The saving it bought was real — no classifier tokens on Finance/HR/Legal
    // — so it is kept, as a LABEL instead of a delete: the same test now lives
    // in the hard-exclusion table as NOT_ENGINEERING, runs before the model
    // (so it still costs nothing), and arrives as a screened card that says
    // why. See lib/icpClassifier NON_TECHNICAL.
    // Title-query hits lead, since they are already engineering/data-scoped.
    const dmRaw = [
      ...(titleRes.status === 200 ? peopleOf(titleRes) : []),
      ...(dmRes.status === 200 ? peopleOf(dmRes) : []),
    ];

    const seen = new Set<string>();
    const merged: ApolloPerson[] = [];
    for (const p of dmRaw) {
      const id = str(p.id) ?? normName(str(p.name) ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(p);
    }

    // Either query having a full page means there is more to fetch. Compare
    // against the RAW page size — TECH_LEADER_RE filters after the fetch, so
    // the kept count would understate what is still available.
    const hasMore =
      (titleRes.status === 200 && peopleOf(titleRes).length >= perPage) ||
      (dmRes.status === 200 && peopleOf(dmRes).length >= perPage);
    const allContacts = merged.map(toContact).filter((c): c is EnrichContact => c !== undefined);
    // STAGE 2 — title exclusion, applied HERE at the search layer rather than at
    // display. The spec is explicit that an excluded contact must never be
    // pulled, enriched or displayed, and every rendered card is a potential
    // reveal credit. Counts are kept so the UI can say what was dropped and
    // under which rule: excluded is not the same as silent.
    const excludedCounts: Record<string, number> = {};
    const contacts = allContacts.filter((c) => {
      const v = hardExclude(c.title);
      if (!v) return true;
      excludedCounts[v.reasonCode] = (excludedCounts[v.reasonCode] ?? 0) + 1;
      return false;
    });
    // ICP persona pass — decides who reaches the review queue. Runs on the whole
    // page BEFORE any card renders, because each rendered card auto-reveals an
    // email (a credit); classifying first means we never spend one on a REJECT.
    // Apollo search itself is free, so the only cost here is Haiku tokens.
    const verdicts = await classifyProfiles(contacts, (c) => ({
      company: orgName ?? company,
      titles: c.title,
      headline: c.title,
      description: [c.seniority && `seniority: ${c.seniority}`, c.department && `department: ${c.department}`]
        .filter(Boolean)
        .join("; "),
      // Real account context. Previously this was ONLY a headcount, and it was
      // doubly dead: it is set inside the no-domain branch (briefs almost
      // always have a domain) and mixed_companies/search does not return
      // estimated_num_employees anyway. So the classifier saw nothing but the
      // job title and could only paraphrase it.
      companySignals:
        [
          signal ? `What we observed at this company: ${signal}` : undefined,
          orgEmployees
            ? `~${orgEmployees.toLocaleString()} total employees (whole company, not the software org)`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n") || undefined,
    }));
    const people = contacts.map((c, i) => ({ ...c, icp: verdicts[i] }));
    if (people.length === 0)
      return {
        configured: true,
        // ok:true even on page 1. A page of Finance/HR/Legal leaders is an
        // ordinary outcome of a seniority-only sweep, not an error — and a
        // false here 502s the route, which makes the client drop the `pinned`
        // first-move contact it would otherwise still render.
        ok: true,
        orgName,
        people: [],
        excludedCounts,
        surfaced: allContacts.length,
        // Carry the REAL value: a full raw page that kept nobody still has more
        // pages behind it. Hardcoding false here permanently ended pagination
        // the first time one page happened to hold no engineering leaders.
        hasMore,
        pinned,
      };
    return { configured: true, ok: true, orgName, people, hasMore, pinned, excludedCounts, surfaced: allContacts.length };
  } catch (e) {
    return fail(true, isTimeout(e) ? "Apollo people search timed out" : "Apollo people search failed");
  }
}

// ---------------------------------------------------------------------------
// ICP sweep — org search as a *discovery* source for the signal feed.
// Filters verified against docs.apollo.io/reference/organization-search:
// organization_num_employees_ranges[] + q_organization_keyword_tags[].
// Search consumes no credits and returns thin-but-real org records.
// ---------------------------------------------------------------------------

export interface IcpSweepOrg {
  name: string;
  domain?: string;
  websiteUrl?: string;
  linkedinUrl?: string;
  /** Which ICP keyword filter surfaced this org (e.g. "apache kafka"). */
  matchedKeyword: string;
  /** The headcount filter band the org matched (e.g. "100-2000 employees"). */
  employeeBand: string;
  /** Apollo's per-org TOTAL employee estimate, when present (not an engineering count). */
  estimatedEmployees?: number;
  /** MEASURED engineering-department headcount (LinkedIn-derived, via the free
   *  org enrich) — preferred over the modeled share wherever present. */
  engineeringCount?: number;
  /** Short "what the company does" blurb from Apollo, when present. */
  about?: string;
  /** Apollo's industry label, when present (maps a technographic match to a segment). */
  industry?: string;
  /** Company-wide headcount growth (fraction) from the search record. */
  growth6m?: number;
  growth12m?: number;
  /** From the per-company lookup: latest funding round and latest M&A event. */
  funding?: ApolloEvent;
  acquisition?: ApolloEvent;
}

/** LinkedIn-derived headcount facts from the FREE organizations/enrich call.
 *  The engineering-department count is a measured figure with provenance —
 *  tighter than the 35%/3% share model wherever it exists. Note the caveats:
 *  it's a FLOOR where LinkedIn coverage is thin (China, blue-collar-heavy
 *  orgs), and "engineering" includes mechanical/industrial engineers at
 *  manufacturers. */
export interface OrgFacts {
  employees?: number;
  engineering?: number;
  informationTechnology?: number;
  /** Company-wide headcount growth (fraction). */
  growth6m?: number;
  growth12m?: number;
  /** Latest round that is not a merger/acquisition, and the latest M&A event. */
  funding?: ApolloEvent;
  acquisition?: ApolloEvent;
}

/** Apollo's funding events, newest first, in the shape sweepEvent() reads. */
function fundingEvents(org: ApolloOrg): ApolloEvent[] {
  const out: ApolloEvent[] = [];
  for (const e of org.funding_events ?? []) {
    const date = str(e?.date);
    const type = str(e?.type);
    if (!date || !type || !Number.isFinite(Date.parse(date))) continue;
    out.push({ date, type, amount: str(e.amount), investors: str(e.investors), newsUrl: str(e.news_url) });
  }
  // Older payloads carry only the latest-round summary fields.
  if (out.length === 0) {
    const date = str(org.latest_funding_round_date);
    const type = str(org.latest_funding_stage);
    if (date && type && Number.isFinite(Date.parse(date))) out.push({ date, type });
  }
  return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

export async function apolloOrgFacts(domain: string): Promise<OrgFacts | null> {
  const key = process.env.APOLLO_API_KEY;
  if (!key || !domain) return null;
  try {
    const { status, body } = await apolloJson(
      `${BASE}/organizations/enrich?${new URLSearchParams({ domain })}`,
      key,
      "GET",
    );
    if (status !== 200) return null;
    const org = (body as { organization?: ApolloOrg } | undefined)?.organization;
    if (!org) return null;
    const dept = org.departmental_head_count ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const events = fundingEvents(org);
    return {
      employees: num(org.estimated_num_employees),
      engineering: num(dept.engineering),
      informationTechnology: num(dept.information_technology),
      growth6m: num(org.organization_headcount_six_month_growth),
      growth12m: num(org.organization_headcount_twelve_month_growth),
      funding: events.find((e) => !isMergerEvent(e.type)),
      acquisition: events.find((e) => isMergerEvent(e.type)),
    };
  } catch {
    return null;
  }
}

/** One org from a search by domain list: canonical name, HQ country and
 *  company-wide growth. */
export interface DomainOrg {
  name: string;
  domain: string;
  country?: string;
  growth6m?: number;
  growth12m?: number;
}

/** Look up many companies at once by domain (mixed_companies/search with
 *  q_organization_domains_list[]). Apollo bills 1 credit per page of up to
 *  100 results, so 100 domains cost 1 credit. Never throws. */
export async function apolloOrgsByDomains(domains: string[]): Promise<{ ok: boolean; error?: string; orgs: DomainOrg[] }> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY not set", orgs: [] };
  const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const orgs: DomainOrg[] = [];
  const errors: string[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const qs = new URLSearchParams({ page: "1", per_page: "100" });
    for (const d of chunk) qs.append("q_organization_domains_list[]", d);
    try {
      const { status, body } = await apolloJson(`${BASE}/mixed_companies/search?${qs}`, key, "POST");
      if (status !== 200) {
        errors.push(statusError(status, "Apollo domain lookup"));
        continue;
      }
      const b = body as { accounts?: ApolloAccountRecord[]; organizations?: ApolloAccountRecord[] } | undefined;
      for (const a of [...(b?.accounts ?? []), ...(b?.organizations ?? [])]) {
        const name = str(a.name);
        const domain = str(a.primary_domain) ?? str(a.domain);
        if (!name || !domain) continue;
        orgs.push({
          name,
          domain: domain.toLowerCase(),
          country: str(a.organization_country) ?? str(a.country),
          growth6m: num(a.organization_headcount_six_month_growth),
          growth12m: num(a.organization_headcount_twelve_month_growth),
        });
      }
    } catch (e) {
      errors.push(isTimeout(e) ? "Apollo domain lookup timed out" : "Apollo domain lookup failed");
    }
  }
  return { ok: errors.length === 0 || orgs.length > 0, error: errors[0], orgs };
}

export interface IcpSweepResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  orgs: IcpSweepOrg[];
}

// Account records returned by search are thin (no per-org headcount), so the
// filters themselves are the evidence — each card states the keyword + band it
// matched.
//
// Three families of keyword, all through the same q_organization_keyword_tags[]
// filter the sweep has always used:
//  - FIRMOGRAPHIC (data-intensive, tech-native segments) swept across several
//    narrow size bands;
//  - TECHNOGRAPHIC: data-stack keywords (Kafka, Snowflake, Databricks,
//    Elasticsearch, ClickHouse, Postgres, Redis, MongoDB, vector DB) that point
//    at the stitched, data-intensive estates SingleStore consolidates. Apollo's
//    keyword tags are company-described, so a tag can also hit a consultancy or
//    the vendor itself; the brief's research is what confirms real usage;
//  - TRADITIONAL industries with large data estates (banks, insurers, telcos,
//    manufacturers…), at a much larger band: a bank with 10,000+ employees runs
//    real-time risk and customer analytics at a scale squarely in the ICP.
interface SweepQuery {
  keyword: string;
  ranges: string[];
  bandLabel: string;
  perPage: number;
}

// Each (keyword × employee-band) is a DISTINCT Apollo filter that paginates its
// own result set — so splitting one broad band into several narrow ones returns
// far more distinct companies per pull (and avoids cross-page overlap) than a
// single wide band ever could. That's what lets the feed scale into the
// thousands instead of dribbling in ~76 orgs per pull.
export const SWEEP_TECH_KEYWORDS = ["saas", "fintech", "adtech", "cybersecurity", "artificial intelligence"];
// Mid-market-to-large tech bands (total headcount → roughly 70-3,500 engineers).
// Kept at 200+ employees to stay above SingleStore's ~50-engineer ICP floor.
const TECH_BANDS: { range: string; label: string }[] = [
  { range: "200,600", label: "200-600 employees" },
  { range: "601,2000", label: "601-2000 employees" },
  { range: "2001,10000", label: "2001-10000 employees" },
];
export const SWEEP_STACK_KEYWORDS = [
  "apache kafka",
  "snowflake",
  "databricks",
  "elasticsearch",
  "clickhouse",
  "postgresql",
  "redis",
  "mongodb",
  "vector database",
];
export const SWEEP_TRAD_KEYWORDS = [
  "banking",
  "insurance",
  "telecommunications",
  "retail",
  "manufacturing",
  "healthcare",
  "logistics",
];

const SWEEP_QUERIES: SweepQuery[] = [
  // Tech-native, data-intensive segments; sweep several narrow size bands.
  ...SWEEP_TECH_KEYWORDS.flatMap((keyword) =>
    TECH_BANDS.map((b) => ({ keyword, ranges: [b.range], bandLabel: b.label, perPage: 16 })),
  ),
  // Data-stack technographics, any industry.
  ...SWEEP_STACK_KEYWORDS.map((keyword) => ({
    keyword,
    ranges: ["200,20000"],
    bandLabel: "200-20,000 employees",
    perPage: 8,
  })),
  // Traditional industries — big totals, big data estates.
  ...SWEEP_TRAD_KEYWORDS.map((keyword) => ({
    keyword,
    ranges: ["5001,1000000"],
    bandLabel: "5,000+ employees",
    perPage: 10,
  })),
];

// Total orgs one full sweep page returns across every query. The signals route
// uses this to advance the sweep cursor by exactly one page per pull, so pages
// neither stall (re-fetching the same orgs) nor skip ahead past results.
export const SWEEP_PAGE_SIZE = SWEEP_QUERIES.reduce((n, q) => n + q.perPage, 0);

interface ApolloAccountRecord {
  name?: string;
  primary_domain?: string;
  domain?: string;
  website_url?: string;
  linkedin_url?: string;
  estimated_num_employees?: number;
  short_description?: string;
  industry?: string;
  country?: string;
  organization_country?: string;
  /** Company-wide headcount growth as a fraction (verified live, Sep 25). */
  organization_headcount_six_month_growth?: number;
  organization_headcount_twelve_month_growth?: number;
}

// organization_locations[] filter values per intel region (verified Apollo
// search param: headquarters location, accepts country names). GLOBAL is the
// rest of the world: no include filter, EXCLUDE the two markets that already
// have their own lenses.
const REGION_LOCATION: Record<RegionId, string | null> = {
  us: "United States",
  in: "India",
  global: null,
};

/**
 * @param page Which results page to fetch per keyword — callers advance this
 * between pulls so each pull surfaces NEW organizations (Apollo has tens of
 * thousands of matches per filter; page 1 alone would repeat forever).
 * @param region Scopes the sweep to HQ country (US vs India).
 */
export async function apolloIcpSweep(page = 1, region: RegionId = "us"): Promise<IcpSweepResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    return {
      configured: false,
      ok: false,
      error: "APOLLO_API_KEY not set — ICP sweep skipped",
      orgs: [],
    };
  }

  try {
    // One sub-query per (keyword × band) so every result carries the exact
    // filter that surfaced it. Results arrive under BOTH `accounts` and
    // `organizations` depending on workspace state — read both. Pooled at a
    // modest concurrency so the ~31 queries don't burst Apollo's rate limit.
    const runQuery = async (q: SweepQuery) => {
      const qs = new URLSearchParams({
        page: String(Math.max(1, Math.min(100, page))),
        per_page: String(q.perPage),
      });
      for (const r of q.ranges) qs.append("organization_num_employees_ranges[]", r);
      qs.append("q_organization_keyword_tags[]", q.keyword);
      const loc = REGION_LOCATION[region];
      if (loc) {
        qs.append("organization_locations[]", loc);
      } else {
        // GLOBAL: rest of world — exclude the markets with their own lenses.
        qs.append("organization_not_locations[]", "United States");
        qs.append("organization_not_locations[]", "India");
      }

      const { status, body } = await apolloJson(
        `${BASE}/mixed_companies/search?${qs}`,
        key,
        "POST",
      );
      if (status !== 200)
        return { query: q, error: statusError(status, "ICP org sweep"), records: [] as ApolloAccountRecord[] };
      const b = body as
        | { accounts?: ApolloAccountRecord[]; organizations?: ApolloAccountRecord[] }
        | undefined;
      return {
        query: q,
        error: undefined as string | undefined,
        records: [...(b?.accounts ?? []), ...(b?.organizations ?? [])],
      };
    };
    const batches = await runPooled(SWEEP_QUERIES, 6, runQuery);

    const errors = batches
      .filter((b) => b.error)
      .map((b) => `${b.query.keyword}: ${b.error}`);
    const seen = new Set<string>();
    const orgs: IcpSweepOrg[] = [];
    for (const batch of batches) {
      for (const a of batch.records) {
        const name = str(a.name);
        if (!name) continue;
        const domain = str(a.primary_domain) ?? str(a.domain);
        const dedupeKey = (domain ?? name).toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        orgs.push({
          name,
          domain,
          websiteUrl: str(a.website_url),
          linkedinUrl: str(a.linkedin_url),
          matchedKeyword: batch.query.keyword,
          employeeBand: batch.query.bandLabel,
          estimatedEmployees: num(a.estimated_num_employees),
          about: str(a.short_description) ?? str(a.industry),
          industry: str(a.industry),
          growth6m: num(a.organization_headcount_six_month_growth),
          growth12m: num(a.organization_headcount_twelve_month_growth),
        });
      }
    }

    if (orgs.length === 0) {
      return {
        configured: true,
        ok: false,
        error: errors.length > 0 ? errors.join("; ") : "ICP sweep matched no organizations",
        orgs: [],
      };
    }
    return {
      configured: true,
      ok: true,
      error: errors.length > 0 ? errors.join("; ") : undefined,
      orgs,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      error: isTimeout(e) ? "Apollo ICP sweep timed out after 15s" : "Apollo ICP sweep failed",
      orgs: [],
    };
  }
}

// ---------------------------------------------------------------------------
// TITLE SEARCH — people by job title, across all companies.
//
// Every other people search here is org-scoped: pick a company, then find its
// engineering and data leaders. This inverts it. "Pull anyone running a data
// platform" is a different prospecting motion, and Apollo supports it directly:
// person_titles[] with no organization filter.
//
// Search consumes no Apollo credits. Emails are NOT revealed here — a query
// like "data platform" can match tens of thousands of people, and
// auto-revealing a page of them is real money. Reveal is per-card and manual.
// ---------------------------------------------------------------------------

export interface TitleSearchPerson extends EnrichContact {
  /** Employer, resolved from the search result's organization block. A person
   *  with no employer is dropped: unusable for outreach and for HubSpot. */
  company: string;
  companyDomain?: string;
  companyEmployees?: number;
  companyIndustry?: string;
  location?: string;
  /** Apollo's own `has_email` flag. The search returns no address, but it does
   *  say whether one exists — so a card can refuse to spend a credit on someone
   *  Apollo has nothing for, instead of finding out afterwards. */
  hasEmail?: boolean;
}

export interface TitleSearchResult {
  configured: boolean;
  ok: boolean;
  error?: string;
  people: TitleSearchPerson[];
  page: number;
  hasMore: boolean;
  /** Apollo's own total for the query, so the UI can say how deep the pool is. */
  total?: number;
}

interface ApolloPagination {
  page?: number;
  per_page?: number;
  total_entries?: number;
  total_pages?: number;
}

// What mixed_people/api_search ACTUALLY returns per person (measured Aug 2026):
//   id, first_name, last_name_obfuscated, title, last_refreshed_at,
//   has_email, has_city, has_state, has_country, has_direct_phone,
//   organization: { name, has_industry, has_phone, has_city, has_state,
//                   has_country, has_zip_code, has_revenue, has_employee_count }
// Note what is NOT there: full name, linkedin_url, seniority, departments, the
// org's primary_domain, and every actual value behind those has_* booleans. The
// filters still apply server-side (an employee-range query does narrow the
// pool) — Apollo just won't tell you the number without a credit.
//
// So: the optional company fields below stay in the type because the org-scoped
// callers can fill them, but on this path they are simply absent, and the UI
// must not imply otherwise.
function toTitleSearchPerson(p: ApolloPerson): TitleSearchPerson | undefined {
  const base = toContact(p);
  if (!base) return undefined;
  const org = p.organization;
  const company = str(org?.name);
  if (!company) return undefined; // no employer, no prospect
  return {
    ...base,
    company,
    companyDomain: str(org?.primary_domain),
    companyEmployees: num(org?.estimated_num_employees),
    companyIndustry: str(org?.industry),
    location: [str(p.city), str(p.state) ?? str(p.country)].filter(Boolean).join(", ") || undefined,
    hasEmail: typeof p.has_email === "boolean" ? p.has_email : undefined,
  };
}

/**
 * Find people by title across all companies.
 * @param opts.titles      Apollo ORs these and matches loosely.
 * @param opts.seniorities Apollo seniority facet (director/vp/c_suite/...).
 * @param opts.employeeRanges "min,max" bands, e.g. "1001,5000".
 * @param opts.locations   Person locations, e.g. "United States".
 */
export async function apolloTitleSearch(opts: {
  titles: string[];
  seniorities?: string[];
  employeeRanges?: string[];
  locations?: string[];
  page?: number;
  perPage?: number;
  /** Company-level context handed to the scorer alongside each title. */
  signal?: string;
}): Promise<TitleSearchResult> {
  const empty = (configured: boolean, error?: string): TitleSearchResult => ({
    configured,
    ok: !error,
    error,
    people: [],
    page: opts.page ?? 1,
    hasMore: false,
  });

  const key = process.env.APOLLO_API_KEY;
  if (!key) return empty(false, "APOLLO_API_KEY not set — add it to .env.local / Vercel env");
  const titles = opts.titles.map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) return empty(true, "Enter at least one title to search for");

  const page = Math.max(1, Math.min(100, opts.page ?? 1));
  const perPage = Math.max(1, Math.min(50, opts.perPage ?? 25));
  const qs = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  for (const t of titles) qs.append("person_titles[]", t);
  for (const s of opts.seniorities ?? []) qs.append("person_seniorities[]", s);
  for (const r of opts.employeeRanges ?? []) qs.append("organization_num_employees_ranges[]", r);
  for (const l of opts.locations ?? []) qs.append("person_locations[]", l);

  let status: number;
  let body: unknown;
  try {
    ({ status, body } = await apolloJson(`${BASE}/mixed_people/api_search?${qs}`, key, "POST"));
  } catch (e) {
    return empty(true, isTimeout(e) ? "Apollo title search timed out after 15s" : "Apollo title search failed");
  }
  if (status !== 200) return empty(true, statusError(status, "title search"));

  const b = body as
    | {
        people?: ApolloPerson[];
        contacts?: ApolloPerson[];
        /** Measured: this endpoint returns total_entries at the TOP level and
         *  no `pagination` object at all. Both are read, top level first. */
        total_entries?: number;
        pagination?: ApolloPagination;
      }
    | undefined;
  const raw = [...(b?.people ?? []), ...(b?.contacts ?? [])];
  const people = raw
    .map(toTitleSearchPerson)
    .filter((p): p is TitleSearchPerson => p !== undefined);

  // Tier them. The hard exclusions run first and cost nothing, which matters
  // here more than anywhere else: a loose title query pulls in a lot of
  // "Solutions Architect" and "Field Engineering" that never reaches the model.
  const verdicts = await classifyProfiles(people, (p) => ({
    company: p.company,
    titles: p.title,
    headline: p.title,
    description: [
      p.seniority && `seniority: ${p.seniority}`,
      p.department && `department: ${p.department}`,
      p.companyEmployees && `employer has ~${p.companyEmployees.toLocaleString()} employees`,
      p.companyIndustry && `industry: ${p.companyIndustry}`,
    ]
      .filter(Boolean)
      .join("; "),
    companySignals: opts.signal,
  }));

  const total = num(b?.total_entries) ?? num(b?.pagination?.total_entries);
  const totalPages = num(b?.pagination?.total_pages);
  return {
    configured: true,
    ok: true,
    people: people.map((p, i) => ({ ...p, icp: verdicts[i] })),
    page,
    // Trust Apollo's own page count when it gives one; otherwise infer from a
    // full page, which is the only other honest signal that more exist.
    hasMore: typeof totalPages === "number" ? page < totalPages : raw.length >= perPage,
    total,
  };
}
