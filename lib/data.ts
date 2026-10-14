import type { Segment, SignalType, SegmentId } from "./types";

// ---------------------------------------------------------------------------
// Intel regions — the feed, cache, scans and Apollo sweep are all scoped to
// one region at a time; the header toggle switches between them.
// ---------------------------------------------------------------------------
export const REGIONS = [
  { id: "us", label: "US", blurb: "US / EU headquartered companies" },
  { id: "in", label: "IN", blurb: "India HQ + India engineering arms (GCCs)" },
  // Rest of world: the US and IN lenses already own those two markets, so
  // GLOBAL deliberately excludes both instead of duplicating them.
  { id: "global", label: "GLOBAL", blurb: "Headquartered outside the US and India — EU/UK, APAC, LATAM, MEA, Canada" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

export function isRegionId(v: unknown): v is RegionId {
  return v === "us" || v === "in" || v === "global";
}

// ---------------------------------------------------------------------------
// SingleStore's target segments — data-intensive orgs where transactions,
// real-time analytics and AI retrieval meet. Working hypotheses, refined by
// the evidence each brief finds.
// ---------------------------------------------------------------------------
export const SEGMENTS: Segment[] = [
  { id: "saas", label: "B2B SaaS", icon: "Cloud", blurb: "SaaS with customer-facing analytics, multi-tenant data at scale, embedded dashboards" },
  { id: "fintech", label: "Fintech & FS", icon: "CircleDollarSign", blurb: "payments, trading, banking, insurance — high-TPS transactions, real-time risk and fraud" },
  { id: "adtech", label: "Adtech & Martech", icon: "Megaphone", blurb: "bidding, attribution, CDPs — billions of events/day, sub-second aggregates" },
  { id: "cybersecurity", label: "Cybersecurity & Observability", icon: "ShieldCheck", blurb: "telemetry, detection, log analytics — high ingest, ad-hoc search over fresh data" },
  { id: "marketplace", label: "E-commerce & Marketplaces", icon: "Store", blurb: "catalog, search, personalization and inventory at peak concurrency" },
  { id: "ai", label: "AI-Native", icon: "Sparkles", blurb: "RAG, agents and semantic search in production — vector + full-text + SQL together" },
  { id: "media", label: "Media, Gaming & Streaming", icon: "Clapperboard", blurb: "player/viewer telemetry, live leaderboards, recommendations" },
  { id: "industrial", label: "IoT, Industrial & Energy", icon: "Factory", blurb: "sensor and device time-series, operational dashboards, predictive maintenance" },
  { id: "telecom", label: "Telecom & Networks", icon: "RadioTower", blurb: "network telemetry, CDRs, real-time customer experience analytics" },
  { id: "health", label: "Healthcare & Life Sci", icon: "HeartPulse", blurb: "claims, clinical and device data — operational analytics under compliance" },
  { id: "logistics", label: "Logistics & Mobility", icon: "Truck", blurb: "fleet, routing, supply-chain visibility — streaming location and order data" },
  { id: "retail", label: "Retail & CPG", icon: "ShoppingCart", blurb: "omnichannel inventory, pricing and loyalty analytics at store scale" },
  { id: "enterprise", label: "Enterprise / Other", icon: "Building2", blurb: "large data estates modernizing legacy warehouses and operational databases" },
];

export const SEGMENT_MAP: Record<SegmentId, Segment> = Object.fromEntries(
  SEGMENTS.map((s) => [s.id, s])
) as Record<SegmentId, Segment>;

// ---------------------------------------------------------------------------
// Signal taxonomy — SingleStore buying signals we ask claude-sonnet-4 to search for.
// ---------------------------------------------------------------------------
// Colors are inlined as hex on chips/strength bars, so they must hold up on
// both the light (default) and dark backgrounds — mid-saturation 500/600s.
export const SIGNAL_TYPES: SignalType[] = [
  {
    id: "hiring",
    label: "Data / Infra Hiring",
    color: "#10b981",
    description:
      "Data-platform, database, streaming, real-time analytics and ML-platform hiring, or fast headcount growth (Apollo)",
  },
  {
    id: "layoffs",
    label: "Layoffs",
    color: "#dc2626",
    description:
      "Layoffs and cost cutting in the news, or company-wide headcount shrinking (Apollo): pressure to consolidate data infrastructure",
  },
  {
    id: "oss",
    label: "OSS / Data Infra Activity",
    color: "#8b5cf6",
    description: "Releases, repo activity and commentary on databases, streaming and vector OSS",
  },
  {
    id: "github",
    label: "GitHub Intent",
    color: "#4f46e5",
    description:
      "Engineers at the account active on database, streaming, vector and SingleStore repos (rolled up from the GitHub tab)",
  },
  {
    id: "ma",
    label: "M&A",
    color: "#d97706",
    description: "Acquisitions & mergers that leave two data estates to consolidate",
  },
  {
    id: "funding",
    label: "Funding + Data/AI Build-out",
    color: "#0284c7",
    description: "Recent rounds (Apollo) and rounds earmarked for data platform, AI or scale (news)",
  },
  {
    id: "ai",
    label: "Gen-AI / RAG Signals",
    color: "#db2777",
    description: "Gen-AI, RAG, vector-search and agent launches, and AI-infrastructure spend",
  },
  {
    id: "icp",
    label: "ICP Sweep (Apollo)",
    color: "#0d9488",
    description:
      "Profile-fit accounts from Apollo org search: headcount + industry / data-stack keyword match, no event signal",
  },
];

/** Cards per Signal Feed page — and the most one Pull More adds, so a pull
 *  fills exactly one page (Max, Sep 30: "1 pull, 1 full page"). */
export const FEED_PAGE_SIZE = 50;

export const SIGNAL_TYPE_MAP: Record<string, SignalType> = Object.fromEntries(
  SIGNAL_TYPES.map((s) => [s.id, s])
);

// ---------------------------------------------------------------------------
// Engineering team-size bands (software + data engineers) — sidebar filter over
// each signal's sweEstimate.
// Signals without an estimate match no band (they're only visible with the
// filter off; the sidebar shows how many were hidden).
// ---------------------------------------------------------------------------
export const SWE_BANDS = [
  { id: "0-50", label: "0–50", min: 0, max: 50 },
  { id: "50-250", label: "50–250", min: 50, max: 250 },
  { id: "250-500", label: "250–500", min: 250, max: 500 },
  { id: "500+", label: "500+", min: 500, max: Number.POSITIVE_INFINITY },
] as const;

export type SweBandId = (typeof SWE_BANDS)[number]["id"];

export function sweBandOf(swe?: number): SweBandId | null {
  if (typeof swe !== "number" || !(swe > 0)) return null;
  const band = SWE_BANDS.find((b) => swe >= b.min && swe < b.max);
  return band ? band.id : "500+";
}

