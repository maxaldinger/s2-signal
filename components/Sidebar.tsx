"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Radio,
  Sparkles,
  Star,
  UserSearch,
  Check,
  SlidersHorizontal,
  ChevronDown,
  X,
  RotateCcw,
  Building2,
  Github,
  LogOut,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
import { SEGMENTS, SIGNAL_TYPES, SWE_BANDS, type SweBandId } from "@/lib/data";
import type { SegmentId, SignalTypeId } from "@/lib/types";
import { useFavorites, useProspectedCount, clearAllProspected } from "@/lib/clientStore";
import { SegmentIcon } from "./SegmentIcon";

export type TabId = "feed" | "directory" | "github" | "titles" | "favorites" | "assist" | "pipeline";

const NAV: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "feed", label: "Signal Feed", icon: Radio },
  { id: "directory", label: "Signal 2000", icon: Building2 },
  { id: "github", label: "GitHub Prospecting", icon: Github },
  { id: "titles", label: "Title Search", icon: UserSearch },
  { id: "favorites", label: "Signal favorites", icon: Star },
  { id: "assist", label: "Sales Assist", icon: Sparkles },
];

// Below the divider: reference material for working the pipeline, as opposed
// to the prospecting surfaces above it.
const NAV_PIPELINE: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "pipeline", label: "Pipeline Questions", icon: ClipboardList },
];

// Section heading with "all" / "clear" affordances.
function FilterHeading({
  label,
  activeCount,
  optionCount,
  onSelectAll,
  onClear,
}: {
  label: string;
  activeCount: number;
  optionCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between px-1">
      <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
        {label}
        {activeCount > 0 && (
          <span className="ml-1.5 rounded bg-neon-500/15 px-1 py-0.5 text-neon-300">
            {activeCount}
          </span>
        )}
      </h3>
      <span className="flex items-center gap-2">
        {activeCount < optionCount && (
          <button
            onClick={onSelectAll}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-500 transition-colors hover:text-neon-300"
          >
            all
          </button>
        )}
        {activeCount > 0 && (
          <button
            onClick={onClear}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-500 transition-colors hover:text-neon-300"
          >
            clear
          </button>
        )}
      </span>
    </div>
  );
}

// Maintenance: wipe all orange "prospected · sent to HubSpot" marks. Needed
// because an earlier bug stamped records the app merely *found* in HubSpot, not
// ones it actually pushed — so the stored marks can't be trusted and a clean
// reset (re-earned on every real push) is the only sure fix. Two-click confirm.
// WS5: each user's own HubSpot connection. Not connected -> an orange call to
// action (pushes fail without it); connected -> the portal domain + disconnect.
function HubSpotConnectChip() {
  const [state, setState] = useState<{
    loaded: boolean;
    configured?: boolean;
    connected?: boolean;
    hubDomain?: string;
  }>({ loaded: false });
  useEffect(() => {
    fetch("/api/hubspot/oauth/status")
      .then((r) => r.json())
      .then((d: { configured?: boolean; connected?: boolean; hubDomain?: string }) =>
        setState({ loaded: true, configured: d.configured, connected: d.connected, hubDomain: d.hubDomain }),
      )
      .catch(() => setState({ loaded: true }));
  }, []);
  if (!state.loaded || state.configured === false) return null;
  if (!state.connected) {
    return (
      <a
        href="/api/hubspot/oauth/install"
        title="Connect your own HubSpot portal — tasks you push land in YOUR HubSpot, owned by you"
        className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 px-2 py-1 font-mono text-[11px] font-semibold text-orange-300 transition-colors hover:bg-orange-500/20"
      >
        Connect HubSpot
      </a>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink-500">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neon-500" />
      <span className="truncate" title={`Connected to ${state.hubDomain ?? "your HubSpot"}`}>
        HubSpot: {state.hubDomain ?? "connected"}
      </span>
      <button
        onClick={async () => {
          await fetch("/api/hubspot/oauth/disconnect", { method: "POST" }).catch(() => {});
          window.location.reload();
        }}
        className="shrink-0 text-ink-600 transition-colors hover:text-ink-300"
        title="Disconnect this portal"
      >
        ×
      </button>
    </span>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d: { signedIn?: boolean; displayName?: string; email?: string }) => {
        if (d.signedIn) setWho(d.displayName || d.email || "signed in");
      })
      .catch(() => {});
  }, []);
  // Auth is always on now (app sessions) — inside the app there is always
  // a session to sign out of. `who` doubles as the loading gate.
  if (!who) return null;
  return (
    <button
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } catch {
          // ignore — navigate regardless; middleware re-gates.
        }
        window.location.assign("/login");
      }}
      title={`Signed in as ${who}`}
      className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink-500 transition-colors hover:text-ink-300"
    >
      <LogOut className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{busy ? "signing out…" : `${who} · sign out`}</span>
    </button>
  );
}

function ResetProspected() {
  const count = useProspectedCount();
  const [armed, setArmed] = useState(false);
  if (count === 0) return null;
  return (
    <button
      onClick={() => {
        if (armed) {
          clearAllProspected();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
      title="Clear every orange 'sent to HubSpot' mark stored in this browser. Real pushes re-mark themselves."
      className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
        armed
          ? "border-red-500/50 bg-red-500/10 text-red-300"
          : "border-ink-700 text-ink-500 hover:border-orange-500/40 hover:text-orange-300"
      }`}
    >
      <RotateCcw className="h-3 w-3" />
      {armed ? `Tap again to wipe ${count}` : `Reset prospected marks (${count})`}
    </button>
  );
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors ${
        checked
          ? "border-neon-500 bg-neon-500/20 text-neon-300"
          : "border-ink-600 bg-transparent text-transparent"
      }`}
    >
      <Check className="h-2.5 w-2.5" strokeWidth={3} />
    </span>
  );
}

export function Sidebar({
  activeTab,
  onTab,
  segmentCounts,
  selectedSegments,
  onToggleSegment,
  onSetSegments,
  sweBandCounts,
  unknownSweCount,
  selectedSweBands,
  onToggleSweBand,
  onSetSweBands,
  signalCounts,
  selectedSignalTypes,
  onToggleSignalType,
  onSetSignalTypes,
  minStrength,
  onMinStrength,
  hubspotFilter,
  onHubspotFilter,
  reviewedFilter,
  onReviewedFilter,
  pullControls,
  mobileOpen = false,
  onMobileClose,
}: {
  activeTab: TabId;
  onTab: (t: TabId) => void;
  /** Compact pull/pagination controls, rendered above the collapsible filters. */
  pullControls?: ReactNode;
  segmentCounts: Record<SegmentId, number>;
  selectedSegments: SegmentId[];
  onToggleSegment: (s: SegmentId) => void;
  onSetSegments: (s: SegmentId[]) => void;
  sweBandCounts: Record<SweBandId, number>;
  unknownSweCount: number;
  selectedSweBands: SweBandId[];
  onToggleSweBand: (b: SweBandId) => void;
  onSetSweBands: (b: SweBandId[]) => void;
  signalCounts: Record<SignalTypeId, number>;
  selectedSignalTypes: SignalTypeId[];
  onToggleSignalType: (s: SignalTypeId) => void;
  onSetSignalTypes: (s: SignalTypeId[]) => void;
  minStrength: number;
  onMinStrength: (v: number) => void;
  hubspotFilter: "all" | "not" | "in";
  onHubspotFilter: (v: "all" | "not" | "in") => void;
  reviewedFilter: "all" | "not" | "reviewed";
  onReviewedFilter: (v: "all" | "not" | "reviewed") => void;
  /** Mobile drawer: open state + close handler (desktop ignores these). */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(true);
  const favCount = Object.keys(useFavorites()).length;
  const activeFilterCount =
    (hubspotFilter !== "all" ? 1 : 0) +
    (reviewedFilter !== "all" ? 1 : 0) +
    selectedSegments.length +
    selectedSweBands.length +
    selectedSignalTypes.length +
    (minStrength > 0 ? 1 : 0);

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[55] bg-black/60 lg:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
      )}
      <aside
        className={`${
          mobileOpen ? "fixed inset-y-0 left-0 z-[60] flex w-[86vw] max-w-xs" : "hidden"
        } shrink-0 flex-col border-r border-ink-700 bg-ink-950 lg:static lg:z-auto lg:flex lg:w-64`}
      >
        <div className="flex h-full flex-col overflow-y-auto p-4 lg:sticky lg:top-[64px] lg:h-[calc(100vh-64px)]">
          {/* Mobile drawer header */}
          <div className="mb-3 flex items-center justify-between lg:hidden">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
              menu &amp; filters
            </span>
            <button
              onClick={onMobileClose}
              aria-label="Close menu"
              className="rounded-lg border border-ink-700 p-1.5 text-ink-400 transition-colors hover:text-ink-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Primary nav */}
          <nav className="flex flex-col gap-1">
            {NAV.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onTab(item.id);
                    onMobileClose?.();
                  }}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                  active
                    ? "border border-neon-600/30 bg-neon-500/10 text-neon-300"
                    : "border border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-50"
                }`}
              >
                <item.icon className="h-[17px] w-[17px]" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.id === "favorites" && favCount > 0 && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-300">
                    {favCount}
                  </span>
                )}
              </button>
            );
          })}
            <div className="my-2 border-t border-ink-800" />
            {NAV_PIPELINE.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onTab(item.id);
                    onMobileClose?.();
                  }}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                    active
                      ? "border border-neon-600/30 bg-neon-500/10 text-neon-300"
                      : "border border-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-50"
                  }`}
                >
                  <item.icon className="h-[17px] w-[17px]" />
                  <span className="flex-1 text-left">{item.label}</span>
                </button>
              );
            })}
        </nav>

        {/* Pull / pagination controls — sit above the collapsible filters */}
        {/* Desktop only — mobile shows its own always-visible copy in the feed. */}
        {pullControls && <div className="mt-3 hidden lg:block">{pullControls}</div>}

        {/* Collapsible filters */}
        <button
          onClick={() => setFiltersOpen((o) => !o)}
          className="mt-3 flex items-center justify-between rounded-lg px-1 py-1.5 text-ink-300 transition-colors hover:text-ink-50"
        >
          <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            filters
            {activeFilterCount > 0 && (
              <span className="rounded bg-neon-500/15 px-1 py-0.5 text-neon-300">
                {activeFilterCount}
              </span>
            )}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-ink-500 transition-transform ${filtersOpen ? "" : "-rotate-90"}`}
          />
        </button>

        {filtersOpen && (
          <div className="mt-2">
        <div className="mb-3 border-t border-ink-700" />

        {/* HubSpot presence — first so the most common cut (untouched accounts)
            is right at the top of the filters. */}
        <h3 className="mb-3 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          hubspot
        </h3>
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              { id: "all", label: "All" },
              { id: "not", label: "Not in" },
              { id: "in", label: "In" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              onClick={() => onHubspotFilter(opt.id)}
              className={`rounded-lg border px-2 py-1.5 font-mono text-[11px] font-medium transition-colors ${
                hubspotFilter === opt.id
                  ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                  : "border-ink-700 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="my-4 border-t border-ink-700" />

        {/* Reviewed — triage progress (a company is reviewed once its brief is
            opened, or you toggle it on the card). */}
        <h3 className="mb-3 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          reviewed
        </h3>
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              { id: "all", label: "All" },
              { id: "not", label: "Not yet" },
              { id: "reviewed", label: "Reviewed" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              onClick={() => onReviewedFilter(opt.id)}
              className={`rounded-lg border px-2 py-1.5 font-mono text-[11px] font-medium transition-colors ${
                reviewedFilter === opt.id
                  ? "border-neon-600/40 bg-neon-500/10 text-neon-300"
                  : "border-ink-700 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="my-4 border-t border-ink-700" />

        {/* Segments — multi-select */}
        <FilterHeading
          label="segments"
          activeCount={selectedSegments.length}
          optionCount={SEGMENTS.length}
          onSelectAll={() => onSetSegments(SEGMENTS.map((s) => s.id))}
          onClear={() => onSetSegments([])}
        />
        <div className="flex flex-col gap-0.5">
          {SEGMENTS.map((seg) => {
            const checked = selectedSegments.includes(seg.id);
            return (
              <button
                key={seg.id}
                onClick={() => onToggleSegment(seg.id)}
                title={seg.blurb}
                className={`group flex items-center justify-between rounded-lg px-2 py-2 transition-colors ${
                  checked ? "bg-ink-800" : "hover:bg-ink-800/60"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <CheckBox checked={checked} />
                  <SegmentIcon
                    name={seg.icon}
                    className={`h-4 w-4 ${
                      checked ? "text-neon-400" : "text-ink-400 group-hover:text-ink-300"
                    }`}
                  />
                  <span
                    className={`text-left text-sm ${checked ? "text-ink-50" : "text-ink-300"}`}
                  >
                    {seg.label}
                  </span>
                </span>
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-400 group-hover:bg-ink-900">
                  {segmentCounts[seg.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="my-4 border-t border-ink-700" />

        {/* Engineering team size — multi-select */}
        <FilterHeading
          label="eng team size"
          activeCount={selectedSweBands.length}
          optionCount={SWE_BANDS.length}
          onSelectAll={() => onSetSweBands(SWE_BANDS.map((b) => b.id))}
          onClear={() => onSetSweBands([])}
        />
        <div className="flex flex-col gap-0.5">
          {SWE_BANDS.map((band) => {
            const checked = selectedSweBands.includes(band.id);
            return (
              <button
                key={band.id}
                onClick={() => onToggleSweBand(band.id)}
                className={`group flex items-center justify-between rounded-lg px-2 py-2 transition-colors ${
                  checked ? "bg-ink-800" : "hover:bg-ink-800/60"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <CheckBox checked={checked} />
                  <span
                    className={`font-mono text-sm tabular-nums ${
                      checked ? "text-ink-50" : "text-ink-300"
                    }`}
                  >
                    {band.label} eng
                  </span>
                </span>
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-400 group-hover:bg-ink-900">
                  {sweBandCounts[band.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        {selectedSweBands.length > 0 && unknownSweCount > 0 && (
          <p className="mt-2 px-1 font-mono text-[10px] leading-relaxed text-ink-500">
            {unknownSweCount} signal{unknownSweCount === 1 ? "" : "s"} have no size
            estimate — shown regardless (can&apos;t confirm they&apos;re out of band)
          </p>
        )}

        <div className="my-4 border-t border-ink-700" />

        {/* Signal types — multi-select */}
        <FilterHeading
          label="signal types"
          activeCount={selectedSignalTypes.length}
          optionCount={SIGNAL_TYPES.length}
          onSelectAll={() => onSetSignalTypes(SIGNAL_TYPES.map((t) => t.id))}
          onClear={() => onSetSignalTypes([])}
        />
        <div className="flex flex-col gap-0.5">
          {SIGNAL_TYPES.map((st) => {
            const checked = selectedSignalTypes.includes(st.id);
            return (
              <button
                key={st.id}
                onClick={() => onToggleSignalType(st.id)}
                title={st.description}
                className={`group flex items-center justify-between rounded-lg px-2 py-2 transition-colors ${
                  checked ? "bg-ink-800" : "hover:bg-ink-800/60"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <CheckBox checked={checked} />
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: st.color }}
                  />
                  <span className={`text-left text-sm ${checked ? "text-ink-50" : "text-ink-300"}`}>
                    {st.label}
                  </span>
                </span>
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-400 group-hover:bg-ink-900">
                  {signalCounts[st.id] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div className="my-4 border-t border-ink-700" />

        {/* Min ICP fit */}
        <h3 className="mb-3 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          min icp fit: <span className="text-neon-400">{minStrength}</span>
        </h3>
        <input
          type="range"
          min={0}
          max={100}
          value={minStrength}
          onChange={(e) => onMinStrength(Number(e.target.value))}
          className="w-full"
        />
        <div className="mt-1.5 flex justify-between px-0.5 font-mono text-[10px] text-ink-500">
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>

          </div>
        )}

        <ResetProspected />

        <div className="mt-auto pt-6 text-center">
          <HubSpotConnectChip />
          <LogoutButton />
          <p className="mt-3 font-mono text-[10px] text-ink-500">built for SingleStore</p>
        </div>
        </div>
      </aside>
    </>
  );
}
