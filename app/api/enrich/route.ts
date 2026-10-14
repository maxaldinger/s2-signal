import { NextRequest, NextResponse } from "next/server";
import { enrichApollo } from "@/lib/enrich/apollo";
import { enrichHunter } from "@/lib/enrich/hunter";
import { enrichGitHub } from "@/lib/enrich/github";
import { enrichProxycurl } from "@/lib/enrich/proxycurl";
import { enrichCrunchbase } from "@/lib/enrich/crunchbase";
import { buildRollup } from "@/lib/enrich/rollup";
import type {
  EnrichmentProfile,
  ProviderId,
  ProviderResult,
} from "@/lib/enrich/types";

// Orchestrator: fan out to every configured enrichment provider and merge.
// GET /api/enrich?company=Ramp[&domain=ramp.com][&github=ramp-org][&linkedin=https://linkedin.com/company/ramp]
export const maxDuration = 60;

function notRun<T>(
  provider: ProviderId,
  reason: string,
  configured: boolean,
): ProviderResult<T> {
  return {
    provider,
    configured,
    ok: false,
    error: reason,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  let domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const github = req.nextUrl.searchParams.get("github")?.trim() || undefined;
  const linkedin = req.nextUrl.searchParams.get("linkedin")?.trim() || undefined;

  if (!company) {
    return NextResponse.json({ error: "Missing ?company=" }, { status: 400 });
  }

  // Pass 1 — providers that work from a bare company name. Apollo and
  // Crunchbase can also recover the domain for pass 2.
  const [apollo, crunchbase, githubRes] = await Promise.all([
    enrichApollo(company, domain),
    enrichCrunchbase(company),
    enrichGitHub(company, github),
  ]);

  if (!domain) {
    domain =
      (apollo.ok ? apollo.data?.domain : undefined) ||
      hostOf(apollo.ok ? apollo.data?.websiteUrl : undefined) ||
      hostOf(crunchbase.ok ? crunchbase.data?.website : undefined);
  }

  // Pass 2 — domain-dependent providers.
  const [hunter, proxycurl] = await Promise.all([
    domain
      ? enrichHunter(domain)
      : Promise.resolve(
          notRun<never>(
            "hunter",
            process.env.HUNTER_API_KEY
              ? "No domain available — pass ?domain= or configure Apollo/Crunchbase to resolve it."
              : "HUNTER_API_KEY not set — add it to .env.local / Vercel env",
            Boolean(process.env.HUNTER_API_KEY),
          ),
        ),
    enrichProxycurl(company, domain, linkedin),
  ]);

  const providers = { apollo, hunter, github: githubRes, proxycurl, crunchbase };

  const profile: EnrichmentProfile = {
    company,
    domain,
    generatedAt: new Date().toISOString(),
    providers,
    rollup: buildRollup(providers),
  };

  // Don't freeze an all-providers-failed pass into the CDN for an hour —
  // those failures are usually transient (rate limits, timeouts).
  const anyOk = Object.values(providers).some((p) => p.ok);
  return NextResponse.json(profile, {
    headers: {
      "Cache-Control": anyOk
        ? "public, s-maxage=3600, stale-while-revalidate=86400"
        : "no-store",
    },
  });
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`)
      .hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
