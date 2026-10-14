// Turn an Apollo sweep org into a REAL event signal when Apollo's own data
// shows one (Max, Sep 25: "why is it so disproportionately Apollo based?").
//
// The sweep already receives everything used here — headcount growth rates on
// the org search record, funding and merger/acquisition events on the
// per-company lookup it runs for the engineering count — and used to throw it
// away, so every swept company became a bare "Profile-fit match" card. No extra
// Apollo calls are made for this.
//
// Priority when several apply: a recent merger/acquisition, then a recent
// funding round, then company-wide shrinkage (layoffs), then fast growth
// (hiring). Everything Apollo showed still lands in the tags.
//
// Apollo's growth rates are COMPANY-WIDE. A shrinking company is labeled as
// such, never as confirmed engineering layoffs or a consolidation plan — the
// news-graded "layoffs" bucket is where cost-cutting detail comes from.

export interface ApolloEvent {
  /** ISO date of the event. */
  date: string;
  /** Apollo's event type: "Series E", "Seed", "Merger / Acquisition", … */
  type: string;
  /** Apollo's printed amount, e.g. "200M" or "1.3B". */
  amount?: string;
  investors?: string;
  newsUrl?: string;
}

export interface SweepEventInput {
  /** Company-wide headcount growth as a fraction (0.21 = +21%). */
  growth6m?: number;
  growth12m?: number;
  /** Latest funding round that is not a merger/acquisition. */
  funding?: ApolloEvent;
  /** Latest "Merger / Acquisition" event. */
  acquisition?: ApolloEvent;
  /** Measured engineering headcount, when the lookup returned one. */
  engineering?: number;
}

export type SweepEventType = "ma" | "funding" | "layoffs" | "hiring";

export interface SweepEvent {
  type: SweepEventType;
  title: string;
  /** One sentence that goes ahead of the company blurb in the description. */
  detail: string;
  url?: string;
  /** YYYY-MM-DD, for events that carry their own date. */
  date?: string;
  source: string;
  /** Added to the profile-fit score so event rows rank above bare profile rows. */
  bump: number;
  /** Short tags for every fact Apollo showed, primary first. */
  facts: string[];
}

/** Funding and M&A count as signals for six months. */
export const EVENT_WINDOW_DAYS = 180;
/** Growth that reads as a hiring push. */
export const GROWTH_12M = 0.2;
export const GROWTH_6M = 0.1;
/** Shrinkage that reads as layoffs. */
export const SHRINK_12M = -0.1;
export const SHRINK_6M = -0.08;

const DAY = 86_400_000;
const pct = (f: number) => `${Math.round(Math.abs(f) * 100)}%`;
const signedPct = (f: number) => `${f >= 0 ? "+" : "-"}${pct(f)}`;
const monthYear = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const ymd = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const money = (a?: string) => (a ? (a.startsWith("$") ? a : `$${a}`) : "");

function isRecent(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now + DAY && now - t <= EVENT_WINDOW_DAYS * DAY;
}

export function isMergerEvent(type: string | undefined): boolean {
  return /merger|acquisition/i.test(type ?? "");
}

export function sweepEvent(o: SweepEventInput, now = Date.now()): SweepEvent | null {
  const eng =
    typeof o.engineering === "number" && o.engineering >= 5
      ? `; about ${o.engineering.toLocaleString()} in engineering today`
      : "";

  // Which growth window qualifies, if any — 12 months preferred.
  const g12 = typeof o.growth12m === "number" ? o.growth12m : undefined;
  const g6 = typeof o.growth6m === "number" ? o.growth6m : undefined;
  const shrink =
    g12 !== undefined && g12 <= SHRINK_12M
      ? { f: g12, months: 12 }
      : g6 !== undefined && g6 <= SHRINK_6M
        ? { f: g6, months: 6 }
        : undefined;
  const grow =
    !shrink && g12 !== undefined && g12 >= GROWTH_12M
      ? { f: g12, months: 12 }
      : !shrink && g6 !== undefined && g6 >= GROWTH_6M
        ? { f: g6, months: 6 }
        : undefined;

  const recentMa = o.acquisition && isRecent(o.acquisition.date, now) ? o.acquisition : undefined;
  const recentFunding = o.funding && isRecent(o.funding.date, now) ? o.funding : undefined;

  // Every fact, for the tags (primary is reordered to the front below).
  const facts: string[] = [];
  if (recentMa) facts.push(`M&A ${monthYear(recentMa.date)}`);
  if (recentFunding) facts.push(`${recentFunding.type} ${monthYear(recentFunding.date)}`);
  if (g12 !== undefined && Math.abs(g12) >= 0.05) facts.push(`${signedPct(g12)} headcount 12m`);
  else if (g6 !== undefined && Math.abs(g6) >= 0.05) facts.push(`${signedPct(g6)} headcount 6m`);

  if (recentMa) {
    const who = recentMa.investors ? ` with ${recentMa.investors}` : "";
    return {
      type: "ma",
      title: `Merger / acquisition${who} · ${monthYear(recentMa.date)}`,
      detail: `Apollo records a merger or acquisition in ${monthYear(recentMa.date)}${recentMa.investors ? ` involving ${recentMa.investors}` : ""}.`,
      url: recentMa.newsUrl,
      date: ymd(recentMa.date),
      source: "Apollo funding data",
      bump: 6,
      facts,
    };
  }
  if (recentFunding) {
    const amount = money(recentFunding.amount);
    return {
      type: "funding",
      title: `Raised ${amount ? `${amount} ` : ""}${recentFunding.type} · ${monthYear(recentFunding.date)}`,
      detail: recentFunding.investors
        ? `Investors: ${recentFunding.investors}.`
        : `Apollo records a ${recentFunding.type} round in ${monthYear(recentFunding.date)}.`,
      url: recentFunding.newsUrl,
      date: ymd(recentFunding.date),
      source: "Apollo funding data",
      bump: 6,
      facts,
    };
  }
  if (shrink) {
    return {
      type: "layoffs",
      title: `Headcount down ${pct(shrink.f)} in ${shrink.months} months`,
      detail: `Company-wide headcount per Apollo, not confirmed to include engineering${eng}.`,
      source: "Apollo headcount data",
      bump: 5,
      facts,
    };
  }
  if (grow) {
    return {
      type: "hiring",
      title: `Headcount up ${pct(grow.f)} in ${grow.months} months`,
      detail: `Company-wide headcount growth per Apollo${eng}.`,
      source: "Apollo headcount data",
      bump: 4,
      facts,
    };
  }
  return null;
}
