// /api/github-prospect/sync — one incremental pipeline run:
//
//   collect  → net-new stars/forks/commits/PRs across the watchlist (cursors)
//   aggregate→ per-person score/summary rows (contribution-weighted)
//   resolve  → GitHub profile/orgs/commit-domains → company
//   enrich   → Apollo org size filter + people-match email/title,
//              HubSpot contact dedupe, active-sequence suppression
//   openers  → "WHAT I SAW" one-liners on the fast model
//
// Every stage is bounded (request budget + batch caps) and cursor/status
// driven, so repeated calls make steady progress and a Vercel cron can hit
// this weekly (GET) while the UI button (POST) drives extra passes on demand.
//
// Before collecting, the watchlist in lib/githubProspect/watchlist.ts is seeded
// into gtm_monitored_repos with INSERT IGNORE: new repos appear, existing rows
// (and their poll cursors / active flag) are left alone.

import { NextResponse, type NextRequest } from "next/server";
import { dbConfigured } from "@/lib/store";
import { adminClient } from "@/lib/auth";
import { WATCHLIST, watchlistKey } from "@/lib/githubProspect/watchlist";
import { collectRepo, type RequestBudget } from "@/lib/githubProspect/collect";
import {
  enrichResolvedProspects,
  generateOpeners,
  reopenSizeSuppressed,
  resolveNewProspects,
  type PassCounts,
} from "@/lib/githubProspect/enrich";
import {
  fetchMonitoredRepos,
  fetchSignalsForLogins,
  insertGitHubSignals,
  updateRepoCursor,
  upsertProspectAggregates,
} from "@/lib/githubProspect/store";
import type {
  GitHubSignalEvent,
  ProspectSignal,
  SyncSummary,
} from "@/lib/githubProspect/types";

// Collection can walk dozens of paginated lists — use the platform maximum.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Add any watchlist repo missing from gtm_monitored_repos. INSERT IGNORE on
 *  the repo_key unique key, so cursors and the active flag of existing rows are
 *  untouched. Never throws; a failure is reported as a sync note. */
async function seedWatchlist(): Promise<string | undefined> {
  try {
    const { error } = await adminClient()
      .from("gtm_monitored_repos")
      .upsert(
        WATCHLIST.map((r) => ({
          repo_key: watchlistKey(r),
          owner: r.owner,
          name: r.name,
          category: r.category,
          why_matters: r.whyMatters,
          active: true,
          poll_cursor: {},
        })),
        { onConflict: "repo_key", ignoreDuplicates: true },
      );
    return error ? `Watchlist seed failed: ${error.message}` : undefined;
  } catch (e) {
    return `Watchlist seed failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Recompute per-person aggregates from ALL stored signals for the logins a
 * run touched. Reading back from the DB (not just this run's events) keeps
 * scores correct across incremental runs. */
async function aggregateTouchedLogins(events: GitHubSignalEvent[]): Promise<{ ok: boolean; error?: string }> {
  const logins = [...new Set(events.map((e) => e.login))];
  if (logins.length === 0) return { ok: true };
  const rows = await fetchSignalsForLogins(logins);
  // A partial read must never overwrite existing (correct) aggregates with
  // undercounted ones — skip and let the next run recompute.
  if (rows === null) return { ok: false, error: "Aggregate read incomplete — scores unchanged this run" };
  const byLogin = new Map<string, GitHubSignalEvent[]>();
  for (const r of rows) {
    const list = byLogin.get(r.login) ?? [];
    list.push(r);
    byLogin.set(r.login, list);
  }
  const aggregates = [...byLogin.entries()].map(([login, list]) => {
    const sorted = [...list].sort(
      (a, b) => b.weight - a.weight || b.actionAt.localeCompare(a.actionAt),
    );
    const best = sorted[0];
    const lastSignalAt = list.reduce((m, s) => (s.actionAt > m ? s.actionAt : m), list[0].actionAt);
    const signals: ProspectSignal[] = sorted.slice(0, 30).map((s) => ({
      repo: s.repoKey,
      action: s.action,
      at: s.actionAt,
      url: s.url,
    }));
    return {
      login,
      score: list.reduce((sum, s) => sum + s.weight, 0),
      bestAction: best.action,
      bestRepo: best.repoKey,
      signals,
      lastSignalAt,
    };
  });
  return upsertProspectAggregates(aggregates);
}

async function runSync(req: NextRequest): Promise<NextResponse> {
  const rawMode = req.nextUrl.searchParams.get("mode")?.trim().toLowerCase();
  // "reopen" re-queues people suppressed under a higher size floor, then runs
  // the normal enrich pass over them — the one action a segment change needs.
  const mode: "full" | "enrich" | "reopen" =
    rawMode === "enrich" ? "enrich" : rawMode === "reopen" ? "reopen" : "full";
  const noStore = { headers: { "Cache-Control": "no-store" } };

  if (!dbConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "SingleStore not configured — set SINGLESTORE_HOST / SINGLESTORE_USER / SINGLESTORE_PASSWORD to enable GitHub prospecting",
        reposPolled: 0,
        newSignals: 0,
        resolved: 0,
        enriched: 0,
        suppressed: 0,
        openers: 0,
        notes: [],
      } satisfies SyncSummary,
      noStore,
    );
  }

  try {
    const token = process.env.GITHUB_TOKEN?.trim() || undefined;
    // Keyless GitHub allows 60 req/h — keep a demo pull inside it. A token
    // raises the ceiling to 5,000/h, so a full watchlist pass fits easily.
    const budget: RequestBudget = { remaining: token ? 400 : 40, used: 0 };
    const counts: PassCounts = { resolved: 0, enriched: 0, suppressed: 0, openers: 0, notes: [] };

    const seedError = await seedWatchlist();
    if (seedError) counts.notes.push(seedError);
    const repoRes = await fetchMonitoredRepos();
    if (!repoRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: repoRes.error ?? "Could not load the repo watchlist",
          reposPolled: 0,
          newSignals: 0,
          resolved: 0,
          enriched: 0,
          suppressed: 0,
          openers: 0,
          notes: [],
        } satisfies SyncSummary,
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const activeRepos = repoRes.repos.filter((r) => r.active);

    // ---- Collect (incremental, net-new only) --------------------------------
    let reposPolled = 0;
    const events: GitHubSignalEvent[] = [];
    if (mode === "full") {
      for (const repo of activeRepos) {
        if (budget.remaining < 8) {
          counts.notes.push(
            `Collection paused after ${reposPolled}/${activeRepos.length} repos — request budget spent (cursors resume next sync)`,
          );
          break;
        }
        const r = await collectRepo(repo, token, budget);
        reposPolled += 1;
        counts.notes.push(...r.notes);
        // Insert THIS repo's events BEFORE advancing its cursor: if the run
        // dies here (Vercel timeout) or the insert fails, the cursor stays
        // put and the window replays next run — the unique key dedupes.
        // Cursor-first would silently and permanently lose the window.
        const ins = await insertGitHubSignals(r.events);
        if (ins.ok) {
          events.push(...r.events);
          await updateRepoCursor(repo.repoKey, {
            pollCursor: r.cursor,
            stars: r.stars,
            active: r.missing ? false : undefined,
          });
        } else {
          counts.notes.push(ins.error ?? "Signal insert failed — cursor held for replay");
          await updateRepoCursor(repo.repoKey, {
            stars: r.stars,
            active: r.missing ? false : undefined,
          });
        }
        if (r.rateLimited) {
          counts.notes.push("Collection stopped — GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
          break;
        }
      }
      if (events.length > 0) {
        const agg = await aggregateTouchedLogins(events);
        if (!agg.ok) counts.notes.push(agg.error ?? "Aggregate upsert failed");
      }
    }

    // ---- Reopen → resolve → enrich → openers -------------------------------
    if (mode === "reopen") await reopenSizeSuppressed(counts);
    await resolveNewProspects(token, budget, counts);
    await enrichResolvedProspects(counts);
    await generateOpeners(repoRes.repos, counts);

    const summary: SyncSummary = {
      ok: true,
      reposPolled,
      newSignals: events.length,
      resolved: counts.resolved,
      enriched: counts.enriched,
      suppressed: counts.suppressed,
      openers: counts.openers,
      notes: counts.notes,
    };
    return NextResponse.json(summary, noStore);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error during GitHub prospect sync.";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        reposPolled: 0,
        newSignals: 0,
        resolved: 0,
        enriched: 0,
        suppressed: 0,
        openers: 0,
        notes: [],
      } satisfies SyncSummary,
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** GET — Vercel cron (weekly) + manual link. */
export async function GET(req: NextRequest) {
  return runSync(req);
}

/** POST — the dashboard's "Sync now" / "Enrich pending" buttons. */
export async function POST(req: NextRequest) {
  return runSync(req);
}
