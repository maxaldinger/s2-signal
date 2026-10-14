"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Target,
  Zap,
  AlertTriangle,
  Users,
  Coins,
  Compass,
  Send,
  Link2,
  ArrowUpRight,
  Copy,
  Check,
  RefreshCw,
  Mail,
  Phone,
  Loader2,
  Plus,
  Minimize2,
  Pencil,
  type LucideIcon,
} from "lucide-react";

import type { CompanyIntel as Intel } from "@/lib/types";
import type { EnrichContact } from "@/lib/enrich/types";
import {
  emailStatusLabel,
  isSendableEmail,
  provenanceIsWeak,
  provenanceLabel,
  unsendableReason,
} from "@/lib/enrich/emailTrust";
import {
  REASON_LABEL,
  TIER_RANK,
  TIER_STYLE,
  allowedActions,
  normalizeClass,
  type ICPClass,
  type ICPReasonCode,
} from "@/lib/icpClassifier";
import { APPROVED_FIGURES, OUTREACH_PRODUCT, bannedHits } from "@/lib/outreachRules";
import { fmtUSD, fmtNum, fmtDate, stripEmDashes, stripMarkdown } from "@/lib/format";
import { HubSpotActions } from "./HubSpotActions";
import { SequenceActions } from "./SequenceActions";
import {
  useIsProspected,
  useProspectedAt,
  useCompanySyncEvent,
  useContactSyncEvent,
  setDeepDiveScore,
  getReveal,
  mergeReveal,
  useSweOverride,
  setSweOverride,
  clearSweOverride,
  setBriefSwe,
  clearBriefSwe,
  useSpendOverride,
  setSpendOverride,
  clearSpendOverride,
} from "@/lib/clientStore";

function Section({
  title,
  icon: Icon,
  iconColor,
  children,
}: {
  title: string;
  icon: LucideIcon;
  iconColor: string;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-fade-in rounded-lg border border-ink-700 bg-ink-900 p-4 sm:p-6">
      <h3 className="mb-4 flex items-center gap-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
        <Icon className={`h-4 w-4 ${iconColor}`} />
        {title}
      </h3>
      {children}
    </section>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  HIGH: "bg-red-500/15 text-red-400",
  MEDIUM: "bg-amber-500/15 text-amber-400",
  LOW: "bg-sky-500/15 text-sky-400",
};

// Pulls one heavy brief section on demand (keeps the default brief lean/cheap).
function ExpandButton({
  label,
  section,
  ctx,
  onData,
  subtle,
}: {
  label: string;
  section: string;
  ctx: { company: string; segment?: string; summary?: string; productFocus?: string };
  onData: (data: Record<string, unknown>) => void;
  subtle?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/intel/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...ctx, section }),
      });
      const d = await res.json();
      if (d?.ok && d.data) onData(d.data);
      else setError(d?.error || "Couldn't load that — try again.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div>
      <button
        onClick={go}
        disabled={loading}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-1.5 font-mono text-[11px] font-medium transition-colors disabled:opacity-60 ${
          subtle
            ? "border-ink-700 text-ink-400 hover:border-neon-600/40 hover:text-neon-300"
            : "border-ink-600 text-ink-300 hover:border-neon-600/50 hover:text-neon-300"
        }`}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        {loading ? "Pulling…" : label}
      </button>
      {error && <p className="mt-1.5 text-xs text-amber-400/90">{error}</p>}
    </div>
  );
}

const ICP_BARS: { key: keyof Pick<
  Intel["icp"],
  "dataScale" | "architectureComplexity" | "realtimeWorkload" | "scalingActivity" | "aiWorkload"
>; label: string }[] = [
  { key: "dataScale", label: "Data & transaction scale" },
  { key: "architectureComplexity", label: "Stitched data systems" },
  { key: "realtimeWorkload", label: "Real-time / high-concurrency workload" },
  { key: "scalingActivity", label: "Recent scaling & re-platforming" },
  { key: "aiWorkload", label: "Gen-AI / RAG / vector workload" },
];

function MotionBadge({ motion }: { motion: Intel["motion"]["primary"] }) {
  return (
    <span className="rounded border border-neon-600/40 bg-neon-500/10 px-2.5 py-1 font-mono text-sm font-bold text-neon-300">
      {motion}
    </span>
  );
}

type RevealKind = "email" | "phone";

interface ApolloRevealResult {
  ok: boolean;
  error?: string;
  email?: string;
  emailStatus?: string;
  phone?: string;
}

interface ApolloRevealPayload extends ApolloRevealResult {
  name?: string;
  country?: string;
  /** Real profile URL from people/match. Absent from the people SEARCH. */
  linkedinUrl?: string;
}

/** Tier badge colours. ANCHOR is the buyer, so it gets the strongest treatment;
 *  ROUTER is amber because it means "ask them who owns this", not "pitch them". */
// Re-exported from lib so the title-search cards badge identically. A tier that
// looks different in two places is two vocabularies, not one.
export { TIER_STYLE };

// Apollo's `seniority` (or title, as a fallback) splits real contacts into the
// two columns the deep dive already uses: economic buyers vs. practitioners.
const DECISION_SENIORITY = new Set([
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
]);

function isDecisionMaker(c: EnrichContact): boolean {
  const sen = (c.seniority || "").toLowerCase();
  if (sen) return DECISION_SENIORITY.has(sen);
  const t = (c.title || "").toLowerCase();
  return /\b(cto|chief|vp|vice president|head|director)\b/.test(t);
}

// Company-level context woven into each contact's HubSpot task body.
interface ContactTaskContext {
  /** One-line company descriptor (segment, ICP, what they do). */
  companyLine: string;
  /** The single most valuable signal as one glanceable sentence — "what I saw". */
  callHook: string;
  /** The 4-touch LinkedIn set (connect + 3 DMs), when the brief has it.
   * dm/resurface are legacy fields from briefs generated pre-restructure. */
  linkedin?: {
    connect: string;
    inmail?: { subject: string; body: string };
    followup2?: { subject: string; body: string };
    followup3?: { subject: string; body: string };
    /** Legacy pre-Aug-2026 fields. */
    dm1?: string;
    dm2?: string;
    dm3?: string;
    dm?: string;
    resurface?: string;
  };
  /** Signal-specific 1-2 sentence lead-in for above the templated email body. */
  emailOpener?: string;
  /** Legacy single outreach draft — fallback for briefs cached before linkedinOutreach. */
  outreach: string;
}

function ApolloPersonCard({
  person,
  company,
  accountKey,
  domain,
  ctx,
  autoCheckDelayMs,
  hideWithoutEmail = true,
  unconfirmed = false,
  state = "UNRESOLVED",
}: {
  person: EnrichContact;
  company: string;
  /** Store key for the parent account — pushing this contact also marks the
   *  company prospected, and the feed card must be able to read that mark. */
  accountKey?: string;
  domain?: string;
  ctx: ContactTaskContext;
  /** Stagger this card's auto HubSpot check (HubSpot search caps ~4 req/s). */
  autoCheckDelayMs: number;
  /** Remove the card entirely when the reveal finds no company-domain email
   *  (default). The pinned first-move contact opts out — it's named in the
   *  motion, so it stays visible and is worked via LinkedIn instead. */
  hideWithoutEmail?: boolean;
  /** No provider record backs this person (the name came from the brief's
   *  generated motion). Blocks the HubSpot push: creating a CRM record for an
   *  unverified name would write a possibly-fictional person into the CRM. */
  unconfirmed?: boolean;
  /** STAGE 4 classification. Drives STAGE 6 action gating: what this card is
   *  allowed to do, and whether it may show an address at all. */
  state?: ICPClass;
}) {
  // One in-flight reveal kind at a time, per card.
  const [loading, setLoading] = useState<RevealKind | null>(null);
  const [result, setResult] = useState<Record<RevealKind, ApolloRevealPayload | undefined>>({
    email: undefined,
    phone: undefined,
  });
  // Apollo un-obfuscates the full name (and returns location) on reveal — swap
  // them in when they arrive, since the people SEARCH is too thin to include them.
  const [revealedName, setRevealedName] = useState<string | undefined>(undefined);
  const [revealedCountry, setRevealedCountry] = useState<string | undefined>(undefined);
  const [revealedLinkedin, setRevealedLinkedin] = useState<string | undefined>(undefined);
  // Per-person connect note. The brief's linkedinOutreach.connect is written
  // once per COMPANY, so pushing it verbatim sends the same note to everyone in
  // the org — and misattributes it when the signal was one person's podcast or
  // talk. Generated on demand for this contact; falls back to the company note.
  const [personalConnect, setPersonalConnect] = useState<string | undefined>(undefined);
  // The generator fell back to the safe template because three drafts failed the
  // connect checks. Marked in the note so a template is never mistaken for a
  // personalized one.
  const [connectGeneric, setConnectGeneric] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);

  // Ground truth first: what the team has already DONE with this contact.
  // Keyed like prospected marks — Apollo id when present, else the name.
  const contactKey = person.apolloId || person.name;
  const contactProspected = useIsProspected("contact", contactKey);
  const contactProspectedAt = useProspectedAt("contact", contactKey);
  const contactTeamSync = useContactSyncEvent(contactKey);
  const contactTeamChip = contactTeamSync && !contactTeamSync.mine ? contactTeamSync : undefined;
  // STAGE 6 — the available actions must match the classification.
  //   QUALIFIED  → LinkedIn, Draft email, HubSpot task, address shown
  //   ROUTER     → LinkedIn, HubSpot task (routing-ask note), no email
  //   UNRESOLVED → LinkedIn only. No draft, no task, NO ADDRESS.
  // "Do not surface a verified email address for anyone the rationale says is
  // not a buyer" — so an UNRESOLVED card never spends a reveal credit either.
  //
  // ...BUT CRM GROUND TRUTH OUTRANKS THE MODEL. A contact already in HubSpot —
  // pushed by this rep or synced by a teammate — has been reviewed and worked
  // by a person; a later pull's classifier verdict must not retract their
  // email or their push button (it did exactly that, and locked cards that
  // were already in HubSpot).
  const modelState: ICPClass = state ?? "UNRESOLVED";
  const humanQualified = contactProspected || !!contactTeamSync;
  const effective: ICPClass = humanQualified ? "QUALIFIED" : modelState;
  const gate = allowedActions(effective);
  const screened = effective === "EXCLUDED";
  /** When this contact reached HubSpot, from own marks or a teammate's sync. */
  const pushedAt =
    contactProspectedAt ?? (contactTeamSync ? new Date(contactTeamSync.at).getTime() : undefined);

  /** FREE lookup — people/match with no reveal_* flag costs no credit. Fills in
   *  the profile URL (and the un-obfuscated name) for a contact whose email was
   *  revealed before those fields were captured. Deliberately NOT routed
   *  through reveal(): that function owns the paid `result` map, and a free
   *  call has no business writing into it. */
  const resolveProfile = async (id: string) => {
    try {
      const res = await fetch(`/api/enrich/apollo/person?id=${encodeURIComponent(id)}&reveal=profile`);
      const d = (await res.json()) as {
        ok?: boolean;
        name?: string;
        country?: string;
        linkedinUrl?: string;
      };
      if (!d.ok) return;
      if (d.linkedinUrl) setRevealedLinkedin(d.linkedinUrl);
      if (d.name) setRevealedName(d.name);
      if (d.country) setRevealedCountry(d.country);
      // Write back so this repair happens once per contact, not once per view.
      if (d.linkedinUrl || d.name || d.country) {
        mergeReveal(id, {
          ...(d.linkedinUrl ? { linkedinUrl: d.linkedinUrl } : {}),
          ...(d.name ? { name: d.name } : {}),
          ...(d.country ? { country: d.country } : {}),
        });
      }
    } catch {
      /* the card still works without a profile URL */
    }
  };

  const reveal = async (kind: RevealKind) => {
    if (loading) return;
    setLoading(kind);
    setResult((r) => ({ ...r, [kind]: undefined }));
    try {
      const params = new URLSearchParams({ reveal: kind });
      // Match by id (exact, un-obfuscated); fall back to name if id is missing.
      if (person.apolloId) {
        params.set("id", person.apolloId);
      } else {
        params.set("name", person.name);
        params.set("company", company);
        if (domain) params.set("domain", domain);
      }
      const res = await fetch(`/api/enrich/apollo/person?${params.toString()}`);
      let data: ApolloRevealPayload;
      try {
        data = (await res.json()) as ApolloRevealPayload;
      } catch {
        data = { ok: false, error: `HTTP ${res.status} — ${res.statusText || "bad response"}` };
      }
      setResult((r) => ({ ...r, [kind]: data }));
      // Identity fields (real name, profile URL, location) come back on ANY
      // successful MATCH — including ok:false "Apollo matched this person but
      // has no email on file". Gating them behind data.ok was why exactly the
      // no-email cards kept their masked "Ba***u" names while everyone else
      // un-obfuscated.
      if (data.name) setRevealedName(data.name);
      if (data.country) setRevealedCountry(data.country);
      // people/match carries the real profile URL; the people SEARCH usually
      // doesn't. We were throwing this away, so every task note printed
      // "PROFILE: UNRESOLVED" for a contact whose profile we had already
      // paid to resolve.
      if (data.linkedinUrl) setRevealedLinkedin(data.linkedinUrl);
      // Cache by Apollo id so reopening the brief reuses it (no re-spend). Use
      // "" for an attempted-but-empty field so it reads as "tried, none found"
      // rather than "not yet tried" (which would re-reveal next time). The
      // paid fields only cache on data.ok — a transport failure must NOT be
      // recorded as attempted-none.
      if (person.apolloId) {
        const patch: {
          name?: string;
          email?: string;
          emailStatus?: string;
          phone?: string;
          country?: string;
          linkedinUrl?: string;
        } = {};
        if (data.name) patch.name = data.name;
        if (data.country) patch.country = data.country;
        if (data.linkedinUrl) patch.linkedinUrl = data.linkedinUrl;
        if (data.ok) {
          if (kind === "email") {
            patch.email = data.email ?? "";
            patch.emailStatus = data.emailStatus;
          } else {
            patch.phone = data.phone ?? "";
          }
        }
        if (Object.keys(patch).length > 0) mergeReveal(person.apolloId, patch);
      }
    } catch (e) {
      setResult((r) => ({
        ...r,
        [kind]: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setLoading(null);
    }
  };

  // Personalize the connect note for THIS contact. The brief writes one note
  // per company, so without this every person in the org receives the same
  // text, and any signal about a named individual ("your DX podcast") gets
  // misattributed to colleagues who had nothing to do with it. Staggered with
  // the reveal so a page of cards doesn't burst. Failure is silent — the
  // company-level note is a fine fallback.
  useEffect(() => {
    if (!ctx.callHook || !ctx.linkedin || !gate.draftEmail) return; // no copy for a non-buyer
    let cancelled = false;
    const t = setTimeout(() => {
      setConnectLoading(true);
      fetch("/api/outreach/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company,
          companyLine: ctx.companyLine,
          callHook: ctx.callHook,
          name: person.name,
          title: person.title,
          classification: person.icp?.classification,
        }),
      })
        .then((r) => r.json())
        .then((d: { ok?: boolean; connect?: string; generic?: boolean }) => {
          if (!cancelled && d.ok && d.connect) {
            setPersonalConnect(d.connect);
            setConnectGeneric(!!d.generic);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setConnectLoading(false);
        });
    }, autoCheckDelayMs + 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // person.name/title are stable for a mounted card; ctx is rebuilt per render
    // so it is deliberately not a dependency (it would refire every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.apolloId, person.name, company, autoCheckDelayMs]);

  // Auto-reveal email on mount so names un-obfuscate and contact info is ready
  // without manual clicks. Phone is intentionally NOT auto-revealed: Apollo only
  // delivers phones async via webhook (we have none), so it always fails here —
  // phones are pulled via the Apollo Chrome extension once a contact's in the
  // CRM. Cached per Apollo id (reopening reuses it) and staggered for rate limits.
  //
  // The tier gate holds back the EMAIL, never the NAME: people/match without a
  // reveal flag is free, and the UNRESOLVED instruction — "review the profile"
  // — is impossible against a masked name (a LinkedIn search for "Hu***t"
  // finds nobody). So every card resolves its real name and profile URL;
  // only gate.showEmail cards touch a credit. gate.showEmail is a dependency
  // on purpose: when a review verdict qualifies the card, the email reveal
  // runs then.
  useEffect(() => {
    const id = person.apolloId;
    if (!id) return;
    let cancelled = false;
    const cached = getReveal(id);
    if (cached?.name) setRevealedName(cached.name);
    if (cached?.country) setRevealedCountry(cached.country);
    if (cached?.linkedinUrl) setRevealedLinkedin(cached.linkedinUrl);

    if (!gate.showEmail) {
      // Gated tier: free unmask only. Staggered like the reveal so a page of
      // cards doesn't burst Apollo's per-minute limit.
      if (!cached?.name || !cached?.linkedinUrl) {
        const t = setTimeout(() => {
          if (!cancelled) void resolveProfile(id);
        }, autoCheckDelayMs);
        return () => {
          cancelled = true;
          clearTimeout(t);
        };
      }
      return;
    }

    if (cached?.email !== undefined) {
      setResult((r) => ({
        ...r,
        email: { ok: true, email: cached.email, emailStatus: cached.emailStatus, name: cached.name },
      }));
      // Already revealed, so no credit is owed — but 2,696 cached entries were
      // written before the profile URL was captured, and this early return is
      // why they stayed "PROFILE: UNRESOLVED" forever: the reveal never re-ran,
      // so the URL never arrived. Repair it with the FREE match (no reveal_*
      // flag, no credit) and write it back to the cache so it happens once.
      if (!cached.linkedinUrl) void resolveProfile(id);
      return;
    }

    const t = setTimeout(() => {
      if (!cancelled) void reveal("email");
    }, autoCheckDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.apolloId, gate.showEmail]);

  // Per-person cold email draft (AI assist).
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<{ text?: string; error?: string } | null>(null);
  const [draftCopied, setDraftCopied] = useState(false);

  const draftEmail = async () => {
    if (drafting) return;
    setDrafting(true);
    setDraft(null);
    setDraftCopied(false);
    try {
      const who = (revealedName || person.name).split(" ")[0];
      const role = person.title || "an engineering or data leader";
      // Same product framing and approved proof figures as every other
      // outreach generator (lib/outreachRules), so this button never drifts
      // into its own pitch.
      const content =
        `Write a short cold outreach email from Max Aldinger, an Account Executive at SingleStore, to ${who} (${role}) at ${company}. ` +
        `Address them by first name only. Lead with the likely consequence for their data stack, framed as a question, not a diagnosis. ` +
        `Any proof figure must be one of the approved ones, attributed to the named customer and stated with what it measured; never promise them a specific result.\n\n${OUTREACH_PRODUCT}\n\n${APPROVED_FIGURES}\n\n` +
        `Output ONLY the email: a "Subject:" line (lowercase, 2-4 plain words), then the body (under 120 words, one clear CTA, signed just "Max"). ` +
        `Plain text only — NO markdown, asterisks, bold, headings, or "---" separators. ` +
        `Do NOT add any notes, caveats, or commentary to the rep, and no placeholders like [Your name]. ` +
        `Don't invent facts; if you can't verify a detail, just leave it out. ` +
        `Use plain punctuation only — no em or en dashes.`;
      const res = await fetch("/api/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "ask", messages: [{ role: "user", content }] }),
      });
      let data: { text?: string; error?: string };
      try {
        data = await res.json();
      } catch {
        data = { error: `HTTP ${res.status} — ${res.statusText || "bad response"}` };
      }
      setDraft(
        res.ok
          ? { text: data.text ? stripEmDashes(stripMarkdown(data.text)) : data.text }
          : { error: data.error || `Draft failed (${res.status})` },
      );
    } catch (e) {
      setDraft({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setDrafting(false);
    }
  };

  const copyDraftEmail = async () => {
    if (!draft?.text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(draft.text);
      setDraftCopied(true);
      setTimeout(() => setDraftCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  const displayName = revealedName || person.name;
  // Location: the people SEARCH is too thin to include it, so prefer the value
  // the reveal returned (or its cache) and fall back to whatever search gave us.
  const displayCountry = revealedCountry || person.country;
  const liQuery = `${company} ${revealedName || person.title || ""}`.trim();
  // The reveal's URL wins: it comes from people/match (exact id lookup), while
  // the search result is usually empty for this field.
  const profileUrl = revealedLinkedin || person.linkedinUrl;
  const linkedinHref =
    profileUrl ||
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(liQuery)}`;
  const emailRes = result.email;
  const phoneRes = result.phone;
  // Only a COMPANY-domain email is usable — a personal/off-domain one would
  // mis-associate the contact in HubSpot, so we treat it as "none surfaced".
  const rootOf = (d?: string) => {
    if (!d) return "";
    const p = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
    return p.length <= 2 ? p.join(".") : p.slice(-2).join(".");
  };
  const revealedEmail = emailRes?.ok && emailRes.email ? emailRes.email : undefined;
  const onCompanyDomain =
    !!revealedEmail && !!domain && rootOf(revealedEmail.split("@")[1]) === rootOf(domain);
  // TWO independent gates. The domain check stops mis-association; the STATUS
  // check stops hard bounces. Only Apollo's "verified" is sendable — an
  // unrecognized or missing status means "unknown", and unknown must never be
  // treated as safe to send. Apollo's reveal can return guessed/extrapolated
  // addresses, which is what was bouncing.
  const emailSendable = onCompanyDomain && isSendableEmail(emailRes?.emailStatus);
  /** Safe to send AND safe to write to the CRM. */
  const companyEmail = emailSendable ? revealedEmail : undefined;
  /** On-domain but NOT verified: shown for research, never used for outreach. */
  const unverifiedEmail = onCompanyDomain && !emailSendable ? revealedEmail : undefined;
  const emailChecked = emailRes !== undefined; // reveal finished (found or not)

  // NOBODY is hidden any more. Cards used to delete themselves once the reveal
  // came back empty, which is why a list would populate and then visibly gut
  // itself — and the reveal credit was already spent, so we lost both the money
  // and the contact. They stay, loudly marked instead.
  //
  //   verified   → green, mailto live, pushable
  //   unverified → amber, address shown for research, never a mailto
  //   none       → RED bar, LinkedIn-only
  const emailState: "pending" | "verified" | "unverified" | "none" = !emailChecked
    ? "pending"
    : companyEmail
      ? "verified"
      : unverifiedEmail
        ? "unverified"
        : "none";
  void hideWithoutEmail; // kept in the signature; suppression is retired

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-ink-950/50 ${
        screened
          ? "border-ink-800 opacity-60"
          : emailState === "none"
            ? "border-red-500/60 ring-1 ring-red-500/25"
            : contactProspected
              ? "border-orange-500/50 ring-1 ring-orange-500/30"
              : "border-ink-700"
      }`}
    >
      {screened && (
        <div className="border-b border-ink-800 bg-ink-900/60 px-4 py-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-wider text-ink-500">
          screened out
          {person.icp?.reasonCode ? ` · ${REASON_LABEL[person.icp.reasonCode]}` : ""}
          {person.icp?.hardFiltered ? " · rule" : ""}
        </div>
      )}
      {!screened && emailState === "none" && (
        <div className="border-b border-red-500/40 bg-red-500/15 px-4 py-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-wider text-red-300">
          no email found · linkedin only
        </div>
      )}
      {emailState === "unverified" && (
        <div className="border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-center font-mono text-[10px] font-bold uppercase tracking-wider text-amber-300">
          email unverified · do not send · risk of hard bounce
        </div>
      )}
      <div className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-sm font-semibold text-ink-100">{displayName}</h4>
        <div className="flex shrink-0 items-center gap-1.5">
          {contactTeamChip && (
            <span
              title={`Synced to ${contactTeamChip.by}'s HubSpot on ${new Date(contactTeamChip.at).toLocaleDateString("en-US")}`}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300"
            >
              synced by {contactTeamChip.by} · {fmtDate(new Date(contactTeamChip.at).getTime())}
            </span>
          )}
          {contactProspected && (
            <span
              title="Already prospected — a HubSpot task has been created for this contact"
              className="inline-flex items-center gap-1 rounded-md border border-orange-500/40 bg-orange-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-orange-200"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-neon-500 text-ink-950">
                <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
              </span>
              In HubSpot{pushedAt ? ` · ${fmtDate(pushedAt)}` : ""}
            </span>
          )}
          {/* STAGE 4. Always rendered: three states that are actually used mean
              the badge carries information, and UNRESOLVED is the honest common
              case rather than a gap. Shows the EFFECTIVE tier; when a human
              decision overrode the model, the tooltip says which and why. */}
          <span
            title={`${person.icp?.reason ?? ""}${person.icp?.recommendedAction ? ` · ${person.icp.recommendedAction}` : ""}${person.icp ? ` (confidence: ${person.icp.confidence})` : ""}${
              effective !== modelState
                ? ` · model said ${modelState.toLowerCase()} — overridden by CRM ground truth (already in HubSpot)`
                : ""
            }`}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide ${
              TIER_STYLE[effective] ?? TIER_STYLE.UNRESOLVED
            }`}
          >
            {effective.toLowerCase()}
            {effective !== modelState ? " ✓" : ""}
          </span>
          {person.seniority && (
            <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-ink-300">
              {person.seniority.replace(/_/g, " ")}
            </span>
          )}
        </div>
      </div>
      {(person.title || displayCountry) && (
        <p className="mt-1 text-xs text-ink-400">
          {person.title}
          {person.title && displayCountry ? " · " : ""}
          {displayCountry && <span className="text-ink-500">{displayCountry}</span>}
        </p>
      )}
      {person.icp && (
        <p className="mt-1 text-[11px] leading-snug text-ink-500">
          {/* The fixed-vocabulary code first, then the prose. The code is what
              makes the tier comparable across contacts; the prose is why. */}
          {person.icp.reasonCode && (
            <span className="mr-1.5 font-mono uppercase tracking-wide text-ink-600">
              {REASON_LABEL[person.icp.reasonCode]} ·
            </span>
          )}
          {person.icp.reason}
          {effective === "ROUTER" && person.icp.routesTo && (
            <span className="ml-1 text-amber-300/90">Routes to: {person.icp.routesTo}</span>
          )}
          {person.icp.confidence === "low" && (
            <span className="ml-1 text-amber-400/80">(low confidence)</span>
          )}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={linkedinHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-neon-400 hover:text-neon-300"
        >
          {profileUrl ? "LinkedIn" : "Find on LinkedIn"} <ArrowUpRight className="h-3 w-3" />
        </a>
        {/* STAGE 6. Draft email is QUALIFIED-only. A ROUTER gets the routing
            question instead, and UNRESOLVED gets neither — drafting outreach
            for a contact we have said we cannot identify is the exact thing
            the spec forbids. */}
        {gate.draftEmail && (
          <button
            type="button"
            onClick={() => void draftEmail()}
            disabled={drafting}
            title="Draft a personalized cold outreach email for this person (AI)"
            className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-300 disabled:opacity-50"
          >
            {drafting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Draft email
          </button>
        )}
        {/* No "Who owns this?" button — a ROUTER's routing ask lives in the
            HubSpot task note instead (see defaultBody below), so the move is
            recorded where the work happens. */}
        {effective === "ROUTER" && (
          <span className="font-mono text-[11px] text-amber-300/80">
            router · task carries the routing ask, not a pitch
          </span>
        )}
      </div>

      {draft && (
        <div className="mt-2">
          {draft.error ? (
            <p className="font-mono text-[11px] text-amber-400/90">Draft: {draft.error}</p>
          ) : draft.text ? (
            <div className="relative">
              <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-950 p-3 pr-16 font-mono text-[12px] leading-relaxed text-ink-200">
                {draft.text}
              </pre>
              <button
                onClick={copyDraftEmail}
                className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[10px] font-medium text-ink-400 transition-colors hover:text-neon-300"
              >
                {draftCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {draftCopied ? "copied" : "copy"}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Contact email — only a COMPANY-domain address is shown/usable; if Apollo
          only has a personal/off-domain one (or none), say so plainly rather than
          surface an address that would mis-associate the contact. */}
      {gate.showEmail && (companyEmail || unverifiedEmail || emailChecked || (phoneRes?.ok && phoneRes.phone)) && (
        <div className="mt-2 space-y-1 font-mono text-[11px]">
          {companyEmail ? (
            <p className="flex items-center gap-1.5 text-ink-200">
              <Mail className="h-3 w-3 text-sky-400" />
              <a href={`mailto:${companyEmail}`} className="break-all hover:text-sky-300">
                {companyEmail}
              </a>
              {/* STAGE 8. Never a bare "(verified)": the label states WHERE the
                  address came from, because a bare verified badge invites sends
                  and two Apollo-"verified" addresses already hard-bounced. */}
              <span
                title="Apollo reports a mailbox check for this address. Apollo-verified addresses have still bounced (550 5.7.367, 550 5.2.1) — treat as strong, not certain."
                className={`text-[10px] ${provenanceIsWeak(emailRes?.emailStatus) ? "text-ink-500" : "text-neon-400"}`}
              >
                {provenanceLabel(emailRes?.emailStatus)}
              </span>
            </p>
          ) : unverifiedEmail ? (
            // Deliberately NOT a mailto: an unverified address is research
            // material, not a send target. Amber and explicit, because the old
            // 10px grey parenthetical was easy to read straight past.
            <p className="flex flex-wrap items-center gap-1.5 text-ink-400">
              <Mail className="h-3 w-3 text-amber-400" />
              <span className="break-all">{unverifiedEmail}</span>
              <span
                title={unsendableReason(emailRes?.emailStatus)}
                className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
              >
                {provenanceLabel(emailRes?.emailStatus)} {emailStatusLabel(emailRes?.emailStatus)} — do not send
              </span>
            </p>
          ) : emailChecked ? (
            // No email is a dead end for this contact, not a footnote. The red
            // bar at the top of the card says it too — this repeats it next to
            // where an address would otherwise sit, so a quick scan can't miss it.
            <p className="flex items-center gap-1.5 font-semibold text-red-400">
              <Mail className="h-3 w-3" /> No company email · Apollo has no checked
              mailbox for this person
            </p>
          ) : null}
          {phoneRes?.ok && phoneRes.phone && (
            <p className="flex items-center gap-1.5 text-ink-200">
              <Phone className="h-3 w-3 text-violet-400" />
              <a href={`tel:${phoneRes.phone}`} className="hover:text-violet-300">
                {phoneRes.phone}
              </a>
            </p>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-ink-800 pt-3">
        {!gate.hubspotTask ? (
          // STAGE 6 — UNRESOLVED gets LinkedIn only. Creating a CRM record and a
          // task for someone we have just said we cannot identify is how the
          // pipeline fills with people who will never be worked.
          <p className="font-mono text-[11px] leading-snug text-ink-500">
            HubSpot push disabled — this title is screened out by the exclusion rules.
          </p>
        ) : unconfirmed ? (
          // Pushing here would CREATE a HubSpot contact from a name only the
          // brief's model has asserted. Verify the person exists first; the
          // grid cards below are provider-backed and push normally.
          <p className="font-mono text-[11px] leading-snug text-amber-300/90">
            HubSpot push disabled — confirm this person exists before creating a CRM
            record for them.
          </p>
        ) : (
        <HubSpotActions
          kind="contact"
          name={displayName}
          apolloId={person.apolloId}
          email={companyEmail}
          phone={phoneRes?.ok ? phoneRes.phone : undefined}
          jobtitle={person.title}
          companyName={company}
          companyDomain={domain}
          companyKey={accountKey}
          // Both names in scope here already: accountKey is the feed's, company
          // is the brief's. Mark under both.
          companyAliases={[accountKey, company].filter(Boolean) as string[]}
          compact
          // A screened contact still has working buttons if you disagree with
          // the call, but nothing fires on its own.
          autoCheck={!screened}
          autoCheckDelayMs={autoCheckDelayMs}
          defaultSubject={`SIGNAL DASH - ${company} - ${displayName.split(" ")[0]}${effective === "ROUTER" ? " - ROUTER" : ""}`}
          defaultBody={
            // LinkedIn-workflow note: COMPANY → WHAT I SAW → EMAIL OPENER →
            // PROFILE → LINKEDIN OUTREACH (CONNECT + 3 DMs). No WHO (the task's
            // contact record carries it natively) and no SIGNAL (redundant with
            // WHAT I SAW). No cadence-tracking text — Max schedules follow-ups
            // himself. The EMAIL OPENER is a signal-specific lead-in pasted
            // above the templated email body, angled differently from the
            // LinkedIn connect note so a prospect on both channels never sees
            // the same observation twice.
            //
            // ROUTER tasks lead with the routing instruction: this person is a
            // path to the buyer, so the task is "ask who owns it", never the
            // pitch below.
            (effective === "ROUTER"
              ? `ROUTER — routing ask, NOT a pitch. Ask ${displayName.split(" ")[0]} who on their team owns the data platform / database infrastructure.` +
                `${person.icp?.routesTo ? `\nROUTES TO: ${person.icp.routesTo}` : ""}\n\n`
              : "") +
            `COMPANY: ${ctx.companyLine}\n` +
            // WHAT I SAW must be traceable to a real artifact. When the brief
            // produced no signal, say so rather than letting the next section
            // imply one existed.
            `\nWHAT I SAW: ${ctx.callHook || "No specific signal, sourced on fit only."}\n` +
            // PROFILE is a real profile URL or the word UNRESOLVED. Never a
            // search URL: a search link in a task note reads as a resolved
            // contact and is not one.
            `\nPROFILE: ${profileUrl || "UNRESOLVED"}\n` +
            `\n---\n\n` +
            (() => {
              const li = ctx.linkedin;
              if (!li)
                return `${draft?.text || ctx.outreach || "—"}\n\n(Update the brief to generate the outreach set.)`;
              // THE BRIEF WRITES ONE OUTREACH SET PER COMPANY, addressed to
              // the signal's named contact. Pasting it verbatim under a
              // DIFFERENT contact shipped "Hey Vishal" into Ali Zaidi's FedEx
              // task. Guard by greeting: a wrong-named CONNECT is re-greeted
              // (its body is company-level, so only the name is wrong), and a
              // wrong-named InMail/follow-up gets a loud rework warning — its
              // BODY may be about the other person's situation, so a silent
              // name swap would still send Ali a message about Vishal's
              // mandate.
              const first = displayName.split(" ")[0];
              const greetRe = /^\s*(hey|hi|hello)\s+([A-Za-z][\w'’-]*)([,.!]?)/i;
              const greetedName = (t?: string) => t?.match(greetRe)?.[2];
              const wrongName = (t?: string) => {
                const g = greetedName(t);
                return !!g && g.toLowerCase() !== first.toLowerCase();
              };
              // Per-person connect when it generated, else the company-level
              // one, re-greeted to THIS contact if needed.
              let connect = stripEmDashes(personalConnect || li.connect);
              if (!personalConnect && wrongName(connect)) {
                connect = connect.replace(greetRe, (_m, g, _n, p) => `${g} ${first}${p}`);
              }
              const parts = [
                `CONNECT (${connect.length} chars)${
                  connectGeneric ? " — GENERIC TEMPLATE, the personalized drafts kept pitching" : ""
                }:\n${connect}`,
              ];
              const warnFor = (t?: string) =>
                wrongName(t)
                  ? `\n!! WRITTEN TO ${(greetedName(t) ?? "").toUpperCase()} (the signal's named contact) — rework for ${first} before sending.`
                  : "";
              const block = (
                label: string,
                m?: { subject: string; body: string },
              ) => {
                if (!m?.body) return;
                parts.push(
                  `${label}${warnFor(m.body)}\n${m.subject ? `Subject: ${m.subject}\n\n` : ""}${stripEmDashes(m.body)}`,
                );
              };
              block("INMAIL", li.inmail);
              block("FOLLOW-UP 2 (send +5 business days if no reply)", li.followup2);
              block("FOLLOW-UP 3 (send +10 business days if no reply)", li.followup3);
              // Briefs generated before the Aug 2026 restructure have no
              // subjects; render what they do have rather than dropping it.
              if (!li.inmail && (li.dm1 || li.dm)) {
                if (li.dm1) parts.push(`1.${warnFor(li.dm1)} ${stripEmDashes(li.dm1)}`);
                if (li.dm2) parts.push(`2.${warnFor(li.dm2)} ${stripEmDashes(li.dm2)}`);
                if (li.dm3) parts.push(`3.${warnFor(li.dm3)} ${stripEmDashes(li.dm3)}`);
                if (li.dm) parts.push(`1.${warnFor(li.dm)} ${stripEmDashes(li.dm)}`);
                if (li.resurface) parts.push(`2.${warnFor(li.resurface)} ${stripEmDashes(li.resurface)}`);
                parts.push("(Update the brief to regenerate with subjects and follow-ups.)");
              }
              return parts.join("\n\n---\n\n");
            })()
          }
        />
        )}
        {/* Sequencing sits next to the HubSpot push and inherits the same
            gates: a screened title or an unconfirmed name can't be enrolled
            either. Email-only in Phase 1, so a contact with no company address
            says so instead of offering a dead button. */}
        {gate.hubspotTask && !unconfirmed && (
          <div className="mt-2">
            <SequenceActions
              compact
              prospect={{
                email: companyEmail,
                name: displayName,
                title: person.title,
                company,
                companyDomain: domain,
                country: revealedCountry ?? person.country,
                linkedinUrl: profileUrl,
                apolloPersonId: person.apolloId,
                classification:
                  effective === "QUALIFIED"
                    ? "qualified"
                    : effective === "ROUTER"
                      ? "router"
                      : "unresolved",
                sourceSection: "signal_feed",
              }}
            />
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

interface ApolloPeopleResponse {
  ok: boolean;
  error?: string;
  orgName?: string;
  people: EnrichContact[];
  hasMore?: boolean;
  pinned?: EnrichContact;
  /** STAGE 1: the whole account was excluded before any contact was pulled. */
  accountExcluded?: { reason: string; code: string };
  /** STAGE 2: how many surfaced titles the search layer dropped, by rule. */
  excludedCounts?: Record<string, number>;
  surfaced?: number;
}

// How many to show per column, and how many more each "pull more" adds. 4 per
// column = an 8-person, 50/50 map; the rest stay in the pool until pulled.
const PER_COLUMN_STEP = 4;

// Drives the stakeholder map from Apollo's live people-by-title search (real
// people + ids), replacing the model's invented roles. Shows a small balanced
// set and lets the rep pull more (next Apollo page) on demand.
function ApolloStakeholders({
  company,
  accountKey,
  domain,
  ctx,
  keyContact,
}: {
  company: string;
  /** Store key for the parent account (see CompanyIntel's `accountKey`).
   *  Separate from `company`, which is the Apollo/HubSpot SEARCH term and must
   *  stay the brief's name so results don't change. */
  accountKey?: string;
  domain?: string;
  ctx: ContactTaskContext;
  /** Person named in the suggested motion — pinned at the top of the list. */
  keyContact?: { name: string; title?: string };
}) {
  const [people, setPeople] = useState<EnrichContact[]>([]);
  const [pinned, setPinned] = useState<EnrichContact | null>(null);
  const [perColumn, setPerColumn] = useState(PER_COLUMN_STEP);
  const [pageFetched, setPageFetched] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [excludedCounts, setExcludedCounts] = useState<Record<string, number>>({});
  const [surfaced, setSurfaced] = useState(0);
  const [accountBlock, setAccountBlock] = useState<{ reason: string } | null>(null);
  // Rep override for the account screen: once forced, every page of this
  // account's pull carries the flag so "pull more" doesn't re-block.
  const [forced, setForced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pinName = keyContact?.name;

  // Fetch one page of people; append (pull more) or replace (initial load).
  // Dedupes by Apollo id so overlapping pages don't double-list a person. On the
  // initial load, also asks Apollo to look up the motion's named contact (pin).
  const fetchPage = useCallback(
    async (p: number, append: boolean, force = false): Promise<void> => {
      const params = new URLSearchParams({ company, page: String(p) });
      if (domain) params.set("domain", domain);
      if (!append && pinName) params.set("pin", pinName);
      // Forward the brief's signal so each contact's rationale can reference
      // what's actually happening at the account, not just their title.
      if (ctx.callHook) params.set("signal", ctx.callHook.slice(0, 600));
      if (force) params.set("force", "1");
      const res = await fetch(`/api/enrich/apollo/people?${params.toString()}`);
      let body: ApolloPeopleResponse | { error?: string };
      try {
        body = await res.json();
      } catch {
        body = { error: `HTTP ${res.status} — ${res.statusText || "non-JSON response"}` };
      }
      if (!res.ok) {
        if (!append) setError((body as { error?: string }).error || `Apollo people lookup failed (${res.status})`);
        setHasMore(false);
        return;
      }
      const fresh = (body as ApolloPeopleResponse).people ?? [];
      setPeople((prev) => {
        if (!append) return fresh;
        const seen = new Set(prev.map((x) => x.apolloId || x.name));
        return [...prev, ...fresh.filter((x) => !seen.has(x.apolloId || x.name))];
      });
      if (!append) {
        setPinned((body as ApolloPeopleResponse).pinned ?? null);
        setAccountBlock((body as ApolloPeopleResponse).accountExcluded ?? null);
      }
      setExcludedCounts((body as ApolloPeopleResponse).excludedCounts ?? {});
      setSurfaced((body as ApolloPeopleResponse).surfaced ?? 0);
      setHasMore(Boolean((body as ApolloPeopleResponse).hasMore));
      setPageFetched(p);
    },
    // ctx.callHook only: ctx itself is rebuilt every render, which would make
    // fetchPage a new function each time and re-fire the effect that calls it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [company, domain, pinName, ctx.callHook],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPeople([]);
    setPerColumn(PER_COLUMN_STEP);
    fetchPage(1, false).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  // SCROLL PRESERVATION. Appending a page re-sorts the whole grid
  // (qualified-first), which moves or unmounts the very cards the browser was
  // using as its scroll anchor — Chrome then flings the viewport to the top
  // of the list. So we anchor manually: note where the pull-more button sits
  // in the viewport when it's clicked, and after the new cards commit, scroll
  // by exactly how far it moved.
  //
  // MUST live ABOVE the early returns below: these hooks originally sat next
  // to pullMore(), after `if (loading) return`, so the component mounted with
  // fewer hooks than it re-rendered with — React error #310, and the app
  // died the moment any brief's contact list finished loading.
  const pullAnchorRef = useRef<HTMLDivElement>(null);
  const pendingAnchorTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingAnchorTop.current === null) return;
    const el = pullAnchorRef.current;
    if (el) {
      const moved = el.getBoundingClientRect().top - pendingAnchorTop.current;
      if (moved !== 0) window.scrollBy(0, moved);
    }
    pendingAnchorTop.current = null;
  }, [people, perColumn]);

  if (loading) {
    return (
      <div className="space-y-3">
        <p className="font-mono text-xs text-sky-400">▸ searching Apollo for engineering and data stakeholders…</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }
  if (error) return <p className="text-sm text-red-400">{error}</p>;

  const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // The motion's named contact, resolved in DESCENDING order of confidence:
  //   1. Apollo's dedicated lookup (findPinned) — a real record with an
  //      apolloId, so email/LinkedIn/HubSpot all work.
  //   2. The same person already in the main results — equally enriched. This
  //      case used to be the bug: the synthesized card below matched by name in
  //      isPinned() and EVICTED this fully-enriched record from the grid, so
  //      the screen showed the unreachable copy of a person we had complete
  //      data for.
  //   3. Nothing found — a bare card from the LLM's own name/title, which is
  //      UNCONFIRMED: nobody has verified this person exists at this company.
  const fromResults =
    !pinned && keyContact?.name
      ? people.find((p) => nameKey(p.name) === nameKey(keyContact.name!))
      : undefined;
  const pinnedContact: EnrichContact | undefined =
    pinned ??
    fromResults ??
    (keyContact?.name ? { name: keyContact.name, title: keyContact.title } : undefined);
  /** True when no provider record backs this person — the name came only from
   *  the brief's generated motion and was never corroborated. */
  const pinnedUnconfirmed = !pinned && !fromResults && !!pinnedContact;

  /** STAGE 2 accounting, in words: what the search layer dropped and why. */
  const excludedNote = (() => {
    const entries = Object.entries(excludedCounts).filter(([, n]) => n > 0);
    if (entries.length === 0) return "";
    const total = entries.reduce((a, [, n]) => a + n, 0);
    const parts = entries
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${n} ${REASON_LABEL[code as ICPReasonCode] ?? code.toLowerCase()}`);
    return `Excluded ${total} of ${surfaced || total} surfaced titles at search: ${parts.join(", ")}.`;
  })();

  // STAGE 1 — the account itself is excluded, so no contacts were pulled at all.
  // Said plainly, with the reason, because "no contacts" and "we deliberately
  // did not look" are different facts.
  if (accountBlock) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-950/50 p-4">
        <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-400">
          account excluded
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{accountBlock.reason}</p>
        <p className="mt-1.5 text-[11px] text-ink-600">
          No contacts were pulled and no credits were spent. If a division here runs its own
          data or software engineering org, prospect that division directly.
        </p>
        {/* The category call is a heuristic and the rep can see the whole
            brief. When the evidence contradicts it (a real data org, a live
            data-platform signal, a big ICP score), the rep's judgment
            outranks the screen. */}
        <button
          type="button"
          onClick={() => {
            setForced(true);
            setAccountBlock(null);
            setError(null);
            setLoading(true);
            fetchPage(1, false, true).finally(() => setLoading(false));
          }}
          className="mt-3 inline-flex items-center gap-1.5 rounded border border-neon-600/40 bg-neon-500/10 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-neon-300 transition-colors hover:bg-neon-500/20"
        >
          Pull contacts anyway
        </button>
        <p className="mt-1.5 text-[11px] text-ink-600">
          Overrides the account screen — for when the brief&rsquo;s own evidence (a real data or
          software org, a live data-platform signal) contradicts the category call.
        </p>
      </div>
    );
  }
  if (people.length === 0 && !pinnedContact) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-ink-500">No engineering or data stakeholders surfaced from Apollo.</p>
        {excludedNote && <p className="font-mono text-[11px] text-ink-600">{excludedNote}</p>}
      </div>
    );
  }
  const isPinned = (p: EnrichContact) =>
    !!pinnedContact &&
    ((!!p.apolloId && p.apolloId === pinnedContact.apolloId) ||
      nameKey(p.name) === nameKey(pinnedContact.name));

  // Drop the pinned person from the list so they're not shown twice.
  const rest = pinnedContact ? people.filter((p) => !isPinned(p)) : people;
  //
  // NOTHING IS FILTERED OUT OF THIS LIST. Every surfaced contact renders, with
  // its tier on it.
  //
  // PASS used to be dropped from the grid, then (briefly) moved into a collapsed
  // "screened out" disclosure. Both are the same mistake wearing different
  // clothes: a list that silently shrinks tells you nothing about WHY, and a
  // tier badge means nothing when the only tiers on screen are the good ones.
  // ANCHOR is informative because PASS is sitting three cards below it saying
  // "devops / sre".
  //
  // The reason PASS was dropped in the first place was cost — every rendered
  // card auto-reveals an email, which is an Apollo credit. That is solved by
  // not auto-spending on a screened card (see `screened` below) rather than by
  // hiding it.
  //
  // A FAILED verdict is not a verdict at all. Treat it as "no verdict" so the
  // seniority heuristic decides, exactly as for briefs cached before the
  // scorer existed. Without this, a rate-limited batch reported "screened out
  // 36 of 36" and rendered an empty section — an outage indistinguishable from
  // a deliberate screening.
  const graded = (p: EnrichContact) => (p.icp && !p.icp.failed ? p.icp : undefined);
  /** The state this contact displays under. Legacy verdicts (ANCHOR/TARGET/
   *  PASS, cached before Aug 4 2026) are mapped by normalizeClass. */
  const tierOf = (p: EnrichContact): ICPClass => {
    const v = graded(p);
    if (v) return normalizeClass(v.classification);
    // No usable verdict. UNRESOLVED is the honest answer; the spec is explicit
    // that the tool must be willing to say it does not know.
    return "UNRESOLVED";
  };
  // STAGE 2/6 — EXCLUDED contacts are dropped at the search layer and never
  // reach this component. Anything still here that reads EXCLUDED came from a
  // legacy PASS verdict on a cached brief, so filter it for the same reason.
  const shownPool = rest.filter((p) => tierOf(p) !== "EXCLUDED");
  const legacyExcluded = rest.length - shownPool.length;
  const countOf = (list: EnrichContact[], cls: ICPClass) =>
    list.filter((p) => tierOf(p) === cls).length;
  /** Profiles the classifier could not judge at all — surfaced separately so a
   *  classifier outage never masquerades as a screening decision. */
  const unclassified = rest.filter((p) => p.icp?.failed).length;

  // ORDERING. QUALIFIED first, then ROUTER (at most one per account), then the
  // UNRESOLVED bulk. Reachability breaks ties inside a state.
  const rank = (p: EnrichContact) => {
    let s = (TIER_RANK[tierOf(p)] ?? 2) * 100;
    if (p.apolloId) s -= 10; // no id means no email can ever be revealed
    if (p.linkedinUrl) s -= 5; // a resolved profile beats a name search
    if (p.icp?.confidence === "high") s -= 2;
    return s;
  };
  const ordered = [...shownPool].sort((a, b) => rank(a) - rank(b));
  const dmShown = ordered.slice(0, perColumn * 2);
  const decisionMakers = shownPool;

  // STAGE 4 distribution check, surfaced rather than silently re-run: if every
  // visible contact carries the same state the classifier has failed, and the
  // rep should know that rather than trust a uniform badge.
  const distinctStates = new Set(dmShown.map(tierOf)).size;
  const uniformBadge = dmShown.length > 2 && distinctStates === 1;
  const routerCount = countOf(dmShown, "ROUTER");


  const poolHasMore = shownPool.length > perColumn * 2;
  const canPullMore = poolHasMore || hasMore;

  const pullMore = async () => {
    if (loadingMore) return;
    const shown = perColumn * 2;
    pendingAnchorTop.current = pullAnchorRef.current?.getBoundingClientRect().top ?? null;
    // Pool exhausted → fetch the next Apollo page and let it render into the
    // CURRENT window. Widening here as well would dump a whole page of cards at
    // once, and every card auto-reveals an email on mount.
    if (decisionMakers.length <= shown && hasMore) {
      setLoadingMore(true);
      await fetchPage(pageFetched + 1, true, forced).finally(() => setLoadingMore(false));
      return;
    }
    setPerColumn(perColumn + PER_COLUMN_STEP);
  };

  return (
    <div className="space-y-4">
      {pinnedContact && (
        <div
          className={`rounded-lg border p-3 ${
            pinnedUnconfirmed
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-violet-500/30 bg-violet-500/5"
          }`}
        >
          {pinnedUnconfirmed ? (
            // The brief NAMED this person, but no provider record corroborates
            // them. Say that outright rather than presenting a generated name
            // with the same authority as an Apollo-backed contact.
            <div className="mb-3">
              <p className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-amber-300">
                <Compass className="h-3.5 w-3.5" /> first move — unconfirmed
              </p>
              <p className="mt-1 text-[11px] leading-snug text-ink-400">
                Named by the brief&rsquo;s suggested motion, but not found in Apollo for{" "}
                {company}. Treat the name as a lead to verify, not a contact: there is no
                record behind it, so no email, LinkedIn, or HubSpot link can be resolved.
              </p>
            </div>
          ) : (
            <p className="mb-3 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-violet-300">
              <Compass className="h-3.5 w-3.5" /> first move — named in the suggested motion
            </p>
          )}
          <ApolloPersonCard
            person={pinnedContact}
            company={company}
            accountKey={accountKey}
            domain={domain}
            ctx={ctx}
            autoCheckDelayMs={0}
            hideWithoutEmail={false}
            unconfirmed={pinnedUnconfirmed}
          />
        </div>
      )}

      <div>
        <p className="mb-3 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-neon-400/90">
          signs / gates the deal
        </p>
        {/* STAGE 1/2 — excluded is not the same as silent. The cards are gone,
            the accounting is not. */}
        {(decisionMakers.length === 0 || unclassified > 0 || excludedNote || uniformBadge) && (
          <p className="mb-3 text-xs text-ink-500">
            {decisionMakers.length === 0 &&
              `No contacts survived the title filter${surfaced ? ` — all ${surfaced} surfaced titles were excluded` : ""}. `}
            {excludedNote && <span>{excludedNote} </span>}
            {legacyExcluded > 0 && (
              <span>
                {legacyExcluded} more excluded from this cached brief&apos;s older scoring.{" "}
              </span>
            )}
            {uniformBadge && (
              <span className="text-amber-400/90">
                Every visible contact carries the same state, which means the classifier did not
                differentiate them — treat these as unreviewed.{" "}
              </span>
            )}
            {unclassified > 0 && (
              <span className="text-amber-400/90">
                {unclassified} profile{unclassified === 1 ? "" : "s"} could not be scored (the
                scorer errored, not a screening decision) — reload to retry.
              </span>
            )}
          </p>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {dmShown.map((p, i) => (
            <ApolloPersonCard
              key={p.apolloId || `dm-${i}`}
              person={p}
              company={company}
              accountKey={accountKey}
              domain={domain}
              ctx={ctx}
              autoCheckDelayMs={i * 300}
              state={tierOf(p)}
            />
          ))}
        </div>
      </div>

      {/* STAGE 4: at most one ROUTER per account is expected. More than that
          means the classifier reached for it as a fallback. */}
      {routerCount > 0 && (
        <p className="font-mono text-[11px] text-ink-500">
          {routerCount === 1
            ? "One ROUTER here — ask who owns the data platform rather than pitching."
            : `${routerCount} ROUTERs here. The spec expects at most one per account, so treat the extras as unclassified rather than as routes.`}
        </p>
      )}

      {canPullMore && (
        <div className="flex justify-center" ref={pullAnchorRef}>
          <button
            onClick={pullMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-4 py-2 font-mono text-xs font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-200 disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
            {loadingMore ? "Pulling…" : "Pull more contacts"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The engineers chip on the brief header (software + data engineers),
 *  editable: once the real engineer count comes up on a call, the rep sets it
 *  here and the confirmed number overrides the modeled estimate everywhere the
 *  account renders — chips, task notes, and the personalized proposal's
 *  modeled spend. Shared with the whole team. */
function SweChip({
  companyKey,
  modeled,
  override,
}: {
  companyKey: string;
  modeled?: number;
  override?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const begin = () => {
    setDraft(String(override ?? modeled ?? ""));
    setFailed(false);
    setEditing(true);
  };
  const save = async () => {
    const n = Math.round(Number(draft.replace(/[,\s]/g, "")));
    if (!Number.isFinite(n) || n < 1) return;
    setSaving(true);
    const ok = await setSweOverride(companyKey, n);
    setSaving(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };
  const reset = async () => {
    setSaving(true);
    const ok = await clearSweOverride(companyKey);
    setSaving(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-ink-950 px-2 py-0.5 font-mono text-xs">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="eng count"
          inputMode="numeric"
          className="w-20 bg-transparent text-ink-100 placeholder:text-ink-600 focus:outline-none"
        />
        <button
          onClick={() => void save()}
          disabled={saving}
          title="Save — this confirmed count overrides the estimate for this account everywhere"
          className="text-neon-300 hover:text-neon-200 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        {override !== undefined && (
          <button
            onClick={() => void reset()}
            disabled={saving}
            title="Clear the confirmed count — go back to the modeled estimate"
            className="text-ink-500 hover:text-ink-300 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {failed && <span className="text-[10px] text-red-400">didn&apos;t save</span>}
      </span>
    );
  }

  const shown = override ?? modeled;
  return (
    <button
      onClick={begin}
      title={
        override !== undefined
          ? "Engineer count (software + data) confirmed on a call — click to adjust"
          : shown
            ? "Modeled estimate of software + data engineers — click to set the real count from a call"
            : "Click to set the engineer count (software + data) from a call"
      }
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
        override !== undefined
          ? "border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
          : "border-ink-700 bg-ink-950 text-ink-300 hover:border-sky-500/40 hover:text-sky-300"
      }`}
    >
      {shown
        ? `${override !== undefined ? "" : "~"}${fmtNum(shown)} eng${override !== undefined ? " · confirmed" : ""}`
        : "set eng count"}
      <Pencil className="h-3 w-3 opacity-60" />
    </button>
  );
}

/** Monthly spend on the data systems SingleStore could consolidate (serving-
 *  layer databases and replicas, real-time analytics store, cache, search,
 *  vector DB, ETL/CDC tooling), feeding the proposal ROI. Stored in $K/month.
 *  Real spend is rarely public, so until the rep sets the account's figure
 *  from a call the proposal MODELS it as engineers × this per-engineer
 *  CUSTOMER ASSUMPTION. Shared with the team. Keep in sync with
 *  DEFAULT_DATA_SPEND_PER_ENG_MO in app/api/proposal/route.ts. */
const DEFAULT_DATA_SPEND_PER_ENG_MO = 250;
/** $K → "$120K" / "$1.2M". */
const fmtK = (k: number) => (k >= 1000 ? `$${Math.round(k / 100) / 10}M` : `$${Math.round(k).toLocaleString()}K`);
function SpendChip({
  companyKey,
  override,
  engineers,
}: {
  companyKey: string;
  /** Call-confirmed spend, $K/month. */
  override?: number;
  /** Engineering headcount the modeled default is built on. */
  engineers?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The modeled default in $K/month, when there is an engineer count. */
  const modeledK = engineers ? Math.max(1, Math.round((engineers * DEFAULT_DATA_SPEND_PER_ENG_MO) / 1000)) : undefined;

  const begin = () => {
    setDraft(String(override ?? modeledK ?? ""));
    setFailed(false);
    setEditing(true);
  };
  const save = async () => {
    const n = Math.round(Number(draft.replace(/[$,\sKk]/g, "")));
    // Cap matches the proposal route's clamp ($1K..$100M a month) — a value
    // the route would silently drop must never save as "confirmed" here.
    if (!Number.isFinite(n) || n < 1 || n > 100_000) {
      setFailed(true);
      return;
    }
    setSaving(true);
    const ok = await setSpendOverride(companyKey, n);
    setSaving(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };
  const reset = async () => {
    setSaving(true);
    const ok = await clearSpendOverride(companyKey);
    setSaving(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-ink-950 px-2 py-0.5 font-mono text-xs">
        <span className="text-ink-500">$</span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="K / mo"
          inputMode="numeric"
          className="w-20 bg-transparent text-ink-100 placeholder:text-ink-600 focus:outline-none"
        />
        <span className="text-ink-500">K/mo</span>
        <button
          onClick={() => void save()}
          disabled={saving}
          title={`Save — the proposal ROI uses this account figure ($K per month on the systems in scope) instead of the modeled $${DEFAULT_DATA_SPEND_PER_ENG_MO}/engineer/month assumption`}
          className="text-neon-300 hover:text-neon-200 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        {override !== undefined && (
          <button
            onClick={() => void reset()}
            disabled={saving}
            title={`Clear — go back to the modeled $${DEFAULT_DATA_SPEND_PER_ENG_MO}/engineer/month assumption`}
            className="text-ink-500 hover:text-ink-300 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {failed && <span className="text-[10px] text-red-400">didn&apos;t save</span>}
      </span>
    );
  }

  const shown = override ?? modeledK;
  return (
    <button
      onClick={begin}
      title={
        override !== undefined
          ? "Monthly spend on the data systems SingleStore could consolidate, confirmed on a call — click to adjust"
          : `MODELED as ${DEFAULT_DATA_SPEND_PER_ENG_MO} USD per engineer per month on the systems SingleStore could consolidate (databases and replicas, real-time analytics, cache, search, vector, ETL/CDC). A customer assumption that feeds the proposal ROI — click to set the account's real number`
      }
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
        override !== undefined
          ? "border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
          : "border-ink-700 bg-ink-950 text-ink-300 hover:border-sky-500/40 hover:text-sky-300"
      }`}
    >
      {shown !== undefined
        ? `${override !== undefined ? "" : "~"}${fmtK(shown)}/mo data infra${override !== undefined ? " · confirmed" : " · modeled"}`
        : "set data-infra spend"}
      <Pencil className="h-3 w-3 opacity-60" />
    </button>
  );
}

export function CompanyIntel({
  intel,
  accountKey,
  onBack,
  onRefresh,
  onCollapse,
}: {
  intel: Intel;
  /** The name the FEED knows this account by — the key every client store is
   *  read under (prospected marks, deep-dive score, HubSpot presence).
   *
   *  `intel.name` is model output and drifts from the card that opened the
   *  brief: "Anthem" comes back as "Elevance Health (formerly Anthem, Inc.)",
   *  "General Electric" as "GE Aerospace". Marks written under the brief's name
   *  were unreadable from the feed, so a pushed account stayed grey. 18 of 170
   *  briefs drift; 12 had marks stranded that way. */
  accountKey?: string;
  onBack: () => void;
  /** Force-regenerate this brief (bypasses the cache). */
  onRefresh?: () => void;
  /** Collapse the whole record (card) to its slim row — card-attached briefs only. */
  onCollapse?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const acctKey = accountKey?.trim() || intel.name;
  // Both names this account answers to. The feed row and the brief disagree far
  // more often than you'd think ("Tesla Motors" vs "Tesla, Inc.", "Anthem" vs
  // "Elevance Health"), and the Signal 2000 sometimes carries a separate row
  // per spelling. Marking only one leaves the other grey.
  const companyAliases = [acctKey, intel.name];
  const companyProspected = useIsProspected("company", acctKey);
  const companyProspectedAt = useProspectedAt("company", acctKey);
  const companyTeamSync = useCompanySyncEvent(acctKey);
  const companyTeamChip = companyTeamSync && !companyTeamSync.mine ? companyTeamSync : undefined;

  // Rep-confirmed engineering headcount (set via the header chip once the real
  // number comes up on a call) overrides the modeled estimate in everything
  // this brief feeds: chips, task notes, and the personalized proposal.
  const sweOverride = useSweOverride(acctKey);
  const swe = sweOverride ?? intel.sweEstimate;
  // Monthly data-infrastructure spend on the systems SingleStore could
  // consolidate ($K/month, call-confirmed) — feeds the proposal ROI in place
  // of the modeled per-engineer default.
  const spendOverride = useSpendOverride(acctKey);

  // On-demand sections: the brief now generates lean (summary / ICP / people /
  // motion + outreach). These heavier sections are pulled only when expanded.
  // Seed from the brief in case it already has them (older brief, or a prior
  // expand that persisted to the cache).
  const [whySingleStore, setWhySingleStore] = useState<string[]>(intel.whySingleStore ?? []);
  const [painPoints, setPainPoints] = useState(intel.painPoints ?? []);
  const [dataCost, setDataCost] = useState(
    intel.dataCost && intel.dataCost.estimatedMonthlyUsd > 0 ? intel.dataCost : null,
  );
  const [motionDetail, setMotionDetail] = useState({
    reasoning: intel.motion.reasoning ?? "",
    watchOuts: intel.motion.watchOuts ?? [],
  });
  // Motion & outreach collapses by default like data-cost / pain-points
  // (Max, Aug 28). The data is already in the brief — this is purely a
  // reveal, no fetch.
  const [motionOpen, setMotionOpen] = useState(false);
  // productFocus rides along so an on-demand section leads with the same
  // entry workload the brief does (realtime unless the brief chose ai).
  const expandCtx = {
    company: intel.name,
    segment: intel.segment?.label,
    summary: intel.summary,
    productFocus: intel.productFocus,
  };

  // Cache this brief's authoritative ICP total so the signal cards can show it
  // instead of their rougher per-signal estimate.
  useEffect(() => {
    setDeepDiveScore(acctKey, intel.icp.total);
  }, [acctKey, intel.icp.total]);

  // Same for the brief's researched engineer count (software + data): it
  // corrects the row's raw Apollo engineering-dept number (which counts
  // mechanical engineers at industrial firms — Donaldson: dept ~1.1K vs ~120
  // actual software engineers). Card chips and task notes pick it up; the rep's confirmed
  // override still outranks it. A brief WITHOUT an estimate retracts any
  // previously cached one, so cards never quote a number the current brief
  // no longer makes.
  useEffect(() => {
    if (intel.sweEstimate) setBriefSwe(acctKey, intel.sweEstimate);
    else clearBriefSwe(acctKey);
  }, [acctKey, intel.sweEstimate]);

  // Company-level context woven into each contact's HubSpot task.
  const contactCtx: ContactTaskContext = {
    companyLine:
      `${intel.name} — ${intel.segment.label}` +
      `${intel.employeeBand ? `, ${intel.employeeBand} employees` : ""}` +
      `${swe ? `, ${sweOverride !== undefined ? `${fmtNum(swe)} engineers (confirmed)` : `~${fmtNum(swe)} engineers`}` : ""}` +
      `. ICP fit ${intel.icp.total}/99.${intel.oneLiner ? ` ${intel.oneLiner}` : ""}`,
    callHook: intel.callHook,
    linkedin: intel.linkedinOutreach,
    emailOpener: intel.emailOpener,
    outreach: stripEmDashes(intel.outreach.draftMessage || intel.outreach.hook || ""),
  };

  // Cached briefs generated before the current outreach spec can carry
  // banned phrases or unapproved figures, and pushing them copies that
  // verbatim into a HubSpot task. Detect it the
  // same way the generators are policed (bannedHits) plus the pre-spec
  // dm/resurface shape, and flag instead of serving it silently.
  const outreachStale = useMemo(() => {
    const li = (intel.linkedinOutreach ?? {}) as Record<string, unknown>;
    const legacyShape = !!intel.linkedinOutreach && !li.inmail && !!(li.dm || li.resurface);
    const msgText = (m: unknown): string =>
      typeof m === "string" ? m : m && typeof m === "object" ? String((m as { body?: unknown }).body ?? "") : "";
    const texts = [
      typeof li.connect === "string" ? li.connect : "",
      msgText(li.inmail),
      msgText(li.followup2),
      msgText(li.followup3),
      msgText(li.dm),
      msgText(li.resurface),
      intel.emailOpener ?? "",
      intel.outreach?.draftMessage ?? "",
    ].filter(Boolean);
    return legacyShape || texts.some((t) => bannedHits(t).length > 0);
  }, [intel]);

  const copyDraft = async () => {
    if (!navigator.clipboard) {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(stripEmDashes(intel.outreach.draftMessage));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    }
  };

  return (
    <div className="space-y-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-ink-400 transition-colors hover:text-ink-50"
          >
            <X className="h-4 w-4" /> Close brief
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Collapse this record to a slim row (keeps its place in the feed)"
              className="inline-flex items-center gap-1.5 text-sm text-ink-400 transition-colors hover:text-ink-50"
            >
              <Minimize2 className="h-4 w-4" /> Collapse
            </button>
          )}
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            title="Re-run the live research and replace this cached brief"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 font-mono text-xs font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-300"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Update brief
          </button>
        )}
      </div>

      {/* Title row */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-bold tracking-tight text-ink-50 sm:text-3xl">
            {intel.name}
          </h2>
          {intel.oneLiner ? (
            <p className="mt-1 text-sm text-ink-300">{intel.oneLiner}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {companyProspected && (
              <span
                title="Already prospected — a HubSpot task exists for this company or one of its contacts"
                className="inline-flex items-center gap-1.5 rounded-md border border-orange-500/40 bg-orange-500/15 px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-orange-200"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neon-500 text-ink-950">
                  <Check className="h-3.5 w-3.5" strokeWidth={3.5} />
                </span>
                Prospected · sent to HubSpot{companyProspectedAt ? ` · ${fmtDate(companyProspectedAt)}` : ""}
              </span>
            )}
            {companyTeamChip && (
              <span
                title={`Synced to ${companyTeamChip.by}'s HubSpot on ${new Date(companyTeamChip.at).toLocaleDateString("en-US")}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 font-mono text-xs font-semibold text-sky-300"
              >
                synced by {companyTeamChip.by} · {new Date(companyTeamChip.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
            <span className="rounded border border-neon-600/30 bg-neon-500/10 px-2 py-0.5 font-mono text-xs font-medium text-neon-300">
              {intel.segment.label}
            </span>
            {intel.employeeBand && (
              <span className="rounded border border-ink-700 bg-ink-950 px-2 py-0.5 font-mono text-xs text-ink-300">
                {intel.employeeBand} employees
              </span>
            )}
            <SweChip companyKey={acctKey} modeled={intel.sweEstimate} override={sweOverride} />
            <SpendChip companyKey={acctKey} override={spendOverride} engineers={swe} />
            {intel.hq && (
              <span className="rounded border border-ink-700 bg-ink-950 px-2 py-0.5 font-mono text-xs text-ink-400">
                {intel.hq}
              </span>
            )}
          </div>
          <p className="mt-2 font-mono text-[11px] text-ink-500">
            generated {new Date(intel.generatedAt).toLocaleString("en-US")} · live web
            research · cached until updated
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            s2 icp fit
          </p>
          <p className="font-mono text-5xl font-bold leading-none text-neon-400">
            {intel.icp.total}
            <span className="text-lg font-medium text-ink-500">/99</span>
          </p>
        </div>
      </div>

      {/* HubSpot — check the account / create a task with the signal context */}
      <HubSpotActions
        kind="company"
        name={intel.name}
        companyKey={acctKey}
        companyAliases={companyAliases}
        domain={intel.domain}
        autoCheck
        proposal={{
          // The brief is the richest context any surface has — signal, summary
          // and the motion's named contact all feed the personalization.
          context:
            `${intel.callHook ? `Signal: ${intel.callHook}\n` : ""}${intel.summary ?? ""}`.slice(0, 1400),
          sweEstimate: swe,
          sweConfirmed: sweOverride !== undefined,
          spendMo: spendOverride,
          icpTotal: intel.icp.total,
          contactName: intel.motion?.keyContactName,
          contactTitle: intel.motion?.keyContactTitle,
          // Structured research: the ICP rationale and the streaming evidence
          // are the densest architecture text the brief produces, and are what
          // the operational narrative leads with.
          research: {
            summary: intel.summary,
            signal: intel.callHook,
            oneLiner: intel.oneLiner,
            segment: intel.segment?.label,
            hq: intel.hq,
            employeeBand: intel.employeeBand,
            icpRationale: intel.icp?.rationale,
            streamingEvidence: intel.icp?.streaming?.detected ? intel.icp.streaming.evidence : undefined,
            migrationDrivers: intel.migration?.drivers,
            painPoints: painPoints.map((p) => ({ title: p.title, evidence: p.evidence })),
            whySingleStore,
            focus: intel.productFocus,
            citations: (intel.citations ?? []).map((c) => c.title).filter(Boolean),
          },
        }}
        defaultSubject={`SIGNAL DASH - ${intel.name}`}
        defaultBody={
          `${intel.name} — ${intel.segment.label}` +
          `${intel.employeeBand ? `, ${intel.employeeBand} employees` : ""}` +
          `${swe ? `, ${sweOverride !== undefined ? `${fmtNum(swe)} engineers (confirmed)` : `~${fmtNum(swe)} engineers`}` : ""}.\n` +
          `${intel.oneLiner ? `${intel.oneLiner}\n` : ""}` +
          `${intel.callHook ? `\nWHAT I SAW: ${intel.callHook}\n` : ""}` +
          `\nSingleStore ICP fit: ${intel.icp.total}/99. ${intel.summary}` +
          `${whySingleStore.length ? `\n\nWhy SingleStore: ${whySingleStore.slice(0, 2).join("; ")}` : ""}`
        }
      />

      {/* Executive summary — the single narrative for the account (the ICP
          rationale used to duplicate this, so it's dropped; the score lives in
          the breakdown below). */}
      <Section title="executive summary" icon={Zap} iconColor="text-amber-400">
        {intel.callHook && (
          <div className="mb-4 rounded-lg border-l-2 border-neon-500 bg-neon-500/[0.07] px-3.5 py-2.5">
            <p className="mb-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-neon-400">
              what i saw
            </p>
            <p className="text-[15px] font-medium leading-snug text-ink-100">{intel.callHook}</p>
          </div>
        )}
        <p className="text-sm leading-relaxed text-ink-200">{intel.summary}</p>
        <div className="mt-4 border-t border-ink-700 pt-4">
          {whySingleStore.length > 0 ? (
            <ol className="space-y-3">
              {whySingleStore.map((reason, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neon-600/30 bg-neon-500/10 font-mono text-xs font-semibold text-neon-300">
                    {i + 1}
                  </span>
                  <p className="text-sm leading-relaxed text-ink-300">{reason}</p>
                </li>
              ))}
            </ol>
          ) : (
            <ExpandButton
              label="Why SingleStore — pull the fit reasons"
              section="whySingleStore"
              ctx={expandCtx}
              onData={(d) => setWhySingleStore((d.whySingleStore as string[]) ?? [])}
            />
          )}
        </div>
      </Section>

      {/* ICP score breakdown — the quantified score behind the summary. */}
      <Section title="icp score breakdown" icon={Target} iconColor="text-neon-400">
        <div className="space-y-3">
          {ICP_BARS.map(({ key, label }) => {
            const v = intel.icp[key];
            const pct = Math.round((v / 20) * 100);
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-xs text-ink-300 sm:w-56 sm:text-sm">{label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-neon-600 to-neon-400"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-12 text-right font-mono text-sm font-semibold tabular-nums text-ink-200">
                  {pct}%
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Stakeholder map — real people, live from Apollo people search */}
      <Section
        title="suggested people to contact"
        icon={Users}
        iconColor="text-sky-400"
      >
        <ApolloStakeholders
          company={intel.name}
          accountKey={acctKey}
          domain={intel.domain}
          ctx={contactCtx}
          keyContact={
            intel.motion.keyContactName
              ? { name: intel.motion.keyContactName, title: intel.motion.keyContactTitle }
              : undefined
          }
        />
      </Section>

      {/* Motion + outreach — one box: how to approach, then the angle/message.
          Collapsed by default like the data-cost / pain-points sections; the
          stale-outreach flag stays visible even collapsed (it's a warning). */}
      <Section title="suggested motion & outreach" icon={Compass} iconColor="text-violet-400">
        {!motionOpen ? (
          <div className="space-y-3">
            {outreachStale && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <p className="text-xs font-medium leading-snug text-amber-300">
                  This outreach fails the current outreach spec — update the brief to regenerate it
                  before sending.
                </p>
                {onRefresh && (
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="rounded border border-amber-500/40 px-2 py-1 font-mono text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-500/20"
                  >
                    Update brief
                  </button>
                )}
              </div>
            )}
            <button
              onClick={() => setMotionOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-ink-600 px-3 py-1.5 font-mono text-[11px] font-medium text-ink-300 transition-colors hover:border-neon-600/50 hover:text-neon-300"
            >
              <Plus className="h-3.5 w-3.5" /> Show motion &amp; outreach
            </button>
          </div>
        ) : (
          <>
        <div className="flex flex-wrap items-center gap-3">
          <MotionBadge motion={intel.motion.primary} />
          <p className="text-sm text-ink-400">recommended GTM motion for this account</p>
        </div>
        {intel.motion.firstMove && (
          <p className="mt-3 rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-sm leading-relaxed text-ink-200">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-violet-400">
              first move:{" "}
            </span>
            {intel.motion.firstMove}
          </p>
        )}
        {/* Deeper motion analysis — pulled on demand to keep the brief lean. */}
        {motionDetail.reasoning ? (
          <>
            <p className="mt-3 text-sm leading-relaxed text-ink-300">{motionDetail.reasoning}</p>
            {motionDetail.watchOuts.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs text-ink-400">
                {motionDetail.watchOuts.map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400/70" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="mt-3">
            <ExpandButton
              label="Expand analysis — why this motion + watch-outs"
              section="motionDetail"
              ctx={expandCtx}
              subtle
              onData={(d) =>
                setMotionDetail({
                  reasoning: String(d.reasoning ?? ""),
                  watchOuts: (d.watchOuts as string[]) ?? [],
                })
              }
            />
          </div>
        )}

        {/* Outreach angle */}
        <div className="mt-5 border-t border-ink-700 pt-4">
          <p className="mb-3 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-neon-400/90">
            <Send className="h-3.5 w-3.5" /> outreach angle
          </p>
          {outreachStale && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <p className="text-xs font-medium leading-snug text-amber-300">
                This outreach fails the current outreach spec — update the brief to regenerate it before
                sending.
              </p>
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="rounded border border-amber-500/40 px-2 py-1 font-mono text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-500/20"
                >
                  Update brief
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-[11px] font-semibold text-ink-300">
              {intel.outreach.channel}
            </span>
            <p className="text-sm font-semibold italic text-ink-100">
              &ldquo;{stripEmDashes(intel.outreach.hook)}&rdquo;
            </p>
          </div>
          {intel.outreach.proof && (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-400">
              <Link2 className="mt-0.5 h-3 w-3 shrink-0 text-ink-500" />
              Backed by: {intel.outreach.proof}
            </p>
          )}
          {intel.outreach.draftMessage && (
            <div className="relative mt-3">
              <pre className="whitespace-pre-wrap break-words rounded-lg border border-ink-700 bg-ink-950 p-4 font-mono text-[13px] leading-relaxed text-ink-200">
                {stripEmDashes(intel.outreach.draftMessage)}
              </pre>
              <button
                onClick={copyDraft}
                className={`absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-900 px-2 py-1 text-[11px] font-medium transition-colors ${
                  copyFailed ? "text-red-400" : "text-ink-400 hover:text-neon-300"
                }`}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copyFailed ? "copy failed — select manually" : copied ? "copied" : "copy"}
              </button>
            </div>
          )}
        </div>
          </>
        )}
      </Section>

      {/* Data-estate cost & consolidation exposure — pulled on demand */}
      <Section title="data-estate cost & consolidation exposure" icon={Coins} iconColor="text-amber-400">
        {dataCost ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-4">
                <p
                  title="MODELED monthly spend on the systems SingleStore could consolidate — not their known bill"
                  className="font-mono text-[10px] uppercase tracking-wider text-ink-400"
                >
                  modeled in-scope spend / mo
                </p>
                <p className="mt-1 font-mono text-2xl font-bold text-amber-400">
                  {dataCost.estimatedMonthlyUsd > 0 ? fmtUSD(dataCost.estimatedMonthlyUsd) : "—"}
                </p>
              </div>
              <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-4">
                <p
                  title={dataCost.systems?.length ? `Evidenced: ${dataCost.systems.join(", ")}` : "Evidenced data systems in the serving path"}
                  className="font-mono text-[10px] uppercase tracking-wider text-ink-400"
                >
                  data systems in scope
                </p>
                <p className="mt-1 font-mono text-2xl font-bold text-ink-100">
                  {dataCost.systemsCount > 0 ? fmtNum(dataCost.systemsCount) : "—"}
                </p>
              </div>
              <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-4">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ink-400">avg per system / mo</p>
                <p className="mt-1 font-mono text-2xl font-bold text-ink-100">
                  {dataCost.perSystemUsd > 0 ? fmtUSD(dataCost.perSystemUsd) : "—"}
                </p>
              </div>
              <div className="rounded-lg border border-neon-600/30 bg-neon-500/5 p-4">
                <p
                  title="MODELED monthly reduction from consolidation, using a published consolidation claim as the scenario rate — not a prediction"
                  className="font-mono text-[10px] uppercase tracking-wider text-neon-400/80"
                >
                  consolidation offset / mo
                </p>
                <p className="mt-1 font-mono text-2xl font-bold text-neon-300">
                  {dataCost.s2OffsetUsd ? fmtUSD(dataCost.s2OffsetUsd) : "—"}
                </p>
              </div>
            </div>
            {dataCost.systems && dataCost.systems.length > 0 && (
              <p className="mt-3 font-mono text-[11px] text-ink-400">
                in scope (evidenced): {dataCost.systems.join(" · ")}
              </p>
            )}
            {dataCost.notes && (
              <p className="mt-3 text-xs italic leading-relaxed text-ink-500">
                Modeled, not their known spend — assumptions: {dataCost.notes}
              </p>
            )}
          </>
        ) : (
          <ExpandButton
            label="Estimate data-estate cost exposure"
            section="dataCost"
            ctx={expandCtx}
            onData={(d) => setDataCost((d.dataCost as typeof dataCost) ?? null)}
          />
        )}
      </Section>

      {/* Pain points — pulled on demand */}
      <Section title="likely pain points" icon={AlertTriangle} iconColor="text-amber-400">
        {painPoints.length > 0 ? (
          <div className="space-y-4">
            {painPoints.map((p, i) => (
              <div key={i} className="border-l-2 border-neon-600/40 pl-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-ink-100">{p.title}</h4>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${SEVERITY_STYLE[p.severity]}`}>
                      {p.severity}
                    </span>
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-300">
                      {p.category}
                    </span>
                  </div>
                </div>
                {p.evidence && (
                  <p className="mt-1.5 font-mono text-xs leading-relaxed text-ink-400">
                    evidence: {p.evidence}
                  </p>
                )}
                <p className="mt-1.5 text-sm leading-relaxed text-ink-300">
                  <span className="font-semibold text-neon-300">SingleStore: </span>
                  {p.s2Solution}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <ExpandButton
            label="Pull likely pain points"
            section="painPoints"
            ctx={expandCtx}
            onData={(d) => setPainPoints((d.painPoints as typeof painPoints) ?? [])}
          />
        )}
      </Section>

    </div>
  );
}
