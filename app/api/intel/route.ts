import { NextRequest, NextResponse } from "next/server";
import { callClaudeWithWebSearch, diagnoseJSON, extractJSON } from "@/lib/anthropic";
import { singlestoreContextFor, type S2Focus } from "@/lib/singlestore";
import { apolloOrgFacts } from "@/lib/enrich/apollo";
import { apolloOrgLookup } from "@/lib/githubProspect/enrich";
import { SEGMENT_MAP } from "@/lib/data";
import { computeIcpTotal, SEGMENT_GUIDE, subScoresComplete } from "@/lib/icpScore";
import { CONNECT_CAP, VOICE_SPEC, enforceLinkedin } from "@/lib/outreachRules";
import { fetchBrief, upsertBrief, dbConfigured } from "@/lib/store";
import type {
  CompanyIntel,
  DataCostExposure,
  ICPScore,
  LiveCitation,
  MigrationFriction,
  Motion,
  SegmentId,
  Stakeholder,
} from "@/lib/types";

// Live Intel Brief: Claude researches the company on the open web,
// then emits the full CompanyIntel JSON. Nothing is templated or canned —
// the model must ground every section in what it actually found.
/** First couple of sentences of the model's own explanation, markdown stripped,
 *  so the reason shows up in the error banner instead of "usually transient". */
function summarizeRefusal(text: string): string {
  const plain = text
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return sentences.length > 320 ? `${sentences.slice(0, 317)}...` : sentences;
}

export const maxDuration =300;

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
const VALID_MOTIONS: Motion[] = ["PLG", "Top-Down", "Champion-Led", "Land-and-Expand"];
const VALID_STAKEHOLDER_TYPES: Stakeholder["type"][] = [
  "feels-pain",
  "signs",
  "champion",
  "blocker",
  "influencer",
];

// Which entry workload the brief leads with. SingleStore sells one engine, so
// the split is by workload, not SKU: "realtime" (default) unless the rep
// pinned "ai", or the evidence is specifically about RAG, vector or semantic
// search.
const VALID_PRODUCTS: S2Focus[] = ["realtime", "ai"];

// POSITIONING. A brief is about ONE entry workload so every narrative field
// pulls in the same direction, and it stays honest: a technology being present
// is a reason to ask, never proof of pain.
const POSITIONING = `PRODUCT FOCUS
SingleStore sells one engine (Helios / self-managed); the brief picks the ENTRY WORKLOAD it leads with and records it in "productFocus". Default: "realtime". Every narrative field (summary, icp.rationale, callHook, motion.firstMove, outreach, linkedinOutreach, emailOpener) is about the focus workload.

When the focus is REALTIME, the brief must:
- Lead with the core engine: one distributed SQL database for transactions AND real-time analytics (HTAP), high-concurrency low-latency queries on fresh data, streaming ingest via Pipelines, MySQL wire compatibility.
- Frame the value as consolidation of the SERVING LAYER the team otherwise stitches together (OLTP + real-time analytics store + cache + search index + vector DB, and the pipelines between them): fewer systems to keep in sync, fresher data in customer-facing queries, lower infrastructure cost. The warehouse/lakehouse usually STAYS for history and training; position SingleStore beside it, never as a big-bang replacement.
- Stay customer-specific: use THEIR evidenced stack, product and scale to explain why it matters for them. A technology being present (they run Postgres, they use Snowflake) is NOT evidence of pain; state any pain as a hypothesis to test on a call.

Choose "ai" when the evidence is specifically about gen-AI features, RAG, vector or semantic search, or agent backends that need fresh operational data, or when the request pins it. Then lead with vector + full-text + SQL filters and joins on live operational data in ONE query and one system, instead of a separate vector DB + search index + operational DB kept in sync. Do not claim more about hybrid ranking than the product context states. Put a one-sentence "focusReason" either way.

HONESTY (both focuses):
- Keep three things visibly distinct: MEASURED results (published customer claims from PROOF, each stated with what it measured), MODELED figures (spend and savings estimates), and CUSTOMER ASSUMPTIONS (what you inferred about them). A commissioned benchmark or a marketing claim is never a measured result.
- Proof points come ONLY from PROOF. Never invent capabilities, integrations, customers or numbers.
- Never promise a specific speedup or saving before the customer's own test. A POC proves one painful workload against agreed SLAs on THEIR data; published figures are other customers' results.
- Competitors: follow COMPETITIVE. Be fair, name where the incumbent is genuinely strong, and position SingleStore alongside existing tools where that is true.`;

const buildSystem = (product: S2Focus) => `${singlestoreContextFor(product)}

${POSITIONING}

You are SingleStore's senior GTM analyst. Given a target company, research it on the live web and produce a TIGHT, evidence-grounded sales intel brief — only the fields in the schema below, no extra sections.

Research checklist (use web_search for each):
1. What the company does, HQ, headcount band, engineering headcount estimate (software + data engineers; LinkedIn pages, about pages, recent press).
2. Data architecture: which operational databases (Postgres, MySQL, Aurora, SQL Server, Oracle, MongoDB), warehouses/lakehouses (Snowflake, Databricks, BigQuery, Redshift), real-time OLAP (ClickHouse, Druid, Pinot), search (Elasticsearch, OpenSearch), caches (Redis), vector DBs (Pinecone, Weaviate, pgvector) and ETL/CDC tooling they run, from job posts, engineering blogs, talks and public repos. Note data volume and concurrency evidence (events/day, users, transactions, dashboards served).
3. Recent signals: data-platform / database / real-time analytics / ML-platform hiring, funding earmarked for data or AI, M&A that merges data estates, migrations or re-platforming, cost-cutting, latency or scaling commentary, customer-facing analytics features, and gen-AI / RAG / vector / agent launches.
4. Named data and engineering leaders where public (CTO, VP/SVP Engineering, Chief Data Officer, VP Data/Analytics, Head/Director of Data Engineering, Data Platform, Platform/Infrastructure, Database Engineering, ML/AI Platform; staff engineers and architects who write or talk publicly).
5. Streaming / real-time ingest evidence: job postings naming Kafka, Kinesis, Pulsar, Flink or Debezium/CDC; engineering-blog posts on event streaming or change data capture; public repos with Kafka/Flink/Debezium configuration.

Scoring: ICP sub-scores are each 0-20.
- dataScale: data and transaction volume, plus the size of the data + engineering org that builds on it. High = evidenced billions of events/rows, large concurrent user bases, or a large data/eng org; LOW for a 10-person startup or a company with little data, regardless of ambition.
- architectureComplexity: how many data systems are stitched together in the serving path (OLTP + warehouse/lakehouse + search + cache + vector + streaming) and how many pipelines move data between them. One Postgres instance scores low; five stores kept in sync for one product scores high.
- realtimeWorkload: customer-facing real-time analytics, high-concurrency and low-latency query needs, or transactions and analytics on the same fresh data (HTAP).
- scalingActivity: growth, migrations, re-platforming, data-platform initiatives and the hiring behind them, in roughly the last 12 months.
- aiWorkload: gen-AI, RAG, semantic/vector search or agents in production or being built.
The "streaming" block is a SILENT BONUS folded into the score (never surfaced to the user): when you find concrete streaming / CDC evidence (checklist item 5), set detected=true, quote the specific evidence, and award a bonus of +4 (indirect, e.g. one blog mention) to +10 (direct, e.g. multiple roles requiring Kafka/Flink, or Debezium/Kafka config in public repos). Do not output a total: the app computes it from your sub-scores and bonus (sum, capped at 99). Score honestly: evidence of a tool is not evidence of pain, and set detected=false with bonus 0 when there is no real streaming evidence.

Motion: pick exactly one of PLG, Top-Down, Champion-Led, Land-and-Expand from the evidence (developer-led teams => PLG on the free Shared tier or $500 starter credits for one workload; strict procurement or a CTO/CDO consolidation mandate => Top-Down; Land-and-Expand = one real-time workload or one consolidated pipeline, then adjacent workloads). Give ONE concrete firstMove (the specific first action to take) and name the key contact (real full name) it targets if found in public sources.

Outreach angle: one concrete angle tied to a specific live signal you found, with a 3-5 line draft message a rep could send today.

Outreach — a connect request, an InMail, and two timed follow-ups, keyed off the callHook signal.
${VOICE_SPEC}

PER-TOUCH STRUCTURE (jobs and caps are fixed; the voice above governs how they read):
- connect: AT MOST three short sentences, HARD CAP 300 characters including spaces, and well under it is better. Open "Hey [First],". NO subject, NO signature, NO pitch, NO mechanism, NO proof figure, NO numbers, NO diagnosis of their problem, NO restatement of their architecture. It ASKS how they're handling their specific data problem (real-time analytics on their product, keeping several stores in sync, serving fresh data at their concurrency, or vectors next to live data when the focus is ai), says in one clause that this is what Max works on, and stops. See the CONNECT REQUESTS block above for the calibration examples; do not model it on the InMail example. If nothing better fits, this template is acceptable: "Hey [First], curious how you're handling real-time analytics across [their specific thing]. That's what I work on at SingleStore. Would be good to connect."
- inmail: 4 short paragraphs MAX, with a subject. Paragraph 1: the specific hook, ONE sentence, no bio restatement. Paragraph 2: the mechanism, plainly: when transactions, analytics, search and vectors live in separate systems, every fresh-data question crosses a pipeline, so dashboards lag ingest and each new feature adds another store to keep in sync. Tie that to THEIR evidenced stack, framed as a likely consequence, not a diagnosis. Paragraph 3: what SingleStore does (one engine for transactions and real-time analytics, with full-text and vector in the same SQL, MySQL wire compatible, streaming ingest via Pipelines) plus ONE approved proof figure from PROOF, attributed to the named customer and stated with what it measured. Paragraph 4: a low-friction way to try it on their own data: point an existing MySQL driver at a Helios cluster and load one workload from Kafka or S3 with Pipelines; no promise of a result. Close "Let me know if it's worth a look." Sign "Max". (When productFocus is ai, paragraph 3 leads with vector + full-text + SQL on live operational data in one query, and paragraph 4 is loading their embeddings next to the operational data for one RAG or search feature.)
- followup2 (send +5 business days if no reply): 3 paragraphs max, with a DIFFERENT subject. A new angle, not a restatement. Either a different approved proof figure (with what it measured) or how evaluations actually run: one painful workload, agreed SLAs, their data. Never "circling back" or "following up".
- followup3 (send +10 business days if no reply): 2 short paragraphs, with its own subject. Reference a genuinely new external event ONLY if one exists in the signal and is verifiable. If none exists, make it a clean permission-to-close: ask whether this sits with someone else in the org. That question gets answered more often than the pitch does.

"[First]" is the ONLY placeholder permitted, because these are drafted per-COMPANY and reused for whichever contact the rep picks. Everything else must be paste-ready with no brackets.

Email opener — ONE or TWO sentences, pasted as a personalized lead-in ABOVE a templated email body (it is a lead-in, not a paragraph). Same voice and hard rules as the LinkedIn messages: mechanism-first, no em dashes, no fluff, specific never generic. It must draw from the callHook signal but frame it from a DIFFERENT angle than the LinkedIn connect note — a prospect who receives both the email and the connect request must never see the same observation twice (different fact, different framing, or a different consequence of the same signal).

Citations: list every distinct source you actually used.

Never include <cite> tags or any citation markup inside JSON string values — write plain prose; sources belong only in the "citations" array.

DEFUNCT, RENAMED, ACQUIRED OR AMBIGUOUS TARGETS. The company you are given comes from a stock-index list that is years out of date in places, so some of them no longer exist under that name. Do NOT answer in prose when this happens, and do NOT ask which company was meant — that reply is discarded by the caller and the whole research pass is wasted. Always return the JSON object:
- Acquired or renamed (e.g. "Twenty-First Century Fox", acquired by Disney in 2019): research the SUCCESSOR that inherited the engineering and data organisation, set "name" to the successor's current legal name, and open "summary" by stating the succession plainly, e.g. "Twenty-First Century Fox no longer exists; its studio and streaming assets went to The Walt Disney Company in March 2019, so this brief covers Disney." Score the successor.
- Split into several entities: pick the one that carries the data and software organisation, name it, and say in "summary" which parts went where.
- Genuinely nothing there, or too ambiguous to resolve: still return the object, with "name" set to the string you were given, every icp sub-score 0, and "summary" explaining in one or two sentences what you found and what the rep should search for instead.

${SEGMENT_GUIDE}

Output ONLY one JSON object — no prose, no code fences:
{
  "name": "Canonical Company Name",
  "domain": "company.com",
  "productFocus": "realtime|ai",
  "focusReason": "one sentence: why this entry workload is the one to lead with here",
  "segment": "${SEGMENT_ENUM}",
  "oneLiner": "what they do, one line",
  "hq": "City, Country",
  "employeeBand": "e.g. 200-500",
  "sweEstimate": number or null (software + data engineers),
  "icp": {
    "dataScale": 0-20,
    "architectureComplexity": 0-20,
    "realtimeWorkload": 0-20,
    "scalingActivity": 0-20,
    "aiWorkload": 0-20,
    "streaming": { "detected": true|false, "bonus": 0-10, "evidence": "the specific streaming / CDC evidence found, or empty string" },
    "rationale": "2-3 sentences explaining the score from evidence"
  },
  "summary": "2-4 sentence executive summary grounded in findings",
  "callHook": "ONE glanceable sentence a rep can drop in a call — the single most valuable, specific signal you found (a number, event, or quote), not generic. e.g. 'Hiring three Kafka engineers for a customer-facing analytics product while the job posts list Postgres, Redis and Elasticsearch side by side.'",
  "motion": { "primary": "PLG|Top-Down|Champion-Led|Land-and-Expand", "firstMove": "concrete first action", "keyContactName": "the specific person the first move targets (real full name) or null if generic", "keyContactTitle": "that person's title or null" },
  "outreach": { "hook": "", "channel": "Email|LinkedIn|Engineering Community|Warm Intro", "proof": "the specific signal behind the hook", "draftMessage": "3-5 lines" },
  "linkedinOutreach": { "connect": "connect request, HARD CAP 300 chars, no subject, no signature, no proof figure", "inmail": { "subject": "lowercase 2-4 words", "body": "4 short paragraphs max, signed Max" }, "followup2": { "subject": "lowercase 2-4 words, different from the inmail subject", "body": "3 paragraphs max, new angle" }, "followup3": { "subject": "lowercase 2-4 words", "body": "2 short paragraphs" } },
  "emailOpener": "1-2 sentence signal-specific email lead-in, different angle than the connect note",
  "citations": [ { "title": "", "source": "publisher", "url": "https://...", "date": "YYYY-MM-DD or omit", "kind": "hiring|oss|ma|funding|ai|news|other" } ]
}`;

interface ModelIntel {
  name?: string;
  domain?: string;
  productFocus?: string;
  focusReason?: string;
  segment?: string;
  oneLiner?: string;
  hq?: string;
  employeeBand?: string;
  sweEstimate?: number | null;
  icp?: Partial<ICPScore>;
  summary?: string;
  callHook?: string;
  linkedinOutreach?: {
    connect?: string;
    inmail?: { subject?: string; body?: string };
    followup2?: { subject?: string; body?: string };
    followup3?: { subject?: string; body?: string };
  };
  emailOpener?: string;
  whySingleStore?: string[];
  stakeholders?: Partial<Stakeholder>[];
  painPoints?: CompanyIntel["painPoints"];
  competitors?: CompanyIntel["competitors"];
  motion?: Partial<CompanyIntel["motion"]>;
  dataCost?: Partial<DataCostExposure>;
  migration?: Partial<MigrationFriction>;
  outreach?: Partial<CompanyIntel["outreach"]>;
  citations?: Partial<LiveCitation>[];
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(x)));
};

// Trim a model-supplied name/title; treat empty or literal "null" as absent.
const cleanName = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "none" ? s : undefined;
};

// Scores must come from the model, not from defaults — a brief with a missing
// or non-numeric ICP block is incomplete and gets rejected (retryable 502)
// rather than rendered with invented midpoint values.
/** Normalize one subject+body message. Subjects are forced lowercase and
 *  stripped of colons/question marks in CODE, because the prompt asks for it
 *  but a title-cased subject is the single most visible tell that the spec was
 *  ignored. Returns undefined when there is no usable body, so a partial model
 *  response degrades to "missing" rather than an empty labelled section. */
function pickMessage(
  m: { subject?: string; body?: string } | undefined,
  cap: number,
): { subject: string; body: string } | undefined {
  const body = enforceLinkedin(String(m?.body || ""), cap);
  if (!body) return undefined;
  const subject = String(m?.subject || "")
    .toLowerCase()
    .replace(/[:?]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return { subject, body };
}

/** Every sub-score is a real number (null / "" / missing fail: Number(null)
 *  is 0, which used to pass). The total is not required: it is computed. */
function icpComplete(icp: Partial<ICPScore> | undefined): icp is ICPScore {
  return subScoresComplete(icp);
}

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  if (!company) {
    return NextResponse.json({ error: "Missing ?company=" }, { status: 400 });
  }

  // Cache-first: a previously generated brief returns instantly. ?fresh=1
  // (the "Update brief" button) skips the cache and regenerates.
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  // ?product=ai pins the brief to the AI / vector entry workload (a brief
  // explicitly meant for it keeps that focus). Anything else: realtime leads
  // and the model may still choose ai from the evidence.
  const productParam = req.nextUrl.searchParams.get("product")?.trim();
  const pinned: S2Focus | undefined = (VALID_PRODUCTS as string[]).includes(productParam ?? "")
    ? (productParam as S2Focus)
    : undefined;
  if (!fresh && dbConfigured()) {
    const cached = await fetchBrief(company);
    if (cached) {
      return NextResponse.json(
        { intel: cached, cached: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // Measured engineering headcount (Apollo departmental counts, two FREE
  // calls) injected as ground evidence, so the brief's engineering estimate anchors
  // on data instead of a share-of-headcount guess. Best-effort — a miss
  // changes nothing about the research pass.
  let orgFactsLine = "";
  try {
    const look = await apolloOrgLookup(company);
    const facts = look.ok && look.domain ? await apolloOrgFacts(look.domain) : null;
    if (facts && (facts.engineering || facts.employees)) {
      orgFactsLine =
        `\nMeasured headcount evidence (Apollo, LinkedIn-derived; treat as floors where LinkedIn coverage is thin, and note "engineering" includes non-software engineers at industrial companies; sweEstimate means software + data engineers): ` +
        `${facts.employees ? `~${facts.employees.toLocaleString()} total employees. ` : ""}` +
        `${facts.engineering ? `Engineering department ~${facts.engineering.toLocaleString()}. ` : ""}` +
        `${facts.informationTechnology ? `IT department ~${facts.informationTechnology.toLocaleString()}. ` : ""}` +
        `Anchor sweEstimate on this evidence, reconciled with anything your research finds.`;
    }
  } catch {
    /* best-effort */
  }

  try {
    const result = await callClaudeWithWebSearch({
      system: buildSystem(pinned ?? "realtime"),
      user:
        `Research "${company}" and produce the lean SingleStore intel brief JSON. Today's date: ${new Date().toISOString().slice(0, 10)}.${orgFactsLine}` +
        (pinned
          ? `\nPRODUCT FOCUS PINNED BY THE REP: ${pinned}. Keep the whole brief about that entry workload.`
          : ""),
      maxSearches: 6,
      // 5000 was set when outreach was four short strings. The Aug 2026 spec
      // replaced those with a connect note plus THREE subject+body messages
      // (InMail and two follow-ups), and the brief already carries stakeholders,
      // pain points, competitors, motion, cost and citations. Research-heavy
      // accounts (Lockheed Martin) then ran past the ceiling and 502'd with
      // stop_reason max_tokens. Headroom is cheap; a truncated brief costs the
      // whole research pass.
      maxTokens: 9000,
      temperature: 0.3,
    });

    const parsed = extractJSON<ModelIntel>(result.text);
    // The lean brief generates neither the migration block nor the cost panel
    // (cost is an on-demand expand),
    // so only require a name + a complete ICP block.
    if (!parsed || !parsed.name || !icpComplete(parsed.icp)) {
      // Log enough to diagnose the next one instead of guessing. "No parseable
      // brief" has several distinct causes (the model answered in prose, it
      // returned only tool blocks, it emitted JSON we mis-sliced) and the
      // message alone can't tell them apart.
      const diag = diagnoseJSON(result.text);
      console.error(
        `[intel] ${company} unparseable: stop=${result.stopReason} truncated=${result.truncated} ` +
          `searches=${result.searchCount} textLen=${result.text.length} json=${diag.detail} ` +
          `head=${JSON.stringify(result.text.slice(0, 200))} tail=${JSON.stringify(result.text.slice(-200))}`,
      );
      // THE MODEL ANSWERED IN PROSE. Not a parse failure and emphatically not
      // transient: it researched the company, concluded it could not write the
      // brief, and explained why in English. Observed on Twenty-First Century
      // Fox — "a defunct entity, acquired by Disney, effective March 20 2019",
      // offering Fox Corporation or Disney instead. Reporting that as "try
      // again, usually transient" sends the rep to burn another research pass
      // on a company that no longer exists.
      //
      // The explanation is the most useful thing the call produced, so it is
      // what gets shown.
      // A text that CONTAINS a brief-sized JSON object is not an explanation:
      // the model wrote the brief and it failed to parse (Sep 25: ten Sonnet 5
      // briefs were reported as "an explanation instead" while each one ended
      // in a complete JSON block).
      const prose = !result.truncated && !parsed && result.text.trim().length > 0 && !diag.attempted;
      if (prose) {
        return NextResponse.json(
          {
            error: `No brief for "${company}" — the research came back with an explanation instead. ${summarizeRefusal(result.text)}`,
            modelNote: result.text.slice(0, 1200),
            retryable: false,
            searchCount: result.searchCount,
            searchErrors: result.searchErrors,
          },
          { status: 422, headers: { "Cache-Control": "no-store" } },
        );
      }
      const cause = result.truncated
        ? `the response was cut off (stop_reason: ${result.stopReason})`
        : !result.text.trim()
          ? "the model returned no text at all (only search calls)"
          : !parsed && diag.attempted
            ? "the brief came back malformed and could not be read"
            : "the brief came back without a complete ICP score";
      return NextResponse.json(
        {
          // Don't call a truncation transient — retrying an over-budget brief
          // just burns another research pass. Say which failure it was.
          error: result.truncated
            ? `Live research pass incomplete — ${cause}. Retrying may not help: the brief is too long for the output budget.`
            : `Live research pass incomplete — ${cause}. Try again; this is usually transient.`,
          searchCount: result.searchCount,
          searchErrors: result.searchErrors,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const segmentId: SegmentId = (VALID_SEGMENTS as string[]).includes(
      String(parsed.segment),
    )
      ? (parsed.segment as SegmentId)
      : "saas";

    // Merge model-declared citations with the URLs actually returned by the
    // web_search tool (the latter are ground truth for "what was read").
    const citations = new Map<string, LiveCitation>();
    for (const c of parsed.citations ?? []) {
      if (!c?.url) continue;
      citations.set(c.url, {
        title: c.title || c.url,
        source: c.source || hostOf(c.url),
        url: c.url,
        date: c.date,
        kind: (c.kind as LiveCitation["kind"]) || "other",
      });
    }
    for (const c of result.citations) {
      if (!citations.has(c.url)) citations.set(c.url, c);
    }

    const intel: CompanyIntel = {
      name: String(parsed.name),
      domain: parsed.domain ? String(parsed.domain) : undefined,
      // A pin outranks the model's choice; otherwise the model's choice,
      // defaulting to realtime if it returned something invalid.
      productFocus:
        pinned ??
        ((VALID_PRODUCTS as string[]).includes(String(parsed.productFocus))
          ? (parsed.productFocus as S2Focus)
          : "realtime"),
      focusReason: parsed.focusReason ? String(parsed.focusReason).slice(0, 300) : undefined,
      segment: SEGMENT_MAP[segmentId],
      oneLiner: String(parsed.oneLiner || ""),
      hq: parsed.hq ? String(parsed.hq) : undefined,
      employeeBand: parsed.employeeBand ? String(parsed.employeeBand) : undefined,
      sweEstimate:
        typeof parsed.sweEstimate === "number" && parsed.sweEstimate > 0
          ? Math.round(parsed.sweEstimate)
          : undefined,
      icp: {
        // icpComplete() guaranteed these are numeric — clamp only bounds them.
        total: 0, // computed from the sub-scores below
        dataScale: clamp(parsed.icp.dataScale, 0, 20, 0),
        architectureComplexity: clamp(parsed.icp.architectureComplexity, 0, 20, 0),
        realtimeWorkload: clamp(parsed.icp.realtimeWorkload, 0, 20, 0),
        scalingActivity: clamp(parsed.icp.scalingActivity, 0, 20, 0),
        aiWorkload: clamp(parsed.icp.aiWorkload, 0, 20, 0),
        // Bonus signal — only kept when detected WITH actual evidence text.
        streaming:
          parsed.icp.streaming?.detected && String(parsed.icp.streaming.evidence || "").trim()
            ? {
                detected: true,
                bonus: clamp(parsed.icp.streaming.bonus, 0, 10, 0),
                evidence: String(parsed.icp.streaming.evidence).trim(),
              }
            : { detected: false, bonus: 0, evidence: "" },
        rationale: String(parsed.icp.rationale || ""),
      },
      generatedAt: new Date().toISOString(),
      summary: String(parsed.summary || ""),
      callHook: String(parsed.callHook || ""),
      linkedinOutreach: parsed.linkedinOutreach?.connect
        ? {
            // connect is a hard 300. The InMail/follow-up caps are generous
            // backstops against a runaway draft, not shaping targets — the
            // paragraph limits in the prompt do the shaping.
            connect: enforceLinkedin(String(parsed.linkedinOutreach.connect), CONNECT_CAP),
            inmail: pickMessage(parsed.linkedinOutreach.inmail, 1100),
            followup2: pickMessage(parsed.linkedinOutreach.followup2, 800),
            followup3: pickMessage(parsed.linkedinOutreach.followup3, 600),
          }
        : undefined,
      // Lead-in, not a paragraph — same dash/length hygiene as the LinkedIn set.
      emailOpener: parsed.emailOpener ? enforceLinkedin(String(parsed.emailOpener), 350) : undefined,
      whySingleStore: (parsed.whySingleStore ?? []).map(String).filter(Boolean).slice(0, 5),
      stakeholders: (parsed.stakeholders ?? [])
        .filter((s) => s?.role)
        .map((s) => ({
          role: String(s.role),
          name: s.name ? String(s.name) : undefined,
          type: VALID_STAKEHOLDER_TYPES.includes(s.type as Stakeholder["type"])
            ? (s.type as Stakeholder["type"])
            : "influencer",
          rationale: String(s.rationale || ""),
          outreachHook: String(s.outreachHook || ""),
          linkedinQuery: s.linkedinQuery ? String(s.linkedinQuery) : undefined,
        }))
        .slice(0, 8),
      painPoints: (parsed.painPoints ?? [])
        .filter((p) => p?.title)
        .map((p) => ({
          title: String(p.title),
          severity: ["HIGH", "MEDIUM", "LOW"].includes(String(p.severity))
            ? (p.severity as "HIGH" | "MEDIUM" | "LOW")
            : "MEDIUM",
          category: String(p.category || "General"),
          evidence: String(p.evidence || ""),
          s2Solution: String(p.s2Solution || ""),
        }))
        .slice(0, 6),
      competitors: (parsed.competitors ?? [])
        .filter((c) => c?.name)
        .map((c) => ({
          name: String(c.name),
          category: String(c.category || "Competitor"),
          weakness: String(c.weakness || ""),
          s2Advantage: String(c.s2Advantage || ""),
          pitch: String(c.pitch || ""),
        }))
        .slice(0, 5),
      motion: {
        primary: VALID_MOTIONS.includes(parsed.motion?.primary as Motion)
          ? (parsed.motion?.primary as Motion)
          : "Champion-Led",
        reasoning: String(parsed.motion?.reasoning || ""),
        firstMove: String(parsed.motion?.firstMove || ""),
        watchOuts: (parsed.motion?.watchOuts ?? []).map(String).slice(0, 4),
        keyContactName: cleanName(parsed.motion?.keyContactName),
        keyContactTitle: cleanName(parsed.motion?.keyContactTitle),
      },
      dataCost: {
        estimatedMonthlyUsd: clamp(parsed.dataCost?.estimatedMonthlyUsd, 0, 100_000_000, 0),
        systemsCount: clamp(parsed.dataCost?.systemsCount, 0, 50, 0),
        perSystemUsd: clamp(parsed.dataCost?.perSystemUsd, 0, 10_000_000, 0),
        systems: Array.isArray(parsed.dataCost?.systems)
          ? parsed.dataCost.systems.map(String).filter(Boolean).slice(0, 10)
          : undefined,
        notes: String(parsed.dataCost?.notes || ""),
        s2OffsetUsd:
          typeof parsed.dataCost?.s2OffsetUsd === "number"
            ? clamp(parsed.dataCost.s2OffsetUsd, 0, 100_000_000, 0)
            : undefined,
      },
      migration: {
        score: clamp(parsed.migration?.score, 0, 99, 0),
        level: ["Low", "Medium", "High"].includes(String(parsed.migration?.level))
          ? (parsed.migration?.level as "Low" | "Medium" | "High")
          : "Medium",
        drivers: (parsed.migration?.drivers ?? []).map(String).slice(0, 5),
        mitigations: (parsed.migration?.mitigations ?? []).map(String).slice(0, 5),
      },
      outreach: {
        hook: String(parsed.outreach?.hook || ""),
        channel: ["Email", "LinkedIn", "Engineering Community", "Warm Intro"].includes(
          String(parsed.outreach?.channel),
        )
          ? (parsed.outreach?.channel as CompanyIntel["outreach"]["channel"])
          : "Email",
        proof: String(parsed.outreach?.proof || ""),
        draftMessage: String(parsed.outreach?.draftMessage || ""),
      },
      citations: Array.from(citations.values()).slice(0, 16),
    };
    // The total is arithmetic, not a model output: sub-scores + streaming bonus, capped at 99.
    intel.icp.total = computeIcpTotal(intel.icp);

    // Persist for instant future opens, keyed on the REQUESTED name — that's
    // what the next click looks up (the model may canonicalize differently).
    // The DB is the cache now — keep the CDN out of it so "Update brief" is
    // never masked by a stale edge copy.
    if (dbConfigured()) {
      await upsertBrief(company, intel);
    }

    return NextResponse.json(
      { intel, cached: false, searchCount: result.searchCount },
      { headers: { "Cache-Control": "no-store" } },
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
    return url;
  }
}

// enforceLinkedin now lives in lib/outreachRules alongside the ban list, so the
// per-person connect generator applies byte-identical sanitizing.
