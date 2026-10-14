// Crunchbase API v4 client (entity lookup via autocomplete -> organization).
//
// Docs: https://data.crunchbase.com/docs/using-the-api
// Auth: X-cb-user-key header. Base: https://api.crunchbase.com/v4/data
// Rate limit: 200 calls/min. Basic tier exposes only summary fields
// (identifier, name, short_description, website_url, ...); funding fields
// (funding_total, last_funding_*, num_employees_enum, founded_on, categories)
// and all cards (investors, raised_funding_rounds) require an Advanced or
// Commercial license — we try the rich field set first, then fall back to
// the Basic-safe set on 403. Cards are never requested; investors stays [].

import type { CrunchbaseData, ProviderResult } from "./types";

const BASE = "https://api.crunchbase.com/v4/data";
const TIMEOUT_MS = 15_000;

// Verified against the live docs (examples + Basic-tier attribute list).
const FULL_FIELD_IDS = [
  "identifier",
  "name",
  "short_description",
  "website_url",
  "founded_on",
  "num_employees_enum",
  "funding_total",
  "last_funding_type",
  "last_funding_at",
  "categories",
].join(",");

const BASIC_FIELD_IDS = ["identifier", "name", "short_description", "website_url"].join(",");

interface CbIdentifier {
  uuid?: string;
  value?: string;
  permalink?: string;
}

interface CbAutocompleteEntity {
  identifier?: CbIdentifier;
  short_description?: string;
}

interface CbOrgProperties {
  identifier?: CbIdentifier;
  name?: string;
  short_description?: string;
  website_url?: string | { value?: string };
  founded_on?: string | { value?: string };
  num_employees_enum?: string;
  funding_total?: { value?: number; currency?: string; value_usd?: number };
  last_funding_type?: string;
  last_funding_at?: string;
  categories?: Array<{ value?: string }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function fail(error: string, configured = true): ProviderResult<CrunchbaseData> {
  return { provider: "crunchbase", configured, ok: false, error, fetchedAt: nowIso() };
}

function statusError(status: number, context: string): string {
  if (status === 401) return `Crunchbase ${context}: 401 unauthorized — CRUNCHBASE_API_KEY is invalid or revoked.`;
  if (status === 403)
    return `Crunchbase ${context}: 403 forbidden — key lacks access (Basic tier gates funding fields; cards need an Advanced/Commercial license).`;
  if (status === 404) return `Crunchbase ${context}: 404 — company not found.`;
  if (status === 429) return `Crunchbase ${context}: 429 rate limited (200 calls/min) — retry later.`;
  return `Crunchbase ${context}: HTTP ${status}.`;
}

async function cbGet(path: string, key: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { "X-cb-user-key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** "c_00101_00250" -> "101-250", "c_10001_max" -> "10001+" */
function humanizeEmployeeEnum(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = /^c_(\d+)_(\d+|max)$/i.exec(raw);
  if (!m) return raw;
  const lo = String(parseInt(m[1], 10));
  return m[2].toLowerCase() === "max" ? `${lo}+` : `${lo}-${parseInt(m[2], 10)}`;
}

/** "series_a" -> "Series A" (formatting only; value comes from the API). */
function humanizeRoundType(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw
    .split("_")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function asString(v: string | { value?: string } | undefined): string | undefined {
  if (typeof v === "string") return v;
  return v?.value;
}

function pickBestMatch(entities: CbAutocompleteEntity[], company: string): CbAutocompleteEntity | undefined {
  const q = company.trim().toLowerCase();
  return (
    entities.find((e) => e.identifier?.value?.toLowerCase() === q) ??
    entities.find((e) => e.identifier?.value?.toLowerCase().startsWith(q)) ??
    entities[0]
  );
}

export async function enrichCrunchbase(company: string): Promise<ProviderResult<CrunchbaseData>> {
  const key = process.env.CRUNCHBASE_API_KEY;
  if (!key) {
    return fail("CRUNCHBASE_API_KEY not set — add it to .env.local / Vercel env", false);
  }
  if (!company.trim()) return fail("No company name provided to Crunchbase lookup.");

  // 1. Autocomplete -> permalink. Note: bare "organizations" is not a valid
  //    collection id in v4; the documented value is "organization.companies".
  let permalink: string;
  try {
    const qs = new URLSearchParams({
      query: company.trim(),
      collection_ids: "organization.companies",
      limit: "5",
    });
    const res = await cbGet(`/autocompletes?${qs.toString()}`, key);
    if (!res.ok) return fail(statusError(res.status, "autocomplete"));
    const body = (await res.json()) as { entities?: CbAutocompleteEntity[] };
    const match = pickBestMatch(body.entities ?? [], company);
    const id = match?.identifier?.permalink ?? match?.identifier?.uuid;
    if (!id) return fail(`Crunchbase: no organization matched "${company}".`);
    permalink = id;
  } catch (e) {
    if (isTimeout(e)) return fail("Crunchbase autocomplete timed out after 15s.");
    return fail(`Crunchbase autocomplete failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Entity lookup — rich fields first, Basic-tier fields on 403.
  let props: CbOrgProperties;
  try {
    let res = await cbGet(
      `/entities/organizations/${encodeURIComponent(permalink)}?field_ids=${FULL_FIELD_IDS}`,
      key
    );
    if (res.status === 403) {
      res = await cbGet(
        `/entities/organizations/${encodeURIComponent(permalink)}?field_ids=${BASIC_FIELD_IDS}`,
        key
      );
    }
    if (!res.ok) return fail(statusError(res.status, "entity lookup"));
    const body = (await res.json()) as { properties?: CbOrgProperties };
    props = body.properties ?? {};
  } catch (e) {
    if (isTimeout(e)) return fail("Crunchbase entity lookup timed out after 15s.");
    return fail(`Crunchbase entity lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Map only fields actually present in the response.
  const finalPermalink = props.identifier?.permalink ?? permalink;
  const foundedRaw = asString(props.founded_on);
  const foundedYear = foundedRaw ? parseInt(foundedRaw.slice(0, 4), 10) : undefined;

  const lastRound =
    props.last_funding_type || props.last_funding_at
      ? {
          type: humanizeRoundType(props.last_funding_type),
          amountUsd: undefined, // per-round amount needs the raised_funding_rounds card (paid license)
          announcedOn: props.last_funding_at,
          leadInvestors: undefined, // investors card requires Advanced/Commercial license
        }
      : undefined;

  const data: CrunchbaseData = {
    name: props.name ?? props.identifier?.value,
    permalink: finalPermalink,
    crunchbaseUrl: `https://www.crunchbase.com/organization/${finalPermalink}`,
    website: asString(props.website_url),
    description: props.short_description,
    foundedYear: Number.isFinite(foundedYear) ? foundedYear : undefined,
    employeeRange: humanizeEmployeeEnum(props.num_employees_enum),
    totalRaisedUsd: props.funding_total?.value_usd,
    lastRound,
    investors: [], // investors card is paywalled above Basic; never fabricated
    categories: (props.categories ?? []).map((c) => c.value).filter((v): v is string => !!v),
  };

  return { provider: "crunchbase", configured: true, ok: true, data, fetchedAt: nowIso() };
}
