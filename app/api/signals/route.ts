import { accountExcluded } from "@/lib/icpClassifier";
import { NextRequest, NextResponse } from "next/server";
import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "@/lib/anthropic";
import { SINGLESTORE_CONTEXT } from "@/lib/singlestore";
import {
  apolloIcpSweep,
  apolloOrgFacts,
  SWEEP_PAGE_SIZE,
  SWEEP_STACK_KEYWORDS,
  SWEEP_TECH_KEYWORDS,
  type IcpSweepOrg,
} from "@/lib/enrich/apollo";
import { sweepEvent } from "@/lib/sweepEvents";
import { githubIntentSignals } from "@/lib/githubIntent";
import { fetchHNItems } from "@/lib/sources/hn";
import { fetchGitHubTrendingItems } from "@/lib/sources/github";
import { fetchGdeltItems } from "@/lib/sources/gdelt";
import { fetchRssItems } from "@/lib/sources/rss";
import type { RawItem } from "@/lib/sources/types";
import {
  upsertSignals,
  dbConfigured,
  fetchRecentAccounts,
  countSignalsByType,
} from "@/lib/store";
import type { Signal, SignalTypeId, SegmentId } from "@/lib/types";
import { FEED_PAGE_SIZE, isRegionId, type RegionId } from "@/lib/data";
import { adminClient } from "@/lib/auth";
import { normCompany } from "@/lib/companyKey";

// Live feed — we ask claude-sonnet-4 to search the public web for fresh
// SingleStore buying signals across the ICP categories, then return them
// in a normalized shape the UI already understands.
//
// Two shapes:
//   GET /api/signals?type=hiring  → ONE bucket (~3 searches, ~25s). The UI
//     fires all five buckets in parallel and renders them as they land —
//     this is the fast path.
//   GET /api/signals              → full five-bucket pass in a single turn
//     (slow, kept for API consumers / curl).
//
// Force dynamic so `next build` never tries to prerender this route (that
// would call Anthropic at build time). CDN caching is handled by the
// Cache-Control header below — per-bucket URLs cache independently;
// "Refresh" in the UI busts it with a &fresh= param.
export const dynamic = "force-dynamic";
// The full pass can run past 90s — use the platform maximum.
export const maxDuration = 300;

const VALID_TYPES: SignalTypeId[] = ["hiring", "oss", "ma", "funding", "ai", "layoffs", "github", "icp"];
// Buckets the model searches for; "icp" is served by Apollo, not Anthropic.
// icp (Apollo sweep) and github (GitHub-tab roll-up) are built from
// structured data, not graded from free sources.
type SearchBucket = Exclude<SignalTypeId, "icp" | "github">;
const VALID_SEGMENTS: SegmentId[] = [
  "saas",
  "fintech",
  "adtech",
  "cybersecurity",
  "marketplace",
  "ai",
  "media",
  "industrial",
  "telecom",
  "health",
  "logistics",
  "retail",
  "enterprise",
];
const SEGMENT_ENUM = VALID_SEGMENTS.join(" | ");

const SYSTEM_CORE = `${SINGLESTORE_CONTEXT}

You are SingleStore's GTM intelligence analyst. Your job is to surface concrete, real-world buying signals that point to data-intensive companies likely to need SingleStore: one distributed SQL engine for transactions AND real-time analytics (HTAP), with vector and full-text search in the same database. The value is consolidating a stitched data stack (OLTP + cache + search + real-time analytics store + vector DB), millisecond queries on fresh data at high concurrency, and lower infrastructure cost. Use ONLY the SingleStore facts in the context above; never invent product claims.

For each candidate signal, you score the company's SingleStore ICP fit on a 0-99 scale using five sub-criteria (each 0-20):
1. Data scale: data and transaction volume, plus the size of the software + data engineering org (roughly 100-2,000 engineers is the bullseye; taper below ~50, and only slightly for very large orgs)
2. Architecture complexity: how many data systems are stitched together (OLTP + warehouse/lakehouse + search + cache + vector + streaming) and the pipelines between them
3. Real-time workload: customer-facing analytics, high concurrency, low-latency queries on fresh data, transactions and analytics on the same data (HTAP)
4. Recent scaling activity: growth, migrations, re-platforming, data-platform initiatives, a database hitting single-node limits
5. AI workload: gen-AI / RAG / semantic search / agents in production or being built, which need vectors next to fresh operational data

BONUS — Streaming / Real-time Data: when the evidence shows streaming infrastructure (Kafka, Kinesis, Pulsar, Redpanda, Flink, Debezium / CDC pipelines; job posts requiring them; engineering-blog posts about event pipelines), add up to +8 to "strength" (capped at 99) and include the exact tag "Streaming / Real-time Data" in that signal's tags. Streaming shops fan fresh events out into several downstream stores, which is where SingleStore Pipelines and consolidation apply. Only apply this when the evidence actually shows it.

A technology being present is NOT evidence of pain. Running Snowflake, Postgres or Elasticsearch is normal; state the fit as a hypothesis ("may be serving app queries from the warehouse") unless the source itself states the pain.

Cast a wide net beyond obvious tech companies. Banks, insurers, manufacturers, retailers, telcos, healthcare systems, logistics carriers and media companies run some of the LARGEST data estates anywhere: real-time dashboards for thousands of users, fraud and risk analytics, IoT telemetry. A data-platform hiring push, gen-AI launch or M&A at a traditional-industry company is exactly as relevant as a startup's.

Be honest. If a signal isn't strong, give it a lower score and say why in the description. Do NOT fabricate signals. If you cannot find enough live signals, return fewer rather than inventing them.

ENGINEERING ESTIMATE: Always fill "sweEstimate" with your best numeric estimate of the company's ENGINEERING headcount (software engineers plus data engineers — not total employees) — never null. Base it on the evidence plus what's generally known about the company's size and segment: an early-stage startup has tens, a mid-market scale-up 100-500, a large enterprise several thousand. This is an explicit modeled ESTIMATE used only for rough sizing and filtering — it is NOT a stated fact, so keep it out of the "description" (which must stay grounded in the source) and never present the number as something the source said.

ACCOUNT RULES — who counts as a real "account":
- The account must be a real organization with an in-house engineering team (software + data) of roughly 50+ engineers. EXCLUDE solo developers, hobby/side projects, and companies with fewer than ~50 engineers — that is below SingleStore's ICP floor.
- Large companies ARE valid prospects — do NOT exclude them. Their size just places them in a higher headcount band: estimate their (large) engineering headcount accurately so size filters can sort them correctly, rather than dropping them.
- EXCLUDE SingleStore itself, and database / data-infrastructure vendors that compete with it (Snowflake, Databricks, ClickHouse, MongoDB, Elastic, Pinecone, Redis and similar). A company that USES those products is exactly who we want.

Output ONLY a single JSON object — no prose, no code fences — matching this schema:
{
  "signals": [
    {
      "account": "Canonical company name",
      "segment": "${SEGMENT_ENUM}",
      "type": "hiring | oss | ma | funding | ai",
      "strength": 0-99,
      "title": "one-line hook (max ~70 chars)",
      "description": "1-2 sentences that quote or paraphrase the live evidence and explain SingleStore relevance (as a hypothesis unless the source states the pain)",
      "tags": ["short fact chip", "another"],
      "source": "publisher / domain in plain English",
      "url": "https://primary-citation-url",
      "date": "YYYY-MM-DD of the underlying event",
      "sweEstimate": best-effort integer estimate of engineering headcount, software + data (REQUIRED — never null; see ENGINEERING ESTIMATE rule above),
      "codebaseHint": "short data-stack phrase stated in the evidence (e.g. Kafka + Postgres + Elasticsearch) or null"
    }
  ]
}`;

// Search variant: instructs the model to browse. Grader variant: forbids it —
// the raw items in the prompt are the only evidence.
const SYSTEM = `${SYSTEM_CORE}

Use the web_search tool aggressively. Every signal you return MUST be backed by a real, recent (last ~60 days when possible), public source — a news article, press release, job board, GitHub release, blog post, podcast transcript, conference talk, etc.`;

const GRADER_SYSTEM = `${SYSTEM_CORE}

You have NO search tools on this call. The user message contains raw items already fetched from public sources — they are your ONLY evidence. Never invent facts beyond what an item states; when the evidence is thin, score low and keep the description strictly to what the item says.`;

const BUCKET_BRIEFS: Record<SearchBucket, string> = {
  hiring:
    "Data-infrastructure hiring: companies posting waves of data-platform, data-engineering, database / DBA, streaming (Kafka, Flink), real-time analytics or ML / AI-platform roles in the last 60 days, ideally with job posts that name the stack they run (Postgres/MySQL at scale, Snowflake, Databricks, ClickHouse, Elasticsearch, Redis, a vector DB). Use sources like LinkedIn announcements, company engineering blogs, hiring trackers, TechCrunch hiring stories.",
  oss: "Data-infrastructure OSS activity: notable releases, engineering-blog posts or new repos from companies with paid commercial products that show how they run databases, streaming, real-time analytics or vector search (scaling Postgres or MySQL, moving off Elasticsearch, building on Kafka/Flink, an in-house OLAP or feature store). Use GitHub, company engineering blogs, HN front page.",
  ma: "M&A that creates data-estate consolidation: acquisitions or mergers in the last ~6 months where the acquirer now runs a second data stack (databases, warehouses, analytics products, customer data) it has to integrate or consolidate. Use TechCrunch, Crunchbase News, M&A wires.",
  funding:
    'Funding rounds earmarked for data / AI platform or scale: rounds where the announcement specifically says "scale the platform", "real-time", "data infrastructure", "AI", "analytics", or "growing transaction volume" — not generic "growth". Use TechCrunch, business wires.',
  ai: "Gen-AI / RAG / vector signals: launches of gen-AI features, RAG, semantic search, AI agents or copilots inside a company's OWN product, and public commentary (engineering blogs, podcasts, conference talks) about the data layer behind them: vector databases, embeddings pipelines, keeping vectors in sync with operational data, AI-infrastructure spend.",
  layoffs:
    "Layoffs and cost cutting: companies that cut staff or announced cost-reduction programs in the last 90 days while still running a large engineering and data organization (roughly 50+ engineers after the cuts). Prefer items that mention engineering, data or infrastructure teams, cloud or infrastructure cost, or vendor consolidation; a bare company-wide number with no link to technology spend scores low. Put the detail (how many, which teams, the stated reason) in the description. Why it matters to SingleStore: cost pressure puts data-infrastructure consolidation on the table (fewer systems, licences and pipelines to run). State that as a hypothesis, never as the company's known plan.",
};

// Region scoping — the whole feed is one region at a time.
const REGION_RULES: Record<RegionId, string> = {
  us: "Prefer companies headquartered in the US/EU with English-language sources.",
  in: "ONLY companies headquartered in India — the buyer must be an Indian company an India-based sales team can call into. EXCLUDE foreign-headquartered companies even when the story is about their India engineering center or GCC (e.g. a US startup 'expanding engineering in India' does NOT qualify). Indian tech press (YourStory, Inc42, ET Tech, Moneycontrol, Entrackr) are first-class sources.",
  global:
    "ONLY companies headquartered OUTSIDE the United States and OUTSIDE India — EU/UK, Canada, LATAM, Japan/Korea, Southeast Asia, ANZ, Middle East, Africa. A US or Indian HQ disqualifies the signal even when the story is international; those markets have their own feeds. English-language sources preferred, but regional tech press qualifies.",
};

const sharedRules = (region: RegionId) => `Hard rules:
- "account" must be the canonical name of a REAL company — never an aggregator, website, list, or repo name (e.g. "GitHub Trending Projects" is invalid; the company behind the repo is what we want).
- Recency: prefer events from the last 60 days; never include anything older than 6 months.
- Never include <cite> tags or any citation markup inside JSON string values — write plain prose; sources belong only in the "url" and "source" fields.
- Avoid: companies under ~50 engineers, hobby OSS, generic funding news.
- REGION: ${REGION_RULES[region]}

Return ONLY the JSON object described in the system prompt.`;

const fullPrompt = (region: RegionId) => `Search the public web for 10-14 fresh buying signals that point to companies in SingleStore's ICP. Spread the signals across these five buckets — find 2-3 in each where possible:

1. ${BUCKET_BRIEFS.hiring}
2. ${BUCKET_BRIEFS.oss}
3. ${BUCKET_BRIEFS.ma}
4. ${BUCKET_BRIEFS.funding}
5. ${BUCKET_BRIEFS.ai}

${sharedRules(region)}`;

const bucketPrompt = (type: SearchBucket, exclude: string[], region: RegionId) =>
  `Search the public web for 8-10 fresh buying signals in ONE category for SingleStore's ICP. Each signal must be a DIFFERENT company.

CATEGORY: ${BUCKET_BRIEFS[type]}

Every signal's "type" field must be "${type}".
${
  exclude.length > 0
    ? `\nALREADY TRACKED — each shown with the date of the signal we already hold. Do NOT return these companies again unless you find a NEWER event than that date (a newer event on a tracked account is wanted); otherwise search for DIFFERENT companies:\n${exclude.join(", ")}\n`
    : ""
}
${sharedRules(region)}`;

// ---------------------------------------------------------------------------
// FREE discovery path (the default): structured sources fetch raw candidates
// for $0, then ONE Claude call (NO web_search — tokens only) filters,
// extracts the company, and scores them. ?deep=1 falls back to the
// web_search path above for an on-demand deeper scan.
// ---------------------------------------------------------------------------

// GDELT limits ~1 req/5s per IP, and Vercel functions share egress IPs with
// other tenants — 429s are routine. Retry once after the cool-down before
// giving up; every bucket also has a non-GDELT source so a miss degrades
// gracefully instead of emptying the bucket.
async function gdeltWithRetry(
  query: string,
  opts?: { limit?: number; timespan?: string },
): Promise<{ ok: boolean; error?: string; items: RawItem[] }> {
  const first = await fetchGdeltItems(query, opts);
  if (first.ok || !/429|rate limit/i.test(first.error ?? "")) return first;
  await new Promise((r) => setTimeout(r, 6500));
  return fetchGdeltItems(query, opts);
}

// HN's Algolia API returns 400/429 in bursts when several queries land at once
// from a shared Vercel IP. Retry once after a short cool-down before giving up.
async function hnWithRetry(
  query: string,
  opts?: { minPoints?: number; limit?: number; days?: number },
): Promise<{ ok: boolean; error?: string; items: RawItem[] }> {
  const first = await fetchHNItems(query, opts);
  if (first.ok || !/HTTP 4|429|rate/i.test(first.error ?? "")) return first;
  await new Promise((r) => setTimeout(r, 1800));
  return fetchHNItems(query, opts);
}

async function fetchBucketItems(
  type: SearchBucket,
  region: RegionId,
): Promise<{ items: RawItem[]; sourceErrors: string[] }> {
  // NOTE: HN's Algolia search has no boolean syntax — multi-angle coverage
  // means multiple simple queries, not "OR" strings (which match the word
  // "OR" literally and return nothing).
  //
  // India mode swaps in Indian tech press (Inc42 / YourStory — feeds verified
  // live) and scopes GDELT with sourcecountry:IN. HN/GitHub stay global; the
  // grader's region rule keeps only India-relevant companies.
  const inIndia = region === "in";
  const gd = (q: string, opts?: { limit?: number; timespan?: string }) =>
    gdeltWithRetry(inIndia ? `${q} sourcecountry:IN` : q, opts);

  const tasks: Promise<{ ok: boolean; error?: string; items: RawItem[] }>[] = (() => {
    switch (type) {
      case "hiring":
        return [
          gd('("data engineers" OR "data platform" OR "data infrastructure" OR "database engineers" OR "real-time analytics" OR "machine learning platform") hiring', { limit: 25 }),
          inIndia
            ? fetchRssItems("https://inc42.com/feed/", { limit: 20 })
            : hnWithRetry("data platform team", { minPoints: 5, days: 21, limit: 10 }),
        ];
      case "oss":
        return [
          // Scoped to data-infrastructure repos (databases, vector, streaming,
          // analytics) instead of all of GitHub trending.
          fetchGitHubTrendingItems({
            limit: 20,
            days: 30,
            minStars: 100,
            keywords: ["database", "vector", "kafka", "streaming", "analytics"],
          }),
          hnWithRetry("Postgres", { minPoints: 40, days: 14, limit: 8 }),
          hnWithRetry("database", { minPoints: 60, days: 10, limit: 8 }),
        ];
      case "ma":
        return [
          gd('(acquires OR acquisition OR "to acquire" OR merger) (data OR analytics OR software) technology', { limit: 25 }),
          // NOTE: TechCrunch renamed fundings-exits; /category/venture/ is live.
          inIndia
            ? fetchRssItems("https://inc42.com/feed/", { limit: 20 })
            : fetchRssItems("https://techcrunch.com/category/venture/feed/", { limit: 20 }),
        ];
      case "funding":
        return [
          inIndia
            ? fetchRssItems("https://yourstory.com/feed", { limit: 20 })
            : fetchRssItems("https://techcrunch.com/category/venture/feed/", { limit: 20 }),
          gd('(raises OR raised) ("Series A" OR "Series B" OR "Series C" OR "Series D") (data OR AI OR analytics OR "real-time")', { limit: 20 }),
        ];
      case "ai":
        return [
          hnWithRetry("RAG", { minPoints: 15, days: 21, limit: 8 }),
          hnWithRetry("vector database", { minPoints: 15, days: 21, limit: 8 }),
          ...(inIndia
            ? [fetchRssItems("https://inc42.com/feed/", { limit: 15 })]
            : [hnWithRetry("AI agents production", { minPoints: 20, days: 21, limit: 6 })]),
          gd('("generative AI" OR "vector database" OR "retrieval augmented" OR "AI agents" OR "semantic search") (launch OR launches OR production OR infrastructure)', { limit: 20 }),
        ];
      case "layoffs":
        return [
          gd('(layoffs OR "laid off" OR "job cuts" OR "cost cutting") (engineering OR technology OR software OR data)', { limit: 25 }),
          // TechCrunch's layoffs tag (verified live Sep 25: 20 items); the
          // category path 404s.
          inIndia
            ? fetchRssItems("https://inc42.com/feed/", { limit: 20 })
            : fetchRssItems("https://techcrunch.com/tag/layoffs/feed/", { limit: 20 }),
          hnWithRetry("layoffs", { minPoints: 20, days: 30, limit: 8 }),
        ];
    }
  })();

  const settled = await Promise.all(tasks);
  const sourceErrors = settled.filter((s) => !s.ok && s.error).map((s) => s.error!);
  // Interleave + cap so the grader input stays small and diverse.
  const items = settled.flatMap((s) => s.items).slice(0, 40);
  return { items, sourceErrors };
}

const graderPrompt = (
  type: SearchBucket,
  items: RawItem[],
  exclude: string[],
  region: RegionId,
) =>
  `Below are RAW items fetched from free public sources (news index, Hacker News, GitHub, RSS). Your job is to GRADE them into SingleStore buying signals for ONE category — no searching, work only from what's given.

CATEGORY: ${BUCKET_BRIEFS[type]}

For each item that genuinely fits the category AND names a real company (per the ACCOUNT RULES in the system prompt), emit one signal (type "${type}"). Extract the company from the headline/snippet (for GitHub repos, the org behind the repo). Skip items with no identifiable company, aggregators, listicles, individuals' side projects, sub-50-engineer companies, duplicates of the same story, and anything clearly outside the category. It is fine — expected — to return far fewer signals than items. Set "url" to the item's url and "date" to the item's date. Score honestly: these are headline-level candidates, so most belong in the 55-80 range; reserve 80+ for unambiguous, strong ICP fits. Always provide sweEstimate as a best-effort engineering-headcount estimate (software + data) per the ENGINEERING ESTIMATE rule in the system prompt.
${
  exclude.length > 0
    ? `\nALREADY TRACKED — each shown with the date of the signal we already hold. Skip an item about one of these companies unless it reports a NEWER event than that date; a newer event on a tracked account is wanted (it may be an account we already work):\n${exclude.join(", ")}\n`
    : ""
}
RAW ITEMS (JSON):
${JSON.stringify(items)}

${sharedRules(region)}`;

interface ModelSignal {
  account: string;
  segment: string;
  type: string;
  strength: number;
  title: string;
  description: string;
  tags?: string[];
  source: string;
  url?: string;
  date?: string;
  sweEstimate?: number | null;
  codebaseHint?: string | null;
}

interface ModelResponse {
  signals?: ModelSignal[];
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Returns undefined (instead of inventing a midpoint) when the model omitted
// the score — callers drop those signals rather than fabricate a strength.
function clampScore(n: unknown): number | undefined {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.max(0, Math.min(99, Math.round(x)));
}

function normalizeType(t: string): SignalTypeId {
  const v = String(t || "").toLowerCase().trim();
  return (VALID_TYPES as string[]).includes(v) ? (v as SignalTypeId) : "ai";
}

function normalizeSegment(s: string): SegmentId {
  const v = String(s || "").toLowerCase().trim();
  return (VALID_SEGMENTS as string[]).includes(v) ? (v as SegmentId) : "saas";
}

function normalizeDate(d: string | undefined): string {
  if (!d) return todayISO();
  // Accept YYYY-MM-DD, ISO, or human dates.
  const time = Date.parse(d);
  if (Number.isNaN(time)) return todayISO();
  return new Date(time).toISOString().slice(0, 10);
}

// Deterministic profile-fit score for Apollo sweep rows, by SingleStore affinity
// of the matched keyword. A disclosed rule, not a model guess — every card
// states the exact filters that produced it.
const ICP_KEYWORD_STRENGTH: Record<string, number> = {
  // Firmographic: data-intensive, real-time segments from the ICP.
  adtech: 78,
  cybersecurity: 76,
  fintech: 76,
  "artificial intelligence": 74,
  saas: 72,
  // Technographic: a stack keyword says the company runs that system. It is
  // NOT evidence of pain; it scores the consolidation hypothesis, which the
  // brief has to confirm. Streaming and search / OLAP serving layers rank
  // highest because that is where SingleStore's published proof sits.
  "apache kafka": 78,
  elasticsearch: 76,
  clickhouse: 76,
  "vector database": 76,
  snowflake: 74,
  databricks: 74,
  postgresql: 72,
  redis: 72,
  mongodb: 72,
  // Traditional industries: large data estates, but the engineering share of
  // total headcount is unverified — score lower until the brief confirms.
  banking: 68,
  telecommunications: 68,
  insurance: 66,
  retail: 66,
  manufacturing: 66,
  logistics: 66,
  healthcare: 64,
};

// Profile-fit score for an Apollo sweep row: keyword affinity, then adjusted by
// how close the modeled engineering headcount (software + data) sits to the
// ~100-2,000 sweet spot. Still a disclosed rule (every card states the keyword +
// band it matched) — but no longer a flat per-keyword constant, so the feed
// actually differentiates instead of showing one number across the board.
function modeledStrength(keyword: string, swe?: number): number {
  const base = ICP_KEYWORD_STRENGTH[keyword] ?? 70;
  if (typeof swe !== "number" || swe <= 0) return base;
  let adj: number;
  if (swe >= 100 && swe <= 2000) adj = 8; // ICP bullseye
  else if (swe < 50) adj = -18 + Math.round((swe / 50) * 8); // below the engineering floor
  else if (swe < 100) adj = 0; // small, but data-heavy teams can still fit
  else if (swe <= 10000) adj = 3; // large data estate, longer cycle
  else adj = -4; // mega-org — one signal is diluted across a huge workforce
  return Math.max(40, Math.min(92, base + adj));
}

const ICP_KEYWORD_SEGMENT: Record<string, SegmentId> = {
  saas: "saas",
  fintech: "fintech",
  adtech: "adtech",
  cybersecurity: "cybersecurity",
  "artificial intelligence": "ai",
  banking: "fintech",
  insurance: "fintech",
  telecommunications: "telecom",
  retail: "retail",
  manufacturing: "industrial",
  healthcare: "health",
  logistics: "logistics",
};

// Technographic rows carry no segment of their own; Apollo's industry label
// places them when it is present. First match wins; no match falls back to
// "saas" like every other unmapped row.
const INDUSTRY_SEGMENT: Array<[RegExp, SegmentId]> = [
  [/bank|financ|insur|payment|capital market|invest/i, "fintech"],
  [/marketing|advertis/i, "adtech"],
  [/security|safety/i, "cybersecurity"],
  [/telecom|wireless/i, "telecom"],
  [/e-?commerce|marketplace/i, "marketplace"],
  [/retail|consumer goods|apparel|food/i, "retail"],
  [/media|entertainment|gaming|broadcast|publish|music/i, "media"],
  [/manufactur|industrial|energy|oil|utilit|automotive|semiconductor|electr/i, "industrial"],
  [/health|hospital|medical|pharma|biotech/i, "health"],
  [/logistic|transport|supply chain|airline|shipping/i, "logistics"],
  [/software|internet|information technology/i, "saas"],
];

function sweepSegment(org: IcpSweepOrg): SegmentId {
  const direct = ICP_KEYWORD_SEGMENT[org.matchedKeyword];
  if (direct) return direct;
  const ind = org.industry ?? "";
  return INDUSTRY_SEGMENT.find(([re]) => re.test(ind))?.[1] ?? "saas";
}

// Apollo sweep records carry only TOTAL-employee counts, never an engineering
// count. To give the size filter something to bite on, model a rough
// engineering share (software + data) of headcount — same spirit as the
// grader's modeled sweEstimate, surfaced with a "~" in the UI so it never reads
// as a stated fact. Tech-native shops are mostly engineering; companies matched
// on a data-stack keyword sit in between; traditional industries run a large
// workforce around a comparatively small in-house technology org. When Apollo
// omits the per-org headcount we fall back to a representative figure for the
// matched band.
const TECH_NATIVE_SWEEP_KEYWORDS = new Set(SWEEP_TECH_KEYWORDS);
const STACK_SWEEP_KEYWORDS = new Set(SWEEP_STACK_KEYWORDS);

function modeledSweFromOrg(org: IcpSweepOrg): number | undefined {
  // MEASURED beats modeled: when the free org enrich returned a LinkedIn-
  // derived engineering-department count, that IS the estimate (a floor
  // where LinkedIn coverage is thin, but evidence rather than a share guess).
  if (typeof org.engineeringCount === "number" && org.engineeringCount >= 5) {
    return org.engineeringCount;
  }
  const techNative = TECH_NATIVE_SWEEP_KEYWORDS.has(org.matchedKeyword);
  const stack = STACK_SWEEP_KEYWORDS.has(org.matchedKeyword);
  // Representative total when Apollo's per-org count is missing: tech-native
  // matches the 200-10,000 bands, data-stack the 200-20,000 band, traditional
  // the 5,000+ band.
  const total =
    typeof org.estimatedEmployees === "number" && org.estimatedEmployees > 0
      ? org.estimatedEmployees
      : techNative
        ? 1000
        : stack
          ? 2000
          : 15000;
  const engShare = techNative ? 0.35 : stack ? 0.15 : 0.03;
  const swe = Math.round(total * engShare);
  return swe > 0 ? swe : undefined;
}

/** What the feed already holds, keyed by normalized company name: the
 *  signal types each company has, the exact account string its rows use,
 *  and the blacklist. (account, type) is unique across regions, so this
 *  reads every region. Empty on a read failure, which only means fewer truly
 *  new rows that pull. */
async function knownCompanies(): Promise<{
  types: Map<string, Set<string>>;
  names: Map<string, string>;
  blacklist: Set<string>;
}> {
  const types = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const blacklist = new Set<string>();
  try {
    const admin = adminClient();
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error } = await admin
        .from("gtm_signals")
        .select("account,type")
        .order("id")
        .range(from, from + 999);
      if (error || !data) break;
      for (const r of data) {
        const k = normCompany(String(r.account));
        if (!k) continue;
        const t = types.get(k) ?? new Set<string>();
        t.add(String(r.type));
        types.set(k, t);
        if (!names.has(k)) names.set(k, String(r.account));
      }
      if (data.length < 1000) break;
    }
    const { data: bl } = await admin.from("gtm_blacklist").select("company_key");
    for (const r of bl ?? []) blacklist.add(normCompany(String(r.company_key)));
  } catch (e) {
    // Without this read every swept company looks new: it would be re-picked,
    // re-enriched (credits) and only refreshed by the upsert.
    console.error(`[signals] known-companies read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { types, names, blacklist };
}

/** Round-robin the sweep's orgs across its keyword x size-band queries, so a
 *  capped pull is a cross-section rather than the first query's companies. */
function interleaveByQuery(orgs: IcpSweepOrg[]): IcpSweepOrg[] {
  const groups = new Map<string, IcpSweepOrg[]>();
  for (const o of orgs) {
    const k = `${o.matchedKeyword}|${o.employeeBand}`;
    const g = groups.get(k);
    if (g) g.push(o);
    else groups.set(k, [o]);
  }
  const lists = [...groups.values()];
  const out: IcpSweepOrg[] = [];
  for (let i = 0; out.length < orgs.length; i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}

// Trim Apollo's company blurb to a single, brief "what they do" sentence.
function briefAbout(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return firstSentence.length > 200 ? `${clean.slice(0, 197).trimEnd()}…` : firstSentence;
}

function icpSweepToSignals(
  orgs: IcpSweepOrg[],
  accountOf: (o: IcpSweepOrg) => string = (o) => o.name,
): Signal[] {
  return orgs.map((org, i) => {
    // Modeled engineering share of Apollo's total headcount (see modeledSweFromOrg)
    // — drives both the size filter and the fit score below. Rough by design.
    const swe = modeledSweFromOrg(org);
    // Prefer a real "what the company does" blurb (Apollo short_description) for
    // the overview; fall back to the Apollo-match explainer when none exists.
    const about = org.about ? briefAbout(org.about) : undefined;
    const base = modeledStrength(org.matchedKeyword, swe);
    // Apollo's own data shows an event (recent funding or M&A, shrinking or
    // fast-growing headcount): the row becomes that signal instead of a bare
    // profile match, and its card skips the lazy web-search research.
    const ev = sweepEvent({
      growth6m: org.growth6m,
      growth12m: org.growth12m,
      funding: org.funding,
      acquisition: org.acquisition,
      engineering: org.engineeringCount,
    });
    if (ev) {
      return {
        id: `${ev.type}-sweep-${i}-${Date.now().toString(36)}`,
        account: accountOf(org),
        segment: sweepSegment(org),
        type: ev.type,
        strength: Math.max(40, Math.min(95, base + ev.bump)),
        title: ev.title,
        description: [ev.detail, about].filter(Boolean).join(" "),
        tags: [...ev.facts, org.matchedKeyword, org.employeeBand].slice(0, 6),
        source: ev.source,
        url: ev.url || org.linkedinUrl || org.websiteUrl,
        date: ev.date ?? todayISO(),
        sweEstimate: swe,
        codebaseHint: undefined,
      };
    }
    return {
      id: `icp-${i}-${Date.now().toString(36)}`,
      account: accountOf(org),
      segment: sweepSegment(org),
      type: "icp" as const,
      strength: base,
      title: `Profile-fit match: ${org.matchedKeyword} · ${org.employeeBand}`,
      // Only a REAL company blurb (Apollo short_description). No blurb → no
      // description: the title + tags already say keyword/band/size, so the old
      // "Surfaced by Apollo…" boilerplate was pure redundant filler.
      description: about ?? "",
      tags: [org.matchedKeyword, org.employeeBand],
      source: "Apollo org search",
      url: org.linkedinUrl || org.websiteUrl,
      date: todayISO(),
      sweEstimate: swe,
      codebaseHint: undefined,
    };
  });
}

export async function GET(req: NextRequest) {
  const typeParam = req.nextUrl.searchParams.get("type")?.trim().toLowerCase();
  const bucket: SignalTypeId | null = (VALID_TYPES as string[]).includes(
    typeParam ?? "",
  )
    ? (typeParam as SignalTypeId)
    : null;

  const regionParam = req.nextUrl.searchParams.get("region")?.trim().toLowerCase();
  const region: RegionId = isRegionId(regionParam) ? regionParam : "us";

  // Apollo-powered bucket: structured org search, no Anthropic involved.
  if (bucket === "icp") {
    // Page cursor: the client passes the page to fetch (it persists the
    // `nextSweepPage` we return), guaranteeing every pull advances to NEW orgs.
    // First pull (no cursor) falls back to a count estimate — divided by the
    // REAL distinct-per-page yield (~60% of theoretical, after dedup), not the
    // theoretical page size, so it doesn't get stuck re-fetching page 1.
    const clientPage = Number(req.nextUrl.searchParams.get("sweepPage"));
    const realisticYield = Math.max(1, Math.round(SWEEP_PAGE_SIZE * 0.6));
    const cachedIcp =
      Number.isFinite(clientPage) && clientPage >= 1
        ? 0
        : dbConfigured()
          ? await countSignalsByType("icp", region)
          : 0;
    const sweepPage =
      Number.isFinite(clientPage) && clientPage >= 1
        ? Math.min(100, Math.floor(clientPage))
        : Math.min(100, Math.floor(cachedIcp / realisticYield) + 1);
    // One pull fills one feed page (Max, Sep 30). The client sends how much
    // of the page the event sources left (`limit`). The sweep keeps up to that
    // many rows:
    //  - companies NEW to the feed (they get the per-company lookup below, 1
    //    Apollo credit each — it used to run on all ~300 swept orgs), and
    //  - companies ALREADY in the feed, prospected or not, only when Apollo's
    //    search data (free) shows a growth or shrink event they don't have a
    //    row for yet. A repeat profile match is not a signal and is skipped.
    // A page with unexamined companies left stays the cursor, so the next
    // pull continues it instead of skipping them.
    const limitParam = Number(req.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam >= 0 ? Math.min(100, Math.floor(limitParam)) : FEED_PAGE_SIZE;
    if (limit === 0) {
      return NextResponse.json(
        { signals: [], empty: true, note: "The page is already full from event sources.", nextSweepPage: sweepPage },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const known = await knownCompanies();
    const picked: IcpSweepOrg[] = [];
    const refound: IcpSweepOrg[] = [];
    const feedName = new Map<IcpSweepOrg, string>();
    const kept = () => picked.length + refound.length;
    let page = sweepPage;
    let pagesFetched = 0;
    let sweepError: string | undefined;
    while (kept() < limit && pagesFetched < 3 && page <= 100) {
      const sweep = await apolloIcpSweep(page, region);
      pagesFetched += 1;
      if (!sweep.configured) {
        // Not an error — just absent. The client treats `skipped` as a quiet
        // no-op so keyless deployments don't show a permanent failure banner.
        return NextResponse.json(
          { signals: [], skipped: sweep.error },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      if (!sweep.ok || sweep.orgs.length === 0) {
        sweepError = sweep.error || "Apollo ICP sweep returned no organizations.";
        break;
      }
      let full = false;
      for (const o of interleaveByQuery(sweep.orgs)) {
        if (kept() >= limit) {
          full = true;
          break;
        }
        const key = normCompany(o.name);
        if (!key || known.blacklist.has(key)) continue;
        const types = known.types.get(key);
        if (!types) {
          picked.push(o);
          known.types.set(key, new Set(["icp"]));
          continue;
        }
        const ev = sweepEvent({ growth6m: o.growth6m, growth12m: o.growth12m });
        if (ev && !types.has(ev.type)) {
          refound.push(o);
          feedName.set(o, known.names.get(key) ?? o.name);
          types.add(ev.type);
        }
      }
      if (full) break; // unexamined companies left: stay on this page
      page += 1;
    }
    if (kept() === 0 && sweepError) {
      return NextResponse.json(
        { error: sweepError },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.log(
      `[signals] icp sweep ${region}: ${picked.length} new + ${refound.length} re-found of ${limit} from page ${sweepPage}..${page} (${pagesFetched} fetched)`,
    );
    // Tighter eng estimate: pull LinkedIn-derived engineering-department counts for the
    // NEW companies before turning them into signals — a measured engineering
    // headcount beats the 35%/15%/3% share model wherever it exists. The lookup
    // costs 1 Apollo credit per company (docs, Sep 25). Concurrency-limited;
    // a miss leaves the model in charge for that org.
    const enrichTargets = picked.filter((o) => o.domain);
    let ei = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (;;) {
          const o = enrichTargets[ei++];
          if (!o) return;
          const facts = await apolloOrgFacts(o.domain!);
          if (facts?.engineering) o.engineeringCount = facts.engineering;
          if (facts?.employees && !o.estimatedEmployees) o.estimatedEmployees = facts.employees;
          // Same response, previously discarded: funding / M&A events and
          // growth rates turn a bare profile match into a real event signal
          // (see lib/sweepEvents). No extra Apollo call.
          if (facts) {
            o.funding = facts.funding;
            o.acquisition = facts.acquisition;
            o.growth6m ??= facts.growth6m;
            o.growth12m ??= facts.growth12m;
          }
        }
      }),
    );
    // Re-found companies keep the account name their feed rows already use,
    // so every mark on the company (prospected, reviewed, score) lines up.
    const icpSignals = icpSweepToSignals([...picked, ...refound], (o) => feedName.get(o) ?? o.name);
    const persisted = dbConfigured() && icpSignals.length > 0
      ? (await upsertSignals(icpSignals, region)).ok
      : false;
    return NextResponse.json(
      {
        signals: icpSignals,
        persisted,
        updated: new Date().toISOString(),
        sweepPage,
        // The client persists this and sends it back next pull: the page that
        // still has unexamined companies, or the one after a drained page.
        nextSweepPage: Math.min(100, page),
      },
      // Depends on what is already in the feed, so never cached.
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // GitHub intent: the GitHub tab's activity rolled up by company (lib/
  // githubIntent). Reads SingleStore, plus one Apollo domain search for HQ
  // regions; no Anthropic call.
  if (bucket === "github") {
    const gh = await githubIntentSignals(region);
    if (!gh.configured) {
      return NextResponse.json({ signals: [], skipped: gh.error }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!gh.ok) {
      return NextResponse.json(
        { error: gh.error || "GitHub intent roll-up failed." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.log(`[signals] github intent: ${gh.signals.length} for ${region} of ${gh.qualifying} qualifying companies`);
    if (gh.signals.length === 0) {
      return NextResponse.json(
        { signals: [], empty: true, note: "No qualifying GitHub intent for this region.", updated: new Date().toISOString() },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Only new accounts, or ones with newer activity, are written. Re-saving
    // unchanged rows would bump them to the top of the feed on every pull and
    // spend page slots on cards the rep has already seen.
    let changed = gh.signals;
    try {
      const { data } = await adminClient().from("gtm_signals").select("account,event_date").eq("type", "github");
      const prev = new Map((data ?? []).map((r) => [String(r.account), r.event_date ? String(r.event_date) : ""]));
      changed = gh.signals.filter((s) => !prev.has(s.account) || s.date > (prev.get(s.account) ?? ""));
    } catch {
      /* no service key: write them all */
    }
    const persisted = dbConfigured() && changed.length > 0 ? (await upsertSignals(changed, region)).ok : false;
    return NextResponse.json(
      { signals: changed, persisted, updated: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // ?deep=1 opts into the expensive web_search path; default is the free
  // structured-sources + grader pipeline.
  const deep = req.nextUrl.searchParams.get("deep") === "1";

  try {
    // Tell the model which companies we already track so each pull hunts new
    // ones — without this, repeat scans rediscover the same headline accounts
    // and dedupe makes pulls look like they "add nothing".
    const exclude =
      bucket && dbConfigured()
        ? (await fetchRecentAccounts(bucket, region, 60)).map((r) => `${r.account} (${r.date ?? "undated"})`)
        : [];

    let result;
    let sourceErrors: string[] = [];
    if (bucket && !deep) {
      // FREE path: fetch raw candidates from structured sources, grade with
      // one no-search Claude call (tokens only — zero billed searches).
      const fetched = await fetchBucketItems(bucket as SearchBucket, region);
      sourceErrors = fetched.sourceErrors;
      if (fetched.items.length === 0) {
        return NextResponse.json(
          {
            error: `No raw candidates from free sources for "${bucket}"${
              sourceErrors.length ? ` — ${sourceErrors.join("; ")}` : ""
            }. Try again or use deep=1.`,
          },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
      result = await callClaudeWithWebSearch({
        system: GRADER_SYSTEM,
        user: graderPrompt(bucket as SearchBucket, fetched.items, exclude, region),
        // Structured grading of pre-fetched candidates — no search, high volume.
        // Haiku handles it well at ~3x lower cost than the deep scan.
        model: FAST_MODEL,
        webSearch: false,
        maxTokens: 4000,
        temperature: 0.2,
      });
    } else {
      result = await callClaudeWithWebSearch({
        system: SYSTEM,
        user: bucket
          ? bucketPrompt(bucket as SearchBucket, exclude, region)
          : fullPrompt(region),
        maxSearches: bucket ? 5 : Number(process.env.ANTHROPIC_WEB_SEARCH_MAX || 8),
        maxTokens: bucket ? 4500 : 6000,
        temperature: 0.4,
      });
    }

    const parsed = extractJSON<ModelResponse>(result.text);
    if (!parsed || !Array.isArray(parsed.signals)) {
      const cause = result.truncated
        ? `the response was cut off (stop_reason: ${result.stopReason})`
        : "this is usually a transient issue";
      return NextResponse.json(
        {
          error: `Live search returned no parseable signals — ${cause}. Try Refresh.`,
          searchCount: result.searchCount,
          searchErrors: result.searchErrors,
          rawPreview: result.text.slice(0, 500),
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Normalize and trust the model's `url` first; only fall back to a search
    // citation if it's missing — Anthropic citations don't always line up 1:1
    // with the items the model picked.
    const citationUrls = new Set(result.citations.map((c) => c.url));
    const signals: Signal[] = parsed.signals
      .filter((s) => s && s.account && s.title && clampScore(s.strength) !== undefined)
      .map((s, i) => {
        const url = s.url && /^https?:\/\//.test(s.url) ? s.url : undefined;
        const type = bucket ?? normalizeType(s.type);
        return {
          id: `${type}-${i}-${Date.now().toString(36)}`,
          account: String(s.account).trim(),
          segment: normalizeSegment(s.segment),
          type,
          strength: clampScore(s.strength)!,
          title: String(s.title).trim(),
          description: String(s.description || "").trim(),
          tags: Array.isArray(s.tags)
            ? s.tags.map((t) => String(t)).filter(Boolean).slice(0, 6)
            : [],
          source: String(s.source || hostOf(url || "") || "Web").trim(),
          url,
          date: normalizeDate(s.date),
          sweEstimate:
            typeof s.sweEstimate === "number" && s.sweEstimate > 0
              ? Math.round(s.sweEstimate)
              : undefined,
          codebaseHint: s.codebaseHint ? String(s.codebaseHint).trim() : undefined,
        };
      })
      // Competing database vendors and hyperscalers are never prospects, even
      // when they appear in the news the scan graded.
      .filter((s) => !accountExcluded(s.account));

    if (signals.length === 0) {
      // Free grader path: the fetch succeeded but none of the candidates
      // qualified as an ICP signal (common for OSS — GitHub Trending / Show HN
      // skew toward sub-50-engineer/indie projects). That's an EMPTY result,
      // not a failure — return 200 so the UI doesn't flag a "failed scan";
      // uncached so the next pull re-grades fresh candidates.
      if (bucket && !deep) {
        return NextResponse.json(
          {
            signals: [],
            empty: true,
            note: `No ICP-qualifying ${bucket} signals from free sources this pass.`,
            updated: new Date().toISOString(),
          },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      }
      // Deep / full web-search pass returning nothing is more likely a
      // transient miss — keep it a retryable failure.
      const failedSearches =
        result.searchErrors.length > 0
          ? ` ${result.searchErrors.length} web search(es) failed (${result.searchErrors.join(", ")}).`
          : "";
      return NextResponse.json(
        {
          error: `The live pass completed but produced no usable signals.${failedSearches} Try Refresh.`,
          searchCount: result.searchCount,
          searchErrors: result.searchErrors,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Persist into the SingleStore cache (upsert on account+type) so pulls
    // accumulate history; non-fatal if unconfigured or down.
    const persisted = dbConfigured()
      ? (await upsertSignals(signals, region)).ok
      : false;

    return NextResponse.json(
      {
        signals,
        persisted,
        updated: new Date().toISOString(),
        searchCount: result.searchCount,
        searchErrors: result.searchErrors,
        citations: result.citations,
        // Useful in the UI footer to be honest about what was actually fetched.
        sources: Array.from(citationUrls).slice(0, 12),
      },
      {
        headers: {
          "Cache-Control":
            "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error talking to Anthropic.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
