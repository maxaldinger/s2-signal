// Proposal generation — one pipeline, both narratives.
//
// Every proposal is generated TWICE from the same account research, in
// parallel: an OPERATIONAL narrative (leads with the account's data
// architecture and the serving-layer friction it creates, economics secondary)
// and a COST narrative (leads with the modeled data-estate economics). The page
// renders both as tabs (lib/proposalDoc.ts). What differs per narrative: which
// facts lead the prompt, what the model is told it is writing for, which fields
// it writes (operational writes the headline; cost never lets the model near a
// number), and the section order.
// Extracted from the route so it can run against a stored brief without an
// HTTP session (scripts/proposal-positioning-check.mts).

import { callClaudeWithWebSearch, extractJSON } from "@/lib/anthropic";
import { singlestoreContextFor, type S2Focus } from "@/lib/singlestore";
import { stripEmDashes } from "@/lib/format";
import {
  ROI_RATE_HIGH,
  ROI_RATE_LOW,
  type PositioningMode,
  type ProposalFields,
  type ProposalNarrative,
  type ProposalRoi,
} from "@/lib/proposalDoc";

export type { PositioningMode, ProposalNarrative };

/** Structured research a surface can hand the generator. Every field is
 *  optional; the brief fills most of them, a feed card fills two or three.
 *  The generator orders them by narrative priority and NEVER fills gaps. */
export interface ProposalResearch {
  /** The brief's executive summary. */
  summary?: string;
  /** The single strongest buying signal ("what I saw"). */
  signal?: string;
  oneLiner?: string;
  segment?: string;
  hq?: string;
  employeeBand?: string;
  /** Free-text architecture hint from a signal card (the Signal type still
   *  calls it codebaseHint), e.g. "Postgres + Redis + Elasticsearch behind one app". */
  codebaseHint?: string;
  /** The ICP scorer's rationale — usually the densest architecture text. */
  icpRationale?: string;
  /** Streaming / CDC evidence from the brief (Kafka, Kinesis, Flink, Debezium). */
  streamingEvidence?: string;
  /** Migration / adoption friction drivers ("Postgres-specific SQL in the app tier"). */
  migrationDrivers?: string[];
  painPoints?: { title: string; evidence?: string }[];
  whySingleStore?: string[];
  /** The brief's entry-workload focus; realtime when absent. */
  focus?: S2Focus;
  tags?: string[];
  /** Titles of the web sources the brief used. */
  citations?: string[];
}

export interface GenerateInput {
  company: string;
  domain?: string;
  /** Legacy free-text context (feed cards still send this). */
  context?: string;
  research?: ProposalResearch;
  contactName?: string;
  contactTitle?: string;
  employees?: number;
  /** Engineering headcount (software + data engineers). */
  swe?: number;
  sweConfirmed: boolean;
  /** The account's monthly spend (USD) on the systems SingleStore could
   *  consolidate, when the rep confirmed it on a call. */
  confirmedSpendMo?: number;
  /** CUSTOMER ASSUMPTION used when nothing is confirmed: in-scope data
   *  infrastructure spend per engineer per month (USD). */
  perEngMo: number;
  icpTotal?: number;
}

// ROI renders as CONSOLIDATION-SCOPE TIERS (first workload / 25% / 50% / the
// whole in-scope estate) once the in-scope spend is big enough for a staged
// story, a single row below it. The first-workload row keeps the pilot
// believable; the full row keeps the scale story on the page. Each row states
// its assumption.
const ROI_TIER_THRESHOLD_YR = 1_000_000;

/** The ROI table, computed — never model-written. Built on the account's
 *  confirmed in-scope spend when the rep has it; otherwise MODELED from the
 *  engineering headcount × a per-engineer assumption. Neither → no table and
 *  no dollar headline, never a manufactured one. */
export function computeRoi(
  swe: number | undefined,
  sweConfirmed: boolean,
  confirmedSpendMo: number | undefined,
  perEngMo: number,
): ProposalRoi | undefined {
  const spendMo = confirmedSpendMo ?? (swe ? swe * perEngMo : undefined);
  if (!spendMo || spendMo <= 0) return undefined;
  const basis: ProposalRoi["basis"] = confirmedSpendMo ? "confirmed" : "modeled";
  const fullYr = spendMo * 12;
  const tier = (scopePct: number, label: string) => {
    const spendYr = Math.round((fullYr * scopePct) / 100);
    return {
      scopePct,
      label,
      spendYr,
      savedLow: Math.round((spendYr * ROI_RATE_LOW) / 100),
      savedHigh: Math.round((spendYr * ROI_RATE_HIGH) / 100),
    };
  };
  const fullLabel =
    basis === "confirmed"
      ? "the full in-scope estate (spend confirmed by your team)"
      : `the full in-scope estate (modeled from ${sweConfirmed ? "" : "~"}${(swe ?? 0).toLocaleString()} engineers)`;
  const tiers =
    fullYr >= ROI_TIER_THRESHOLD_YR
      ? [
          tier(10, "first workload: ~10% of in-scope spend"),
          tier(25, "25% of in-scope spend consolidated"),
          tier(50, "50% of in-scope spend consolidated"),
          tier(100, fullLabel),
        ]
      : [tier(100, fullLabel)];
  return {
    spendMo: Math.round(spendMo),
    basis,
    perEngMo: basis === "modeled" ? perEngMo : undefined,
    engineers: basis === "modeled" ? swe : undefined,
    engineersConfirmed: basis === "modeled" ? sweConfirmed : undefined,
    lowPct: ROI_RATE_LOW,
    highPct: ROI_RATE_HIGH,
    tiers,
  };
}

// ---------------------------------------------------------------------------
// Research prioritization. The model reads the facts top to bottom and is told
// the order is the priority, so what leads the list leads the narrative.
// ---------------------------------------------------------------------------

const clip = (s: string | undefined, n: number) => (s ? s.trim().slice(0, n) : "");

function factBlocks(input: GenerateInput): Record<string, string> {
  const r = input.research ?? {};
  const swe = input.swe;
  const sweLine = swe
    ? input.sweConfirmed
      ? `Engineering headcount (software + data engineers): ${swe.toLocaleString()} (confirmed by the account on a call — reliable, may be stated plainly)`
      : `Estimated engineering headcount (software + data engineers): ~${swe.toLocaleString()} (LinkedIn-derived headcount data — approximate, never quote as fact)`
    : "";
  const pains = (r.painPoints ?? [])
    .slice(0, 4)
    .map((p) => `- ${p.title}${p.evidence ? `: ${clip(p.evidence, 240)}` : ""}`)
    .join("\n");
  const spendLine = input.confirmedSpendMo
    ? `In-scope data-infrastructure spend: $${input.confirmedSpendMo.toLocaleString()}/month on the systems SingleStore could consolidate (shared by the account)`
    : swe
      ? `Modeled in-scope data-infrastructure spend: $${input.perEngMo.toLocaleString()} per engineer per month on the systems SingleStore could consolidate (a CUSTOMER ASSUMPTION, not known spend)`
      : "";
  return {
    identity: [
      `Company: ${input.company}`,
      input.domain ? `Domain: ${input.domain}` : "",
      r.segment ? `Segment: ${r.segment}` : "",
      r.oneLiner ? `What they do: ${clip(r.oneLiner, 300)}` : "",
      r.hq ? `HQ: ${r.hq}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    architecture: [
      r.streamingEvidence ? `Streaming / data-pipeline evidence: ${clip(r.streamingEvidence, 900)}` : "",
      r.icpRationale ? `Data architecture and scale assessment: ${clip(r.icpRationale, 900)}` : "",
      r.codebaseHint ? `Architecture hint: ${clip(r.codebaseHint, 200)}` : "",
      r.migrationDrivers?.length ? `Known migration considerations: ${r.migrationDrivers.slice(0, 5).join("; ")}` : "",
      r.tags?.length ? `Tech signals: ${r.tags.slice(0, 10).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    summary: r.summary ? `Account summary (researched): ${clip(r.summary, 1200)}` : "",
    signal: r.signal ? `Most relevant current signal: ${clip(r.signal, 600)}` : "",
    pains: pains ? `Likely pain points (researched hypotheses, not confirmed):\n${pains}` : "",
    initiatives: [
      r.whySingleStore?.length ? `Fit reasons (researched): ${r.whySingleStore.slice(0, 3).join(" | ")}` : "",
      r.citations?.length ? `Sources consulted: ${r.citations.slice(0, 12).join(" | ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    org: [
      typeof input.employees === "number" ? `Total employees: ~${input.employees.toLocaleString()}` : "",
      r.employeeBand && typeof input.employees !== "number" ? `Employees: ${r.employeeBand}` : "",
      sweLine,
      typeof input.icpTotal === "number" ? `SingleStore ICP fit score: ${input.icpTotal}/99` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    economics: [
      spendLine,
      spendLine ? "An ROI table is computed separately from these numbers; do not restate its figures." : "",
    ]
      .filter(Boolean)
      .join("\n"),
    legacyContext: input.context ? `Additional context: ${clip(input.context, 1500)}` : "",
  };
}

/** Facts in the narrative's priority order. */
export function buildFacts(input: GenerateInput, mode: PositioningMode): string {
  const b = factBlocks(input);
  const order =
    mode === "operational"
      ? // 1 data architecture · 2 summary · 3 signal (hiring, launches,
        // migrations) · 4 pains · 5 org · 6 initiatives · economics LAST.
        ["identity", "architecture", "summary", "signal", "pains", "org", "initiatives", "legacyContext", "economics"]
      : // 1 scale · 2 signal · 3 pains · 4 spend assumptions · 5 architecture
        // · 6 financial impact.
        ["identity", "org", "signal", "pains", "economics", "summary", "architecture", "initiatives", "legacyContext"];
  return order
    .map((k) => b[k])
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SHARED_RULES = `Write in a direct, senior register. No hype words, no em dashes, no exclamation marks.

HARD RULES:
- Use ONLY the account facts provided, and treat their ORDER as their priority. NEVER invent initiatives, names, numbers, quotes, systems, technologies, or events for the company. If a fact you would like is missing, write around it in general terms for a company of their kind; never fill the gap.
- A technology being present is not evidence of pain. Describe the account's likely friction as what tends to happen in an architecture like theirs, never as a diagnosis of their systems.
- Every paragraph must be usable by anyone at the account: never address one person, never assume a title or role.
- Statistics: ONLY published customer figures from PROOF, verbatim, each attributed to the named customer and stated with what it measured (for example: Fathom Analytics reported 60% lower database TCO after replacing RDS MySQL, ElastiCache and DynamoDB). These are customer claims published by SingleStore, never a prediction for this account. Never present the GigaOm commissioned study or the "10-100x at 1/3 the cost" line as a customer result. At most two figures total across everything you write.
- Do not restate the ROI table's dollar figures; the document computes and prints those itself.
- Never promise a specific speedup, latency or saving for this account. You may propose a scoped proof of concept: one painful workload, on their data, against SLAs agreed up front (latency at concurrency, ingest-to-query freshness, cost). Never promise its outcome and never frame it as a bake-off against their incumbent.
- Position SingleStore beside the warehouse or lakehouse, not as a replacement for it, and recommend moving one workload first, not a big-bang migration.`;

function modePrompt(mode: PositioningMode, company: string): string {
  if (mode === "operational") {
    return `POSITIONING MODE: OPERATIONAL

You are writing for a senior engineering or data leader. Lead with a specific operational problem supported by the supplied company research. Establish credibility by demonstrating understanding of their data architecture before discussing economics. Cost savings are secondary evidence, not the opening hook. Avoid generic SaaS ROI language.

The first page must make the reader think "they actually understand how our data stack works", not "they ran our headcount through an ROI calculator". Draw on, where the facts support it: several stores kept in sync for one product (operational database, cache, search index, real-time analytics store, vector DB), the pipelines and CDC jobs between them, dashboards and features that lag ingest, an operational database hitting single-writer limits, a warehouse or search cluster serving application queries it was not designed for, reindexing and cache invalidation, concurrency spikes on customer-facing analytics, embeddings kept in sync with the source of truth for RAG, and the on-call load of operating many systems.

Return ONLY JSON:
{"headline": "...", "subtitle": "...", "execSummary": ["p1", "p2", "p3"], "cta": "..."}
- headline: 8-14 words, names ${company} or its platform, states the operational outcome. NO dollar figures, NO percentages, NO savings claims. Good shapes: "Real-Time Analytics on Fresh Data Across <company>'s <platform>", "Collapsing <company>'s Serving Layer into One Real-Time Engine", "Serving <platform>'s Customer-Facing Analytics from Live Operational Data".
- subtitle: one sentence, 15-30 words, what SingleStore changes for the systems behind their product. No figures.
- execSummary: exactly 3 paragraphs, 55-95 words each. Paragraph 1: their data architecture and workload, built from the research (stores, streaming, scale, customer-facing analytics, AI features), and the operational friction an architecture like that tends to create. Paragraph 2: why that friction persists (every fresh-data question crosses a pipeline between systems) and how SingleStore changes it: transactions and real-time analytics in one distributed SQL engine, with full-text and vector in the same SQL, streaming ingest via Pipelines, MySQL wire compatibility. Paragraph 3: the expected engineering impact for them, with at most one approved proof figure. Economics may be mentioned in one clause, framed as an additional benefit.
- cta: 40-70 words proposing to start with one painful workload on THEIR data (connect an existing MySQL driver or BI tool, load it with Pipelines or Flow), proved against SLAs agreed up front, framed around freshness, concurrency and the systems it could retire rather than the bill, ending with scheduling a brief technical kickoff.`;
  }
  return `POSITIONING MODE: COST

You are writing for an engineering, data-platform or FinOps leader evaluating data-infrastructure economics. Lead with a defensible quantified business case using the supplied assumptions. Clearly distinguish modeled estimates from known customer data: modeled spend is an assumption, never their known bill. Label estimates as estimates and avoid false precision. If the facts cannot support a credible financial estimate, do not manufacture one.

Return ONLY JSON:
{"execSummary": ["p1", "p2"], "environment": ["p1"], "cta": "..."}
- execSummary: exactly 2 paragraphs, 50-90 words each. Paragraph 1: why data-infrastructure cost rises at a company like theirs as each new feature adds another store, another pipeline and another cluster to run, tied to the provided facts (scale, stack signals, spend assumptions). Paragraph 2: how SingleStore reduces it by consolidating serving-layer systems onto one engine while the warehouse stays for history, with at most one approved proof figure.
- environment: 1-2 paragraphs, 40-80 words each, on their relevant data architecture and workload context from the research only. If the research is thin, one short paragraph that states only what is known.
- cta: 40-70 words proposing to start with one workload on THEIR data, with the modeled assumptions above revisited against their actual bills for the systems in scope, ending with scheduling a brief technical kickoff.`;
}

export function buildSystemPrompt(mode: PositioningMode, company: string, focus: S2Focus = "realtime"): string {
  return `${singlestoreContextFor(focus)}

You write the personalized sections of a SingleStore proposal document. SingleStore is one distributed SQL database for transactions and real-time analytics (HTAP), with full-text and vector search in the same SQL engine, streaming ingest via Pipelines, migration and CDC via Flow, and MySQL wire compatibility; delivered as Helios (managed on AWS, Azure, GCP), Helios BYOC, or self-managed. ${
    focus === "ai"
      ? "This account's entry workload is AI: lead with vector + full-text + SQL filters and joins on live operational data in one query and one system, instead of a separate vector DB kept in sync."
      : "This account's entry workload is real-time: lead with fresh-data analytics at high concurrency and consolidation of the serving layer."
  } The document's fixed sections (how SingleStore works, rollout, proof points, why SingleStore) and its ROI table are written by the system; you write only the fields requested below.

${SHARED_RULES}

${modePrompt(mode, company)}`;
}

// ---------------------------------------------------------------------------
// Generation + validation
// ---------------------------------------------------------------------------

interface GenOut {
  headline?: unknown;
  subtitle?: unknown;
  execSummary?: unknown;
  environment?: unknown;
  cta?: unknown;
}

const carriesMoneyOrPct = (t: string) => /\$|\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[MK]\b/i.test(t);

const paras = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .map((p) => stripEmDashes(String(p ?? "")).trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

type NarrativeResult = { ok: true; narrative: ProposalNarrative } | { ok: false; error: string };

/** One narrative, validated. Exported so the check script can exercise a
 *  single mode; the route always generates both. */
export async function generateNarrative(input: GenerateInput, mode: PositioningMode): Promise<NarrativeResult> {
  let gen: GenOut | null = null;
  try {
    const result = await callClaudeWithWebSearch({
      system: buildSystemPrompt(mode, input.company, input.research?.focus ?? "realtime"),
      user: `Account facts, in priority order:\n\n${buildFacts(input, mode)}\n\nWrite the JSON now.`,
      webSearch: false,
      maxTokens: mode === "operational" ? 1800 : 1500,
    });
    gen = extractJSON<GenOut>(result.text);
  } catch (e) {
    return { ok: false, error: `${mode}: ${e instanceof Error ? e.message : "Generation failed"}` };
  }

  const execSummary = paras(gen?.execSummary, 3);
  const cta = typeof gen?.cta === "string" ? stripEmDashes(gen.cta).trim() : "";
  if (execSummary.length < 2 || !cta) {
    return { ok: false, error: `${mode}: the generator returned an unusable draft — try again` };
  }

  const narrative: ProposalNarrative = { execSummary, cta };
  if (mode === "operational") {
    // The headline is the narrative's whole point: a model draft carrying a
    // figure is dropped for the safe generic form, never passed through.
    const headline = typeof gen?.headline === "string" ? stripEmDashes(gen.headline).trim() : "";
    const subtitle = typeof gen?.subtitle === "string" ? stripEmDashes(gen.subtitle).trim() : "";
    if (headline && headline.length <= 120 && !carriesMoneyOrPct(headline)) narrative.headline = headline;
    if (subtitle && subtitle.length <= 240 && !carriesMoneyOrPct(subtitle)) narrative.subtitle = subtitle;
  } else {
    const environment = paras(gen?.environment, 2);
    if (environment.length > 0) narrative.environment = environment;
  }
  return { ok: true, narrative };
}

export type GenerateResult = { ok: true; fields: ProposalFields } | { ok: false; error: string };

/** Both narratives, in parallel, as one document. Either failing fails the
 *  whole generation: the page promises both tabs. */
export async function generateProposalFields(input: GenerateInput): Promise<GenerateResult> {
  const roi = computeRoi(input.swe, input.sweConfirmed, input.confirmedSpendMo, input.perEngMo);
  const [op, co] = await Promise.all([generateNarrative(input, "operational"), generateNarrative(input, "cost")]);
  if (!op.ok) return { ok: false, error: op.error };
  if (!co.ok) return { ok: false, error: co.error };

  const fields: ProposalFields = {
    company: input.company,
    contactName: input.contactName,
    focus: input.research?.focus,
    narratives: { operational: op.narrative, cost: co.narrative },
    // Operational is the default tab; the flattened fields mirror it for any
    // reader that predates `narratives`.
    positioningMode: "operational",
    headline: op.narrative.headline,
    subtitle: op.narrative.subtitle,
    execSummary: op.narrative.execSummary,
    cta: op.narrative.cta,
    engineers: input.swe,
    employees: input.employees,
    roi,
    generatedAt: new Date().toISOString(),
  };
  return { ok: true, fields };
}
