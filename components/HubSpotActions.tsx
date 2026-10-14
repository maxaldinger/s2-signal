"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  CalendarPlus,
  Loader2,
  Check,
  CircleCheck,
  CircleX,
  ArrowUpRight,
  FileText,
  RefreshCw,
  X,
} from "lucide-react";
import {
  markProspected,
  setHubspotPresence,
  getLastDueDate,
  setLastDueDate,
} from "@/lib/clientStore";
import type { ProposalResearch } from "@/lib/proposalGen";

type HsKind = "company" | "contact";
type HsTaskType = "CALL" | "EMAIL" | "TODO";

interface HsRecord {
  id: string;
  name?: string;
  detail?: string;
  url?: string;
}
interface SearchResp {
  ok: boolean;
  error?: string;
  found: boolean;
  records: HsRecord[];
  /** Present when full-text hits were discarded as name mismatches. */
  note?: string;
  /** STAGE 7: "exact" = matched on email/domain (confirmed). "name" = full-text
   *  name hit, a CANDIDATE only. "none" = no match. */
  matchedBy?: "exact" | "name" | "none";
}
interface TaskResp {
  ok: boolean;
  error?: string;
  taskId?: string;
  taskUrl?: string;
  noteId?: string;
  noteError?: string;
  linkedTo?: HsRecord & { kind: HsKind; created: boolean };
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Serialize all HubSpot "Check" calls with a min gap so a busy feed (dozens of
// card + contact auto-checks) stays under HubSpot's ~4 req/s search limit and
// stops tripping 429s.
let hsSearchChain: Promise<unknown> = Promise.resolve();
let hsSearchLast = 0;
function throttledSearch(url: string): Promise<Response> {
  const run = async () => {
    const gap = 320 - (Date.now() - hsSearchLast);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    hsSearchLast = Date.now();
    return fetch(url);
  };
  const p = hsSearchChain.then(run, run);
  hsSearchChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p as Promise<Response>;
}

export function HubSpotActions({
  kind,
  name,
  domain,
  email,
  phone,
  jobtitle,
  apolloId,
  companyName,
  companyDomain,
  companyKey,
  companyAliases,
  defaultSubject,
  defaultBody,
  compact = false,
  autoCheck = false,
  autoCheckDelayMs = 0,
  proposal,
}: {
  kind: HsKind;
  name: string;
  domain?: string;
  email?: string;
  /** Contact extras pushed into the HubSpot record on task create. */
  phone?: string;
  jobtitle?: string;
  /** Apollo person id — lets the server reveal a missing email/phone. */
  apolloId?: string;
  /** Parent company for a contact (so the contact + task link to it). */
  companyName?: string;
  companyDomain?: string;
  /** The FEED's name for this account, used only as the client-store key for
   *  prospected marks and HubSpot presence. Never sent to HubSpot.
   *
   *  A brief renames the account to whatever the research turned up ("Elevance
   *  Health (formerly Anthem, Inc.)") while the card that opened it is still
   *  called "Anthem". Keying the mark off the brief's name wrote it somewhere
   *  the feed card could never read, so pushing a contact left the card grey. */
  companyKey?: string;
  /** EVERY name this account is known by. One company reaches this component
   *  under several spellings: the feed row ("Tesla Motors"), the brief's
   *  researched name ("Tesla, Inc."), and in the Signal 2000 a SECOND row for
   *  the same business ("Tesla Inc.", key "tesla"). Marking one spelling leaves
   *  the others grey, which is exactly what "some records don't go orange"
   *  looks like from the feed. The mark is written under all of them. */
  companyAliases?: string[];
  defaultSubject: string;
  defaultBody: string;
  /** Smaller styling for use inside a contact card. */
  compact?: boolean;
  /** Run the HubSpot lookup automatically when the component populates. */
  autoCheck?: boolean;
  /** Stagger auto-checks to stay under HubSpot's ~4 req/s search limit. */
  autoCheckDelayMs?: number;
  /** Company surfaces only: enables the "Personalize proposal" button, which
   *  generates a tailored SingleStore proposal page at a public /p/<token> link.
   *  Pass whatever account context the surface has — the generator degrades
   *  gracefully, never invents. */
  proposal?: {
    context?: string;
    sweEstimate?: number;
    /** True when the engineer count is the rep's confirmed-on-a-call override. */
    sweConfirmed?: boolean;
    /** Call-confirmed monthly spend on the data systems SingleStore could
     *  consolidate, in $K/month — replaces the proposal ROI's modeled
     *  per-engineer default. */
    spendMo?: number;
    employees?: number;
    icpTotal?: number;
    contactName?: string;
    contactTitle?: string;
    /** Structured research for the generator — the brief fills most of it,
     *  a feed card fills two or three fields. Ordered by positioning mode
     *  server-side. */
    research?: ProposalResearch;
  };
}) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SearchResp | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Personalized proposal link generation (company surfaces). Proposals are
  // CACHED per account: the first click either generates or returns the
  // existing link; "Update" regenerates with the latest facts at the SAME
  // link (a copy already emailed out starts showing the new content).
  const [propBusy, setPropBusy] = useState(false);
  const [propUrl, setPropUrl] = useState<string | null>(null);
  const [propInfo, setPropInfo] = useState<"" | "cached" | "updated">("");
  const [propAt, setPropAt] = useState<string | null>(null);
  const [propCopied, setPropCopied] = useState(false);
  const [propErr, setPropErr] = useState<string | null>(null);
  // Every generation produces BOTH narratives (Operational and ROI) as tabs
  // on the one page. `propDual` is false only for a cached link generated
  // before the tabs existed — Update brings it up to both.
  const [propDual, setPropDual] = useState<boolean | null>(null);
  const makeProposal = async (force = false) => {
    if (propBusy) return;
    setPropBusy(true);
    setPropErr(null);
    // Open the tab NOW, inside the click's user activation — a window.open
    // after the ~15s generation await would be popup-blocked. The tab shows a
    // holding screen and navigates itself to the proposal when it's ready.
    const tab = window.open("", "_blank");
    if (tab) {
      // The non-force copy stays outcome-neutral: the server may serve the
      // CACHED proposal instantly, and a screen claiming to be "writing the
      // summary" over a weeks-old doc would misrepresent what happened.
      tab.document.write(
        `<title>${force ? "Updating" : "Opening"} proposal…</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#46556a"><div style="text-align:center"><p style="font-size:17px;font-weight:700;color:#1a2230;margin:0 0 6px">${force ? "Updating" : "Opening"} the proposal for ${name.replace(/</g, "&lt;")}…</p><p style="font-size:13px;margin:0">${force ? "Writing both narratives (Operational and ROI) and re-running the numbers — this tab loads it in ~20 seconds." : "An existing proposal loads in a moment (Update folds in the latest numbers); writing a new one takes ~20 seconds."}</p></div></body>`,
      );
      tab.document.close();
    }
    try {
      const res = await fetch("/api/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: name,
          companyKey: companyKey || name,
          domain,
          context: proposal?.context,
          sweEstimate: proposal?.sweEstimate,
          sweConfirmed: proposal?.sweConfirmed,
          spendMo: proposal?.spendMo,
          employees: proposal?.employees,
          icpTotal: proposal?.icpTotal,
          contactName: proposal?.contactName,
          contactTitle: proposal?.contactTitle,
          research: proposal?.research,
          force,
        }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        url?: string;
        error?: string;
        cached?: boolean;
        updated?: boolean;
        generatedAt?: string;
        dual?: boolean;
      };
      if (!res.ok || !d.ok || !d.url) {
        tab?.close();
        setPropErr(d.error || `Proposal generation failed (${res.status})`);
        return;
      }
      setPropUrl(d.url);
      setPropInfo(d.cached ? "cached" : d.updated ? "updated" : "");
      setPropAt(d.generatedAt ?? null);
      setPropDual(d.dual ?? true);
      if (tab) tab.location.href = d.url;
      try {
        // Best effort: if the new tab stole focus, some browsers refuse the
        // write ("document is not focused") — the chip still holds the link.
        await navigator.clipboard.writeText(d.url);
        setPropCopied(true);
      } catch {
        /* clipboard blocked — the link chip still shows */
      }
    } catch (e) {
      tab?.close();
      setPropErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPropBusy(false);
    }
  };

  // The matched record id (if any) is reused when creating the task.
  const matchedId = check?.found ? check.records[0]?.id : undefined;

  // Block pulling a contact whose email domain doesn't match its company —
  // Apollo sometimes returns a personal/old email and HubSpot would link the
  // contact to the wrong account.
  const rootOf = (d: string) => {
    const parts = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
    return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
  };
  const emailDomain = email ? email.split("@")[1] ?? "" : "";
  const domainMismatch =
    kind === "contact" &&
    !!emailDomain &&
    !!companyDomain &&
    rootOf(emailDomain) !== rootOf(companyDomain);
  // No company email surfaced — still pushable, but as a LinkedIn-connect task
  // (create the contact by name, log a to-do to connect on LinkedIn). Only an
  // OFF-DOMAIN email is blocked (it would mis-associate the contact). The card
  // passes only a company-domain email, so an empty `email` here means none.
  const noCompanyEmail = kind === "contact" && !email;
  const blockContact = domainMismatch; // off-domain only; missing email is allowed

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    setCheck(null);
    try {
      const params = new URLSearchParams({ kind, name });
      if (domain) params.set("domain", domain);
      if (email) params.set("email", email);
      const res = await throttledSearch(`/api/hubspot/search?${params.toString()}`);
      let data: SearchResp;
      try {
        data = (await res.json()) as SearchResp;
      } catch {
        data = { ok: false, found: false, records: [], error: `HTTP ${res.status}` };
      }
      setCheck(data);
      // Share the live company result so the feed can sort by HubSpot presence.
      // NOTE: a check finding the record in HubSpot drives the green "In HubSpot"
      // line + presence sort — NOT the orange "Prospected" badge, which is
      // reserved for records THIS app created a task for. (Records can exist in
      // HubSpot from other reps/imports; those aren't "prospected by me".)
      if (kind === "company" && data.ok) setHubspotPresence(companyKey || name, data.found);
    } catch (e) {
      setCheck({ ok: false, found: false, records: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  // Auto-check on populate. Staggered (autoCheckDelayMs) so a deep dive's dozen
  // contact cards don't fire at once and trip HubSpot's ~4 req/s search limit.
  // Re-runs when the name/email sharpens (e.g. after an Apollo reveal).
  useEffect(() => {
    if (!autoCheck || (!name && !domain && !email)) return;
    const t = setTimeout(() => void runCheck(), autoCheckDelayMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, autoCheckDelayMs, kind, name, domain, email]);

  const btn = compact
    ? "inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-300 transition-colors disabled:opacity-50"
    : "inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs font-medium text-ink-300 transition-colors disabled:opacity-50";

  return (
    <>
      {/* STAGE 7 — EXACTLY ONE HubSpot state per card. The old row showed a
          confirmed "In HubSpot" badge NEXT TO a "Check in HubSpot" button and a
          "Not in HubSpot yet" line, which is three contradictory claims at once.
          Now the state decides which single control is offered:
            exact match → the record, linked. Nothing to check, nothing to create.
            name match  → "Possible match" + Confirm. Never a green badge; this
                          is the Rich Sauser -> Sarah Rich collision.
            no match    → "Not in HubSpot" + Create. */}
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        {checking ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-500">
            <Loader2 className="h-3 w-3 animate-spin" /> checking HubSpot…
          </span>
        ) : check?.error ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
            <span className="break-words text-amber-400/90">{check.error}</span>
            <button type="button" onClick={runCheck} className={`${btn} hover:border-orange-500/40`}>
              <Search className="h-3 w-3" /> Retry
            </button>
          </span>
        ) : check?.found && check.matchedBy === "exact" ? (
          <a
            href={check.records[0]?.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-neon-300 hover:text-neon-200"
          >
            <CircleCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              In HubSpot: {check.records[0]?.name || check.records[0]?.detail || "record"}
            </span>
            <ArrowUpRight className="h-3 w-3 shrink-0" />
          </a>
        ) : check?.found && check.matchedBy === "name" ? (
          <>
            <a
              href={check.records[0]?.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Matched on NAME only. HubSpot OR-matches tokens across properties, so this may be a different person."
              className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-amber-300 hover:text-amber-200"
            >
              <CircleX className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                Possible match: {check.records[0]?.name || check.records[0]?.detail || "record"}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </a>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={blockContact}
              title="Confirm this is the same person and attach the task to that record"
              className={`${btn} hover:border-orange-500/40 hover:text-orange-300`}
            >
              <CalendarPlus className="h-3 w-3" /> Confirm &amp; add task
            </button>
          </>
        ) : check ? (
          <>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-400">
              <CircleX className="h-3.5 w-3.5" /> Not in HubSpot
              {check.note && <span className="text-ink-500"> (no name match)</span>}
            </span>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              disabled={blockContact}
              title={
                domainMismatch
                  ? `${email} isn't on the company domain — pushing would mis-associate this contact`
                  : `Create this ${kind} in HubSpot with a task`
              }
              className={`${btn} hover:border-orange-500/40 hover:text-orange-300`}
            >
              <CalendarPlus className="h-3 w-3" /> Create HubSpot task
            </button>
          </>
        ) : (
          // Never checked (auto-check off). One control, and it does the check.
          <button
            type="button"
            onClick={runCheck}
            className={`${btn} hover:border-orange-500/40 hover:text-orange-300`}
          >
            <Search className="h-3 w-3" /> Check in HubSpot
          </button>
        )}

        {domainMismatch && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-amber-400/90">
            email domain ≠ company
          </span>
        )}
      </div>

      {/* Personalized proposal — company surfaces only. Its OWN row, on
          purpose: the HubSpot status above changes width when the auto-check
          resolves ("checking HubSpot…" → "In HubSpot: <name> ↗"), and while
          these controls shared that row the shift slid the HubSpot link under
          a cursor aimed at these buttons (Max, Sep 21). Every generation
          produces both narratives; the page's Operational | ROI tabs switch. */}
      {kind === "company" && proposal && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {propUrl ? (
            <>
              <a
                href={propUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={
                  propInfo === "cached"
                    ? `Existing proposal${propAt ? ` from ${new Date(propAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""} — link copied. Update regenerates it with the latest info at the same link.`
                    : propCopied
                      ? "Link copied to clipboard — click to preview"
                      : "Click to preview the proposal"
                }
                className="inline-flex items-center gap-1 rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 font-mono text-[11px] font-semibold text-violet-300 transition-colors hover:bg-violet-500/20"
              >
                <FileText className="h-3 w-3" /> Proposal
                {propInfo === "cached" && propAt
                  ? ` · ${new Date(propAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                  : propInfo === "updated"
                    ? " · updated"
                    : propCopied
                      ? " · link copied"
                      : ""}
                <ArrowUpRight className="h-3 w-3" />
              </a>
              {/* A link from before the tabs existed carries one narrative;
                  say so, since Update is what brings it up to both. */}
              {propDual === false && (
                <span
                  className="font-mono text-[10px] text-amber-300/90"
                  title="This proposal was generated before the Operational | ROI tabs — Update regenerates it with both"
                >
                  single narrative
                </span>
              )}
              <button
                type="button"
                onClick={() => void makeProposal(true)}
                disabled={propBusy}
                title="Regenerate this proposal with the latest account info — both narratives, same link"
                className={`${btn} hover:border-violet-500/40 hover:text-violet-300`}
              >
                {propBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {propBusy ? "Updating…" : "Update"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void makeProposal()}
              disabled={propBusy}
              title="Generate a SingleStore proposal personalized to this account — Operational and ROI narratives as tabs on one shareable link, with Download PDF on the page. Repeat clicks reuse the same link."
              className={`${btn} hover:border-violet-500/40 hover:text-violet-300`}
            >
              {propBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
              {propBusy ? "Personalizing…" : "Personalize proposal"}
            </button>
          )}
          {propErr && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-red-400">{propErr}</span>
          )}
        </div>
      )}

      {modalOpen && (
        <TaskModal
          kind={kind}
          name={name}
          domain={domain}
          email={email}
          phone={phone}
          jobtitle={jobtitle}
          apolloId={apolloId}
          companyName={companyName}
          companyDomain={companyDomain}
          companyKey={companyKey}
          companyAliases={companyAliases}
          objectId={matchedId}
          defaultSubject={defaultSubject}
          defaultBody={defaultBody}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function TaskModal({
  kind,
  name,
  domain,
  email,
  phone,
  jobtitle,
  apolloId,
  companyName,
  companyDomain,
  companyKey,
  companyAliases,
  objectId,
  defaultSubject,
  defaultBody,
  onClose,
}: {
  kind: HsKind;
  name: string;
  domain?: string;
  email?: string;
  phone?: string;
  jobtitle?: string;
  apolloId?: string;
  companyName?: string;
  companyDomain?: string;
  companyKey?: string;
  companyAliases?: string[];
  objectId?: string;
  defaultSubject: string;
  defaultBody: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  // Earliest allowed due date is tomorrow (never same-day). Default to the last
  // date the rep picked (sticky across contacts), clamped to that floor.
  const minDue = tomorrowISO();
  const [due, setDue] = useState(() => {
    const last = getLastDueDate();
    return last && last >= minDue ? last : minDue;
  });
  // No email → it's a LinkedIn-connect to-do, not a call.
  const [taskType, setTaskType] = useState<HsTaskType>(kind === "contact" && !email ? "TODO" : "CALL");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TaskResp | null>(null);

  const submit = async () => {
    if (saving) return;
    // Never schedule same-day or in the past — floor at tomorrow.
    const dueDate = due >= minDue ? due : minDue;
    setLastDueDate(dueDate);
    // Schedule at local noon so the date lands as picked regardless of timezone.
    const dueDateMs = new Date(`${dueDate}T12:00:00`).getTime();
    if (!subject.trim() || !Number.isFinite(dueDateMs)) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/hubspot/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name,
          domain,
          email,
          phone,
          jobtitle,
          apolloId,
          companyName,
          companyDomain,
          objectId,
          subject,
          body,
          dueDateMs,
          taskType,
        }),
      });
      let data: TaskResp;
      try {
        data = (await res.json()) as TaskResp;
      } catch {
        data = { ok: false, error: `HTTP ${res.status}` };
      }
      setResult(data);
      // Mark prospected so the company/contact is badged across the UI. A
      // contact task also prospects its parent company.
      //
      // The company mark uses companyKey (the FEED's name for the account) when
      // the caller supplies one. `name`/`companyName` are the brief's names,
      // which the feed card cannot look itself up by.
      if (data.ok) {
        const acct = companyKey || (kind === "contact" ? companyName : name);
        markProspected(kind, kind === "contact" ? apolloId || name : acct || name);
        // Mark the company under every spelling we know, not just the one this
        // card happened to be opened under.
        const aliases = [acct, companyKey, kind === "contact" ? companyName : name, ...(companyAliases ?? [])];
        for (const a of aliases) if (a && a.trim()) markProspected("company", a);
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // Render through a portal to <body>: the modal lives inside the animated
  // (transformed) deep-dive section, which would otherwise be the containing
  // block for `fixed` — pinning the overlay to that section instead of the
  // viewport. The portal escapes it so it overlays the whole screen.
  const overlay = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-6 py-4">
          <h3 className="flex min-w-0 items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
            <CalendarPlus className="h-4 w-4 shrink-0 text-orange-400" />
            <span className="truncate">HubSpot task · {name}</span>
          </h3>
          <button onClick={onClose} className="shrink-0 text-ink-400 hover:text-ink-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body (scrolls if tall) */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {result?.ok ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm text-neon-300">
                <CircleCheck className="h-4 w-4 shrink-0" /> {result.noteId ? "Task + note created" : "Task created"}
                {result.linkedTo?.created
                  ? ` — new ${result.linkedTo.kind} added to HubSpot`
                  : result.linkedTo
                    ? ` — linked to existing ${result.linkedTo.kind}`
                    : ""}
              </p>
              {result.taskUrl && (
                <a
                  href={result.taskUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-neon-400 hover:text-neon-300"
                >
                  Open task in HubSpot <ArrowUpRight className="h-3 w-3" />
                </a>
              )}
              {result.noteError && (
                <p className="text-xs text-amber-400/90">
                  Note not logged ({result.noteError}) — the task still landed.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">subject</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 focus:border-orange-500/40 focus:outline-none"
                />
              </label>
              <div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">context / notes</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={12}
                  className="mt-1 max-h-[45vh] min-h-[10rem] w-full resize-y rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm leading-relaxed text-ink-200 focus:border-orange-500/40 focus:outline-none"
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="block">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">due date</span>
                  <input
                    type="date"
                    value={due}
                    min={minDue}
                    onChange={(e) => {
                      const v = e.target.value && e.target.value >= minDue ? e.target.value : minDue;
                      setDue(v);
                      setLastDueDate(v);
                    }}
                    className="mt-1 block rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 focus:border-orange-500/40 focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">type</span>
                  <select
                    value={taskType}
                    onChange={(e) => setTaskType(e.target.value as HsTaskType)}
                    className="mt-1 block rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 focus:border-orange-500/40 focus:outline-none"
                  >
                    <option value="CALL">Call</option>
                    <option value="TODO">To-do</option>
                    <option value="EMAIL">Email</option>
                  </select>
                </label>
              </div>

              {result?.error && <p className="text-xs text-amber-400/90">{result.error}</p>}
            </div>
          )}
        </div>

        {/* Footer (always visible) */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-800 px-6 py-4">
          {result?.ok ? (
            <button
              onClick={onClose}
              className="rounded-lg border border-ink-700 px-4 py-2 text-xs font-medium text-ink-300 hover:text-ink-100"
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-ink-700 px-4 py-2 text-xs font-medium text-ink-400 hover:text-ink-100"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={saving || !subject.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-2 text-xs font-semibold text-orange-300 transition-colors hover:bg-orange-500/20 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Create HubSpot task
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(overlay, document.body) : null;
}
