// Proxycurl (Nubela) LinkedIn company enrichment client.
//
// IMPORTANT SERVICE STATUS: Proxycurl was shut down in July 2025 as part of a
// settlement of LinkedIn Corp. v. Nubela Pte. Ltd. (N.D. Cal. 3:25-cv-00828).
// As of June 2026 every legacy endpoint returns HTTP 410 with
// {"error":{"code":"API_SUNSET",...}} and existing keys were migrated to
// Nubela's successor product, NinjaPear. This client implements the
// last-documented Proxycurl API so a key that somehow still works is usable;
// otherwise it surfaces an honest sunset error at runtime.

import type { ProviderResult, ProxycurlData } from "./types";

const BASE = "https://nubela.co/proxycurl/api";
const TIMEOUT_MS = 15_000;
const SUNSET_HINT =
  "Note: Proxycurl shut down in July 2025 after LinkedIn's lawsuit; keys now belong to NinjaPear (nubela.co).";

interface PcHq {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

// Last-documented company profile shape (only the fields we map).
interface PcCompany {
  name?: string | null;
  website?: string | null;
  industry?: string | null;
  founded_year?: number | null;
  description?: string | null;
  /** [min, max] head-count band; max may be null (e.g. [10001, null]). */
  company_size?: Array<number | null> | null;
  /** Scraped employee count straight from the LinkedIn company page. */
  company_size_on_linkedin?: number | null;
  hq?: PcHq | null;
  /** Feeds the Jobs Listing Count endpoint. */
  search_id?: string | null;
}

interface PcResolveResponse {
  url?: string | null;
  profile?: PcCompany | null;
}

type ApiOutcome = { kind: "ok"; body: unknown } | { kind: "err"; message: string };

function fail(error: string, configured = true): ProviderResult<ProxycurlData> {
  return { provider: "proxycurl", configured, ok: false, error, fetchedAt: new Date().toISOString() };
}

async function apiGet(
  path: string,
  params: Record<string, string | undefined>,
  apiKey: string,
): Promise<ApiOutcome> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "err", message: `Proxycurl request timed out after 15s (${path}). ${SUNSET_HINT}` };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "err", message: `Proxycurl network error on ${path}: ${msg}. ${SUNSET_HINT}` };
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    if (res.status === 410 || bodyText.includes("API_SUNSET")) {
      return {
        kind: "err",
        message:
          "Proxycurl API has been sunset (HTTP 410, code API_SUNSET). The service shut down in July 2025 " +
          "after settling LinkedIn's lawsuit; existing keys were migrated to NinjaPear (nubela.co). " +
          "This provider can no longer return LinkedIn data.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        kind: "err",
        message: `Proxycurl rejected the API key (HTTP ${res.status}) — invalid key or plan-gated endpoint. Check PROXYCURL_API_KEY. ${SUNSET_HINT}`,
      };
    }
    if (res.status === 404) {
      return { kind: "err", message: `Proxycurl: company not found (HTTP 404 on ${path}). ${SUNSET_HINT}` };
    }
    if (res.status === 429) {
      return {
        kind: "err",
        message: "Proxycurl rate limit hit (HTTP 429) — documented ceiling was 300 req/min (2/min on trial keys). Retry with backoff.",
      };
    }
    return { kind: "err", message: `Proxycurl HTTP ${res.status} on ${path}. ${SUNSET_HINT}` };
  }

  try {
    return { kind: "ok", body: (await res.json()) as unknown };
  } catch {
    return { kind: "err", message: `Proxycurl returned non-JSON on ${path}. ${SUNSET_HINT}` };
  }
}

function mapProfile(p: PcCompany, linkedinUrl?: string): ProxycurlData {
  let employeeRange: string | undefined;
  if (Array.isArray(p.company_size)) {
    const [min, max] = p.company_size;
    if (typeof min === "number" && typeof max === "number") employeeRange = `${min}-${max}`;
    else if (typeof min === "number") employeeRange = `${min}+`;
  }
  const hqParts = [p.hq?.city, p.hq?.state, p.hq?.country].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  return {
    name: typeof p.name === "string" ? p.name : undefined,
    linkedinUrl,
    websiteUrl: typeof p.website === "string" ? p.website : undefined,
    totalEmployees: typeof p.company_size_on_linkedin === "number" ? p.company_size_on_linkedin : undefined,
    employeeRange,
    // engineeringHeadcount / engineeringJobOpenings stay undefined on purpose:
    // Proxycurl never documented a per-department breakdown, and we never estimate.
    industry: typeof p.industry === "string" ? p.industry : undefined,
    foundedYear: typeof p.founded_year === "number" ? p.founded_year : undefined,
    hq: hqParts.length > 0 ? hqParts.join(", ") : undefined,
    description: typeof p.description === "string" ? p.description : undefined,
  };
}

export async function enrichProxycurl(
  company: string,
  domain?: string,
  linkedinUrl?: string,
): Promise<ProviderResult<ProxycurlData>> {
  const apiKey = process.env.PROXYCURL_API_KEY;
  if (!apiKey) {
    return fail("PROXYCURL_API_KEY not set — add it to .env.local / Vercel env", false);
  }

  try {
    let resolvedUrl = linkedinUrl?.trim() || undefined;
    let profile: PcCompany | undefined;

    if (!resolvedUrl) {
      const name = company.trim();
      if (!domain && !name) {
        return fail("Proxycurl: need a LinkedIn URL, domain, or company name to look up.");
      }
      // Company Lookup (2 credits); enrich_profile=enrich piggybacks the cached
      // profile (+1 credit) so the happy path is a single round-trip.
      const out = await apiGet(
        "/linkedin/company/resolve",
        { company_domain: domain, company_name: name || undefined, enrich_profile: "enrich" },
        apiKey,
      );
      if (out.kind === "err") return fail(out.message);
      const body = out.body as PcResolveResponse;
      if (typeof body.url === "string" && body.url) resolvedUrl = body.url;
      if (body.profile && typeof body.profile === "object") profile = body.profile;
      if (!resolvedUrl && !profile) {
        return fail(`Proxycurl could not resolve a LinkedIn company for "${name || domain}".`);
      }
    }

    if (!profile) {
      if (!resolvedUrl) return fail("Proxycurl: no LinkedIn URL available after lookup.");
      // Company Profile (1 credit). use_cache=if-present is the cheapest mode.
      const out = await apiGet(
        "/linkedin/company",
        { url: resolvedUrl, use_cache: "if-present", fallback_to_cache: "on-error" },
        apiKey,
      );
      if (out.kind === "err") return fail(out.message);
      profile = out.body as PcCompany;
    }

    const data = mapProfile(profile, resolvedUrl);

    // Jobs Listing Count (2 credits) — total open LinkedIn job posts. Best
    // effort only; a failure here never sinks the profile result.
    if (typeof profile.search_id === "string" && profile.search_id) {
      const jobs = await apiGet("/v2/linkedin/company/job/count", { search_id: profile.search_id }, apiKey);
      if (jobs.kind === "ok") {
        const count = (jobs.body as { count?: unknown }).count;
        if (typeof count === "number") data.jobOpenings = count;
      }
    }

    return { provider: "proxycurl", configured: true, ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`Proxycurl client error: ${msg}. ${SUNSET_HINT}`);
  }
}
