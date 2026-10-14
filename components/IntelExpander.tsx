"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, ChevronUp } from "lucide-react";
import type { CompanyIntel as Intel } from "@/lib/types";
import { collapseCard } from "@/lib/clientStore";
import { CompanyIntel } from "./CompanyIntel";

const LOADING_LINES = [
  "▸ searching news, engineering blogs, job boards…",
  "▸ estimating data scale and the systems in the serving path…",
  "▸ scoring ICP fit across five criteria…",
  "▸ mapping stakeholders — who feels the pain vs who signs…",
  "▸ checking streaming, real-time and AI workloads…",
  "▸ drafting the outreach angle…",
];

/**
 * Inline expansion that hosts the intel brief beneath a signal card (or at
 * the top of the feed for searched companies). Animates open on mount via
 * the .expander grid-rows transition and collapses before unmounting.
 */
export function IntelExpander({
  company,
  intel,
  loading,
  error,
  onClose,
  onRetry,
  onRefresh,
  framed = false,
}: {
  company: string;
  intel: Intel | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  /** Standalone (orphan/searched) briefs get their own card box; briefs nested
   *  inside a signal card render flush (just a divider) so the card "expands". */
  framed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Mount collapsed, then flip on the next frame so the transition runs.
    const raf = requestAnimationFrame(() => setOpen(true));
    const scroll = setTimeout(
      () => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      150,
    );
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(scroll);
    };
  }, []);

  // Collapse smoothly, then let the parent unmount us.
  const close = () => {
    setOpen(false);
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(onClose, 500);
  };

  // Closing a card-attached brief fully collapses the record to its slim row
  // (Max, Aug 28) — "close brief" and "collapse" are one gesture. Framed
  // (searched/orphan) briefs have no card to collapse, so they just close.
  // That includes a FAILED brief's Close (Max, Sep 25: closing the brief in
  // the feed has to collapse the account the way Signal 2000 does); Retry
  // stays on the error box for anyone who wants another pass.
  const closeFully = () => {
    if (!framed) collapseCard(company);
    close();
  };

  return (
    <div ref={ref} className={`expander ${open ? "expander-open" : ""}`}>
      <div>
        <div
          className={
            framed
              ? "my-3 rounded-xl border border-neon-600/30 bg-ink-950/40 p-4 shadow-glow-sm sm:p-6"
              : "mt-5 border-t border-neon-600/30 pt-5"
          }
        >
          {loading ? (
            <BriefSkeleton company={company} />
          ) : error || !intel ? (
            <BriefError
              company={company}
              error={error || "No brief returned."}
              onRetry={onRetry}
              onClose={closeFully}
            />
          ) : (
            <>
              <CompanyIntel
                intel={intel}
                // The feed's name for this account. Every prospected/score mark
                // is keyed off it, so the card that opened the brief can read
                // back what the brief wrote — even when the research renames the
                // company ("Anthem" → "Elevance Health (formerly Anthem, Inc.)").
                accountKey={company}
                onBack={closeFully}
                onRefresh={onRefresh}
                // Collapse the whole record to its slim row (card-attached briefs
                // only — orphan/searched briefs have no card to collapse).
                onCollapse={framed ? undefined : closeFully}
              />
              <button
                onClick={closeFully}
                className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink-700 py-2.5 text-sm font-medium text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
              >
                <ChevronUp className="h-4 w-4" /> Collapse brief
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function BriefSkeleton({ company }: { company: string }) {
  const [lineIdx, setLineIdx] = useState(0);
  useEffect(() => {
    const i = setInterval(
      () => setLineIdx((n) => (n + 1) % LOADING_LINES.length),
      2600,
    );
    return () => clearInterval(i);
  }, []);

  return (
    <div className="space-y-4">
      <p className="font-mono text-sm text-neon-400">
        researching {company} live — {LOADING_LINES[lineIdx]}
      </p>
      <p className="font-mono text-xs text-ink-500">
        Claude + web_search · typically 30-60s
      </p>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-5">
          <div className="skeleton mb-3 h-4 w-40 rounded" />
          <div className="skeleton mb-2 h-4 w-full rounded" />
          <div className="skeleton h-4 w-2/3 rounded" />
        </div>
      ))}
    </div>
  );
}

function BriefError({
  company,
  error,
  onRetry,
  onClose,
}: {
  company: string;
  error: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-5">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-red-300">
          Intel brief for {company} failed
        </p>
        <p className="mt-1 break-words text-xs leading-relaxed text-red-200/80">{error}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
        <button
          onClick={onClose}
          className="rounded border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:bg-ink-800"
        >
          Close
        </button>
      </div>
    </div>
  );
}
