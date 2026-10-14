// Person → company resolution + enrichment for GitHub prospects.
//
// Resolution ladder (free, GitHub API):
//   1. profile `company` field
//   2. public org memberships
//   3. corporate email DOMAINS from public commit history — domain inference
//      only; outreach emails always come from Apollo (cleaner data, avoids the
//      GitHub ToS gray zone of scraping commit emails).
//
// Enrichment (Apollo): free org search for headcount + canonical name, then
// people-match (credits) for the verified work email + title. Prospects are
// then deduped against HubSpot contacts and suppressed when already in an
// active Apollo sequence. Openers are generated last, on the fast model, in
// the same "WHAT I SAW" voice as the existing signals.

import { SINGLESTORE_CONTEXT } from "../singlestore";
import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "../anthropic";
import { apolloPersonContact } from "../enrich/apollo";
import { isSendableEmail, unsendableReason } from "../enrich/emailTrust";
import { stripEmDashes } from "../format";
import { hubspotSearch } from "../hubspot";
import {
  fetchCommitEmailDomains,
  fetchFirstOrg,
  fetchGitHubProfile,
  isFreemailDomain,
  type RequestBudget,
} from "./collect";
import {
  fetchProspectsByStatus,
  fetchSizeSuppressedAbove,
  fetchTargetIndex,
  matchTarget,
  updateProspect,
} from "./store";
import { ACTION_LABELS, type MonitoredRepo, type Prospect } from "./types";

/** Company-size floor (total employees) — below it a prospect is suppressed,
 * not deleted, so the threshold can be tuned without losing data.
 *
 * Default 1,000: the target is large data estates, and the floor gates the
 * PAID people-match, so anything well below the target segment shouldn't cost a
 * credit. It sits deliberately under the dashboard's default 5,000 view so the
 * UI bar can drop to enterprise-adjacent without re-enriching anyone. A real
 * mid-market push means lowering this AND running `?mode=reopen` to re-queue
 * the people suppressed under the old floor. */
export function minEmployees(): number {
  const n = Number(process.env.GITHUB_PROSPECT_MIN_EMPLOYEES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

/** Re-queue people suppressed purely for company size who clear the CURRENT
 * floor. Without this a lowered floor is inert: size-suppressed rows never
 * re-enter the "resolved" queue, so the segment change would need a manual DB
 * edit. Bounded per call; repeat until it reports 0. */
export async function reopenSizeSuppressed(counts: PassCounts): Promise<void> {
  const floor = minEmployees();
  const rows = await fetchSizeSuppressedAbove(floor, REOPEN_CAP);
  if (rows.length === 0) return;
  let reopened = 0;
  for (const p of rows) {
    const r = await updateProspect(p.login, {
      status: "resolved",
      suppressedReason: "",
    });
    if (r.ok) reopened += 1;
  }
  if (reopened > 0) {
    counts.notes.push(
      `Re-queued ${reopened} prospect(s) suppressed under a higher size floor (now ≥ ${floor.toLocaleString()} employees)`,
    );
  }
}

// --------- Company-field cleanup ---------

/** Profile `company` values that are not companies. */
const NON_COMPANY_RE =
  /^(none|n\/a|na|self|self.?employed|freelance|freelancer|independent|personal|home|student|retired|unemployed|open to work|looking|earth|world|internet|remote|nowhere|-+)$/i;

/** Normalize a raw GitHub profile company field ("@vercel | ex-Stripe") to a
 * single plausible company name, or undefined. */
export function cleanCompanyField(raw?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/[|,;·•]/)[0]?.trim() ?? "";
  const cleaned = first.replace(/^@/, "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 80) return undefined;
  if (NON_COMPANY_RE.test(cleaned)) return undefined;
  if (/^(ex[- ]|formerly )/i.test(cleaned)) return undefined;
  return cleaned;
}

// --------- Apollo org search (free — headcount + canonical name) ---------

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const APOLLO_TIMEOUT_MS = 15_000;

function apolloHeaders(key: string): Record<string, string> {
  return {
    "x-api-key": key,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Cache-Control": "no-cache",
  };
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Registrable root of a domain ("us.experian.com" → "experian.com"), same
 * subdomain-tolerant rule HubSpotActions uses for its off-domain email guard. */
function rootDomainOf(d: string): string {
  const parts = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

interface OrgLookup {
  ok: boolean;
  error?: string;
  orgName?: string;
  domain?: string;
  headcount?: number;
}

/** Read a company's canonical name + real headcount straight from a domain.
 *  Free (organizations/enrich consumes no credits) and exact — no fuzzy name
 *  matching, so "nordstrom.com" can't land on Nordstrom Trunk Club. */
async function apolloOrgByDomain(domain: string, key: string): Promise<OrgLookup | null> {
  try {
    const res = await fetch(
      `${APOLLO_BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { headers: apolloHeaders(key), signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { organization?: Record<string, unknown> };
    const org = body.organization;
    if (!org) return null;
    const emp = org.estimated_num_employees;
    const name = typeof org.name === "string" && org.name.trim() ? org.name.trim() : undefined;
    const primary =
      typeof org.primary_domain === "string" && org.primary_domain.trim()
        ? org.primary_domain.trim()
        : domain;
    return {
      ok: true,
      orgName: name,
      domain: primary,
      headcount: typeof emp === "number" && Number.isFinite(emp) ? emp : undefined,
    };
  } catch {
    return null;
  }
}

/** Free company lookup. Prefers a KNOWN CORPORATE DOMAIN (resolved from the
 *  prospect's profile email or public commit history, freemail already filtered)
 *  because a domain is an exact key, where a name search is fuzzy. Falls back to
 *  searching by name when no domain is known. Consumes no credits either way. */
export async function apolloOrgLookup(company: string, knownDomain?: string): Promise<OrgLookup> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { ok: false, error: "APOLLO_API_KEY not set" };

  // Domain-first: exact, and it returns the headcount the size gate needs.
  if (knownDomain) {
    const byDomain = await apolloOrgByDomain(knownDomain, key);
    if (byDomain?.headcount !== undefined) return byDomain;
    // No headcount from the domain (or the lookup failed) — fall through to the
    // name search rather than giving up, then re-enrich from whatever domain
    // that turns up.
  }

  try {
    const qs = new URLSearchParams({
      q_organization_name: company,
      page: "1",
      per_page: "5",
    });
    const res = await fetch(`${APOLLO_BASE}/mixed_companies/search?${qs}`, {
      method: "POST",
      headers: apolloHeaders(key),
      signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `Apollo ${res.status} on company search` };
    const body = (await res.json()) as {
      organizations?: Record<string, unknown>[];
      accounts?: Record<string, unknown>[];
    };
    const records = [...(body.organizations ?? []), ...(body.accounts ?? [])];
    if (records.length === 0) return { ok: true };
    const target = normName(company);
    const exact = records.find((r) => normName(String(r.name ?? "")) === target);
    const org = exact ?? records[0];
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const orgName = str(org.name);
    const domain = str(org.primary_domain);

    // mixed_companies/search does NOT return estimated_num_employees — it only
    // carries headcount GROWTH rates. Verified against the live API: Microsoft,
    // Nordstrom and Harness all come back undefined. That silently disabled the
    // size gate, so every resolved person fell through to the PAID people-match
    // regardless of company size. organizations/enrich (keyed by domain) has the
    // real number and does not consume credits, so the gate can do its job.
    let headcount = num(org.estimated_num_employees);
    if (headcount === undefined && domain) {
      // Same domain-keyed enrich as the fast path above. Unknown headcount is
      // left undefined on failure; the caller treats that as a hard stop rather
      // than guessing and spending a match credit.
      const byDomain = await apolloOrgByDomain(domain, key);
      headcount = byDomain?.headcount;
    }
    return { ok: true, orgName, domain, headcount };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Whether this email's person already sits in an active Apollo sequence.
 * Degrades to { known: false } when the endpoint is unavailable/plan-gated. */
export async function apolloInActiveSequence(
  email: string,
): Promise<{ known: boolean; inSequence: boolean }> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return { known: false, inSequence: false };
  try {
    const qs = new URLSearchParams({ q_keywords: email, page: "1", per_page: "3" });
    const res = await fetch(`${APOLLO_BASE}/contacts/search?${qs}`, {
      method: "POST",
      headers: apolloHeaders(key),
      signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
    });
    if (!res.ok) return { known: false, inSequence: false };
    const body = (await res.json()) as {
      contacts?: { email?: string; contact_campaign_statuses?: { status?: string }[] }[];
    };
    const match = (body.contacts ?? []).find(
      (c) => (c.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (!match) return { known: true, inSequence: false };
    const active = (match.contact_campaign_statuses ?? []).some(
      (s) => (s.status ?? "").toLowerCase() === "active",
    );
    return { known: true, inSequence: active };
  } catch {
    return { known: false, inSequence: false };
  }
}

// --------- Pipeline stages ---------

export interface PassCounts {
  resolved: number;
  enriched: number;
  suppressed: number;
  openers: number;
  notes: string[];
}

const RESOLVE_CAP = 20;
const ENRICH_CAP = 10;
const OPENER_CAP = 12;
const REOPEN_CAP = 50;

/** Stage 1 — resolve `new` prospects to a company via the GitHub API. */
export async function resolveNewProspects(
  token: string | undefined,
  budget: RequestBudget,
  counts: PassCounts,
): Promise<void> {
  const pending = await fetchProspectsByStatus(["new"], RESOLVE_CAP);
  for (const p of pending) {
    if (budget.remaining <= 3) {
      counts.notes.push("Resolution paused — GitHub request budget exhausted (resumes next sync)");
      return;
    }
    const prof = await fetchGitHubProfile(p.login, token, budget);
    if (!prof.ok) {
      if (prof.rateLimited) {
        counts.notes.push("Resolution paused — GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
        return;
      }
      continue; // transient failure — retry next run
    }
    const profile = prof.profile!;
    const base = {
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      githubUrl: profile.htmlUrl ?? `https://github.com/${p.login}`,
      location: profile.location,
    };

    // 1. Profile company field.
    let company = cleanCompanyField(profile.company);
    let companyDomain: string | undefined;
    let source = company ? "profile" : undefined;

    // Public profile email → corporate domain hint (domain only, never outreach).
    if (profile.email) {
      const at = profile.email.lastIndexOf("@");
      const domain = at > 0 ? profile.email.slice(at + 1).toLowerCase() : "";
      if (domain && !isFreemailDomain(domain)) companyDomain = domain;
    }

    // 2. Org membership.
    if (!company) {
      const { org, rateLimited } = await fetchFirstOrg(p.login, token, budget);
      if (rateLimited) {
        counts.notes.push("Resolution paused — GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
        await updateProspect(p.login, base);
        return;
      }
      if (org) {
        company = org;
        source = "org-membership";
      }
    }

    // 3. Corporate commit-email domains (cross-reference of public history).
    if (!company && !companyDomain) {
      const { domains, rateLimited } = await fetchCommitEmailDomains(
        p.login,
        profile.name,
        token,
        budget,
      );
      if (rateLimited) {
        counts.notes.push("Resolution paused — GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
        await updateProspect(p.login, base);
        return;
      }
      if (domains[0]) {
        companyDomain = domains[0];
        const label = domains[0].split(".")[0] ?? "";
        company = label.charAt(0).toUpperCase() + label.slice(1);
        source = "commit-domain";
      }
    }

    if (company || companyDomain) {
      await updateProspect(p.login, {
        ...base,
        company,
        companyDomain,
        resolutionSource: source,
        status: "resolved",
      });
      counts.resolved += 1;
    } else {
      await updateProspect(p.login, {
        ...base,
        status: "no_match",
        suppressedReason: "No company on the GitHub profile, org memberships, or public commit history",
      });
    }
  }
}

/** Stage 2 — size-filter, Apollo people-match, HubSpot dedupe, sequence check. */
export async function enrichResolvedProspects(counts: PassCounts): Promise<void> {
  const floor = minEmployees();
  const pending = await fetchProspectsByStatus(["resolved"], ENRICH_CAP);
  // One target-index read per pass, shared by every prospect in the batch.
  const targets = pending.length > 0 ? await fetchTargetIndex() : null;
  let hubspotDown = false;
  for (const p of pending) {
    if (!p.name) {
      await updateProspect(p.login, {
        status: "no_match",
        suppressedReason: "No public name on the GitHub profile — Apollo cannot match without one",
      });
      continue;
    }
    const companyGuess = p.company ?? p.companyDomain;
    if (!companyGuess) continue;

    let company = p.company;
    let companyDomain = p.companyDomain;
    let headcount = p.headcount;

    // Target-account fast path: a company you've prospected, researched, or
    // that sits in Signal 2000 already has a canonical name and (usually) a
    // size, so the gate can decide without calling Apollo at all.
    const dirHit = targets ? matchTarget(targets, p.companyDomain, p.company) : undefined;
    if (dirHit) {
      company = dirHit.company;
      headcount = dirHit.employees ?? headcount;
    }

    // Otherwise the free org lookup: canonical name, domain, real headcount.
    // Pass the domain resolved from the prospect's profile email or public
    // commit history when we have one — it keys Apollo exactly, where the name
    // search is fuzzy and can land on a subsidiary ("Nordstrom" → Trunk Club).
    if (typeof headcount !== "number") {
      const org = await apolloOrgLookup(companyGuess, p.companyDomain);
      if (!org.ok && org.error?.includes("APOLLO_API_KEY")) {
        counts.notes.push("Enrichment skipped — APOLLO_API_KEY not set");
        return;
      }
      if (org.ok) {
        company = org.orgName ?? company;
        companyDomain = org.domain ?? companyDomain;
        headcount = org.headcount ?? headcount;
      }
    }

    // SPEND GATE. Everything above this line is free; the people-match below
    // costs a credit. Both a known-too-small company AND an unknown size stop
    // here — "unknown" must not mean "spend anyway", which is exactly what the
    // old `typeof headcount === "number"` guard did once the lookup stopped
    // returning sizes: it passed every unsized company straight to the paid
    // call. Suppressed (not deleted), so ?mode=reopen can re-queue them.
    if (typeof headcount !== "number") {
      await updateProspect(p.login, {
        company,
        companyDomain,
        status: "suppressed",
        suppressedReason: `Company size unknown for "${company}" — not spending a match credit without it`,
      });
      counts.suppressed += 1;
      continue;
    }
    if (headcount < floor) {
      await updateProspect(p.login, {
        company,
        companyDomain,
        headcount,
        status: "suppressed",
        suppressedReason: `Company size ~${headcount.toLocaleString()} employees — below the ${floor.toLocaleString()} floor`,
      });
      counts.suppressed += 1;
      continue;
    }

    // Verified work email + title — Apollo people-match (consumes a credit).
    // Re-use an email saved by a previous partial run instead of re-spending.
    // An email is ONLY ever persisted after clearing the gate below, so a
    // stored address is already-verified; the flag makes that explicit rather
    // than relying on an empty status slipping past the check.
    const reusedEmail = Boolean(p.email);
    const match = p.email
      ? {
          configured: true,
          ok: true,
          name: p.name,
          email: p.email,
          emailStatus: undefined as string | undefined,
          title: p.title,
          linkedinUrl: p.linkedinUrl,
          error: undefined as string | undefined,
        }
      : await apolloPersonContact({
          name: p.name,
          company,
          domain: companyDomain,
          reveal: "email",
        });
    if (!match.configured) {
      counts.notes.push("Enrichment skipped — APOLLO_API_KEY not set");
      return;
    }
    if (!match.ok || !match.email) {
      // Only auth / rate-limit / credit / transport problems pause the whole
      // stage; anything else (404/422/no-match/no-email) is data-dependent
      // and must move THIS prospect out of the queue, or the score-ordered
      // fetch retries the same person forever and the stage never advances.
      const systemic = /\b(401|403|429)\b|rate limited|timed out|credits|APOLLO_API_KEY|match failed$/i.test(
        match.error ?? "",
      );
      if (systemic) {
        await updateProspect(p.login, { company, companyDomain, headcount });
        counts.notes.push(`Apollo enrichment paused — ${match.error ?? "match failed"}`);
        return;
      }
      await updateProspect(p.login, {
        company,
        companyDomain,
        headcount,
        status: "no_match",
        suppressedReason: match.error ?? "Apollo could not match this person",
      });
      continue;
    }
    const email = match.email;

    // Enforce the "verified WORK email" contract: reject personal addresses
    // (Apollo's reveal can fall back to personal_emails) and anything Apollo
    // does not positively call verified.
    //
    // This was a DENYLIST of three statuses, which let every other value pass —
    // including "extrapolated", which is Apollo's word for a guess. It is now an
    // allowlist (lib/enrich/emailTrust), shared with the stakeholder cards so
    // both pipelines apply one bar.
    const emailDomain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
    const offDomain = companyDomain
      ? rootDomainOf(emailDomain) !== rootDomainOf(companyDomain)
      : isFreemailDomain(emailDomain);
    // `reusedEmail` was already gated by this same check before it was stored,
    // so it is trusted without a status. Re-revealing to re-read the status
    // would re-spend the credit the reuse path exists to save.
    if (offDomain || (!reusedEmail && !isSendableEmail(match.emailStatus))) {
      await updateProspect(p.login, {
        company,
        companyDomain,
        headcount,
        title: match.title,
        linkedinUrl: match.linkedinUrl,
        status: "no_match",
        suppressedReason: offDomain
          ? "Apollo only had a personal or off-domain email on file"
          : unsendableReason(match.emailStatus),
      });
      continue;
    }
    // A validated corporate email can supply the domain when resolution
    // could not (helps the HubSpot company link + UI badges).
    if (!companyDomain && !isFreemailDomain(emailDomain)) companyDomain = emailDomain;

    // Dedupe against existing HubSpot contacts (exact email match).
    if (!hubspotDown) {
      const hs = await hubspotSearch("contact", { email });
      if (!hs.configured) {
        hubspotDown = true;
        counts.notes.push("HubSpot dedupe skipped — HUBSPOT_TOKEN not set");
      } else if (!hs.ok) {
        // Configured but erroring — do NOT fail open into "enriched" without
        // the dedupe. Save progress (email kept, status stays resolved) and
        // retry next run without re-spending the Apollo credit.
        await updateProspect(p.login, {
          name: match.name ?? p.name,
          company,
          companyDomain,
          headcount,
          email,
          title: match.title,
          linkedinUrl: match.linkedinUrl,
        });
        counts.notes.push(`Enrichment paused — HubSpot dedupe unavailable (${hs.error ?? "search failed"})`);
        return;
      } else if (hs.found) {
        await updateProspect(p.login, {
          company,
          companyDomain,
          headcount,
          email,
          title: match.title,
          linkedinUrl: match.linkedinUrl,
          hubspotContactId: hs.records[0]?.id,
          status: "suppressed",
          suppressedReason: "Already a HubSpot contact",
        });
        counts.suppressed += 1;
        continue;
      }
    }

    // Suppress anyone already in an active Apollo sequence.
    const seq = await apolloInActiveSequence(email);
    if (seq.known && seq.inSequence) {
      await updateProspect(p.login, {
        company,
        companyDomain,
        headcount,
        email,
        title: match.title,
        linkedinUrl: match.linkedinUrl,
        status: "suppressed",
        suppressedReason: "Already in an active Apollo sequence",
      });
      counts.suppressed += 1;
      continue;
    }

    await updateProspect(p.login, {
      name: match.name ?? p.name,
      company,
      companyDomain,
      headcount,
      email,
      title: match.title,
      linkedinUrl: match.linkedinUrl,
      status: "enriched",
    });
    counts.enriched += 1;
  }
}

// --------- Openers ---------

const OPENER_SYSTEM = `${SINGLESTORE_CONTEXT}

You write ONE-or-two-sentence cold-outreach OPENERS for engineers who engaged
with open-source repos that SingleStore buyers and champions touch: SingleStore's
own SDKs and integrations, distributed OLTP databases, streaming / CDC, vector
databases, real-time OLAP engines, RAG frameworks and data pipelines. The rep
pastes the opener above a templated email body, in the existing "WHAT I SAW"
pattern: lead with the specific observed activity, then pivot to why it maps to
what SingleStore does. Example shape (calibration only, never reuse verbatim):
"Saw your commits to debezium. Most CDC setups I see exist to keep a second
store in step with the app database; SingleStore runs both workloads on one
engine, so that hop can go away."

RULES:
- Observation first, in one clause: the person's REAL action and repo (given below). Never invent activity.
- Then at most one clause of SingleStore relevance, chosen by the repo's category (whyRepoMatters says what it signals). Mechanism, not marketing. Only product facts from the context above.
- Touching a repo is NOT evidence of pain. Never claim their system is slow, out of sync or failing; describe the general pattern or what SingleStore does instead.
- If the repo is SingleStore's own (singlestore-labs or memsql), acknowledge they are already building with it and offer help, never a pitch.
- No numbers, no proof figures, no customer names.
- HARD CAP 300 characters per opener. Shorter beats fuller.
- Plain declarative sentences, technically literate, no compliments, no questions.
- No em or en dashes. Use periods or commas. No exclamation marks.
- Banned words: delve, seamless, robust, leverage, unlock, streamline, optimize, supercharge, tapestry.
- No placeholders, no sign-off. Ready to paste verbatim.

Output ONLY a single JSON object, no prose, no code fences:
{ "openers": [ { "login": "github-login", "opener": "..." } ] }`;

function enforceOpener(raw: string): string {
  let t = stripEmDashes(raw).replace(/\s+/g, " ").trim();
  if (t.length > 320) {
    const cut = t.slice(0, 320);
    const lastStop = cut.lastIndexOf(". ");
    t = lastStop > 160 ? cut.slice(0, lastStop + 1) : cut.slice(0, cut.lastIndexOf(" "));
  }
  return t;
}

/** Stage 3 — batch-generate "WHAT I SAW" openers for enriched prospects. */
export async function generateOpeners(
  repos: MonitoredRepo[],
  counts: PassCounts,
): Promise<void> {
  const pending = (await fetchProspectsByStatus(["enriched"], 60))
    .filter((p) => !p.opener)
    .slice(0, OPENER_CAP);
  if (pending.length === 0) return;
  const repoMap = new Map(repos.map((r) => [r.repoKey, r]));

  const items = pending.map((p) => {
    const repo = p.bestRepo ? repoMap.get(p.bestRepo) : undefined;
    return {
      login: p.login,
      name: p.name,
      title: p.title,
      company: p.company,
      activity: p.bestAction && p.bestRepo
        ? `${ACTION_LABELS[p.bestAction]} ${repo?.name ?? p.bestRepo}`
        : "engaged with a watchlist repo",
      repoCategory: repo?.category,
      whyRepoMatters: repo?.whyMatters,
    };
  });

  let text: string;
  try {
    const result = await callClaudeWithWebSearch({
      system: OPENER_SYSTEM,
      user: `Write one opener per person. PEOPLE (JSON):\n${JSON.stringify(items)}`,
      // High-volume structured copy with the evidence already in hand — the
      // fast model matches the signal-grader cost profile.
      model: FAST_MODEL,
      webSearch: false,
      maxTokens: 2000,
      temperature: 0.4,
    });
    text = result.text;
  } catch (e) {
    counts.notes.push(
      `Opener generation skipped — ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  const parsed = extractJSON<{ openers?: { login?: string; opener?: string }[] }>(text);
  if (!parsed || !Array.isArray(parsed.openers)) {
    counts.notes.push("Opener generation returned unparseable output — will retry next sync");
    return;
  }
  const byLogin = new Map(
    parsed.openers
      .filter((o) => typeof o.login === "string" && typeof o.opener === "string" && o.opener.trim())
      .map((o) => [o.login!.toLowerCase(), o.opener!]),
  );
  for (const p of pending) {
    const opener = byLogin.get(p.login.toLowerCase());
    if (!opener) continue;
    const r = await updateProspect(p.login, { opener: enforceOpener(opener) });
    if (r.ok) counts.openers += 1;
  }
}

/** Convenience: does this prospect represent a code contribution (vs. a star)? */
export function isContributor(p: Prospect): boolean {
  return p.bestAction === "pr_merged" || p.bestAction === "committed" || p.bestAction === "pr_opened";
}
