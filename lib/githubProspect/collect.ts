// GitHub REST collection for the prospecting watchlist.
//
// Weekly incremental poll per repo: stargazers, forks, recent commits and PR
// authors. Every action family keeps an ISO cutoff in the repo's poll_cursor so
// each run only emits NET-NEW activity; the (login, repo, action, timestamp)
// unique key on gtm_github_signals makes re-runs idempotent regardless.
//
// Works keyless at 60 req/h (enough for a demo pull); set GITHUB_TOKEN (no
// scopes needed) for the real 5,000 req/h budget. Same header/rate-limit
// conventions as lib/enrich/github.ts.

import { ACTION_WEIGHTS, type GitHubSignalEvent, type MonitoredRepo } from "./types";

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

// First-run backfill windows (days) — bounded so a fresh deploy doesn't try to
// page through 40K historical stars on a popular repo.
const BACKFILL_STARS_DAYS = 14;
const BACKFILL_FORKS_DAYS = 14;
const BACKFILL_COMMITS_DAYS = 30;
const BACKFILL_PRS_DAYS = 30;

// Per-repo per-run page caps (100 items/page). Cap-limited runs keep the
// cursor at the oldest item read so the gap stays "new" for the next run.
const MAX_STAR_PAGES = 3;
const MAX_FORK_PAGES = 2;
const MAX_COMMIT_PAGES = 2;
const MAX_PR_PAGES = 2;

/** Automation accounts that would poison the prospect list — CI bots plus the
 * logins AI coding agents commit under (observed live: "claude" showing up as
 * a top contributor). */
const BOT_LOGINS = new Set([
  "dependabot",
  "renovate",
  "renovate-bot",
  "github-actions",
  "imgbot",
  "snyk-bot",
  "greenkeeper",
  "allcontributors",
  "claude",
  "copilot",
  "devin-ai-integration",
  "google-labs-jules",
  "cursoragent",
  "sweep-ai",
]);

export function isBotLogin(login: string): boolean {
  const l = login.toLowerCase();
  return l.endsWith("[bot]") || BOT_LOGINS.has(l);
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function buildGitHubHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "s2-signal",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface GhResponse {
  ok: boolean;
  status: number;
  rateLimited: boolean;
  notFound: boolean;
  body: unknown;
  error?: string;
}

/** Shared request budget for one sync run — collection stops (and resumes next
 * run via cursors) instead of blowing the hourly limit. */
export interface RequestBudget {
  remaining: number;
  used: number;
}

async function gh(
  path: string,
  token: string | undefined,
  budget: RequestBudget,
  accept?: string,
): Promise<GhResponse> {
  if (budget.remaining <= 0) {
    return { ok: false, status: 0, rateLimited: false, notFound: false, body: undefined, error: "request budget exhausted" };
  }
  budget.remaining -= 1;
  budget.used += 1;
  try {
    const headers = buildGitHubHeaders(token);
    if (accept) headers.Accept = accept;
    const res = await fetch(`${API}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        rateLimited,
        notFound: res.status === 404,
        body: undefined,
        error: `GitHub ${res.status} on ${path.split("?")[0]}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      rateLimited: false,
      notFound: false,
      body: await res.json(),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      rateLimited: false,
      notFound: false,
      body: undefined,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

interface CollectResult {
  events: GitHubSignalEvent[];
  cursor: MonitoredRepo["pollCursor"];
  stars?: number;
  /** Repo 404'd — renamed or deleted; caller marks it inactive. */
  missing: boolean;
  rateLimited: boolean;
  notes: string[];
}

interface StargazerEntry {
  starred_at?: string;
  user?: { login?: string } | null;
}

interface ForkEntry {
  created_at?: string;
  owner?: { login?: string } | null;
  html_url?: string;
}

interface CommitEntry {
  sha?: string;
  html_url?: string;
  author?: { login?: string } | null;
  commit?: {
    author?: { date?: string } | null;
    committer?: { date?: string } | null;
    message?: string;
  } | null;
}

interface PullEntry {
  number?: number;
  title?: string;
  html_url?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  user?: { login?: string } | null;
}

/** Poll one watchlist repo incrementally. Never throws. */
export async function collectRepo(
  repo: MonitoredRepo,
  token: string | undefined,
  budget: RequestBudget,
): Promise<CollectResult> {
  const events: GitHubSignalEvent[] = [];
  const notes: string[] = [];
  const cursor: MonitoredRepo["pollCursor"] = { ...repo.pollCursor };
  const full = `${repo.owner}/${repo.name}`;
  let rateLimited = false;

  // Repo metadata — validates existence and gives the star count that the
  // backwards stargazer walk needs.
  const meta = await gh(`/repos/${full}`, token, budget);
  if (meta.notFound) {
    return { events, cursor, missing: true, rateLimited: false, notes: [`${full}: repo not found (renamed or deleted)`] };
  }
  if (!meta.ok) {
    return {
      events,
      cursor,
      missing: false,
      rateLimited: meta.rateLimited,
      notes: [`${full}: ${meta.error ?? "metadata fetch failed"}`],
    };
  }
  const metaBody = meta.body as { stargazers_count?: number };
  const starCount = typeof metaBody.stargazers_count === "number" ? metaBody.stargazers_count : 0;

  const push = (
    login: string | undefined,
    action: GitHubSignalEvent["action"],
    at: string | undefined,
    detail?: string,
    url?: string,
  ) => {
    if (!login || !at || isBotLogin(login)) return;
    events.push({
      login,
      repoKey: repo.repoKey,
      action,
      actionAt: at,
      weight: ACTION_WEIGHTS[action],
      detail: detail?.slice(0, 140),
      url,
    });
  };

  // ---- Stars ----------------------------------------------------------------
  // The stargazers list is oldest→newest with no sort param, so new stars live
  // on the LAST pages. Walk backwards from the last page until we cross the
  // cutoff or hit the page cap.
  {
    const cutoff = cursor.starsAt ?? daysAgoISO(BACKFILL_STARS_DAYS);
    const lastPage = Math.max(1, Math.ceil(starCount / 100));
    let newestRead: string | undefined;
    let crossedCutoff = false;
    for (let page = lastPage; page > Math.max(0, lastPage - MAX_STAR_PAGES) && !crossedCutoff; page--) {
      const res = await gh(
        `/repos/${full}/stargazers?per_page=100&page=${page}`,
        token,
        budget,
        "application/vnd.github.star+json",
      );
      if (!res.ok) {
        if (res.rateLimited) rateLimited = true;
        // Observed live: star-timestamp requests (star+json media type) 401
        // when keyless even though the plain endpoint is public.
        if (res.status === 401 && !token)
          notes.push(`${full} stars: star timestamps need a GITHUB_TOKEN (401 when keyless)`);
        else if (res.error) notes.push(`${full} stars: ${res.error}`);
        break;
      }
      const entries = (res.body as StargazerEntry[]) ?? [];
      for (const s of entries) {
        const at = s.starred_at;
        if (!at) continue;
        if (at <= cutoff) {
          crossedCutoff = true;
          continue;
        }
        push(s.user?.login, "starred", at, undefined, `https://github.com/${full}/stargazers`);
        if (!newestRead || at > newestRead) newestRead = at;
      }
      if (page === 1) crossedCutoff = true;
    }
    // Fully walked → advance to the newest star. Cap-limited or aborted →
    // HOLD at the previous cutoff so the unread gap stays "new" next run;
    // the unique (login, repo, action, timestamp) key dedupes any replays.
    if (newestRead) cursor.starsAt = crossedCutoff ? newestRead : cutoff;
    else if (!cursor.starsAt) cursor.starsAt = cutoff;
  }

  // ---- Forks ----------------------------------------------------------------
  {
    const cutoff = cursor.forksAt ?? daysAgoISO(BACKFILL_FORKS_DAYS);
    let newestRead: string | undefined;
    let crossedCutoff = false;
    for (let page = 1; page <= MAX_FORK_PAGES && !crossedCutoff; page++) {
      const res = await gh(`/repos/${full}/forks?sort=newest&per_page=100&page=${page}`, token, budget);
      if (!res.ok) {
        if (res.rateLimited) rateLimited = true;
        if (res.error) notes.push(`${full} forks: ${res.error}`);
        break;
      }
      const entries = (res.body as ForkEntry[]) ?? [];
      if (entries.length === 0) crossedCutoff = true;
      for (const f of entries) {
        const at = f.created_at;
        if (!at) continue;
        if (at <= cutoff) {
          crossedCutoff = true;
          break;
        }
        push(f.owner?.login, "forked", at, undefined, f.html_url);
        if (!newestRead || at > newestRead) newestRead = at;
      }
      if (entries.length < 100) crossedCutoff = true;
    }
    // Same rule as stars: only advance past what we provably read to the end.
    if (newestRead) cursor.forksAt = crossedCutoff ? newestRead : cutoff;
    else if (!cursor.forksAt) cursor.forksAt = cutoff;
  }

  // ---- Commits --------------------------------------------------------------
  // `since=` makes this the cleanest incremental family.
  {
    const cutoff = cursor.commitsAt ?? daysAgoISO(BACKFILL_COMMITS_DAYS);
    let newestRead: string | undefined;
    let complete = false;
    for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
      const res = await gh(
        `/repos/${full}/commits?since=${encodeURIComponent(cutoff)}&per_page=100&page=${page}`,
        token,
        budget,
      );
      if (!res.ok) {
        if (res.rateLimited) rateLimited = true;
        // 409 = empty repository — a non-event, not an error.
        if (res.status === 409) complete = true;
        else if (res.error) notes.push(`${full} commits: ${res.error}`);
        break;
      }
      const entries = (res.body as CommitEntry[]) ?? [];
      for (const c of entries) {
        // `since=` filters by COMMITTER date, so the cursor must compare the
        // same field — author date lags it on rebase-merged contributions.
        const at = c.commit?.committer?.date ?? c.commit?.author?.date;
        if (!at || at <= cutoff) continue;
        const firstLine = (c.commit?.message ?? "").split("\n")[0];
        push(c.author?.login, "committed", at, firstLine, c.html_url);
        if (!newestRead || at > newestRead) newestRead = at;
      }
      if (entries.length < 100) {
        complete = true;
        break;
      }
    }
    // Only advance when the walk drained the window — a truncated or errored
    // walk holds the cursor so the tail is re-collected next run.
    if (newestRead) cursor.commitsAt = complete ? newestRead : cutoff;
    else if (!cursor.commitsAt) cursor.commitsAt = cutoff;
  }

  // ---- Pull requests --------------------------------------------------------
  // sorted by updated desc; a merged PR is the strongest signal we track.
  {
    const cutoff = cursor.prsAt ?? daysAgoISO(BACKFILL_PRS_DAYS);
    let newestRead: string | undefined;
    let crossedCutoff = false;
    for (let page = 1; page <= MAX_PR_PAGES && !crossedCutoff; page++) {
      const res = await gh(
        `/repos/${full}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
        token,
        budget,
      );
      if (!res.ok) {
        if (res.rateLimited) rateLimited = true;
        if (res.error) notes.push(`${full} pulls: ${res.error}`);
        break;
      }
      const entries = (res.body as PullEntry[]) ?? [];
      if (entries.length === 0) crossedCutoff = true;
      for (const pr of entries) {
        const updated = pr.updated_at;
        if (!updated) continue;
        if (updated <= cutoff) {
          crossedCutoff = true;
          break;
        }
        if (pr.merged_at && pr.merged_at > cutoff) {
          push(pr.user?.login, "pr_merged", pr.merged_at, pr.title, pr.html_url);
        } else if (!pr.merged_at && pr.created_at && pr.created_at > cutoff) {
          push(pr.user?.login, "pr_opened", pr.created_at, pr.title, pr.html_url);
        }
        if (!newestRead || updated > newestRead) newestRead = updated;
      }
      if (entries.length < 100) crossedCutoff = true;
    }
    // Same rule: hold the cursor unless the walk provably reached the cutoff.
    if (newestRead) cursor.prsAt = crossedCutoff ? newestRead : cutoff;
    else if (!cursor.prsAt) cursor.prsAt = cutoff;
  }

  return { events, cursor, stars: starCount, missing: false, rateLimited, notes };
}

// --------- Person profile lookups (resolution inputs) ---------

export interface GitHubProfile {
  login: string;
  name?: string;
  company?: string; // raw profile field, e.g. "@vercel" or "Acme Corp"
  location?: string;
  blog?: string;
  email?: string; // public profile email — used for DOMAIN inference only
  avatarUrl?: string;
  htmlUrl?: string;
}

export async function fetchGitHubProfile(
  login: string,
  token: string | undefined,
  budget: RequestBudget,
): Promise<{ ok: boolean; rateLimited: boolean; profile?: GitHubProfile; error?: string }> {
  const res = await gh(`/users/${encodeURIComponent(login)}`, token, budget);
  if (!res.ok) return { ok: false, rateLimited: res.rateLimited, error: res.error };
  const b = res.body as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    ok: true,
    rateLimited: false,
    profile: {
      login,
      name: s(b.name),
      company: s(b.company),
      location: s(b.location),
      blog: s(b.blog),
      email: s(b.email),
      avatarUrl: s(b.avatar_url),
      htmlUrl: s(b.html_url),
    },
  };
}

/** First public org membership, as a company-resolution fallback. */
export async function fetchFirstOrg(
  login: string,
  token: string | undefined,
  budget: RequestBudget,
): Promise<{ org?: string; rateLimited: boolean }> {
  const res = await gh(`/users/${encodeURIComponent(login)}/orgs?per_page=5`, token, budget);
  if (!res.ok) return { rateLimited: res.rateLimited };
  const orgs = (res.body as { login?: string }[]) ?? [];
  const first = orgs.find((o) => typeof o.login === "string" && o.login);
  return { org: first?.login, rateLimited: false };
}

/** Corporate email domains from the user's recent public push events.
 *  DOMAIN inference only — never harvested as an outreach address (verified
 *  emails come from Apollo; scraping commit emails is a GitHub ToS gray zone).
 *  A push can contain OTHER people's commits (maintainers merging external
 *  PRs), so only commits authored by this person are counted. */
export async function fetchCommitEmailDomains(
  login: string,
  profileName: string | undefined,
  token: string | undefined,
  budget: RequestBudget,
): Promise<{ domains: string[]; rateLimited: boolean }> {
  const res = await gh(`/users/${encodeURIComponent(login)}/events/public?per_page=30`, token, budget);
  if (!res.ok) return { domains: [], rateLimited: res.rateLimited };
  const events =
    (res.body as {
      type?: string;
      payload?: { commits?: { author?: { email?: string; name?: string } }[] };
    }[]) ?? [];
  const loginLc = login.toLowerCase();
  const nameLc = profileName?.trim().toLowerCase();
  const domains = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "PushEvent") continue;
    for (const c of ev.payload?.commits ?? []) {
      const email = c.author?.email ?? "";
      const authorName = (c.author?.name ?? "").trim().toLowerCase();
      const isOwnCommit =
        authorName === loginLc ||
        (nameLc !== undefined && authorName === nameLc) ||
        email.toLowerCase().startsWith(`${loginLc}@`);
      if (!isOwnCommit) continue;
      const at = email.lastIndexOf("@");
      if (at < 1) continue;
      const domain = email.slice(at + 1).toLowerCase();
      if (domain && !isFreemailDomain(domain)) domains.add(domain);
    }
  }
  return { domains: [...domains], rateLimited: false };
}

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "fastmail.com",
  "hey.com",
  "aol.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "foxmail.com",
  "duck.com",
  "tutanota.com",
  "mail.com",
  "web.de",
  "t-online.de",
  "orange.fr",
  "free.fr",
  "wanadoo.fr",
  "laposte.net",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "rediffmail.com",
  "zoho.com",
  "zohomail.com",
  "seznam.cz",
  "sina.com",
  "sohu.com",
]);

/** Regional freemail variants share these brand prefixes (hotmail.fr,
 * yahoo.co.jp, live.de, …) — match the brand, not an exhaustive TLD list. */
const FREEMAIL_PREFIXES = ["hotmail.", "outlook.", "yahoo.", "live.", "gmx.", "yandex.", "ymail."];

export function isFreemailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    FREEMAIL.has(d) ||
    FREEMAIL_PREFIXES.some((p) => d.startsWith(p)) ||
    d.endsWith(".noreply.github.com") ||
    d === "users.noreply.github.com" ||
    d === "github.com" ||
    d === "example.com" ||
    d === "localhost"
  );
}
