// GitHub prospecting — domain types.
//
// A signal source alongside the news and Apollo signals: engineers at
// target-sized companies engaging with the database, streaming, vector and
// SingleStore repos on the watchlist (lib/githubProspect/watchlist.ts).
// Contribution signals (merged PRs, commits) rank far above passive stars —
// the weights below drive every sort order.

export type GitHubAction = "starred" | "forked" | "committed" | "pr_opened" | "pr_merged";

/** Contribution-over-star weighting. A merged PR into a watchlist repo is a
 *  far stronger signal than a star; scores are summed per person. */
export const ACTION_WEIGHTS: Record<GitHubAction, number> = {
  pr_merged: 50,
  committed: 40,
  pr_opened: 30,
  forked: 12,
  starred: 5,
};

/** Verb phrases for "signal type" chips and generated openers. */
export const ACTION_LABELS: Record<GitHubAction, string> = {
  pr_merged: "merged a PR into",
  committed: "committed to",
  pr_opened: "opened a PR on",
  forked: "forked",
  starred: "starred",
};

/** True contribution actions (vs. passive engagement). */
export const CONTRIBUTION_ACTIONS: GitHubAction[] = ["pr_merged", "committed", "pr_opened"];

export function isGitHubAction(v: unknown): v is GitHubAction {
  return (
    v === "starred" || v === "forked" || v === "committed" || v === "pr_opened" || v === "pr_merged"
  );
}

// --------- Watchlist ---------

/** One curated repo on the watchlist (gtm_monitored_repos), seeded from
 *  lib/githubProspect/watchlist.ts. ~15-25 rows, reviewed monthly. */
export interface MonitoredRepo {
  repoKey: string; // "owner/name" lowercase
  owner: string;
  name: string;
  category: string; // WatchlistCategory: singlestore | competitor-oltp | streaming | vector | competitor-olap | ai-framework | pipeline
  whyMatters: string; // one-line "why this repo matters" shown on prospect cards
  active: boolean;
  stars?: number;
  /** Incremental poll cutoffs (ISO timestamps) per action family. */
  pollCursor: { starsAt?: string; forksAt?: string; commitsAt?: string; prsAt?: string };
  lastPolledAt?: string;
}

// --------- Raw signals ---------

/** One row per (person, repo, action, timestamp) in gtm_github_signals. */
export interface GitHubSignalEvent {
  login: string;
  repoKey: string;
  action: GitHubAction;
  actionAt: string; // ISO timestamp of the underlying activity
  weight: number;
  detail?: string; // PR title / commit message first line
  url?: string;
}

/** Denormalized per-prospect signal summary entry (gtm_enriched_contacts.signal_summary). */
export interface ProspectSignal {
  repo: string;
  action: GitHubAction;
  at: string;
  url?: string;
}

// --------- Resolved + enriched people ---------

export type ProspectStatus =
  | "new" // signal collected, person not yet resolved
  | "resolved" // company known, awaiting Apollo enrichment
  | "enriched" // verified work email + title on file — ready for outreach
  | "no_match" // could not resolve a company / Apollo had nothing
  | "suppressed"; // filtered out (size threshold, already in HubSpot, active sequence)

/** One row per person in gtm_enriched_contacts — the dashboard output. */
export interface Prospect {
  login: string;
  name?: string;
  avatarUrl?: string;
  githubUrl?: string;
  location?: string;
  company?: string;
  companyDomain?: string;
  resolutionSource?: string; // profile | org-membership | commit-domain
  status: ProspectStatus;
  suppressedReason?: string;
  email?: string; // verified work email (Apollo people-match)
  title?: string;
  seniority?: string;
  linkedinUrl?: string;
  headcount?: number; // company employees (Apollo org search, free)
  hubspotContactId?: string;
  hubspotCompanyId?: string;
  /** Target-account hit: this person works somewhere already in the pipeline —
   *  pushed to HubSpot ("prospected"), given an intel brief ("researched"), or
   *  standing in Signal 2000 ("directory"). Computed at read time by joining on
   *  root domain then normalized company name — NOT stored, so it stays correct
   *  as those sets change and needs no schema migration. */
  directory?: {
    company: string; // canonical company name from the matching source
    employees?: number;
    sweEstimate?: number;
    segment?: string;
    kind: "prospected" | "researched" | "directory";
  };
  score: number; // summed ACTION_WEIGHTS — contributions rank first
  bestAction?: GitHubAction;
  bestRepo?: string;
  signals: ProspectSignal[];
  opener?: string; // suggested "WHAT I SAW" opener
  lastSignalAt?: string;
  updatedAt?: string;
}

/** Summary returned by one /api/github-prospect/sync run. */
export interface SyncSummary {
  ok: boolean;
  error?: string;
  /** Repos polled this run (incremental — net-new activity only). */
  reposPolled: number;
  newSignals: number;
  resolved: number;
  enriched: number;
  suppressed: number;
  openers: number;
  /** Honest per-step notes (rate limits, missing keys, skipped stages). */
  notes: string[];
}
