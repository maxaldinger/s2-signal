// GitHub intent → main-feed signals (Max, Sep 25). The GitHub tab tracks
// engineers acting on the SingleStore watchlist (lib/githubProspect/watchlist:
// SingleStore's own repos, scale-out OLTP, streaming, vector, real-time OLAP,
// AI frameworks, pipelines). This rolls that activity up by company into one
// "github" signal per account.
//
// Measured on the original build (Sep 25): of ~150 resolved company domains,
// only ~38 survived the filters below, and almost all had ONE active engineer.
// So the score leans on how many people are active, whether they contributed
// (commits / PRs) rather than only forked, and — new for SingleStore — which
// CATEGORY of repo they touched (CATEGORY_WEIGHT: SingleStore's own repos and
// distributed-OLTP repos say far more about database intent than LangChain).
//
// Filters: the repo's own maintainers never count toward their own repo
// (Qdrant engineers on qdrant, ClickHouse on ClickHouse), SingleStore itself is never
// an account, schools and research institutes are dropped, and the company must
// have 200+ employees. Region comes from the company's HQ country in Apollo
// (one search call per 100 companies, 1 credit), falling back to the engineers'
// GitHub locations.

import type { RegionId } from "./data";
import type { Signal } from "./types";
import type { GitHubSignalEvent, Prospect } from "./githubProspect/types";
import { fetchMonitoredRepos, fetchProspects, fetchSignalsForLogins, rootDomain } from "./githubProspect/store";
import { apolloOrgsByDomains } from "./enrich/apollo";
import { CATEGORY_WEIGHT, watchlistCategory, type WatchlistCategory } from "./githubProspect/watchlist";

const WINDOW_DAYS = 90;
const MIN_EMPLOYEES = 200;
const DAY = 86_400_000;
const SCHOOL_NAME = /universit|college|institut|school|academ|polytechnic/i;
const SCHOOL_DOMAIN = /\.(edu|gov|mil)(\.[a-z]{2})?$|\.ac\.[a-z]{2}$/i;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The seller. Its own engineers on its own (or any) watchlist repo are not intent. */
const SELLER_DOMAIN = /^(singlestore|memsql)\.com$/i;
const SELLER_NAME = /^(singlestore|memsql)\b/i;

function categoryWeight(category: string | undefined): number {
  return category && category in CATEGORY_WEIGHT ? CATEGORY_WEIGHT[category as WatchlistCategory] : 0;
}

/** True when the person's employer is the repo's owner (maintainers acting on
 *  their own repo are not buying intent). Matches the domain's first label or
 *  the company name against the GitHub owner, e.g. qdrant.tech ↔ qdrant,
 *  clickhouse.com ↔ ClickHouse, zilliz.com ↔ zilliztech (Milvus is
 *  milvus-io, so Zilliz needs the name match, which it gets). */
function isRepoOwner(repoKey: string, domain: string, company: string): boolean {
  const owner = squash(repoKey.split("/")[0] ?? "");
  if (!owner) return false;
  const label = squash(domain.split(".")[0] ?? "");
  const name = squash(company);
  if (label.length >= 4 && (owner.includes(label) || label.includes(owner))) return true;
  if (name.length >= 4 && (owner.includes(name) || name.includes(owner))) return true;
  return false;
}

function regionFromCountry(country: string | undefined): RegionId | undefined {
  if (!country) return undefined;
  if (/^(united states|usa|us)$/i.test(country.trim())) return "us";
  if (/^india$/i.test(country.trim())) return "in";
  return "global";
}

const US_HINT =
  /\b(usa|united states|san francisco|new york|seattle|austin|boston|chicago|los angeles|denver|atlanta|bay area|silicon valley|, (ca|ny|wa|tx|ma|il|co|ga|nc|va|pa|or|nj|fl|mn|ut|az)\b)/i;
const IN_HINT = /\b(india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|kolkata)\b/i;

/** Majority of the engineers' GitHub locations, when Apollo has no country. */
function regionFromLocations(locations: string[]): RegionId | undefined {
  let us = 0;
  let ind = 0;
  let other = 0;
  for (const l of locations) {
    if (IN_HINT.test(l)) ind += 1;
    else if (US_HINT.test(l)) us += 1;
    else if (l.trim()) other += 1;
  }
  if (us + ind + other === 0) return undefined;
  if (us >= ind && us >= other) return "us";
  if (ind >= other) return "in";
  return "global";
}

interface CompanyActivity {
  domain: string;
  company: string;
  headcount: number;
  people: Set<string>;
  locations: string[];
  prs: number;
  commits: number;
  forks: number;
  repos: Map<string, number>;
  /** Highest CATEGORY_WEIGHT among the repos touched. */
  bestCategory: number;
  last?: GitHubSignalEvent;
}

export async function githubIntentSignals(region: RegionId): Promise<{
  configured: boolean;
  ok: boolean;
  error?: string;
  signals: Signal[];
  /** Companies that passed the filters in any region (for the log line). */
  qualifying: number;
}> {
  const [prospectsRes, reposRes] = await Promise.all([fetchProspects(3000), fetchMonitoredRepos()]);
  if (!prospectsRes.configured) return { configured: false, ok: false, error: prospectsRes.error, signals: [], qualifying: 0 };
  if (!prospectsRes.ok) return { configured: true, ok: false, error: prospectsRes.error, signals: [], qualifying: 0 };
  const repoNames = new Map(reposRes.repos.map((r) => [r.repoKey, r.name]));
  const repoCategory = new Map(reposRes.repos.map((r) => [r.repoKey, r.category]));

  // People at a resolved company big enough to be an account.
  const byLogin = new Map<string, Prospect & { root: string }>();
  for (const p of prospectsRes.prospects) {
    if (!p.companyDomain || !p.company) continue;
    if ((p.headcount ?? 0) < MIN_EMPLOYEES) continue;
    const root = rootDomain(p.companyDomain);
    if (SCHOOL_DOMAIN.test(root) || SCHOOL_NAME.test(p.company)) continue;
    if (SELLER_DOMAIN.test(root) || SELLER_NAME.test(p.company)) continue;
    byLogin.set(p.login.toLowerCase(), { ...p, root });
  }
  if (byLogin.size === 0) return { configured: true, ok: true, signals: [], qualifying: 0 };

  const events = await fetchSignalsForLogins([...byLogin.values()].map((p) => p.login));
  if (events === null) return { configured: true, ok: false, error: "GitHub activity read failed", signals: [], qualifying: 0 };

  const now = Date.now();
  const companies = new Map<string, CompanyActivity>();
  for (const e of events) {
    const t = Date.parse(e.actionAt);
    if (!Number.isFinite(t) || now - t > WINDOW_DAYS * DAY) continue;
    const p = byLogin.get(e.login.toLowerCase());
    if (!p) continue;
    if (isRepoOwner(e.repoKey, p.root, p.company!)) continue;
    const c =
      companies.get(p.root) ??
      ({
        domain: p.root,
        company: p.company!,
        headcount: p.headcount ?? 0,
        people: new Set<string>(),
        locations: [],
        prs: 0,
        commits: 0,
        forks: 0,
        repos: new Map<string, number>(),
        bestCategory: 0,
      } satisfies CompanyActivity);
    if (!c.people.has(p.login)) {
      c.people.add(p.login);
      if (p.location) c.locations.push(p.location);
    }
    if (e.action === "pr_opened" || e.action === "pr_merged") c.prs += 1;
    else if (e.action === "committed") c.commits += 1;
    else if (e.action === "forked") c.forks += 1;
    c.repos.set(e.repoKey, (c.repos.get(e.repoKey) ?? 0) + 1);
    c.bestCategory = Math.max(c.bestCategory, categoryWeight(watchlistCategory(e.repoKey) ?? repoCategory.get(e.repoKey)));
    if (!c.last || Date.parse(c.last.actionAt) < t) c.last = e;
    companies.set(p.root, c);
  }
  if (companies.size === 0) return { configured: true, ok: true, signals: [], qualifying: 0 };

  // HQ country + canonical name from Apollo; the engineers' locations otherwise.
  const apollo = await apolloOrgsByDomains([...companies.keys()]);
  const byDomain = new Map(apollo.orgs.map((o) => [rootDomain(o.domain), o]));

  const signals: Signal[] = [];
  for (const c of companies.values()) {
    const org = byDomain.get(c.domain);
    const r = regionFromCountry(org?.country) ?? regionFromLocations(c.locations);
    if (r !== region) continue;

    const people = c.people.size;
    const contributed = c.prs + c.commits > 0;
    const lastAt = c.last ? Date.parse(c.last.actionAt) : now;
    const days = Math.floor((now - lastAt) / DAY);
    // Category is the new term: touching SingleStore's own or a distributed-OLTP
    // repo says more about database intent than starring LangChain.
    let strength =
      54 + Math.min(4, people) * 5 + (contributed ? 6 : 0) + (days <= 14 ? 4 : days <= 45 ? 2 : 0) + c.bestCategory;
    // One engineer at a 100k-person company is a faint signal for the account.
    if (c.headcount > 20_000) strength -= 6;
    strength = Math.max(40, Math.min(90, strength));

    const topRepos = [...c.repos.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => repoNames.get(k) ?? k.split("/")[1] ?? k);
    const parts = [
      c.prs ? `${c.prs} PR${c.prs === 1 ? "" : "s"}` : "",
      c.commits ? `${c.commits} commit${c.commits === 1 ? "" : "s"}` : "",
      c.forks ? `${c.forks} fork${c.forks === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const lastDate = c.last ? new Date(c.last.actionAt) : new Date(now);
    const name = org?.name ?? c.company;

    signals.push({
      id: `github-${c.domain}-${now.toString(36)}`,
      account: name,
      segment: "saas",
      type: "github",
      strength,
      title: `${people} engineer${people === 1 ? "" : "s"} active on data-infra repos · ${topRepos.slice(0, 3).join(", ")}`,
      description:
        `Last ${WINDOW_DAYS} days: ${parts.join(", ")} by ${people === 1 ? "one engineer" : `${people} engineers`} at ${name}, ` +
        `most recently ${lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}. ` +
        `From the GitHub tab's monitored repos.`,
      tags: [...topRepos.slice(0, 4), "GitHub"],
      source: "GitHub (monitored repos)",
      url: c.last?.url || (c.last ? `https://github.com/${c.last.repoKey}` : undefined),
      date: lastDate.toISOString().slice(0, 10),
    });
  }
  // Two domains can resolve to one Apollo name; a batch upsert that hits the
  // same (account, type) twice fails whole, so keep the stronger row.
  const byAccount = new Map<string, Signal>();
  for (const s of signals) {
    const k = s.account.toLowerCase();
    const prev = byAccount.get(k);
    if (!prev || s.strength > prev.strength) byAccount.set(k, s);
  }
  return { configured: true, ok: true, signals: [...byAccount.values()], qualifying: companies.size };
}
