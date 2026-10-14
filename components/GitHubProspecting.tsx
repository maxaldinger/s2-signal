"use client";

// GitHub Prospecting — engineers at target-sized companies engaging with the
// repos SingleStore buyers touch (SingleStore's own, distributed OLTP,
// streaming, vector, real-time OLAP, RAG frameworks, pipelines). A signal
// source alongside the news and Apollo signals: each card is a PERSON
// (not a company), with their resolved employer, verified work email + title
// from Apollo, and a suggested "WHAT I SAW" opener. Contribution signals
// (merged PRs, commits) always rank above passive stars.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookMarked,
  Building2,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  Github,
  Loader2,
  MailCheck,
  MapPin,
  RefreshCw,
  Search,
  Star,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  ACTION_LABELS,
  CONTRIBUTION_ACTIONS,
  type GitHubAction,
  type MonitoredRepo,
  type Prospect,
  type SyncSummary,
} from "@/lib/githubProspect/types";
import { fmtNum, timeAgo } from "@/lib/format";
import { MetricCard } from "./MetricCard";
import { HubSpotActions } from "./HubSpotActions";

const PAGE_SIZE = 25;

// Chip color: violet for the OSS/contribution family (matches the existing
// "oss" signal-type color), neutral ink for passive engagement.
const OSS_COLOR = "#8b5cf6";

const ACTION_ICON: Record<GitHubAction, LucideIcon> = {
  pr_merged: GitPullRequest,
  pr_opened: GitPullRequest,
  committed: GitCommitHorizontal,
  forked: GitFork,
  starred: Star,
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return { error: `HTTP ${res.status} — ${res.statusText || "non-JSON response"}` };
  }
}

function repoShortName(repoKey: string): string {
  return repoKey.split("/")[1] ?? repoKey;
}

function isContribution(action?: GitHubAction): boolean {
  return !!action && (CONTRIBUTION_ACTIONS as string[]).includes(action);
}

// Prev / page / Next — mirrors the feed's simple pager.
function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3">
      <button
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="inline-flex items-center gap-1 rounded border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Prev
      </button>
      <span className="font-mono text-xs tabular-nums text-ink-400">
        pg {page} / {totalPages}
      </span>
      <button
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="inline-flex items-center gap-1 rounded border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="inline-flex items-center gap-1 rounded border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-200"
    >
      {copied ? <Check className="h-3 w-3 text-neon-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

function StatusChip({ p }: { p: Prospect }) {
  if (p.status === "enriched")
    return (
      <span className="rounded border border-neon-600/30 bg-neon-500/10 px-1.5 py-0.5 font-mono text-[11px] text-neon-300">
        ready
      </span>
    );
  if (p.status === "suppressed")
    return (
      <span
        title={p.suppressedReason}
        className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-300"
      >
        suppressed
      </span>
    );
  if (p.status === "no_match")
    return (
      <span
        title={p.suppressedReason}
        className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-ink-500"
      >
        no match
      </span>
    );
  return (
    <span className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-ink-400">
      pending enrich
    </span>
  );
}

/** Registrable root ("us.experian.com" → "experian.com") — mirrors the
 * HubSpotActions off-domain email guard. */
function rootOf(d: string): string {
  const parts = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

function ProspectCard({ p, repos, index }: { p: Prospect; repos: Map<string, MonitoredRepo>; index: number }) {
  const displayName = p.name ?? p.login;
  const bestRepo = p.bestRepo ? repos.get(p.bestRepo) : undefined;
  const contribution = isContribution(p.bestAction);
  const shownSignals = p.signals.slice(0, 4);
  const extraSignals = p.signals.length - shownSignals.length;
  // HubSpotActions' contract: pass only a company-domain email. Anything else
  // (legacy rows, personal fallbacks) renders unverified and stays out of CRM.
  const emailDomain = p.email?.split("@")[1];
  const companyEmail =
    p.email && emailDomain && (!p.companyDomain || rootOf(emailDomain) === rootOf(p.companyDomain))
      ? p.email
      : undefined;
  // Freeze the auto-check stagger at mount — position churn from re-sorts
  // must not re-fire /api/hubspot/search for every moved card.
  const mountDelayMs = useRef(index * 300).current;

  const taskBody = [
    `WHO: ${displayName} (github.com/${p.login})${p.title ? ` — ${p.title}` : ""}`,
    `COMPANY: ${p.company ?? "unresolved"}${p.headcount ? ` (~${fmtNum(p.headcount)} employees)` : ""}`,
    // Same convention as the brief notes: a real profile URL or the word
    // UNRESOLVED — never a search link masquerading as a resolved profile.
    `PROFILE: ${p.linkedinUrl || "UNRESOLVED"}`,
    p.bestAction && p.bestRepo
      ? `SIGNAL: ${ACTION_LABELS[p.bestAction]} ${repoShortName(p.bestRepo)}${bestRepo ? ` — ${bestRepo.whyMatters}` : ""}`
      : "",
    p.opener ? `SUGGESTED OUTREACH: ${p.opener}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="animate-fade-in rounded-lg border border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-600 sm:p-5">
      {/* Header: person + handle + score */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {p.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.avatarUrl}
              alt=""
              loading="lazy"
              className="h-10 w-10 shrink-0 rounded-full border border-ink-700"
            />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-950">
              <Github className="h-5 w-5 text-ink-400" />
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-semibold text-ink-50">{displayName}</span>
              <a
                href={p.githubUrl ?? `https://github.com/${p.login}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-neon-300 transition-colors hover:text-neon-200"
              >
                @{p.login}
                <ExternalLink className="h-3 w-3" />
              </a>
              <StatusChip p={p} />
              {p.directory && <TargetChip d={p.directory} />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {(p.directory?.company || p.company) && (
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-100">
                  <Building2 className="h-3.5 w-3.5 text-ink-400" />
                  {p.directory?.company || p.company}
                </span>
              )}
              {(typeof p.headcount === "number" || typeof p.directory?.employees === "number") && (
                <span className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-ink-400">
                  ~{fmtNum(p.headcount ?? p.directory?.employees ?? 0)} employees
                </span>
              )}
              {p.location && (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-500">
                  <MapPin className="h-3 w-3" />
                  {p.location}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* Contribution-weighted score */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-sm font-bold tabular-nums" style={{ color: OSS_COLOR }}>
            {Math.min(99, p.score)}
          </span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, p.score)}%`, backgroundColor: OSS_COLOR }}
            />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
            {contribution ? "contributor" : "engagement"}
          </span>
        </div>
      </div>

      {/* Title + verified email */}
      {(p.title || p.email) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {p.title && <span className="text-sm text-ink-300">{p.title}</span>}
          {companyEmail ? (
            <span className="inline-flex items-center gap-1.5">
              <MailCheck className="h-3.5 w-3.5 text-neon-400" />
              <span className="font-mono text-xs text-neon-300">{companyEmail}</span>
              <CopyButton text={companyEmail} label="Copy" />
            </span>
          ) : p.email ? (
            // Off-company-domain address — shown, but never badged as verified.
            <span className="font-mono text-xs text-ink-400">{p.email}</span>
          ) : null}
          {p.linkedinUrl && (
            <a
              href={p.linkedinUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-400 transition-colors hover:text-sky-500"
            >
              LinkedIn
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {/* Signal chips — contributions colored, passive neutral */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {shownSignals.map((s, i) => {
          const Icon = ACTION_ICON[s.action];
          const contrib = isContribution(s.action);
          const inner = (
            <>
              <Icon className="h-3.5 w-3.5" />
              {ACTION_LABELS[s.action]} {repoShortName(s.repo)}
              {s.at && <span className="opacity-70">· {timeAgo(s.at.slice(0, 10))}</span>}
            </>
          );
          const cls = `inline-flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px] font-medium ${
            contrib ? "" : "border border-ink-700 bg-ink-950 text-ink-400"
          }`;
          const style = contrib
            ? { backgroundColor: `${OSS_COLOR}1c`, color: OSS_COLOR }
            : undefined;
          return s.url ? (
            <a
              key={`${s.repo}-${s.action}-${i}`}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className={`${cls} transition-opacity hover:opacity-80`}
              style={style}
            >
              {inner}
            </a>
          ) : (
            <span key={`${s.repo}-${s.action}-${i}`} className={cls} style={style}>
              {inner}
            </span>
          );
        })}
        {extraSignals > 0 && (
          <span className="rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">
            +{extraSignals} more
          </span>
        )}
      </div>

      {/* Why this repo matters */}
      {bestRepo && (
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            why {bestRepo.name}:{" "}
          </span>
          {bestRepo.whyMatters}
        </p>
      )}

      {/* Suppression reason */}
      {(p.status === "suppressed" || p.status === "no_match") && p.suppressedReason && (
        <p className="mt-2 text-xs text-amber-300/80">{p.suppressedReason}</p>
      )}

      {/* Suggested opener */}
      {p.opener && (
        <div className="mt-4 border-t border-ink-700 pt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
              suggested opener
            </span>
            <CopyButton text={p.opener} label="Copy opener" />
          </div>
          <p className="text-sm leading-relaxed text-ink-200">{p.opener}</p>
        </div>
      )}

      {/* HubSpot actions */}
      <div className="mt-4 border-t border-ink-700 pt-3">
        <HubSpotActions
          kind="contact"
          name={displayName}
          email={companyEmail}
          jobtitle={p.title}
          companyName={p.company}
          companyDomain={p.companyDomain}
          compact
          autoCheck={Boolean(companyEmail)}
          autoCheckDelayMs={mountDelayMs}
          defaultSubject={`SIGNAL DASH - GitHub - ${displayName}`}
          defaultBody={taskBody}
        />
      </div>
    </div>
  );
}

// Collapsible watchlist footer — the curated repo list (reviewed monthly).
function Watchlist({ repos }: { repos: MonitoredRepo[] }) {
  const [open, setOpen] = useState(false);
  if (repos.length === 0) return null;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-1 py-0.5 text-ink-300 transition-colors hover:text-ink-50"
      >
        <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
          <BookMarked className="h-3.5 w-3.5" />
          repo watchlist
          <span className="rounded bg-neon-500/15 px-1 py-0.5 text-neon-300">{repos.length}</span>
          <span className="normal-case tracking-normal text-ink-500">
            reviewed monthly — categories map to buying intent
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 text-ink-500 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {repos.map((r) => (
            <div
              key={r.repoKey}
              className={`rounded-lg border border-ink-700 bg-ink-950 p-3 ${r.active ? "" : "opacity-50"}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={`https://github.com/${r.owner}/${r.name}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-neon-300 transition-colors hover:text-neon-200"
                >
                  {r.owner}/{r.name}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <span className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">
                  {r.category}
                </span>
                {typeof r.stars === "number" && (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-500">
                    <Star className="h-3 w-3" />
                    {fmtNum(r.stars)}
                  </span>
                )}
                {!r.active && (
                  <span className="font-mono text-[10px] text-amber-300">inactive</span>
                )}
                {r.lastPolledAt && (
                  <span className="ml-auto font-mono text-[10px] text-ink-500">
                    polled {timeAgo(r.lastPolledAt.slice(0, 10))}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-ink-400">{r.whyMatters}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type TierFilter = "all" | "contributors" | "forked" | "starred";
type StatusFilter = "active" | "ready" | "pending" | "suppressed" | "all";
type SortId = "signal" | "recent";

/** Why this person's company is already a target — strongest intent first. */
const TARGET_STYLE = {
  prospected: {
    label: "prospected",
    hint: "already pushed to HubSpot from the signal feed",
    cls: "border-orange-500/40 bg-orange-500/15 text-orange-200",
  },
  researched: {
    label: "researched",
    hint: "you've generated an intel brief for this company",
    cls: "border-neon-600/40 bg-neon-500/15 text-neon-300",
  },
  directory: {
    label: "signal 2000",
    hint: "in your standing Signal 2000 target universe",
    cls: "border-violet-500/40 bg-violet-500/15 text-violet-300",
  },
} as const;

function TargetChip({ d }: { d: NonNullable<Prospect["directory"]> }) {
  const s = TARGET_STYLE[d.kind] ?? TARGET_STYLE.directory;
  return (
    <span
      title={`${d.company} — ${s.hint}`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${s.cls}`}
    >
      <Building2 className="h-3 w-3" /> {s.label}
    </span>
  );
}

interface FilterState {
  q: string;
  repo: string;
  tier: TierFilter;
  status: StatusFilter;
  size: string;
  /** Signal 2000 accounts only. */
  targetOnly: boolean;
}

/** The single source of truth for "does this prospect show". Module-level and
 *  parameterized so the empty state can re-run it with one filter relaxed to
 *  work out which one is hiding everything. */
function passesFilters(p: Prospect, f: FilterState): boolean {
  if (f.targetOnly && !p.directory) return false;
  if (f.status === "active" && (p.status === "suppressed" || p.status === "no_match")) return false;
  if (f.status === "ready" && p.status !== "enriched") return false;
  if (f.status === "pending" && p.status !== "new" && p.status !== "resolved") return false;
  if (f.status === "suppressed" && p.status !== "suppressed" && p.status !== "no_match") return false;
  if (f.tier === "contributors" && !isContribution(p.bestAction)) return false;
  if (f.tier === "forked" && p.bestAction !== "forked") return false;
  if (f.tier === "starred" && p.bestAction !== "starred") return false;
  // Size floor. Unknown headcount only survives at "Any" — an unsized company
  // can't be claimed to have a moderate-to-large data estate. Directory employee
  // counts stand in when enrichment didn't persist a headcount (everyone
  // enriched before the size gate wrote one): the card's badge already shows
  // them, and a filter that rejects a size the card displays reads as broken —
  // Microsoft at ~181K was hidden behind every floor.
  const floor = Number(f.size);
  if (floor > 0) {
    const size = typeof p.headcount === "number" ? p.headcount : p.directory?.employees;
    if (!(typeof size === "number" && size >= floor)) return false;
  }
  if (f.repo !== "all" && p.bestRepo !== f.repo && !p.signals.some((s) => s.repo === f.repo)) return false;
  if (
    f.q &&
    !p.login.toLowerCase().includes(f.q) &&
    !(p.name ?? "").toLowerCase().includes(f.q) &&
    !(p.company ?? "").toLowerCase().includes(f.q)
  )
    return false;
  return true;
}

/** Company-size floor applied in the UI (not at enrichment time) so the bar can
 *  be moved without re-spending Apollo credits — headcount is already stored.
 *  Employee count is the practical stand-in for data-estate scale. */
const SIZE_OPTIONS = [
  { id: "5000", label: "Enterprise (5,000+)" },
  { id: "10000", label: "Large enterprise (10,000+)" },
  { id: "1000", label: "Enterprise-adjacent (1,000+)" },
  { id: "250", label: "Mid-market (250+)" },
  { id: "0", label: "Any company size" },
] as const;

export function GitHubProspecting() {
  const [prospects, setProspects] = useState<Prospect[] | null>(null);
  const [repos, setRepos] = useState<MonitoredRepo[]>([]);
  const [totalSignals, setTotalSignals] = useState(0);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<false | "full" | "enrich" | "reopen">(false);
  const [syncResult, setSyncResult] = useState<SyncSummary | null>(null);

  const [query, setQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  // Default to the workable stream: people with a verified email at a company
  // that cleared the size bar. The raw-username queue is pipeline plumbing, not
  // prospects — it lives behind "Pending enrich".
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ready");
  // Enterprise is the default view for SingleStore. Dropping to 1,000 is instant (the
  // server floor sits there, so those people are already enriched); going below
  // it needs a `?mode=reopen` pass to re-queue size-suppressed prospects.
  const [minSize, setMinSize] = useState("5000");
  const [targetOnly, setTargetOnly] = useState(false);
  const [sort, setSort] = useState<SortId>("signal");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/github-prospect", { cache: "no-store" });
      const data = await readJson(res);
      if (typeof data.configured === "boolean") setConfigured(data.configured);
      if (data.ok) {
        setProspects((data.prospects as Prospect[]) ?? []);
        setRepos((data.repos as MonitoredRepo[]) ?? []);
        setTotalSignals(typeof data.totalSignals === "number" ? data.totalSignals : 0);
        setError(null);
      } else {
        setProspects([]);
        setRepos(((data.repos as MonitoredRepo[]) ?? []) || []);
        // Unconfigured deployments get the dedicated setup notice, not a
        // duplicate error banner on top of it.
        setError(
          data.configured === false
            ? null
            : typeof data.error === "string"
              ? data.error
              : `HTTP ${res.status}`,
        );
      }
    } catch (e) {
      setProspects([]);
      setError(String((e as Error)?.message || e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSync = useCallback(
    async (mode: "full" | "enrich" | "reopen") => {
      setSyncing(mode);
      setSyncResult(null);
      try {
        const res = await fetch(
          `/api/github-prospect/sync${mode === "full" ? "" : `?mode=${mode}`}`,
          { method: "POST", cache: "no-store" },
        );
        const raw = await readJson(res);
        // Normalize defensively — a gateway timeout returns non-JSON.
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        setSyncResult({
          ok: raw.ok === true,
          error: typeof raw.error === "string" ? raw.error : undefined,
          reposPolled: num(raw.reposPolled),
          newSignals: num(raw.newSignals),
          resolved: num(raw.resolved),
          enriched: num(raw.enriched),
          suppressed: num(raw.suppressed),
          openers: num(raw.openers),
          notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
        });
        await load();
      } catch (e) {
        setSyncResult({
          ok: false,
          error: String((e as Error)?.message || e),
          reposPolled: 0,
          newSignals: 0,
          resolved: 0,
          enriched: 0,
          suppressed: 0,
          openers: 0,
          notes: [],
        });
      } finally {
        setSyncing(false);
      }
    },
    [load],
  );

  const repoMap = useMemo(() => new Map(repos.map((r) => [r.repoKey, r])), [repos]);

  const all = useMemo(() => prospects ?? [], [prospects]);
  const readyCount = useMemo(() => all.filter((p) => p.status === "enriched").length, [all]);
  const pendingCount = useMemo(
    () => all.filter((p) => p.status === "new" || p.status === "resolved").length,
    [all],
  );
  const contributorCount = useMemo(
    () => all.filter((p) => isContribution(p.bestAction)).length,
    [all],
  );
  // People parked purely for company size. Surfacing the count is what makes a
  // segment change discoverable — without it a lowered floor looks broken.
  const sizeSuppressedCount = useMemo(
    () =>
      all.filter(
        (p) => p.status === "suppressed" && (p.suppressedReason ?? "").startsWith("Company size"),
      ).length,
    [all],
  );

  const active: FilterState = useMemo(
    () => ({
      q: query.trim().toLowerCase(),
      repo: repoFilter,
      tier: tierFilter,
      status: statusFilter,
      size: minSize,
      targetOnly,
    }),
    [query, repoFilter, tierFilter, statusFilter, minSize, targetOnly],
  );

  const filtered = useMemo(() => {
    const sorted = all.filter((p) => passesFilters(p, active));
    // Target accounts float to the top of BOTH sorts, strongest intent first:
    // prospected > researched > Signal 2000 > everyone else. Someone at a
    // company you're already working outranks a stronger raw signal at a
    // company you aren't. Within each tier the normal ordering applies.
    const RANK = { prospected: 0, researched: 1, directory: 2 } as const;
    const tier = (p: Prospect) => (p.directory ? RANK[p.directory.kind] ?? 2 : 3);
    if (sort === "recent") {
      sorted.sort(
        (a, b) =>
          tier(a) - tier(b) ||
          (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? "") ||
          b.score - a.score,
      );
    } else {
      sorted.sort(
        (a, b) =>
          tier(a) - tier(b) ||
          b.score - a.score ||
          (b.lastSignalAt ?? "").localeCompare(a.lastSignalAt ?? ""),
      );
    }
    return sorted;
  }, [all, active, sort]);

  const targetCount = useMemo(() => all.filter((p) => p.directory).length, [all]);

  // How many tracked people even HAVE a company size. Headcount is only written
  // during enrichment, so early in a run this is ~0 — and then every size floor
  // above "Any" matches nobody, which reads as a broken tab unless we say so.
  // Directory employees count too, same fallback as the filter itself.
  const sizeKnownCount = useMemo(
    () =>
      all.filter(
        (p) => typeof p.headcount === "number" || typeof p.directory?.employees === "number",
      ).length,
    [all],
  );

  // When the list comes back empty, work out WHICH filter is responsible by
  // relaxing them one at a time, so the empty state can name it and offer the
  // exact fix instead of a vague "loosen the filters".
  const emptyCause = useMemo(() => {
    if (filtered.length > 0 || all.length === 0) return null;
    const sizeLabel = SIZE_OPTIONS.find((o) => o.id === minSize)?.label ?? "size";
    // Size is probed specially: relax it as LITTLE as possible. Offering a jump
    // straight to "Any" would quietly abandon the enterprise segment, so step
    // down to the HIGHEST tier that actually has people and offer that instead.
    const currentFloor = Number(minSize);
    const nextTier =
      currentFloor > 0
        ? SIZE_OPTIONS.map((o) => ({ ...o, n: Number(o.id) }))
            .filter((o) => o.n < currentFloor)
            .sort((a, b) => b.n - a.n)
            .find((o) => all.some((p) => passesFilters(p, { ...active, size: o.id })))
        : undefined;
    const probes: { label: string; fixLabel: string; fix: () => void; relaxed: FilterState }[] = [
      ...(nextTier
        ? [
            {
              label: `the "${sizeLabel}" company-size filter`,
              fixLabel: `Drop to ${nextTier.label}`,
              fix: () => setMinSize(nextTier.id),
              relaxed: { ...active, size: nextTier.id },
            },
          ]
        : []),
      {
        label: "the “Target accounts only” filter",
        fixLabel: "Include non-target accounts",
        fix: () => setTargetOnly(false),
        relaxed: { ...active, targetOnly: false },
      },
      {
        label: "the status filter",
        fixLabel: "Show everything",
        fix: () => setStatusFilter("all"),
        relaxed: { ...active, status: "all" },
      },
      {
        label: "the signal-tier filter",
        fixLabel: "Show all tiers",
        fix: () => setTierFilter("all"),
        relaxed: { ...active, tier: "all" },
      },
      {
        label: "the repo filter",
        fixLabel: "Show all repos",
        fix: () => setRepoFilter("all"),
        relaxed: { ...active, repo: "all" },
      },
      {
        label: "the search box",
        fixLabel: "Clear the search",
        fix: () => setQuery(""),
        relaxed: { ...active, q: "" },
      },
    ];
    for (const probe of probes) {
      const n = all.filter((p) => passesFilters(p, probe.relaxed)).length;
      if (n > 0) return { ...probe, n };
    }
    return null;
  }, [filtered.length, all, active, minSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const loading = prospects === null;

  // Per-page enrichment: landing on (or advancing to) a page pumps the pending
  // queue one bounded batch. The backend pass is score-ordered, so browsing
  // pulls the strongest unresolved signals through resolve → size-filter →
  // Apollo in the order you'd want them. Guarded so only one runs at a time and
  // never while a manual sync is in flight; the free org lookup applies the
  // size floor before the paid people-match, so sub-threshold companies never
  // cost a credit.
  // Per-page auto-enrichment was REMOVED. Enrichment ends in a paid Apollo
  // people-match, so browsing pages must never spend on its own — merely
  // opening this tab was pumping the queue a batch at a time. Enrichment is now
  // strictly opt-in via the "Enrich pending" button, which processes one
  // bounded batch per click.
  //
  // The spend is only safe because the free size gate (lib/githubProspect/
  // enrich.ts) rejects too-small and unknown-size companies BEFORE the paid
  // call, so a click costs credits for enterprise-sized matches only.

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold text-ink-50">
          <Github className="h-5 w-5 text-neon-400" />
          GitHub Prospecting
        </h2>
        <p className="mt-1 text-sm text-ink-300">
          Engineers at target-sized companies engaging with database, streaming, vector
          and SingleStore repos. Contributions rank above stars; emails come verified from
          Apollo, never scraped from commits.
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Watchlist repos" value={repos.length} icon={BookMarked} color="text-neon-400" loading={loading} />
        <MetricCard label="People tracked" value={all.length} icon={Users} color="text-violet-400" loading={loading} />
        <MetricCard label="Email ready" value={readyCount} icon={MailCheck} color="text-neon-400" loading={loading} />
        <MetricCard label="Contributors" value={contributorCount} icon={GitPullRequest} color="text-violet-400" loading={loading} />
      </div>

      {/* Sync controls */}
      <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void runSync("full")}
            disabled={syncing !== false}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {syncing === "full" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {syncing === "full" ? "Syncing…" : "Sync watchlist"}
          </button>
          {pendingCount > 0 && (
            <button
              onClick={() => void runSync("enrich")}
              disabled={syncing !== false}
              className="inline-flex items-center gap-1 rounded border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {syncing === "enrich" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MailCheck className="h-3.5 w-3.5" />
              )}
              Enrich next 10 of {fmtNum(pendingCount)}
            </button>
          )}
          {sizeSuppressedCount > 0 && (
            <button
              onClick={() => void runSync("reopen")}
              disabled={syncing !== false}
              title="Re-queue people who were suppressed for company size but clear the current server floor (GITHUB_PROSPECT_MIN_EMPLOYEES). Needed after lowering the floor for a mid-market push."
              className="inline-flex items-center gap-1 rounded border border-ink-700 px-2.5 py-1.5 text-xs font-medium text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {syncing === "reopen" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Re-queue size-suppressed ({sizeSuppressedCount})
            </button>
          )}
          <span className="font-mono text-[11px] text-ink-500">
            {fmtNum(totalSignals)} raw signals · weekly cron + on-demand · incremental
          </span>
        </div>

        {syncing !== false && (
          <p className="mt-2 font-mono text-xs text-neon-400">
            ▸{" "}
            {syncing === "full"
              ? "polling watchlist, resolving people, enriching…"
              : syncing === "reopen"
                ? "re-queuing people suppressed under a higher size floor…"
                : "resolving + enriching pending people…"}
          </p>
        )}

        {syncResult && (
          <div
            className={`mt-3 flex items-start gap-3 rounded-lg border px-4 py-2.5 ${
              syncResult.ok
                ? "border-neon-600/30 bg-neon-500/10"
                : "border-red-500/30 bg-red-500/10"
            }`}
          >
            {syncResult.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-neon-400" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            )}
            <div className="min-w-0 text-xs leading-relaxed">
              {syncResult.ok ? (
                <p className="text-ink-200">
                  Polled {syncResult.reposPolled} repos · {syncResult.newSignals} new signals ·{" "}
                  {syncResult.resolved} resolved · {syncResult.enriched} enriched ·{" "}
                  {syncResult.suppressed} suppressed · {syncResult.openers} openers
                </p>
              ) : (
                <p className="text-red-200">{syncResult.error ?? "Sync failed"}</p>
              )}
              {syncResult.notes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-amber-300/90">
                  {syncResult.notes.slice(0, 5).map((n, i) => (
                    <li key={i}>· {n}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-200">{error}</p>
        </div>
      )}
      {!configured && (
        <div className="flex items-start gap-3 rounded-lg border border-violet-500/30 bg-violet-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
          <p className="text-xs leading-relaxed text-violet-200">
            SingleStore is not configured — set SINGLESTORE_HOST, SINGLESTORE_USER and SINGLESTORE_PASSWORD to enable
            GitHub prospecting.
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3.5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-ink-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search people, handles, companies…"
            className="w-full bg-transparent font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
        </div>
        <select
          value={repoFilter}
          onChange={(e) => {
            setRepoFilter(e.target.value);
            setPage(1);
          }}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
        >
          <option value="all">All repos</option>
          {repos.map((r) => (
            <option key={r.repoKey} value={r.repoKey}>
              {r.owner}/{r.name}
            </option>
          ))}
        </select>
        <select
          value={tierFilter}
          onChange={(e) => {
            setTierFilter(e.target.value as TierFilter);
            setPage(1);
          }}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
        >
          <option value="all">All signal tiers</option>
          <option value="contributors">Contributors (PRs + commits)</option>
          <option value="forked">Forked</option>
          <option value="starred">Starred</option>
        </select>
        <button
          onClick={() => {
            setTargetOnly((v) => !v);
            setPage(1);
          }}
          title="Only people at companies you've prospected, researched, or that sit in Signal 2000"
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-xs font-medium transition-colors ${
            targetOnly
              ? "border-violet-500/50 bg-violet-500/15 text-violet-300"
              : "border-ink-700 bg-ink-900 text-ink-300 hover:border-ink-600"
          }`}
        >
          <Building2 className="h-3.5 w-3.5" />
          Target accounts only{targetCount > 0 ? ` (${targetCount})` : ""}
        </button>
        <select
          value={minSize}
          onChange={(e) => {
            setMinSize(e.target.value);
            setPage(1);
          }}
          title="Company-size floor — the practical stand-in for data-estate scale"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
        >
          {SIZE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.id !== "0" && sizeKnownCount === 0 ? " — no sizes known yet" : ""}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as StatusFilter);
            setPage(1);
          }}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
        >
          <option value="active">Active pipeline</option>
          <option value="ready">Ready (email verified)</option>
          <option value="pending">Pending enrich</option>
          <option value="suppressed">Suppressed / no match</option>
          <option value="all">Everything</option>
        </select>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortId);
            setPage(1);
          }}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-xs text-ink-200 transition-colors hover:border-ink-600 focus:border-neon-600/40 focus:outline-none sm:flex-none"
        >
          <option value="signal">Strongest signal</option>
          <option value="recent">Most recent</option>
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-ink-700 bg-ink-900 p-5">
              <div className="skeleton h-4 w-3/4 rounded" />
              <div className="skeleton mt-3 h-3 w-1/2 rounded" />
              <div className="skeleton mt-3 h-3 w-2/3 rounded" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-700 bg-ink-900/50 p-12 text-center">
          <p className="text-sm text-ink-300">
            {all.length === 0
              ? "No GitHub prospects yet."
              : "No prospects match the current filters."}
          </p>
          {all.length === 0 ? (
            <p className="mt-1 text-xs text-ink-500">
              Run the first watchlist sync to collect stargazers, forks and contributors.
            </p>
          ) : (
            <>
              {/* Name the actual cause. "Loosen the filters" is useless when one
                  specific filter is excluding everything — especially the size
                  floor, which matches nobody until enrichment writes headcounts. */}
              {Number(minSize) > 0 && sizeKnownCount === 0 ? (
                <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-amber-300/90">
                  None of the {fmtNum(all.length)} tracked people have a known company size yet, so
                  every size floor above &ldquo;Any&rdquo; matches zero. Company size is written
                  during enrichment
                  {pendingCount > 0 ? ` (${fmtNum(pendingCount)} still pending)` : ""}.
                </p>
              ) : emptyCause ? (
                <p className="mt-2 text-xs text-ink-400">
                  {emptyCause.label} is hiding them. Relaxing just that would show{" "}
                  <span className="font-semibold text-ink-200">{fmtNum(emptyCause.n)}</span>.
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-500">
                  No single filter explains it, so more than one is excluding people at once.
                  Clearing them all will show everyone.
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {emptyCause && (
                  <button
                    onClick={() => {
                      emptyCause.fix();
                      setPage(1);
                    }}
                    className="rounded-lg border border-neon-600/40 bg-neon-500/10 px-3 py-1.5 font-mono text-xs font-medium text-neon-300 transition-colors hover:bg-neon-500/20"
                  >
                    {emptyCause.fixLabel}
                  </button>
                )}
                <button
                  onClick={() => {
                    setQuery("");
                    setRepoFilter("all");
                    setTierFilter("all");
                    setStatusFilter("all");
                    setMinSize("0");
                    setTargetOnly(false);
                    setPage(1);
                  }}
                  className="rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-xs font-medium text-ink-400 transition-colors hover:border-ink-600 hover:text-ink-200"
                >
                  Clear all filters
                </button>
              </div>
            </>
          )}
          {all.length === 0 && (
            <button
              onClick={() => void runSync("full")}
              disabled={syncing !== false}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {syncing !== false ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run first sync
            </button>
          )}
        </div>
      ) : (
        <>
          <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
          <div className="space-y-4">
            {pageItems.map((p, i) => (
              <ProspectCard key={p.login} p={p} repos={repoMap} index={i} />
            ))}
          </div>
          <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
        </>
      )}

      <Watchlist repos={repos} />
    </div>
  );
}
