// S2 Signal — domain types.
//
// SingleStore's ICP: companies running data-intensive applications — high
// transaction volume, customer-facing real-time analytics, several stitched
// data systems (OLTP + warehouse + search + streaming + vector), and AI/RAG
// apps. Signals and intel briefs are generated live by Claude with the
// web_search tool and persisted in SingleStore.

// --------- Signals ---------

// Signal taxonomy — what *kind* of buying signal it is.
export type SignalTypeId =
  | "hiring"   // engineering hiring announcements / surges
  | "oss"      // major OSS / GitHub activity (releases, stars, big repos)
  | "ma"       // M&A creating codebase complexity (merges, acquisitions)
  | "funding"  // funding rounds with explicit engineering build-out
  | "ai"       // AI tooling spend / public AI tooling commentary
  | "layoffs"  // engineering layoffs (news-graded) or company-wide headcount shrinkage (Apollo)
  | "github"   // engineers at the account active on code-context / AI-coding repos (GitHub tab)
  | "icp";     // Apollo org-search sweep — profile-fit match, no event

// Company segment — what kind of data-intensive org this is.
export type SegmentId =
  | "saas"          // B2B SaaS & analytics-heavy applications
  | "fintech"       // payments, banking, trading, insurance
  | "adtech"        // adtech, martech, customer-data platforms
  | "cybersecurity" // security, observability, telemetry platforms
  | "marketplace"   // e-commerce & marketplaces
  | "ai"            // AI-native application companies
  | "media"         // media, streaming & gaming
  | "industrial"    // IoT, industrial, energy & utilities
  | "telecom"       // telecom & network operators
  | "health"        // healthcare & life sciences
  | "logistics"     // logistics, mobility & supply chain
  | "retail"        // retail & CPG
  | "enterprise";   // everything else with a data-intensive core

export interface Segment {
  id: SegmentId;
  label: string;
  icon: string; // lucide-react icon name
  blurb: string;
}

export interface SignalType {
  id: SignalTypeId;
  label: string;
  color: string;
  description: string;
}

// One live signal returned by the /api/signals route.
export interface Signal {
  id: string;
  account: string;          // company name
  segment: SegmentId;
  type: SignalTypeId;

  // ICP fit (0-99) computed by the model from publicly observable proof.
  strength: number;

  title: string;            // one-line hook
  description: string;      // 1-2 sentences with concrete proof from the search
  tags: string[];           // short factual chips

  source: string;           // human-readable source (e.g. "TechCrunch")
  url?: string;             // primary citation
  date: string;             // ISO date of the underlying event
  /** When this row first entered the feed (created_at). With `date`, decides
   *  whether a signal on a prospected company is new since prospecting. */
  firstSeenAt?: string;

  // Optional structured detail used by the card / brief.
  sweEstimate?: number;     // engineering headcount (software + data) when known
  codebaseHint?: string;    // e.g. "monorepo, ~7M LoC across 40+ services"
}

// --------- Signal 2000 directory ---------
// A standing, pre-populated list of ~2000 real companies (broad — not just
// tech) the rep can prospect from immediately. The SHORT brief is filled at
// populate time from Apollo (free short_description + modeled engineering headcount); the FULL
// intel brief is generated on demand, reusing the signal-feed deep-dive flow.
export interface DirectoryEntry {
  companyKey: string;       // normalized dedup key
  company: string;
  domain?: string;
  /** Directory scope — 'us' (the original Signal 2000) or 'in' (largest
   *  Indian companies). Follows the header's US/IN toggle. */
  region?: "us" | "in";
  segment: SegmentId;
  sweEstimate?: number;     // modeled engineer headcount (rough, shown with "~")
  shortBrief: string;       // pre-populated "what they do" (Apollo short_description)
  employeeBand?: string;    // e.g. "5,000+ employees"
  estimatedEmployees?: number;
  websiteUrl?: string;
  linkedinUrl?: string;
  strength: number;         // 0-99 ICP-fit estimate (for sorting)
  source: string;
}

// --------- ICP scoring ---------
//
// Surfaced both as a structured object (used in the brief) and as the
// overall `strength` on each signal.
export interface ICPScore {
  total: number;            // 0-99 (five sub-scores + streaming bonus, capped)
  // Sub-scores — each 0-20 (so five of them sum to ~100).
  dataScale: number;
  architectureComplexity: number;
  realtimeWorkload: number;
  scalingActivity: number;
  aiWorkload: number;
  /**
   * Streaming / real-time ingest bonus. Detected from: Kafka, Kinesis,
   * Pulsar, Flink, Debezium/CDC pipelines in job posts, engineering blogs or
   * public repos. Optional — briefs generated before this rule lack it.
   */
  streaming?: {
    detected: boolean;
    bonus: number;          // 0-10, added to total
    evidence: string;       // the specific evidence found
  };
  rationale: string;        // short markdown-ish rationale
}

// --------- Intel Brief ---------
//
// What we render when a user "Get Intel"s on an account.
// Every field is filled by the model from live web evidence.

export interface PainPoint {
  title: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  category: string;
  evidence: string;       // grounded quote / fact from the search
  s2Solution: string;     // how SingleStore addresses it (a hypothesis, never a promise)
}

export interface Stakeholder {
  role: string;
  name?: string;          // when the model surfaces a named person
  type: "feels-pain" | "signs" | "champion" | "blocker" | "influencer";
  rationale: string;
  outreachHook: string;
  linkedinQuery?: string; // search string suggestion
}

export interface Competitor {
  name: string;
  category: string;       // "Cloud warehouse" | "Real-time OLAP" | "Search" | "Vector DB" | etc.
  weakness: string;       // where it is a poor fit for THIS workload (fairly stated)
  s2Advantage: string;
  pitch: string;
}

export type Motion = "PLG" | "Top-Down" | "Champion-Led" | "Land-and-Expand";

export interface MotionRecommendation {
  primary: Motion;
  reasoning: string;
  firstMove: string;
  watchOuts: string[];
  /** The specific person the first move targets, if the motion names one — so
   *  the UI can pin them into the people-to-contact list. */
  keyContactName?: string;
  keyContactTitle?: string;
}

/** Data-estate cost & consolidation exposure. MODELED, never the account's
 *  known bill: the spend on the systems SingleStore could consolidate
 *  (warehouse compute serving app queries, OLTP replicas, search clusters,
 *  vector DB, cache, ETL/CDC tooling, plus engineer time on pipelines). */
export interface DataCostExposure {
  estimatedMonthlyUsd: number;   // modeled monthly spend on the in-scope systems
  systemsCount: number;          // evidenced data systems in the serving path
  perSystemUsd: number;          // assumed average monthly cost per system
  systems?: string[];            // the evidenced systems in scope, e.g. "Elasticsearch"
  notes: string;                 // assumption disclosure + anchors used
  s2OffsetUsd?: number;          // modeled monthly reduction from consolidation
}

/** Migration / adoption friction for SingleStore at this account. */
export interface MigrationFriction {
  score: number;                 // 0-99 (higher = more friction expected)
  level: "Low" | "Medium" | "High";
  drivers: string[];             // concrete reasons (e.g. "Postgres-specific SQL in the app tier")
  mitigations: string[];         // playbook to reduce friction (MySQL wire, Pipelines, Flow…)
}

export interface OutreachAngle {
  hook: string;                  // one-liner that opens a cold message
  channel: "Email" | "LinkedIn" | "Engineering Community" | "Warm Intro";
  proof: string;                 // the specific signal that justifies the angle
  draftMessage: string;          // 3-5 line draft
}

export interface LiveCitation {
  title: string;
  source: string;
  url: string;
  date?: string;
  kind: "hiring" | "oss" | "ma" | "funding" | "ai" | "news" | "other";
}

export interface CompanyIntel {
  name: string;
  domain?: string;
  /** Which entry workload the brief leads with. "realtime" (the core HTAP
   *  engine: real-time analytics, consolidation) by default; "ai" (vector +
   *  full-text + AI functions) when the evidence is about RAG, vector or
   *  semantic search, or the rep pinned it. Absent on older briefs. */
  productFocus?: "realtime" | "ai";
  focusReason?: string;
  segment: Segment;
  oneLiner: string;            // what the company does
  hq?: string;
  employeeBand?: string;       // "50-100", "100-500", etc.
  sweEstimate?: number;        // engineering headcount (software + data engineers)

  icp: ICPScore;
  generatedAt: string;

  summary: string;             // 2-3 sentence exec summary, evidence-backed
  callHook: string;            // the single most valuable signal as one glanceable sentence ("what I saw")

  /** Three LinkedIn-native messages mapped to the cadence (connect note / DM
   * after connect / light re-surface), generated in Max's voice with hard
   * character caps. Optional — briefs cached before this field lack it. */
  linkedinOutreach?: {
    /** ≤300 chars. A question about how they're handling it, no pitch, no
     *  proof figure, no diagnosis. No signature. */
    connect: string;
    /** InMail and the two timed follow-ups. Each carries its own lowercase
     *  2-4 word subject; connect requests deliberately have none. */
    inmail?: { subject: string; body: string };
    followup2?: { subject: string; body: string };
    followup3?: { subject: string; body: string };
    /** Legacy fields from briefs generated before the Aug 2026 restructure. */
    dm1?: string;
    dm2?: string;
    dm3?: string;
    dm?: string;
    resurface?: string;
  };

  /** 1-2 sentence signal-specific lead-in to paste above the templated email
   * body. Different angle on the signal than the LinkedIn connect note, so a
   * prospect on both channels never sees the same observation twice. */
  emailOpener?: string;

  // Why SingleStore (segment-tailored, evidence-grounded). Optional on read:
  // the lean brief leaves it to the on-demand expand.
  whySingleStore?: string[];

  // Stakeholder map — who feels the pain vs who signs
  stakeholders: Stakeholder[];

  // Pain points grounded in live web evidence (hypotheses, not diagnoses)
  painPoints: PainPoint[];

  // Competitive context
  competitors: Competitor[];

  // Motion (PLG vs top-down vs champion-led) with reasoning
  motion: MotionRecommendation;

  // Data-estate cost & consolidation exposure (modeled; on-demand expand)
  dataCost?: DataCostExposure;

  // Migration / adoption friction
  migration?: MigrationFriction;

  // Specific outreach angle
  outreach: OutreachAngle;

  // Raw live citations — the actual web pages the model used.
  citations: LiveCitation[];
}

/** Per-company deep-dive state — the feed keeps a map of these so multiple
 *  briefs can load and stay open at once. */
export interface BriefState {
  loading: boolean;
  error: string | null;
  intel: CompanyIntel | null;
}
