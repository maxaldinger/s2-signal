"use client";

import type { LucideIcon } from "lucide-react";

export function MetricCard({
  label,
  value,
  icon: Icon,
  color,
  loading,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color: string; // tailwind text color class
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">
          {label}
        </span>
        <Icon className={`h-4 w-4 ${color}`} />
      </div>
      {loading ? (
        <div className="skeleton mt-3 h-8 w-16 rounded" />
      ) : (
        <div className={`mt-2 font-mono text-3xl font-bold tabular-nums ${color}`}>
          {value}
        </div>
      )}
    </div>
  );
}
