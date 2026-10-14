// Hunter.io enrichment client — domain-search (+ optional email-verifier).
// Docs: https://hunter.io/api-documentation/v2 (verified 2026-06).
// Auth via X-API-KEY header. Never throws; always resolves ProviderResult.

import type { EnrichContact, HunterData, ProviderResult } from "./types";

const BASE = "https://api.hunter.io/v2";
const TIMEOUT_MS = 15_000;
const ENV_VAR = "HUNTER_API_KEY";

interface HunterErrorItem {
  id?: string;
  code?: number;
  details?: string;
}

interface HunterEmailRaw {
  value?: string;
  type?: string;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  linkedin?: string | null;
  phone_number?: string | null;
  verification?: { status?: string | null } | null;
}

interface DomainSearchBody {
  data?: {
    domain?: string;
    organization?: string | null;
    pattern?: string | null;
    emails?: HunterEmailRaw[];
  };
  errors?: HunterErrorItem[];
}

interface VerifierBody {
  data?: {
    email?: string;
    status?: string;
    score?: number;
    result?: string; // deprecated by Hunter; prefer status
  };
  errors?: HunterErrorItem[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function fail(error: string, configured: boolean): ProviderResult<HunterData> {
  return { provider: "hunter", configured, ok: false, error, fetchedAt: nowIso() };
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
}

interface HunterResponse<T> {
  status: number;
  body: T | undefined;
}

async function hunterGet<T>(
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<HunterResponse<T>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${path}?${qs}`, {
    method: "GET",
    headers: { "X-API-KEY": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: T | undefined;
  try {
    body = (await res.json()) as T;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function apiErrorMessage(status: number, errors: HunterErrorItem[] | undefined, domain: string): string {
  const detail = errors?.[0]?.details ?? errors?.[0]?.id ?? "";
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401) return `Hunter: invalid or revoked API key — check ${ENV_VAR}${suffix}`;
  if (status === 403) return `Hunter: request rate limit hit or feature not on your plan${suffix}`;
  if (status === 404) return `Hunter: no results for "${domain}" — domain not found${suffix}`;
  if (status === 429) return `Hunter: account usage quota exceeded — upgrade plan or wait for reset${suffix}`;
  if (status === 451) return `Hunter: data withheld for legal/privacy reasons${suffix}`;
  return `Hunter: HTTP ${status}${suffix}`;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function toContact(e: HunterEmailRaw): EnrichContact | undefined {
  if (!e.value) return undefined;
  const name = [e.first_name, e.last_name].filter(Boolean).join(" ").trim() || e.value;
  return {
    name,
    title: e.position ?? undefined,
    email: e.value,
    emailStatus: e.verification?.status ?? undefined,
    confidence: typeof e.confidence === "number" ? e.confidence : undefined,
    linkedinUrl: e.linkedin ?? undefined,
    phone: e.phone_number ?? undefined,
    seniority: e.seniority ?? undefined,
    department: e.department ?? undefined,
  };
}

export async function enrichHunter(
  domain: string,
  email?: string,
): Promise<ProviderResult<HunterData>> {
  const apiKey = process.env[ENV_VAR];
  if (!apiKey) {
    return fail(`${ENV_VAR} not set — add it to .env.local / Vercel env`, false);
  }

  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return fail("Hunter: empty domain argument", true);

  try {
    // Prefer engineering/IT contacts; Hunter's department filter supports "it".
    let search = await hunterGet<DomainSearchBody>(
      "domain-search",
      { domain: cleanDomain, limit: "10", department: "it" },
      apiKey,
    );

    // Fall back to unfiltered top results when no IT-department emails exist.
    if (search.status === 200 && (search.body?.data?.emails?.length ?? 0) === 0) {
      search = await hunterGet<DomainSearchBody>(
        "domain-search",
        { domain: cleanDomain, limit: "10" },
        apiKey,
      );
    }

    if (search.status !== 200 || !search.body?.data) {
      return fail(apiErrorMessage(search.status, search.body?.errors, cleanDomain), true);
    }

    const d = search.body.data;
    const data: HunterData = {
      domain: d.domain ?? cleanDomain,
      organization: d.organization ?? undefined,
      emailPattern: d.pattern ?? undefined,
      emails: (d.emails ?? [])
        .map(toContact)
        .filter((c): c is EnrichContact => c !== undefined),
    };

    if (email && email.trim()) {
      // Verifier failure is non-fatal: domain-search data still returns ok.
      try {
        const ver = await hunterGet<VerifierBody>(
          "email-verifier",
          { email: email.trim() },
          apiKey,
        );
        // 202 = verification still running server-side; no result to report.
        if (ver.status === 200 && ver.body?.data?.status) {
          data.verification = {
            email: ver.body.data.email ?? email.trim(),
            status: ver.body.data.status,
            score: typeof ver.body.data.score === "number" ? ver.body.data.score : undefined,
          };
        }
      } catch {
        // swallow — verification stays undefined
      }
    }

    return { provider: "hunter", configured: true, ok: true, data, fetchedAt: nowIso() };
  } catch (err) {
    if (isTimeout(err)) {
      return fail(`Hunter: request timed out after ${TIMEOUT_MS / 1000}s`, true);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Hunter: network error — ${msg}`, true);
  }
}
