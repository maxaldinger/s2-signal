// GET /api/github-prospect — dashboard read: the repo watchlist, all prospects
// (contribution-weighted first), and the raw-signal total for the metric row.

import { NextResponse } from "next/server";
import {
  countGitHubSignals,
  fetchMonitoredRepos,
  fetchProspects,
  fetchTargetIndex,
  matchTarget,
} from "@/lib/githubProspect/store";
import { WATCHLIST, watchlistKey } from "@/lib/githubProspect/watchlist";
import type { MonitoredRepo } from "@/lib/githubProspect/types";

export const maxDuration = 30;

export async function GET() {
  try {
    const [repos, prospects, totalSignals, targets] = await Promise.all([
      fetchMonitoredRepos(),
      fetchProspects(),
      countGitHubSignals(),
      fetchTargetIndex(),
    ]);
    // Target-account join (prospected / researched / Signal 2000), done
    // server-side so the client never ships thousands of rows to compare.
    if (targets.size > 0) {
      for (const p of prospects.prospects) {
        const hit = matchTarget(targets, p.companyDomain, p.company);
        if (hit) p.directory = hit;
      }
    }
    // Before the first sync seeds gtm_monitored_repos, show the curated
    // watchlist itself (never polled yet) rather than an empty list.
    const repoList: MonitoredRepo[] =
      repos.ok && repos.repos.length === 0
        ? WATCHLIST.map((r) => ({
            repoKey: watchlistKey(r),
            owner: r.owner,
            name: r.name,
            category: r.category,
            whyMatters: r.whyMatters,
            active: true,
            pollCursor: {},
          }))
        : repos.repos;
    const configured = repos.configured && prospects.configured;
    const ok = repos.ok && prospects.ok;
    return NextResponse.json(
      {
        configured,
        ok,
        error: repos.error ?? prospects.error,
        repos: repoList,
        prospects: prospects.prospects,
        totalSignals,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error reading GitHub prospects.";
    return NextResponse.json(
      { configured: true, ok: false, error: message, repos: [], prospects: [], totalSignals: 0 },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
