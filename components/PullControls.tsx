"use client";

import {
  ChevronLeft,
  ChevronRight,
  DownloadCloud,
  Loader2,
} from "lucide-react";
import type { RegionId } from "@/lib/data";

// Compact pagination + pull controls. Lives at the top of the sidebar (and a
// mobile copy in the feed). Sorting lives in the feed itself, not here.
export function PullControls({
  cacheMode,
  region,
  page,
  totalPages,
  totalCached,
  signalCount,
  updated,
  pulling,
  onPullMore,
  onPage,
}: {
  cacheMode: boolean;
  region: RegionId;
  page: number;
  totalPages: number;
  totalCached: number;
  /** Live-scan mode count (when no cache is configured). */
  signalCount: number;
  updated: string;
  pulling: boolean;
  onPullMore: () => void;
  onPage: (p: number) => void;
}) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
      {cacheMode ? (
        <p className="font-mono text-[11px] text-ink-400">
          <span className="font-semibold text-ink-100">{totalCached}</span> cached ·{" "}
          <span className="rounded bg-ink-800 px-1 py-0.5 text-[9px] font-bold uppercase text-ink-300">
            {region}
          </span>{" "}
          · pg <span className="font-semibold text-ink-100">{page}</span>/{totalPages}
        </p>
      ) : (
        <p className="font-mono text-[11px] text-ink-400">
          <span className="font-semibold text-ink-100">{signalCount}</span> signals · live scan
        </p>
      )}
      <p className="mt-0.5 font-mono text-[10px] text-ink-600">updated {updated}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {cacheMode && (
          <>
            <button
              onClick={() => onPage(page - 1)}
              disabled={page <= 1 || pulling}
              title="Previous page"
              className="inline-flex items-center gap-0.5 rounded border border-ink-700 px-2 py-1 text-[11px] font-medium text-ink-300 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-3 w-3" /> Prev
            </button>
            <button
              onClick={() => onPage(page + 1)}
              disabled={page >= totalPages || pulling}
              title="Next page"
              className="inline-flex items-center gap-0.5 rounded border border-ink-700 px-2 py-1 text-[11px] font-medium text-ink-300 transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next <ChevronRight className="h-3 w-3" />
            </button>
          </>
        )}
      </div>

      {cacheMode && (
        <button
          onClick={onPullMore}
          disabled={pulling}
          title="Run a fresh live scan and add new results to the cache"
          className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded border border-neon-600/50 bg-neon-500/15 px-3 py-1.5 text-[11px] font-semibold text-neon-300 transition-colors hover:bg-neon-500/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pulling ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <DownloadCloud className="h-3.5 w-3.5" />
          )}
          {pulling ? "Pulling…" : "Pull More Signals"}
        </button>
      )}
    </div>
  );
}
