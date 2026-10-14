"use client";

import { useState } from "react";
import { Code2, Network, Search, Loader2 } from "lucide-react";
import { SEGMENT_MAP } from "@/lib/data";
import type { SegmentId } from "@/lib/types";

interface Hit {
  companyKey: string;
  company: string;
  segment: string | null;
  icpTotal: number | null;
  productFocus: string | null;
  similarity: number;
  snippet: string;
}
interface Result {
  ok: boolean;
  configured: boolean;
  error?: string;
  hits: Hit[];
  sql?: string;
  ms?: number;
  indexed?: number;
}

/**
 * Semantic search over researched accounts, backed by gtm_brief_vectors in
 * SingleStore (VECTOR column + HNSW index). "Find look-alikes" ranks other
 * researched accounts by how close their research is to this one's; the
 * search box ranks them against a free-text theme. Shows the SQL that ran.
 */
export function SimilarAccounts({ company }: { company: string }) {
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState("");
  const [mode, setMode] = useState<"like" | "theme">("like");
  const [showSql, setShowSql] = useState(false);

  const run = async (m: "like" | "theme") => {
    const qs = m === "like" ? `like=${encodeURIComponent(company)}` : `q=${encodeURIComponent(theme.trim())}`;
    if (m === "theme" && !theme.trim()) return;
    setMode(m);
    setLoading(true);
    try {
      const r = await fetch(`/api/semantic?${qs}&k=6`, { cache: "no-store" });
      setRes((await r.json()) as Result);
    } catch {
      setRes({ ok: false, configured: true, error: "Search failed. Try again.", hits: [] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="animate-fade-in rounded-lg border border-ink-700 bg-ink-900 p-4 sm:p-6">
      <h3 className="mb-1 flex items-center gap-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
        <Network className="h-4 w-4 text-neon-400" />
        similar accounts
      </h3>
      <p className="mb-4 text-xs text-ink-400">
        Vector search over every researched account, run in SingleStore: research embeddings in a VECTOR column with an HNSW index,
        filtered and ranked in one SQL query.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          onClick={() => run("like")}
          disabled={loading}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-neon-600/40 bg-neon-500/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-neon-300 transition-colors hover:bg-neon-500/20 disabled:opacity-50"
        >
          {loading && mode === "like" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Network className="h-3.5 w-3.5" />}
          Find look-alikes
        </button>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run("theme");
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-500" />
            <input
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="or search a theme: e.g. teams replicating several databases through Kafka"
              className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pl-8 pr-3 text-xs text-ink-100 outline-none placeholder:text-ink-500 focus:border-neon-500/50"
            />
          </div>
          <button
            disabled={loading || !theme.trim()}
            className="rounded-lg border border-ink-700 px-3 font-mono text-[11px] font-semibold uppercase text-ink-300 hover:border-neon-600/40 hover:text-neon-300 disabled:opacity-40"
          >
            {loading && mode === "theme" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
          </button>
        </form>
      </div>

      {res && (
        <div className="mt-4">
          {res.error && <p className="mb-2 text-xs text-amber-400">{res.error}</p>}
          {res.ok && res.hits.length === 0 && !res.error && (
            <p className="text-xs text-ink-400">No other researched accounts yet. Generate more briefs and they'll show up here.</p>
          )}
          <div className="space-y-2">
            {res.hits.map((h) => {
              const seg = h.segment ? SEGMENT_MAP[h.segment as SegmentId] : undefined;
              const pct = Math.max(0, Math.min(100, Math.round(h.similarity * 100)));
              return (
                <div key={h.companyKey} className="rounded-lg border border-ink-800 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink-100">{h.company}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-500">
                        {seg?.label ?? h.segment ?? "unsegmented"}
                        {h.icpTotal != null ? ` · ICP ${h.icpTotal}` : ""}
                        {h.productFocus ? ` · ${h.productFocus === "ai" ? "AI focus" : "real-time focus"}` : ""}
                      </span>
                    </span>
                    <span className="w-28 shrink-0 text-right">
                      <span className="block font-mono text-xs font-bold text-neon-400">{h.similarity.toFixed(3)}</span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-ink-800">
                        <span className="block h-full rounded-full bg-neon-500" style={{ width: `${pct}%` }} />
                      </span>
                    </span>
                  </div>
                  {h.snippet && <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-ink-400">{h.snippet}</p>}
                </div>
              );
            })}
          </div>
          {res.sql && (
            <div className="mt-3">
              <button
                onClick={() => setShowSql((v) => !v)}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-500 hover:text-neon-300"
              >
                <Code2 className="h-3 w-3" />
                {showSql ? "hide" : "show"} the SQL · {res.ms} ms · {res.indexed ?? 0} accounts indexed
              </button>
              {showSql && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300">{res.sql}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
