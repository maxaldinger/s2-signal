// GitHub REST search fetcher: hot recently-created repos with real star
// traction, as a proxy for commercial engineering activity. Free endpoint;
// GITHUB_TOKEN (optional) only raises rate limits. Verified live 2026-06-10
// against GET https://api.github.com/search/repositories (API 2022-11-28).

import type { RawItem, FetchResult } from "./types";

const API_BASE = "https://api.github.com";
const DEFAULT_LIMIT = 20;
const DEFAULT_DAYS = 30;
const DEFAULT_MIN_STARS = 150;
const TITLE_DESC_MAX = 120;

interface GitHubOwner {
  login?: string;
}

interface GitHubRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  language?: string | null;
  owner?: GitHubOwner | null;
}

interface GitHubSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GitHubRepo[];
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function isoDateDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "s2-signal",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function toRawItem(repo: GitHubRepo): RawItem | null {
  if (!repo.full_name || !repo.html_url) return null;

  const desc = repo.description ? stripHtml(repo.description) : "";
  const truncated =
    desc.length > TITLE_DESC_MAX ? `${desc.slice(0, TITLE_DESC_MAX - 1)}…` : desc;

  const meta: Record<string, string | number> = {};
  if (typeof repo.stargazers_count === "number") meta.stars = repo.stargazers_count;
  if (repo.owner?.login) meta.org = repo.owner.login;
  if (repo.language) meta.language = repo.language;

  const item: RawItem = {
    title: truncated ? `${repo.full_name}: ${truncated}` : repo.full_name,
    url: repo.html_url,
    source: "GitHub",
  };
  if (repo.pushed_at) item.date = repo.pushed_at;
  if (desc) item.snippet = desc;
  if (Object.keys(meta).length > 0) item.meta = meta;
  return item;
}

export async function fetchGitHubTrendingItems(opts?: {
  limit?: number;
  days?: number;
  minStars?: number;
  /** Optional topic scoping: matched with OR against repo name, description
   *  and topics (GitHub search allows at most 5 OR operators, so ≤6 terms).
   *  Omitted = all of GitHub. */
  keywords?: string[];
}): Promise<FetchResult> {
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_LIMIT, 100));
  const days = Math.max(1, opts?.days ?? DEFAULT_DAYS);
  const minStars = Math.max(0, opts?.minStars ?? DEFAULT_MIN_STARS);
  const terms = (opts?.keywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((k) => (/\s/.test(k) ? `"${k}"` : k));
  const scope = terms.length > 0 ? `${terms.join(" OR ")} in:name,description,topics ` : "";

  const q = `${scope}created:>${isoDateDaysAgo(days)} stars:>${minStars}`;
  const params = new URLSearchParams({
    q,
    sort: "stars",
    order: "desc",
    per_page: String(limit),
  });
  const url = `${API_BASE}/search/repositories?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 403 || res.status === 429) {
      return {
        ok: false,
        error:
          "GitHub search rate limit hit (10 req/min unauthenticated). Set GITHUB_TOKEN to raise limits, or retry after a minute.",
        items: [],
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `GitHub search failed: HTTP ${res.status} ${res.statusText}`,
        items: [],
      };
    }

    const data = (await res.json()) as GitHubSearchResponse;
    if (!Array.isArray(data.items)) {
      return {
        ok: false,
        error: "GitHub search returned an unexpected payload (no items array).",
        items: [],
      };
    }

    const items: RawItem[] = [];
    for (const repo of data.items) {
      if (items.length >= limit) break;
      const mapped = toRawItem(repo);
      if (mapped) items.push(mapped);
    }
    return { ok: true, items };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `GitHub search request failed (network/timeout): ${msg}`,
      items: [],
    };
  }
}
