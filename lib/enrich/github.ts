// GitHub REST API enrichment client — public engineering signal for an org.
// Works keyless (60 req/hr core, 10/min search); GITHUB_TOKEN raises limits
// to 5,000 req/hr (30/min search). Docs: https://docs.github.com/en/rest
// API version pinned via X-GitHub-Api-Version: 2022-11-28.

import type { GitHubData, GitHubRepoSummary, ProviderResult } from "./types";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

type ErrKind = "rate_limit" | "auth" | "not_found" | "other";

class ApiError extends Error {
  constructor(public kind: ErrKind, message: string) {
    super(message);
  }
}

interface RawSearchUser {
  login: string;
  name?: string | null;
}

interface RawOrg {
  login: string;
  name?: string | null;
  public_repos?: number;
  followers?: number;
  created_at?: string;
  html_url?: string;
}

interface RawRepo {
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  pushed_at?: string | null;
  open_issues_count?: number;
  fork?: boolean;
  description?: string | null;
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "s2-signal",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function gh(path: string, token: string | undefined): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function classify(res: Response, what: string, token: string | undefined): ApiError {
  const s = res.status;
  const rateLimited =
    s === 429 ||
    (s === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null));
  if (rateLimited) {
    return new ApiError(
      "rate_limit",
      token
        ? `GitHub rate limit hit (HTTP ${s}) on ${what} — token quota exhausted; retry after the x-ratelimit-reset window`
        : `GitHub rate limit hit (HTTP ${s}) on ${what} — keyless requests get 60/hr (10/min for search); set GITHUB_TOKEN to raise limits`,
    );
  }
  if (s === 401) return new ApiError("auth", "GitHub returned 401 — GITHUB_TOKEN is invalid or revoked; fix or unset it");
  if (s === 403) return new ApiError("auth", `GitHub returned 403 on ${what} — forbidden (token scope, SSO, or blocked resource)`);
  if (s === 404) return new ApiError("not_found", `${what} not found on GitHub (404)`);
  return new ApiError("other", `GitHub returned HTTP ${s} on ${what}`);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function resolveOrg(company: string, token: string | undefined): Promise<string> {
  const q = encodeURIComponent(`${company.trim()} type:org`);
  const res = await gh(`/search/users?q=${q}&per_page=5`, token);
  if (!res.ok) throw classify(res, "org search", token);
  const body = (await res.json()) as { items?: RawSearchUser[] };
  const items = Array.isArray(body.items) ? body.items : [];
  const target = norm(company);
  const exact = items.find(
    (i) => norm(i.login) === target || (typeof i.name === "string" && norm(i.name) === target),
  );
  if (exact) return exact.login;
  const partial = items.find((i) => {
    const candidates = [norm(i.login), typeof i.name === "string" ? norm(i.name) : ""];
    return candidates.some((c) => c.length > 0 && (c.includes(target) || target.includes(c)));
  });
  if (partial) return partial.login;
  throw new ApiError("not_found", `no GitHub org found for "${company}"`);
}

function parseLastPage(link: string | null): number | undefined {
  if (!link) return undefined;
  const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m ? parseInt(m[1], 10) : undefined;
}

async function sampleCommits(
  login: string,
  repos: RawRepo[],
  token: string | undefined,
): Promise<number | undefined> {
  // repos arrive sorted by pushed_at desc; sample the 4 freshest non-forks.
  const sample = repos.filter((r) => !r.fork).slice(0, 4);
  if (sample.length === 0) return undefined;
  const since = new Date(Date.now() - NINETY_DAYS_MS).toISOString();
  let sum = 0;
  let sampled = 0;
  for (const r of sample) {
    try {
      const res = await gh(
        `/repos/${login}/${encodeURIComponent(r.name)}/commits?since=${encodeURIComponent(since)}&per_page=100`,
        token,
      );
      if (res.status === 409) continue; // empty repository
      if (!res.ok) throw classify(res, `commits for ${r.full_name}`, token);
      const arr = (await res.json()) as unknown;
      if (Array.isArray(arr)) {
        sum += arr.length; // capped at 100/repo — floor estimate by design
        sampled += 1;
      }
    } catch (e) {
      if (e instanceof ApiError && e.kind === "rate_limit") throw e;
      // any other per-repo failure: skip this repo, keep the estimate honest
    }
  }
  return sampled > 0 ? sum : undefined;
}

async function estimateContributors(
  login: string,
  reposByStars: RawRepo[],
  token: string | undefined,
): Promise<number | undefined> {
  let max: number | undefined;
  for (const r of reposByStars.slice(0, 3)) {
    try {
      const res = await gh(
        `/repos/${login}/${encodeURIComponent(r.name)}/contributors?per_page=1&anon=true`,
        token,
      );
      if (res.status === 204) continue; // empty repo: no contributors
      if (!res.ok) throw classify(res, `contributors for ${r.full_name}`, token);
      let count = parseLastPage(res.headers.get("link"));
      if (count === undefined) {
        const arr = (await res.json()) as unknown;
        count = Array.isArray(arr) ? arr.length : undefined;
      }
      if (count !== undefined && (max === undefined || count > max)) max = count;
    } catch (e) {
      if (e instanceof ApiError && e.kind === "rate_limit") throw e;
      // 403 "list too large" or other per-repo failures: skip
    }
  }
  return max;
}

function toErrorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError")
      return "GitHub request timed out after 15s";
    return `GitHub request failed: ${e.message}`;
  }
  return "GitHub request failed with an unknown error";
}

export async function enrichGitHub(company: string, org?: string): Promise<ProviderResult<GitHubData>> {
  const token = process.env.GITHUB_TOKEN?.trim() || undefined;
  const base = { provider: "github" as const, configured: true };
  try {
    if (!company?.trim() && !org?.trim())
      return { ...base, ok: false, error: "no company name or org given", fetchedAt: new Date().toISOString() };

    const login = org?.trim() || (await resolveOrg(company, token));

    const orgRes = await gh(`/orgs/${encodeURIComponent(login)}`, token);
    if (!orgRes.ok) throw classify(orgRes, `GitHub org "${login}"`, token);
    const o = (await orgRes.json()) as RawOrg;

    const reposRes = await gh(
      `/orgs/${encodeURIComponent(o.login)}/repos?sort=pushed&per_page=100&type=public`,
      token,
    );
    if (!reposRes.ok) throw classify(reposRes, `repos for "${o.login}"`, token);
    const reposBody = (await reposRes.json()) as unknown;
    const repos: RawRepo[] = Array.isArray(reposBody) ? (reposBody as RawRepo[]) : [];

    const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);
    const languages: Record<string, number> = {};
    for (const r of repos) if (r.language) languages[r.language] = (languages[r.language] ?? 0) + 1;
    const cutoff = Date.now() - NINETY_DAYS_MS;
    const activeReposLast90d = repos.filter(
      (r) => r.pushed_at && Date.parse(r.pushed_at) >= cutoff,
    ).length;

    const nonForksByStars = repos
      .filter((r) => !r.fork)
      .sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    const topRepos: GitHubRepoSummary[] = nonForksByStars.slice(0, 8).map((r) => ({
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      stars: r.stargazers_count ?? 0,
      forks: r.forks_count ?? 0,
      language: r.language ?? undefined,
      pushedAt: r.pushed_at ?? undefined,
      openIssues: r.open_issues_count,
      isFork: r.fork === true,
      description: r.description ?? undefined,
    }));

    const commitsLast90d = await sampleCommits(o.login, repos, token);
    const contributorEstimate = await estimateContributors(o.login, nonForksByStars, token);

    const data: GitHubData = {
      org: o.login,
      orgUrl: o.html_url ?? `https://github.com/${o.login}`,
      name: o.name ?? undefined,
      publicRepos: o.public_repos ?? 0,
      followers: o.followers,
      createdAt: o.created_at,
      totalStars,
      languages,
      topRepos,
      contributorEstimate,
      commitsLast90d,
      activeReposLast90d,
    };
    return { ...base, ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { ...base, ok: false, error: toErrorMessage(e), fetchedAt: new Date().toISOString() };
  }
}
