"use client";

import { useState } from "react";
import {
  Search,
  Sparkles,
  Zap,
  Building,
  Gauge,
  Flame,
  Info,
  AlertTriangle,
  RefreshCw,
  DownloadCloud,
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  X,
  Ban,
} from "lucide-react";
import type { Signal, SignalTypeId, BriefState } from "@/lib/types";
import { SIGNAL_TYPE_MAP } from "@/lib/data";
import { useBlacklist, removeFromBlacklist } from "@/lib/clientStore";
import { MetricCard } from "./MetricCard";
import { SignalCard } from "./SignalCard";
import { AccountPriority } from "./AccountPriority";
import { IntelExpander } from "./IntelExpander";

// Feed sort. "feed" = mixed (original pull order). The rest sort the cards;
// minimized/low-priority cards always sink to the bottom regardless (page.tsx).
export type FeedSort =
  | "feed"
  | "fit"
  | "size"
  | "recent"
  | "az"
  | "hubspot"
  | "nothubspot";

// Compact prev/next + "pg X/Y" pager, shown at the top and bottom of the feed.
function Pager({
  page,
  totalPages,
  onPage,
  disabled,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  disabled: boolean;
}) {
  if (totalPages <= 1) return null;
  const btn =
    "inline-flex items-center gap-0.5 rounded border border-ink-700 px-2 py-1 text-[11px] font-medium text-ink-300 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-ink-400">
      <button onClick={() => onPage(page - 1)} disabled={page <= 1 || disabled} className={btn}>
        <ChevronLeft className="h-3 w-3" /> Prev
      </button>
      <span>
        pg <span className="font-semibold text-ink-100">{page}</span> / {totalPages}
      </span>
      <button
        onClick={() => onPage(page + 1)}
        disabled={page >= totalPages || disabled}
        className={btn}
      >
        Next <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

// Collapsible list of companies removed as "not a fit", with one-click restore.
// Shared with DirectoryView (Signal 2000) — the blacklist spans both views.
export function NotAFitList() {
  const map = useBlacklist();
  const [open, setOpen] = useState(false);
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between font-mono text-[11px] uppercase tracking-wider text-ink-400 transition-colors hover:text-ink-200"
      >
        <span className="flex items-center gap-1.5">
          <Ban className="h-3.5 w-3.5" /> removed as not a fit ({entries.length})
        </span>
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {entries.map(([k, name]) => (
            <button
              key={k}
              onClick={() => removeFromBlacklist(name)}
              title="Restore to feed"
              className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-200"
            >
              {name} <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SORT_OPTIONS: { id: FeedSort; label: string }[] = [
  { id: "feed", label: "Mixed feed" },
  { id: "fit", label: "ICP fit (high → low)" },
  { id: "size", label: "Eng team size (high → low)" },
  { id: "recent", label: "Most recent" },
  { id: "az", label: "Company A → Z" },
  { id: "hubspot", label: "In HubSpot first" },
  { id: "nothubspot", label: "Not in HubSpot first" },
];

export function SignalFeed({
  signals,
  loading,
  pulling,
  cacheMode,
  totalCached,
  historyError,
  pendingBuckets,
  bucketErrors,
  metrics,
  hiddenCount,
  onClearFilters,
  onSelectCompany,
  onGetIntel,
  onRetry,
  onPullMore,
  briefs,
  onCloseIntel,
  onRefreshIntel,
  sort,
  onSort,
  page,
  totalPages,
  onPage,
  pullResult,
  onDismissPullResult,
}: {
  signals: Signal[];
  sort: FeedSort;
  onSort: (s: FeedSort) => void;
  /** Current page + total (cache mode) and the page setter, for the in-feed pagers. */
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  /** Outcome of the last "Pull More" — drives the post-pull feedback line. */
  pullResult: { added: number; refreshed?: number; failed: SignalTypeId[] } | null;
  onDismissPullResult: () => void;
  loading: boolean;
  pulling: boolean;
  cacheMode: boolean;
  totalCached: number;
  historyError: string | null;
  pendingBuckets: SignalTypeId[];
  bucketErrors: Partial<Record<SignalTypeId, string>>;
  metrics: { total: number; accounts: number; avgFit: number; hot: number };
  /** How many cached signals the active filters are hiding (global). */
  hiddenCount: number;
  onClearFilters: () => void;
  onSelectCompany: (c: string) => void;
  onGetIntel: (c: string) => void;
  onRetry: () => void;
  onPullMore: () => void;
  /** Open briefs, keyed by company — multiple can be open at once. */
  briefs: Record<string, BriefState>;
  onCloseIntel: (company: string) => void;
  onRefreshIntel: (company: string) => void;
}) {
  const [query, setQuery] = useState("");

  // Sorting happens upstream (page.tsx) so order is applied once; the dropdown
  // below just drives the `sort` state. `signals` arrives already ordered.
  const sorted = signals;

  // Accept a company name OR an email — for an email, research the company at
  // its domain (drop generic mailbox providers so "jane@gmail.com" doesn't
  // research Gmail).
  const submit = (c: string) => {
    const v = c.trim();
    if (!v) return;
    const emailMatch = v.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
    const generic = /^(gmail|outlook|hotmail|yahoo|icloud|proton|protonmail|aol|live|msn)\./i;
    const target =
      emailMatch && !generic.test(emailMatch[1]) ? emailMatch[1] : v;
    onGetIntel(target);
  };

  // Toggle semantics: clicking an open company again closes its brief.
  const toggleCompany = (account: string) =>
    briefs[account] ? onCloseIntel(account) : onSelectCompany(account);

  // Render a company's brief from the open-briefs map. `framed` standalone
  // briefs (no card on this page) get their own box; in-card briefs render
  // flush so the card itself expands into the brief.
  const renderBrief = (company: string, framed = false) => {
    const b = briefs[company];
    if (!b) return null;
    return (
      <IntelExpander
        key={company}
        company={company}
        intel={b.intel}
        loading={b.loading}
        error={b.error}
        framed={framed}
        onClose={() => onCloseIntel(company)}
        onRetry={() => onGetIntel(company)}
        onRefresh={() => onRefreshIntel(company)}
      />
    );
  };

  // Briefs whose company has no card on this page (e.g. searched, or filtered
  // off) render at the top so they're not lost.
  const orphanBriefs = Object.keys(briefs).filter(
    (c) => !sorted.some((s) => s.account === c),
  );

  // Booting = nothing has landed yet; afterwards cards render progressively
  // while remaining buckets are still scanning.
  const booting = (loading || pulling) && signals.length === 0;
  const failedBuckets = Object.keys(bucketErrors) as SignalTypeId[];
  const allFailed = !loading && failedBuckets.length >= 5 && signals.length === 0;
  const bucketLabel = (b: SignalTypeId) => SIGNAL_TYPE_MAP[b]?.label ?? b;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink-50">Signal Feed</h2>
        <p className="mt-1 text-sm text-ink-300">
          Live SingleStore buying signals across data-intensive companies — data hiring, OSS, M&A, funding,
          gen-AI launches. Generated fresh by Claude + web search.
        </p>
      </div>

      {/* Search card */}
      <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-ink-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(query)}
              placeholder="Run a live intel brief on any company or email…"
              className="w-full bg-transparent font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => submit(query)}
            disabled={!query.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <Sparkles className="h-4 w-4" />
            Get Intel
          </button>
        </div>
      </div>

      {/* Metrics — all four describe exactly what's rendered on this page
          right now (after filters). The cache-wide total lives in the
          pagination bar below. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="signals on page" value={metrics.total} icon={Zap} color="text-neon-400" loading={loading} />
        <MetricCard label="accounts" value={metrics.accounts} icon={Building} color="text-sky-400" loading={loading} />
        <MetricCard label="avg icp fit" value={metrics.avgFit} icon={Gauge} color="text-violet-400" loading={loading} />
        <MetricCard label="hot (≥80)" value={metrics.hot} icon={Flame} color="text-amber-400" loading={loading} />
      </div>

      {/* Post-pull feedback — tell the user what the pull actually did, so a
          no-op pull (sources recycled, or some rate-limited) isn't silent. */}
      {pullResult && !booting && (
        <div
          className={`flex items-start gap-3 rounded-lg border px-4 py-2.5 ${
            pullResult.added > 0
              ? "border-neon-600/30 bg-neon-500/10"
              : "border-ink-700 bg-ink-900/60"
          }`}
        >
          {pullResult.added > 0 ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-neon-400" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
          )}
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-300">
            {pullResult.added > 0 ? (
              <span className="font-semibold text-neon-300">
                Pulled {pullResult.added} new signal{pullResult.added === 1 ? "" : "s"}
                {pullResult.refreshed ? `, ${pullResult.refreshed} re-sighted` : ""}.
              </span>
            ) : (
              <span className="font-semibold text-ink-200">No new signals this pull.</span>
            )}{" "}
            {pullResult.failed.length > 0
              ? `Some sources errored or were rate-limited (${pullResult.failed
                  .map(bucketLabel)
                  .join(", ")}) — try again shortly.`
              : pullResult.added === 0
                ? "The sources only returned companies already in your feed. Try the other region, or check back later as new signals appear."
                : ""}
          </p>
          <button
            onClick={onDismissPullResult}
            className="shrink-0 text-ink-500 transition-colors hover:text-ink-200"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Filters hiding rows — say so loudly instead of looking like a small pull */}
      {!loading && hiddenCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2.5">
          <p className="font-mono text-xs text-violet-300">
            ▸ {hiddenCount} cached signal{hiddenCount === 1 ? "" : "s"} hidden by your filters
          </p>
          <button
            onClick={onClearFilters}
            className="shrink-0 rounded border border-violet-500/40 px-2.5 py-1 font-mono text-[11px] font-medium text-violet-300 transition-colors hover:bg-violet-500/15"
          >
            clear filters
          </button>
        </div>
      )}

      {/* Error banner — only when the WHOLE pull fails and nothing landed.
          Free sources (HN Algolia, GDELT) 4xx/429 routinely, so a partial
          bucket miss is normal noise, not something to alarm on every pull. */}
      {allFailed && !booting && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-300">
              Live signal pass failed — no sources responded
            </p>
            <p className="mt-0.5 break-words text-xs leading-relaxed text-amber-200/80">
              {failedBuckets.map((b) => `${bucketLabel(b)}: ${bucketErrors[b]}`).join(" · ")}
            </p>
          </div>
          <button
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-amber-500/40 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/15"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      {/* History read error */}
      {historyError && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-red-300">
            Cache read failed: {historyError}
          </p>
        </div>
      )}

      {/* Briefs for companies with no card on this page expand here */}
      {orphanBriefs.map((c) => (
        <div key={c}>{renderBrief(c, true)}</div>
      ))}

      {/* Account prioritization */}
      {signals.length > 0 && <AccountPriority signals={signals} onSelect={toggleCompany} />}

      {/* Sort control — lives in the feed itself. Minimized/low-priority cards
          always sort to the bottom regardless of the choice. A page counter sits
          on the left (top of feed); a matching one repeats at the bottom. */}
      {!booting && sorted.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {cacheMode && (
            <div className="flex justify-center sm:justify-start">
              <Pager page={page} totalPages={totalPages} onPage={onPage} disabled={pulling} />
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2 sm:ml-auto">
            <label className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-400">
              <ArrowDownUp className="h-3.5 w-3.5" />
              sort
            </label>
            <select
              value={sort}
              onChange={(e) => onSort(e.target.value as FeedSort)}
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Feed */}
      {booting ? (
        <div className="space-y-4">
          <p className="font-mono text-xs text-neon-400">
            ▸ running 6 parallel scans: data hiring, OSS, M&A, funding, gen-AI + Apollo ICP sweep…
          </p>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-5">
              <div className="mb-3 flex gap-2">
                <div className="skeleton h-6 w-24 rounded" />
                <div className="skeleton h-6 w-20 rounded" />
              </div>
              <div className="skeleton mb-2 h-7 w-40 rounded" />
              <div className="skeleton mb-2 h-4 w-3/4 rounded" />
              <div className="skeleton h-4 w-1/2 rounded" />
            </div>
          ))}
        </div>
      ) : cacheMode && totalCached === 0 && failedBuckets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-12 text-center">
          <p className="text-sm text-ink-300">The signal cache is empty.</p>
          <p className="mt-1 text-xs text-ink-500">
            Run your first pull — six parallel scans (web + Apollo), about a minute.
          </p>
          <button
            onClick={onPullMore}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25"
          >
            <DownloadCloud className="h-4 w-4" /> Pull Signals
          </button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-12 text-center">
          <p className="text-sm text-ink-400">
            {hiddenCount > 0
              ? "No cached signals match the current filters. Clear a filter to see them."
              : "No signals cached yet — hit Pull More Signals."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingBuckets.length > 0 && (
            <p className="animate-pulse-dot font-mono text-xs text-neon-400">
              ▸ still scanning: {pendingBuckets.map(bucketLabel).join(", ")}…
            </p>
          )}
          {sorted.map((s, i) => (
            <div key={s.id}>
              <SignalCard
                signal={s}
                index={i}
                onSelect={toggleCompany}
                expanded={Boolean(briefs[s.account])}
                brief={renderBrief(s.account)}
              />
            </div>
          ))}
        </div>
      )}

      {/* Bottom pager — so you can page without scrolling back to the top. */}
      {!booting && cacheMode && sorted.length > 0 && (
        <div className="flex justify-center">
          <Pager page={page} totalPages={totalPages} onPage={onPage} disabled={pulling} />
        </div>
      )}

      {/* Companies removed as "not a fit" — collapsible, restorable */}
      <NotAFitList />

      {/* Honest data-source note */}
      <div className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-900/50 p-3 text-xs text-ink-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
        <span>
          Signals are generated live by{" "}
          <span className="font-mono text-ink-400">Claude</span> +{" "}
          <span className="font-mono text-ink-400">web_search</span> and the Apollo ICP
          sweep{cacheMode ? ", then cached in SingleStore — each pull adds new results and refreshes repeat sightings" : ""}.
          Strength is an ICP-fit estimate, and sources are linked on each card. Verify
          before outreach.
        </span>
      </div>
    </div>
  );
}
