// Merge provider results into one ICP-relevant rollup. Only real fields are
// merged — nothing here estimates or backfills.

import type {
  ApolloData,
  CrunchbaseData,
  EnrichContact,
  EnrichmentRollup,
  GitHubData,
  HunterData,
  ProviderResult,
  ProxycurlData,
} from "./types";

export function buildRollup(p: {
  apollo: ProviderResult<ApolloData>;
  hunter: ProviderResult<HunterData>;
  github: ProviderResult<GitHubData>;
  proxycurl: ProviderResult<ProxycurlData>;
  crunchbase: ProviderResult<CrunchbaseData>;
}): EnrichmentRollup {
  const apollo = p.apollo.ok ? p.apollo.data : undefined;
  const hunter = p.hunter.ok ? p.hunter.data : undefined;
  const github = p.github.ok ? p.github.data : undefined;
  const proxycurl = p.proxycurl.ok ? p.proxycurl.data : undefined;
  const crunchbase = p.crunchbase.ok ? p.crunchbase.data : undefined;

  const domain =
    apollo?.domain ||
    hostOf(apollo?.websiteUrl) ||
    hostOf(proxycurl?.websiteUrl) ||
    hostOf(crunchbase?.website) ||
    hunter?.domain;

  // Contacts: Apollo people first (titles/seniority), then Hunter emails that
  // add addresses we don't already have. Dedupe on lowercase email, then name.
  const contacts: EnrichContact[] = [];
  const seen = new Set<string>();
  for (const c of [...(apollo?.people ?? []), ...(hunter?.emails ?? [])]) {
    const key = (c.email || c.name || "").toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    contacts.push(c);
  }

  const topLanguages = Object.entries(github?.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);

  const lastRound =
    crunchbase?.lastRound?.type ||
    apollo?.latestFundingRound ||
    undefined;

  return {
    domain,
    totalHeadcount: proxycurl?.totalEmployees ?? apollo?.estimatedEmployees,
    sweHeadcount: proxycurl?.engineeringHeadcount,
    techStack: apollo?.techStack ?? [],
    aiDevTools: apollo?.aiDevTools ?? [],
    repoCount: github?.publicRepos,
    totalStars: github?.totalStars,
    commitsLast90d: github?.commitsLast90d,
    contributorEstimate: github?.contributorEstimate,
    topLanguages,
    totalRaisedUsd: crunchbase?.totalRaisedUsd ?? apollo?.fundingTotalUsd,
    lastRound,
    emailPattern: hunter?.emailPattern,
    contacts: contacts.slice(0, 12),
  };
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
