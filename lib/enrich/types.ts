// Shared contract for the enrichment layer.
//
// Each provider client (apollo.ts, hunter.ts, github.ts, proxycurl.ts,
// crunchbase.ts) exports a single async function that NEVER throws and
// resolves to a ProviderResult<T>. The orchestrator route fans out to all
// configured providers and merges what came back into an EnrichmentRollup.
//
// Hard rule (project-wide): no mock or fabricated data. A provider either
// returns real API fields or an honest error — the UI renders both states.

export type ProviderId = "apollo" | "hunter" | "github" | "proxycurl" | "crunchbase";

export interface ProviderResult<T> {
  provider: ProviderId;
  /** Whether the required API key / credentials are present at all. */
  configured: boolean;
  /** Whether the call succeeded and `data` is populated. */
  ok: boolean;
  error?: string;
  data?: T;
  fetchedAt: string; // ISO timestamp
}

export interface EnrichContact {
  name: string;
  /** Apollo person id — the exact key used to reveal email/phone (no fuzzy match). */
  apolloId?: string;
  title?: string;
  email?: string;
  /** e.g. "verified" | "guessed" | "unavailable" — provider's own wording. */
  emailStatus?: string;
  confidence?: number; // 0-100 when the provider scores it
  linkedinUrl?: string;
  phone?: string;
  seniority?: string;
  department?: string;
  /** Country the person is based in, when the provider returns it. */
  country?: string;
  /** Classification verdict (lib/icpClassifier). Set server-side before the
   *  contact reaches the UI; absent when the classifier is unconfigured.
   *
   *  Type-only import so this module stays free of a runtime dependency — it is
   *  imported by client components that must not pull in the Anthropic client.
   *  Verdicts cached before Aug 4 2026 carry the old ANCHOR/TARGET/PASS
   *  vocabulary; run them through normalizeClass() on read. */
  icp?: import("../icpClassifier").ICPVerdict;
}

// --------- Apollo.io ---------
export interface ApolloData {
  name?: string;
  domain?: string;
  websiteUrl?: string;
  linkedinUrl?: string;
  industry?: string;
  estimatedEmployees?: number;
  annualRevenueUsd?: number;
  city?: string;
  state?: string;
  country?: string;
  /** Raw technology names Apollo reports for the org. */
  techStack: string[];
  /** Subset of techStack SingleStore competes with or consolidates
   *  (Snowflake, Kafka, Elasticsearch, Redis, Pinecone, …). Field name kept
   *  for the provider contract; see DATA_STACK_MARKERS. Presence is a reason
   *  to ask, never evidence of pain. */
  aiDevTools: string[];
  /** Engineering and data leadership surfaced by people search. */
  people: EnrichContact[];
  fundingTotalUsd?: number;
  latestFundingRound?: string;
  latestFundingDate?: string;
}

// --------- Hunter.io ---------
export interface HunterData {
  domain: string;
  organization?: string;
  /** e.g. "{first}.{last}" */
  emailPattern?: string;
  emails: EnrichContact[];
  /** Present only when an explicit ?email= was verified. */
  verification?: { email: string; status: string; score?: number };
}

// --------- GitHub ---------
export interface GitHubRepoSummary {
  name: string;
  fullName: string;
  url: string;
  stars: number;
  forks: number;
  language?: string;
  pushedAt?: string;
  openIssues?: number;
  isFork: boolean;
  description?: string;
}

export interface GitHubData {
  org: string;
  orgUrl: string;
  name?: string;
  publicRepos: number;
  followers?: number;
  createdAt?: string;
  totalStars: number;
  /** language -> number of repos whose primary language it is. */
  languages: Record<string, number>;
  topRepos: GitHubRepoSummary[];
  /** Unique-contributor floor estimate across top repos (see client notes). */
  contributorEstimate?: number;
  /** Commits across the most active repos in the last 90 days (capped sample). */
  commitsLast90d?: number;
  activeReposLast90d?: number;
}

// --------- Proxycurl (LinkedIn) ---------
export interface ProxycurlData {
  name?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  totalEmployees?: number;
  employeeRange?: string;
  engineeringHeadcount?: number;
  jobOpenings?: number;
  engineeringJobOpenings?: number;
  industry?: string;
  foundedYear?: number;
  hq?: string;
  description?: string;
}

// --------- Crunchbase ---------
export interface CrunchbaseData {
  name?: string;
  permalink?: string;
  crunchbaseUrl?: string;
  website?: string;
  description?: string;
  foundedYear?: number;
  employeeRange?: string;
  totalRaisedUsd?: number;
  lastRound?: {
    type?: string;
    amountUsd?: number;
    announcedOn?: string;
    leadInvestors?: string[];
  };
  investors: string[];
  categories: string[];
}

// --------- Orchestrator output ---------
export interface EnrichmentRollup {
  domain?: string;
  totalHeadcount?: number;
  /** Engineering headcount (software + data). Only populated from a real
   *  engineering-headcount signal — never inferred. */
  sweHeadcount?: number;
  techStack: string[];
  /** SingleStore-relevant data-stack technologies (see DATA_STACK_MARKERS). */
  aiDevTools: string[];
  repoCount?: number;
  totalStars?: number;
  commitsLast90d?: number;
  contributorEstimate?: number;
  topLanguages: string[];
  totalRaisedUsd?: number;
  lastRound?: string;
  emailPattern?: string;
  contacts: EnrichContact[];
}

export interface EnrichmentProfile {
  company: string;
  domain?: string;
  generatedAt: string;
  providers: {
    apollo: ProviderResult<ApolloData>;
    hunter: ProviderResult<HunterData>;
    github: ProviderResult<GitHubData>;
    proxycurl: ProviderResult<ProxycurlData>;
    crunchbase: ProviderResult<CrunchbaseData>;
  };
  rollup: EnrichmentRollup;
}

/** Technologies flagged as SingleStore-relevant when found in a tech stack:
 *  the systems it competes with or consolidates (warehouses, real-time OLAP,
 *  search, cache, vector DBs, operational DBs at scale) and the streaming /
 *  CDC tooling that feeds them. A match means "worth asking about", never
 *  "they have the pain". */
export const DATA_STACK_MARKERS = [
  "snowflake",
  "databricks",
  "bigquery",
  "redshift",
  "clickhouse",
  "druid",
  "pinot",
  "rockset",
  "elasticsearch",
  "opensearch",
  "elastic",
  "redis",
  "pinecone",
  "weaviate",
  "milvus",
  "qdrant",
  "pgvector",
  "kafka",
  "confluent",
  "kinesis",
  "pulsar",
  "flink",
  "debezium",
  "mongodb",
  "cassandra",
  "aurora",
  "postgres",
  "mysql",
  "sap hana",
  "singlestore",
  "memsql",
];
/** @deprecated Old name, kept so existing importers keep compiling. */
export const AI_DEV_TOOL_MARKERS = DATA_STACK_MARKERS;

/** SingleStore-relevant data-stack technologies in a tech stack. The name is
 *  kept for the provider contract (lib/enrich/apollo.ts imports it). */
export function pickAiDevTools(stack: string[]): string[] {
  return stack.filter((t) => {
    const v = t.toLowerCase();
    return DATA_STACK_MARKERS.some((m) => v.includes(m));
  });
}
