"use client";

import { useMemo } from "react";
import { Flame, ArrowRight } from "lucide-react";
import { SEGMENT_MAP } from "@/lib/data";
import { fmtNum } from "@/lib/format";
import type { Signal } from "@/lib/types";
import { useSweOverrides, useBriefSweMap, companyValue } from "@/lib/clientStore";
import { SegmentIcon } from "./SegmentIcon";

export function AccountPriority({
  signals,
  onSelect,
}: {
  signals: Signal[];
  onSelect: (company: string) => void;
}) {
  // Engineering-size precedence: rep-confirmed override > brief-researched > per-signal.
  const sweOverrides = useSweOverrides();
  const briefSweMap = useBriefSweMap();
  const ranked = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        segment: Signal["segment"];
        count: number;
        strength: number;
        sweEstimate?: number;
        sweConfirmed?: boolean;
      }
    >();
    for (const s of signals) {
      const cur = map.get(s.account) ?? {
        name: s.account,
        segment: s.segment,
        count: 0,
        strength: 0,
        sweEstimate: undefined as number | undefined,
        sweConfirmed: false,
      };
      cur.count += 1;
      cur.strength = Math.max(cur.strength, s.strength);
      const confirmed = companyValue(sweOverrides, s.account);
      const fromBrief = companyValue(briefSweMap, s.account);
      if (confirmed) {
        cur.sweEstimate = confirmed;
        cur.sweConfirmed = true;
      } else if (fromBrief) cur.sweEstimate = fromBrief;
      else if (!cur.sweEstimate && s.sweEstimate) cur.sweEstimate = s.sweEstimate;
      map.set(s.account, cur);
    }
    return [...map.values()]
      .sort((a, b) => b.strength - a.strength || b.count - a.count)
      .slice(0, 6);
  }, [signals, sweOverrides, briefSweMap]);

  if (ranked.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
          <Flame className="h-4 w-4 text-amber-400" />
          priority accounts
        </h3>
        <span className="font-mono text-[11px] text-ink-500">ranked by live ICP fit</span>
      </div>

      <div className="space-y-1.5">
        {ranked.map((a, i) => {
          const seg = SEGMENT_MAP[a.segment];
          return (
            <button
              key={a.name}
              onClick={() => onSelect(a.name)}
              className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-ink-600 hover:bg-ink-800/60"
            >
              <span className="w-5 shrink-0 text-center font-mono text-sm font-bold tabular-nums text-ink-500">
                {i + 1}
              </span>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-800">
                <SegmentIcon name={seg.icon} className="h-4 w-4 text-neon-400" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink-100">
                  {a.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-ink-500">
                  {seg.label}
                  {a.sweEstimate ? ` · ${a.sweConfirmed ? "" : "~"}${fmtNum(a.sweEstimate)} eng` : ""}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end">
                <span className="font-mono text-sm font-bold tabular-nums text-neon-400">
                  {a.strength}
                </span>
                <span className="font-mono text-[10px] text-ink-500">
                  {a.count} sig
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-ink-600 transition-colors group-hover:text-neon-400" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
