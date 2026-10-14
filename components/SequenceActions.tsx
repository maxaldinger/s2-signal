"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Send, X, CircleCheck, CircleX, TriangleAlert, ArrowUpRight } from "lucide-react";
import type { ProspectInput, Precheck } from "@/lib/sequencer/enroll";

// "Add to sequence" — the contact-card entry point to the email sequencer.
//
// The button opens a picker that immediately runs the enrollment DRY RUN, so
// what you see is produced by the same code that enforces it a moment later:
//   block → red, no enroll button at all
//   warn  → amber, enroll requires a second deliberate click
//   allow → plain enroll
// Blocks are not overridable from here on purpose. A live thread with this
// person is exactly the case where a confident rep does the wrong thing.

interface SequenceRow {
  id: string;
  name: string;
  stepCount: number;
  emailSteps: number;
}

export function SequenceActions({
  prospect,
  compact = false,
}: {
  prospect: ProspectInput;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [enrolled, setEnrolled] = useState(false);

  const btn = compact
    ? "inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-300 transition-colors disabled:opacity-50"
    : "inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs font-medium text-ink-300 transition-colors disabled:opacity-50";

  // No email, no email sequence. Say why rather than rendering a dead button.
  if (!prospect.email) {
    return (
      <span
        className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-600"
        title="An email sequence needs an address. LinkedIn-only sequencing lands in Phase 2."
      >
        no email — can&apos;t sequence
      </span>
    );
  }

  if (enrolled) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 font-mono text-[11px] font-semibold text-sky-300">
        <CircleCheck className="h-3 w-3" /> In sequence
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Add this contact to an email sequence"
        className={`${btn} hover:border-sky-500/40 hover:text-sky-300`}
      >
        <Send className="h-3 w-3" /> Add to sequence
      </button>
      {open && (
        <SequenceModal
          prospect={prospect}
          onClose={() => setOpen(false)}
          onEnrolled={() => {
            setEnrolled(true);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function SequenceModal({
  prospect,
  onClose,
  onEnrolled,
}: {
  prospect: ProspectInput;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [sequences, setSequences] = useState<SequenceRow[] | null>(null);
  const [sequenceId, setSequenceId] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [pre, setPre] = useState<Precheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the picker list once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sequencer/sequences", { cache: "no-store" });
        const d = (await res.json()) as { ok?: boolean; sequences?: SequenceRow[]; error?: string };
        if (cancelled) return;
        if (!d.ok || !d.sequences) {
          setError(d.error ?? "Couldn't load sequences");
          setSequences([]);
          return;
        }
        setSequences(d.sequences);
        if (d.sequences.length > 0) setSequenceId(d.sequences[0].id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-run the dry run whenever the chosen sequence changes. This is the same
  // call the real enrollment makes, minus the write.
  useEffect(() => {
    if (!sequenceId) return;
    let cancelled = false;
    setChecking(true);
    setPre(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/api/sequencer/enroll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prospect, sequenceId, dryRun: true }),
        });
        const d = (await res.json()) as { ok?: boolean; precheck?: Precheck; error?: string };
        if (cancelled) return;
        if (!d.ok || !d.precheck) setError(d.error ?? "Check failed");
        else setPre(d.precheck);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceId]);

  const submit = async () => {
    if (saving || !sequenceId || !pre || pre.verdict === "block") return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/sequencer/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prospect,
          sequenceId,
          // Only ever true when the user is looking at the warning.
          acknowledgeWarning: pre.verdict === "warn",
        }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string; precheck?: Precheck };
      if (!d.ok) {
        setError(d.error ?? "Enrollment failed");
        if (d.precheck) setPre(d.precheck);
        return;
      }
      onEnrolled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const chosen = sequences?.find((s) => s.id === sequenceId);
  const who = [prospect.firstName, prospect.lastName].filter(Boolean).join(" ") || prospect.name || prospect.email;

  const overlay = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-6 py-4">
          <h3 className="flex min-w-0 items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
            <Send className="h-4 w-4 shrink-0 text-sky-400" />
            <span className="truncate">Add to sequence · {who}</span>
          </h3>
          <button onClick={onClose} className="shrink-0 text-ink-400 hover:text-ink-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">sequence</span>
            {sequences === null ? (
              <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-500">
                <Loader2 className="h-3 w-3 animate-spin" /> loading…
              </p>
            ) : sequences.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-amber-400/90">
                No active sequences yet.
              </p>
            ) : (
              <select
                value={sequenceId}
                onChange={(e) => setSequenceId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 focus:border-sky-500/40 focus:outline-none"
              >
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.emailSteps} email step{s.emailSteps === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            )}
          </label>

          {/* A sequence whose steps have no body cannot send anything yet. */}
          {chosen && chosen.emailSteps === 0 && (
            <p className="font-mono text-[11px] text-amber-400/90">
              This sequence has no email steps — enrolling will do nothing until steps are added.
            </p>
          )}

          {checking ? (
            <p className="flex items-center gap-1.5 font-mono text-[11px] text-ink-500">
              <Loader2 className="h-3 w-3 animate-spin" /> checking blacklist, prior enrollments and HubSpot…
            </p>
          ) : pre ? (
            <VerdictPanel pre={pre} />
          ) : null}

          {error && <p className="font-mono text-[11px] text-red-400">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-ink-700 px-4 py-2 text-xs font-medium text-ink-400 hover:text-ink-100"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || checking || !pre || pre.verdict === "block"}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
              pre?.verdict === "warn"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                : "border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
            }`}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {pre?.verdict === "warn" ? "Enroll anyway" : "Enroll"}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(overlay, document.body) : null;
}

function VerdictPanel({ pre }: { pre: Precheck }) {
  if (pre.verdict === "block") {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs font-semibold leading-snug text-red-300">
          <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{pre.reason ?? "Blocked"}</span>
        </p>
        {pre.hubspot?.contactUrl && (
          <a
            href={pre.hubspot.contactUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] text-red-200/80 hover:text-red-100"
          >
            Open the HubSpot record <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  if (pre.verdict === "warn") {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs font-semibold leading-snug text-amber-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{pre.reason ?? "Open opportunity at this account"}</span>
        </p>
        <p className="mt-1 text-[11px] leading-snug text-amber-200/70">
          Multi-threading an open account is fine — this is here so it&apos;s a decision, not an accident.
        </p>
        {pre.hubspot?.openDeals && pre.hubspot.openDeals.length > 1 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] text-amber-200/70">
            {pre.hubspot.openDeals.slice(1).map((d, i) => (
              <li key={i}>
                {d.name} · {d.stage}
                {d.owner ? ` · ${d.owner}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <p className="flex items-center gap-1.5 font-mono text-[11px] text-neon-300">
      <CircleCheck className="h-3.5 w-3.5" /> Clear to enroll — no live thread, no open opp, not blacklisted.
    </p>
  );
}
