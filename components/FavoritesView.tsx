"use client";

import { useMemo } from "react";
import { Star } from "lucide-react";
import type { Signal, BriefState } from "@/lib/types";
import { useFavorites, companyInMap } from "@/lib/clientStore";
import { SignalCard } from "./SignalCard";
import { IntelExpander } from "./IntelExpander";

// The "Signal favorites" tab — the rep's starred companies, pulled from the
// loaded cache. Cards behave exactly like the feed (briefs expand inline,
// multiple at once).
export function FavoritesView({
  signals,
  onSelectCompany,
  onGetIntel,
  briefs,
  onCloseIntel,
  onRefreshIntel,
}: {
  signals: Signal[];
  onSelectCompany: (c: string) => void;
  onGetIntel: (c: string) => void;
  briefs: Record<string, BriefState>;
  onCloseIntel: (company: string) => void;
  onRefreshIntel: (c: string) => void;
}) {
  const favs = useFavorites();
  const favSignals = useMemo(
    () => signals.filter((s) => companyInMap(favs, s.account)),
    [signals, favs],
  );

  const toggleCompany = (account: string) =>
    briefs[account] ? onCloseIntel(account) : onSelectCompany(account);

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

  const orphanBriefs = Object.keys(briefs).filter(
    (c) => !favSignals.some((s) => s.account === c),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-ink-50">
          <Star className="h-5 w-5 fill-amber-400 text-amber-400" /> Signal Favorites
        </h2>
        <p className="mt-1 text-sm text-ink-300">
          Companies you&apos;ve starred for quick access.
        </p>
      </div>

      {/* Briefs for companies not in the favorites list expand here. */}
      {orphanBriefs.map((c) => (
        <div key={c}>{renderBrief(c, true)}</div>
      ))}

      {favSignals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-12 text-center">
          <p className="text-sm text-ink-400">
            No favorites yet. Tap the star on a signal card to add it here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {favSignals.map((s, i) => (
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
    </div>
  );
}
