"use client";

// Title Search — people by job title, across every company.
//
// The rest of the app is account-first: pick a company, then find its people.
// This inverts it. "Pull anyone running a data platform" is a real prospecting
// motion and the tool had no way to express it.
//
// COST. Apollo search is free but returns MASKED names ("Romain Hu***t") and
// no emails. Cards auto-fill the real name and verified email on arrival —
// NO reveal button (Max: "if it surfaces an email, it's just there"). The
// reveal endpoint is shared-cache-guarded server side, so a person anyone on
// the team already revealed costs nothing, and known no-email people are
// skipped (a credit for "none on file" buys nothing). Blast radius stays
// bounded: only the CURRENT PAGE (25 people) ever auto-fills, and screened
// tiers spend nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Building2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  MapPin,
  Search,
  Users,
} from "lucide-react";
import {
  REASON_LABEL,
  TIER_STYLE,
  allowedActions,
  normalizeClass,
  type ICPClass,
} from "@/lib/icpClassifier";
import type { TitleSearchPerson } from "@/lib/enrich/apollo";
import type { RegionId } from "@/lib/data";
import { isSendableEmail, provenanceIsWeak, provenanceLabel } from "@/lib/enrich/emailTrust";
import { fmtNum } from "@/lib/format";
import { HubSpotActions } from "./HubSpotActions";

// Starting points, not a fixed menu — the input is free text. These are the
// titles in SingleStore's buying group: champions who own the data serving
// layer, the economic buyers above them, and the people who feel the pain.
const PRESETS = [
  "data platform",
  "data engineering",
  "data infrastructure",
  "database engineering",
  "real-time analytics",
  "ml platform",
  "chief data officer",
  "database architect",
];

// Apollo's own band strings. Enterprise-first because that is the ICP; the
// smaller bands are here for the mid-market play when it happens.
const SIZE_BANDS: { label: string; ranges: string[] }[] = [
  { label: "10,000+", ranges: ["10001,50000", "50001,100000", "100001,500000", "500001,1000000"] },
  { label: "1,000+", ranges: ["1001,5000", "5001,10000", "10001,50000", "50001,100000", "100001,500000", "500001,1000000"] },
  { label: "200+", ranges: ["201,500", "501,1000", "1001,5000", "5001,10000", "10001,50000", "50001,100000", "100001,500000", "500001,1000000"] },
  { label: "any size", ranges: [] },
];

const SENIORITY_SETS: { label: string; values: string[] }[] = [
  { label: "director+", values: ["c_suite", "vp", "head", "director", "owner", "founder", "partner"] },
  { label: "manager+", values: ["c_suite", "vp", "head", "director", "owner", "founder", "partner", "manager"] },
  { label: "any level", values: [] },
];

interface SearchResponse {
  ok?: boolean;
  error?: string;
  people?: TitleSearchPerson[];
  page?: number;
  hasMore?: boolean;
  total?: number;
}

interface RevealState {
  loading?: boolean;
  email?: string;
  status?: string;
  /** Un-obfuscated name and employer domain — the search returns neither. */
  name?: string;
  domain?: string;
  linkedinUrl?: string;
  error?: string;
  done?: boolean;
}

export function TitleSearch({ region }: { region: RegionId }) {
  const [query, setQuery] = useState("data platform");
  const [sizeIdx, setSizeIdx] = useState(1); // 1,000+
  const [senIdx, setSenIdx] = useState(0); // director+
  // "This region only" — the header's US/IN toggle picks WHICH country that
  // is, this checkbox just turns the geographic filter on/off. GLOBAL has no
  // single country, so the checkbox disappears and the search runs worldwide.
  const [regionOnly, setRegionOnly] = useState(true);
  const regionCountry = region === "in" ? "India" : region === "us" ? "United States" : null;

  const [people, setPeople] = useState<TitleSearchPerson[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // Reveals are keyed by Apollo id and survive re-renders, so a credit spent is
  // never spent twice for the same person in one session.
  const [reveals, setReveals] = useState<Record<string, RevealState>>({});

  // The live request, so a fast second search can't have its results overwritten
  // by a slow first one landing late.
  const reqId = useRef(0);

  const run = useCallback(
    async (toPage: number) => {
      const titles = query
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (titles.length === 0) {
        setError("Enter at least one title.");
        return;
      }
      const mine = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/people/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            titles,
            seniorities: SENIORITY_SETS[senIdx].values,
            employeeRanges: SIZE_BANDS[sizeIdx].ranges,
            locations: regionOnly && regionCountry ? [regionCountry] : [],
            page: toPage,
            perPage: 25,
          }),
        });
        let data: SearchResponse;
        try {
          data = (await res.json()) as SearchResponse;
        } catch {
          data = { ok: false, error: `HTTP ${res.status}` };
        }
        if (mine !== reqId.current) return; // superseded
        if (!res.ok || !data.ok) {
          setError(data.error || `Search failed (${res.status})`);
          setPeople([]);
          setHasMore(false);
          return;
        }
        setPeople(data.people ?? []);
        setPage(data.page ?? toPage);
        setHasMore(!!data.hasMore);
        setTotal(data.total);
      } catch (e) {
        if (mine !== reqId.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mine === reqId.current) {
          setLoading(false);
          setSearched(true);
        }
      }
    },
    [query, senIdx, sizeIdx, regionOnly, regionCountry],
  );

  // First load AND region flips: run the query so the screen tracks the
  // header's US/IN toggle without a manual re-search.
  useEffect(() => {
    void run(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  const reveal = async (p: TitleSearchPerson) => {
    const id = p.apolloId;
    if (!id || reveals[id]?.loading || reveals[id]?.done) return;
    setReveals((r) => ({ ...r, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/enrich/apollo/person?id=${encodeURIComponent(id)}&reveal=email`);
      const d = (await res.json()) as {
        ok?: boolean;
        email?: string;
        emailStatus?: string;
        name?: string;
        companyDomain?: string;
        linkedinUrl?: string;
        error?: string;
      };
      setReveals((r) => ({
        ...r,
        [id]: {
          done: true,
          email: d.email,
          status: d.emailStatus,
          // The match response carries what the search withheld: the real name
          // behind "Hu***t", the employer domain, and the profile URL.
          name: d.name,
          domain: d.companyDomain,
          linkedinUrl: d.linkedinUrl,
          error: d.ok ? undefined : d.error,
        },
      }));
    } catch (e) {
      setReveals((r) => ({
        ...r,
        [id]: { done: true, error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  // Auto-fill QUALIFIED cards with the real name + verified email. Keyed off
  // `people`, so each page of results queues exactly once; `autoQueued`
  // survives re-renders so mid-flight state updates can't re-fire a reveal.
  // Three workers — a page fills in seconds without tripping Apollo's
  // per-minute limits. The cleanup halts unstarted work when the page flips;
  // anything not yet started re-queues if those results ever come back.
  const autoQueued = useRef(new Set<string>());
  useEffect(() => {
    const queue = people.filter((p) => {
      if (!p.apolloId || autoQueued.current.has(p.apolloId)) return false;
      if (p.hasEmail === false) return false; // known "none on file" — skip
      return allowedActions(normalizeClass(p.icp?.classification)).showEmail;
    });
    if (queue.length === 0) return;
    let live = true;
    const workers = Array.from({ length: 3 }, (_, w) =>
      (async () => {
        for (let i = w; i < queue.length; i += 3) {
          if (!live) return;
          autoQueued.current.add(queue[i].apolloId as string);
          await reveal(queue[i]);
        }
      })(),
    );
    void Promise.all(workers);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(1);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-ink-50">Title Search</h2>
        <p className="mt-1 text-sm text-ink-400">
          Find people by job title across every company, not just one account. Search costs
          nothing; names and verified emails fill in automatically as cards load — one Apollo
          credit each, free when anyone on the team already revealed the person.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="data platform, data engineering"
              className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pl-9 pr-3 text-sm text-ink-100 placeholder:text-ink-600 focus:border-neon-600/50 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neon-600/40 bg-neon-500/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-neon-300 transition-colors hover:bg-neon-500/20 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Search
          </button>
        </div>

        <p className="font-mono text-[11px] text-ink-600">
          comma-separated. Apollo matches loosely, so &quot;data platform&quot; also catches
          &quot;Head of Data Platform Engineering&quot; and &quot;Director, Data &amp; ML Platform&quot;.
        </p>

        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setQuery(p)}
              className={`rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                query === p
                  ? "border-neon-600/50 bg-neon-500/15 text-neon-300"
                  : "border-ink-700 bg-ink-950 text-ink-400 hover:text-ink-200"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 pt-3">
          <Filter label="company size" options={SIZE_BANDS.map((b) => b.label)} idx={sizeIdx} onPick={setSizeIdx} />
          <Filter label="seniority" options={SENIORITY_SETS.map((s) => s.label)} idx={senIdx} onPick={setSenIdx} />
          {regionCountry ? (
            <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-ink-400">
              <input
                type="checkbox"
                checked={regionOnly}
                onChange={(e) => setRegionOnly(e.target.checked)}
                className="h-3 w-3 accent-neon-500"
              />
              {region === "in" ? "India" : "US"} only
            </label>
          ) : (
            <span className="font-mono text-[11px] text-ink-500">worldwide</span>
          )}
        </div>
      </form>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {searched && !error && (
        <p className="font-mono text-[11px] text-ink-500">
          page {page}
          {typeof total === "number" && ` · ${fmtNum(total)} match${total === 1 ? "" : "es"} in Apollo`}
          {people.length > 0 && ` · showing ${people.length}`}
        </p>
      )}

      {loading && people.length === 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-32 rounded-lg" />
          ))}
        </div>
      ) : people.length === 0 && searched && !error ? (
        <p className="text-sm text-ink-500">
          Nobody matched. Try a broader title, drop the seniority floor, or widen the company size.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {people.map((p, i) => (
            <PersonCard
              key={p.apolloId || `${p.name}-${i}`}
              person={p}
              reveal={p.apolloId ? reveals[p.apolloId] : undefined}
              autoCheckDelayMs={i * 300}
            />
          ))}
        </div>
      )}

      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => void run(page - 1)}
            disabled={page <= 1 || loading}
            className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-ink-300 transition-colors hover:text-neon-300 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <span className="font-mono text-xs text-ink-500">page {page}</span>
          <button
            onClick={() => void run(page + 1)}
            disabled={!hasMore || loading}
            className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-ink-300 transition-colors hover:text-neon-300 disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function Filter({
  label,
  options,
  idx,
  onPick,
}: {
  label: string;
  options: string[];
  idx: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-600">{label}</span>
      <div className="flex gap-1">
        {options.map((o, i) => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(i)}
            className={`rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
              idx === i
                ? "border-neon-600/50 bg-neon-500/15 text-neon-300"
                : "border-ink-700 bg-ink-950 text-ink-500 hover:text-ink-300"
            }`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function PersonCard({
  person,
  reveal,
  autoCheckDelayMs,
}: {
  person: TitleSearchPerson;
  reveal?: RevealState;
  autoCheckDelayMs: number;
}) {
  const tier: ICPClass = normalizeClass(person.icp?.classification);
  // STAGE 6 — action gating. A title search is exactly where an ungated card
  // would burn credits: the pool is unbounded, so only QUALIFIED may reveal.
  const gate = allowedActions(tier);
  const screened = tier === "EXCLUDED";
  // The search returns "Romain Hu***t"; the reveal returns the real name.
  const displayName = reveal?.name || person.name;

  // Same two gates as the brief cards: the address must be on the company
  // domain (or HubSpot associates the contact to the wrong account) and Apollo
  // must call it verified (or it hard-bounces). The domain comes from the
  // REVEAL here — the title search doesn't return one, so checking against
  // person.companyDomain alone would fail every time.
  const rootOf = (d?: string) => {
    if (!d) return "";
    const p = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
    return p.length <= 2 ? p.join(".") : p.slice(-2).join(".");
  };
  const knownDomain = reveal?.domain || person.companyDomain;
  const onDomain =
    !!reveal?.email && !!knownDomain && rootOf(reveal.email.split("@")[1]) === rootOf(knownDomain);
  const sendable = onDomain && isSendableEmail(reveal?.status);
  const email = sendable ? reveal?.email : undefined;

  const profileUrl = reveal?.linkedinUrl || person.linkedinUrl;
  const liHref =
    profileUrl ||
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      `${person.company} ${displayName}`,
    )}`;
  // Apollo told us up front whether an address exists. Spending a credit to be
  // told "none on file" is the one avoidable way to waste one here.
  const noEmailOnFile = person.hasEmail === false;

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-ink-950/50 ${
        screened ? "border-ink-800 opacity-60" : "border-ink-700"
      }`}
    >
      {screened && (
        <div className="border-b border-ink-800 bg-ink-900/60 px-4 py-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-wider text-ink-500">
          screened out
          {person.icp?.reasonCode ? ` · ${REASON_LABEL[person.icp.reasonCode]}` : ""}
          {person.icp?.hardFiltered ? " · rule" : ""}
        </div>
      )}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h4 className="min-w-0 truncate text-sm font-semibold text-ink-100">{displayName}</h4>
          <span
            title={person.icp?.reason}
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${
              TIER_STYLE[tier] ?? TIER_STYLE.UNRESOLVED
            }`}
          >
            {tier.toLowerCase()}
          </span>
        </div>
        {person.title && <p className="mt-1 text-xs text-ink-400">{person.title}</p>}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-500">
          <span className="inline-flex items-center gap-1">
            <Building2 className="h-3 w-3" /> {person.company}
          </span>
          {person.companyEmployees ? (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" /> {fmtNum(person.companyEmployees)}
            </span>
          ) : null}
          {person.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {person.location}
            </span>
          )}
        </div>

        {person.icp?.reason && (
          <p className="mt-1.5 text-[11px] leading-snug text-ink-500">
            {person.icp.reasonCode && (
              <span className="mr-1.5 font-mono uppercase tracking-wide text-ink-600">
                {REASON_LABEL[person.icp.reasonCode]} ·
              </span>
            )}
            {person.icp.reason}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={liHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-neon-400 hover:text-neon-300"
          >
            {profileUrl ? "LinkedIn" : "Find on LinkedIn"}
            <ArrowUpRight className="h-3 w-3" />
          </a>
          {!gate.showEmail ? (
            <span className="font-mono text-[11px] text-ink-600">
              {tier.toLowerCase()} · no address for this tier
            </span>
          ) : noEmailOnFile ? (
            <span className="inline-flex items-center gap-1 rounded border border-ink-800 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-500">
              <Mail className="h-3 w-3" /> no email on file · linkedin only
            </span>
          ) : person.apolloId && !reveal?.done ? (
            // No reveal button — the page auto-fills every card; this is just
            // the in-flight state while the queue gets here.
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-500">
              <Loader2 className="h-3 w-3 animate-spin" /> pulling email…
            </span>
          ) : null}
        </div>

        {gate.showEmail && reveal?.done && (
          <div className="mt-2 font-mono text-[11px]">
            {email ? (
              <p className="flex items-center gap-1.5 text-ink-200">
                <Mail className="h-3 w-3 text-sky-400" />
                <a href={`mailto:${email}`} className="break-all hover:text-sky-300">
                  {email}
                </a>
                <span
                  className={`text-[10px] ${provenanceIsWeak(reveal?.status) ? "text-ink-500" : "text-neon-400"}`}
                >
                  {provenanceLabel(reveal?.status)}
                </span>
              </p>
            ) : reveal.email ? (
              <p className="flex flex-wrap items-center gap-1.5 text-amber-300/90">
                <Mail className="h-3 w-3" />
                <span className="break-all">{reveal.email}</span>
                <span className="text-[10px] uppercase tracking-wide">
                  {onDomain ? "unverified — do not send" : "off company domain — do not use"}
                </span>
              </p>
            ) : (
              <p className="flex items-center gap-1.5 font-semibold text-red-400">
                <Mail className="h-3 w-3" /> {reveal.error || "No verified address on file"}
              </p>
            )}
          </div>
        )}

        <div className="mt-3 border-t border-ink-800 pt-3">
          <HubSpotActions
            kind="contact"
            name={displayName}
            apolloId={person.apolloId}
            email={email}
            jobtitle={person.title}
            companyName={person.company}
            companyDomain={knownDomain}
            compact
            // No auto-check: a page of 25 would burn the HubSpot search limit on
            // people the rep hasn't decided about yet.
            autoCheckDelayMs={autoCheckDelayMs}
            defaultSubject={`SIGNAL DASH - ${person.company} - ${displayName.split(" ")[0]}`}
            defaultBody={
              `COMPANY: ${person.company}` +
              `${person.companyEmployees ? ` — ${fmtNum(person.companyEmployees)} employees` : ""}` +
              `${person.companyIndustry ? `, ${person.companyIndustry}` : ""}\n` +
              `\nWHAT I SAW: Sourced by title search, not by a company signal. No buying event observed at this account yet.\n` +
              `\nPROFILE: ${profileUrl || "UNRESOLVED"}\n` +
              `\nTIER: ${tier}${person.icp?.reason ? ` — ${person.icp.reason}` : ""}\n`
            }
          />
        </div>
      </div>
    </div>
  );
}
