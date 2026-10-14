"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Building2,
  Loader2,
  DownloadCloud,
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import type { DirectoryEntry, Signal, BriefState } from "@/lib/types";
import type { RegionId } from "@/lib/data";
import {
  useBlacklist,
  companyInMap,
  companyValue,
  useSweOverrides,
  useBriefSweMap,
} from "@/lib/clientStore";
import { SignalCard } from "./SignalCard";
import { NotAFitList } from "./SignalFeed";
import { IntelExpander } from "./IntelExpander";

const PAGE_SIZE = 25;
const todayISO = () => new Date().toISOString().slice(0, 10);

type DirSort = "fit" | "size" | "az";
const SORTS: { id: DirSort; label: string }[] = [
  { id: "fit", label: "ICP fit (high → low)" },
  { id: "size", label: "Eng team size (high → low)" },
  { id: "az", label: "Company A → Z" },
];

// A directory row renders through the SAME SignalCard as the feed. We leave the
// `description` empty (and `title` empty) so the card lazily fetches the real
// "what they do" company blurb on view — the exact same mechanism, endpoint, and
// cross-device cache the signal feed already uses. The company name shows on the
// account button, so there's no duplicate headline.
function toSignal(e: DirectoryEntry): Signal {
  return {
    id: `dir-${e.companyKey}`,
    account: e.company,
    segment: e.segment,
    type: "icp",
    strength: e.strength,
    title: "",
    description: "",
    tags: e.employeeBand ? [e.employeeBand] : [],
    source: e.source,
    url: e.websiteUrl || e.linkedinUrl,
    date: todayISO(),
    sweEstimate: e.sweEstimate,
  };
}

// Pager with a jump-to-page box. Module-level (stable identity) so the input
// keeps focus across the parent's re-renders — an inline component would remount
// on every keystroke and drop focus. The box shows the current page; type a
// number + Enter (or blur) to jump, clamped to [1, totalPages].
function Pager({
  page,
  totalPages,
  onJump,
}: {
  page: number;
  totalPages: number;
  onJump: (p: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const editing = draft !== "";

  if (totalPages <= 1) return null;

  const commit = () => {
    const n = parseInt(draft, 10);
    if (!Number.isNaN(n)) onJump(Math.min(totalPages, Math.max(1, n)));
    setDraft("");
  };

  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-ink-400">
      <button
        onClick={() => onJump(page - 1)}
        disabled={page <= 1}
        className="inline-flex items-center gap-0.5 rounded border border-ink-700 px-2 py-1 text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
      >
        <ChevronLeft className="h-3 w-3" /> Prev
      </button>
      <span className="flex items-center gap-1">
        pg
        <input
          type="text"
          inputMode="numeric"
          aria-label="Jump to page"
          value={editing ? draft : String(page)}
          onFocus={() => setDraft(String(page))}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setDraft("");
              e.currentTarget.blur();
            }
          }}
          className="w-10 rounded border border-ink-700 bg-ink-900 px-1 py-0.5 text-center font-semibold text-ink-100 outline-none focus:border-neon-600/50"
        />
        / {totalPages}
      </span>
      <button
        onClick={() => onJump(page + 1)}
        disabled={page >= totalPages}
        className="inline-flex items-center gap-0.5 rounded border border-ink-700 px-2 py-1 text-ink-300 transition-colors hover:bg-ink-800 disabled:opacity-40"
      >
        Next <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

export function DirectoryView({
  briefs,
  region,
  onSelectCompany,
  onGetIntel,
  onCloseIntel,
  onRefreshIntel,
}: {
  briefs: Record<string, BriefState>;
  /** Header's US/IN toggle — picks which region's directory shows. */
  region: RegionId;
  onSelectCompany: (c: string) => void;
  onGetIntel: (c: string) => void;
  onCloseIntel: (company: string) => void;
  onRefreshIntel: (company: string) => void;
}) {
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirSort>("fit");
  const [page, setPage] = useState(1);
  const [populating, setPopulating] = useState(false);
  const blacklistMap = useBlacklist();

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/directory?region=${region}`, { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; error?: string; entries: DirectoryEntry[] };
      if (data.ok) setEntries(data.entries);
      else {
        setEntries([]);
        setError(data.error || "Could not load the directory.");
      }
    } catch {
      setEntries([]);
      setError("Network error loading the directory.");
    }
  }, [region]);

  // Region flip = a different directory: show the skeleton, reload, page 1.
  useEffect(() => {
    setEntries(null);
    setPage(1);
    void load();
  }, [load]);

  const populate = async () => {
    if (populating) return;
    setPopulating(true);
    setError("");
    try {
      const res = await fetch("/api/directory/populate?pages=8", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; upserted?: number; errors?: string[] };
      if (!data.ok && !(data.upserted && data.upserted > 0)) {
        setError(data.errors?.[0] || "Populate failed — check the Apollo key / SingleStore config.");
      }
      await load();
    } catch {
      setError("Populate request failed.");
    } finally {
      setPopulating(false);
    }
  };

  // The size sort uses the same engineering-size precedence the cards display (confirmed
  // override > brief-researched > raw row estimate) so a corrected account
  // doesn't rank by the number its chip no longer shows.
  const sweOverridesMap = useSweOverrides();
  const briefSweMap = useBriefSweMap();

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    const effSwe = (e: DirectoryEntry) =>
      companyValue(sweOverridesMap, e.company) ??
      companyValue(briefSweMap, e.company) ??
      e.sweEstimate;
    // Same "Not a fit" blacklist the feed honors — a blacklisted company
    // disappears here too (restorable via the list at the bottom).
    const list = entries.filter(
      (e) =>
        !companyInMap(blacklistMap, e.company) &&
        (!q || e.company.toLowerCase().includes(q)),
    );
    const sorted = [...list];
    if (sort === "fit") sorted.sort((a, b) => b.strength - a.strength);
    else if (sort === "size") sorted.sort((a, b) => (effSwe(b) ?? 0) - (effSwe(a) ?? 0));
    else sorted.sort((a, b) => a.company.localeCompare(b.company));
    return sorted;
  }, [entries, query, sort, blacklistMap, sweOverridesMap, briefSweMap]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const renderBrief = (company: string) => {
    const b = briefs[company];
    if (!b) return null;
    return (
      <IntelExpander
        key={company}
        company={company}
        intel={b.intel}
        loading={b.loading}
        error={b.error}
        onClose={() => onCloseIntel(company)}
        onRetry={() => onGetIntel(company)}
        onRefresh={() => onRefreshIntel(company)}
      />
    );
  };
  const toggleCompany = (account: string) =>
    briefs[account] ? onCloseIntel(account) : onSelectCompany(account);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-ink-50">
            <Building2 className="h-5 w-5 text-neon-400" /> Signal 2000
          </h2>
          <p className="mt-1 text-sm text-ink-300">
            {region === "in"
              ? "The ~2,000 largest Indian companies across every sector"
              : region === "global"
                ? "The ~2,000 largest companies headquartered outside the US and India — EU/UK, APAC, LATAM, MEA"
                : "The ~2,000 largest US companies across every sector"}{" "}
            — short brief on view, full intel on demand.{" "}
            {entries ? `${entries.length.toLocaleString()} companies.` : ""}
          </p>
        </div>
        {/* The re-seed button only applies to the US list (its static seed
            lives in the repo); the India list is built server-side from
            Apollo + a curated seed via scripts/build-india-directory.mjs. */}
        {region === "us" && (
          <button
            onClick={populate}
            disabled={populating}
            title="Re-seed the directory from the largest-US-companies list"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-200 disabled:opacity-50"
          >
            {populating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {populating ? "Building…" : "Refresh list"}
          </button>
        )}
      </div>

      {/* Search */}
      <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
        <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-ink-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Filter the directory by company name…"
            className="w-full bg-transparent font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="min-w-0 flex-1 break-words text-xs leading-relaxed text-amber-200/90">{error}</p>
        </div>
      )}

      {/* Loading */}
      {entries === null ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-5">
              <div className="skeleton mb-2 h-6 w-40 rounded" />
              <div className="skeleton mb-2 h-4 w-3/4 rounded" />
              <div className="skeleton h-4 w-1/2 rounded" />
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-12 text-center">
          <p className="text-sm text-ink-300">
            The {region === "in" ? "India" : region === "global" ? "global" : "US"} directory is
            empty.
          </p>
          {region === "us" ? (
            <>
              <p className="mt-1 text-xs text-ink-500">
                Build it now — seeds the ~2,000 largest US companies across every sector.
              </p>
              <button
                onClick={populate}
                disabled={populating}
                className="mt-4 inline-flex items-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25 disabled:opacity-50"
              >
                {populating ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}
                {populating ? "Building directory…" : "Build directory"}
              </button>
            </>
          ) : (
            <p className="mt-1 text-xs text-ink-500">
              This list is seeded server-side (scripts/build-india-directory.mjs) — ask Max.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Pager page={safePage} totalPages={totalPages} onJump={setPage} />
            <div className="flex min-w-0 items-center gap-2 sm:ml-auto">
              <label className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-ink-400">
                <ArrowDownUp className="h-3.5 w-3.5" /> sort
              </label>
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as DirSort);
                  setPage(1);
                }}
                className="min-w-0 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none"
              >
                {SORTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {pageItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-10 text-center text-sm text-ink-400">
              No companies match “{query}”.
            </div>
          ) : (
            <div className="space-y-4">
              {pageItems.map((e, i) => {
                const s = toSignal(e);
                return (
                  <SignalCard
                    key={s.id}
                    signal={s}
                    index={i}
                    onSelect={toggleCompany}
                    expanded={Boolean(briefs[s.account])}
                    brief={renderBrief(s.account)}
                  />
                );
              })}
            </div>
          )}

          <div className="flex justify-center">
            <Pager page={safePage} totalPages={totalPages} onJump={setPage} />
          </div>

          {/* Companies removed as "not a fit" — collapsible, restorable. */}
          <NotAFitList />
        </>
      )}
    </div>
  );
}
