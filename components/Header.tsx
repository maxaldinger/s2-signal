"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Activity, Sun, Moon, Menu } from "lucide-react";
import { REGIONS, type RegionId } from "@/lib/data";

// US / India intel scope — switching reloads the feed for that region.
function RegionToggle({
  region,
  onRegion,
}: {
  region: RegionId;
  onRegion: (r: RegionId) => void;
}) {
  return (
    <div
      className="flex overflow-hidden rounded-lg border border-ink-700"
      role="group"
      aria-label="Intel region"
    >
      {REGIONS.map((r) => {
        const active = region === r.id;
        return (
          <button
            key={r.id}
            onClick={() => onRegion(r.id)}
            title={r.blurb}
            className={`px-2.5 py-2 font-mono text-[11px] font-semibold uppercase transition-colors ${
              active
                ? "bg-neon-500/15 text-neon-300"
                : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function ThemeToggle() {
  // null until mounted — the server doesn't know the stored preference.
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    setTheme(
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    );
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("s2-theme", next);
    } catch {
      /* private mode — toggle still works for the session */
    }
    setTheme(next);
  };

  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-2 font-mono text-[11px] font-medium text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-300"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="hidden sm:inline">{isDark ? "light" : "dark"}</span>
    </button>
  );
}

export function Header({
  onRefresh,
  refreshing,
  lastUpdated,
  region,
  onRegion,
  onMenu,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  lastUpdated: string;
  region: RegionId;
  onRegion: (r: RegionId) => void;
  /** Opens the mobile nav/filters drawer (hidden on desktop). */
  onMenu?: () => void;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-ink-700 bg-ink-950/85 backdrop-blur-xl">
      <div className="flex h-[64px] items-center gap-3 px-4 sm:gap-4 sm:px-6">
        {/* Mobile menu */}
        <button
          onClick={onMenu}
          aria-label="Open menu and filters"
          className="rounded-lg border border-ink-700 p-2 text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-300 lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-neon-600/50 bg-ink-900 shadow-glow-sm">
            <Activity className="h-5 w-5 text-neon-400" />
          </div>
          <div className="leading-tight">
            <h1 className="cursor font-mono text-[16px] font-bold tracking-tight text-ink-50">
              s2<span className="text-neon-400">signal</span>
            </h1>
            <p className="font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-ink-400">
              singlestore account intelligence
            </p>
          </div>
        </div>

        {/* Right controls */}
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-1.5 font-mono text-[11px] text-ink-400 sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-neon-400" />
            live · {lastUpdated}
          </div>
          <RegionToggle region={region} onRegion={onRegion} />
          <ThemeToggle />
          <button
            onClick={onRefresh}
            aria-label="Refresh signals"
            className="rounded-lg border border-ink-700 p-2 text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-300"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>
    </header>
  );
}
