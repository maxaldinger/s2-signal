import { NextRequest, NextResponse } from "next/server";
import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "@/lib/anthropic";
import { singlestoreContextFor, type S2Focus } from "@/lib/singlestore";

// Sales Assist — two kinds of modes:
//  - chat modes (ask / email / objections / research): free-form answers,
//    grounded with web_search where it helps;
//  - tool modes (lou / threading / poc / meddpicc): structured JSON extracted
//    from the rep's notes, rendered as interactive tools in the UI (LOU table +
//    Excel export, MEDDPICC scorecard, POC plan + PDF, …). The ROI calculator
//    is fully client-side and does not hit this route.
export const maxDuration = 180;

// Must match the Excel data-validation list in components/SalesAssist.tsx.
const LOU_CATEGORIES =
  "Performance & Concurrency | Data Freshness & Ingest | Cost & Consolidation | AI / Vector & Search | Migration & Operations";

type ModeType = "text" | "json";
interface ModeCfg {
  type: ModeType;
  instruction: string;
  schema?: string;
  maxSearches: number;
  // Heavy JSON modes (e.g. the POC plan) need Sonnet + more tokens for quality;
  // the light extract modes stay on the fast model.
  heavy?: boolean;
}

const MODES: Record<string, ModeCfg> = {
  // ---- chat mode ----
  ask: {
    type: "text",
    instruction:
      "Answer the rep's request directly and practically — questions, objection handling, email drafts, account research, call prep. " +
      "For emails: subject line + tight body (under 130 words) + one clear CTA. Any pain you attribute to the prospect is a HYPOTHESIS ('teams running X often…'), never a stated fact; a technology being in their stack is not evidence of pain. " +
      "For objections: acknowledge → reframe → evidence → one question to advance the deal. Follow the COMPETITIVE section: say plainly where the competitor or the status quo is genuinely strong, position SingleStore alongside existing tools where that is true (the warehouse/lakehouse usually stays), and recommend proving one painful workload rather than a big-bang migration. Evidence comes ONLY from PROOF, each figure stated with what it measured and as a published customer claim; never promise a speedup or saving for this prospect before their own test. " +
      "For account research: search the live web, synthesize into SHORT CAPS sections, end with 'SO WHAT FOR SINGLESTORE' (the likely entry workload, who to approach, and the hypothesis to test). " +
      "Whenever a specific company or person is referenced, verify facts with a quick web search before asserting them — never invent prospect facts or contact details.",
    maxSearches: 5,
  },

  // ---- structured tool modes ----
  lou: {
    type: "json",
    instruction:
      "Read the meeting notes and extract the prospect's critical business issues. For EACH issue, map whether/how SingleStore helps — be specific about which SingleStore capability (e.g. HTAP rowstore + columnstore, Pipelines ingest, MySQL wire compatibility, vector + full-text in SQL, Flow CDC migration, online scaling) and what outcome. If SingleStore is not the right fit for an issue, say so in 'solution'. Only include issues actually present in the notes; never invent issues or numbers.",
    schema: `{"issues":[{"issue":"the critical business problem in their words","solution":"Can we help? If so, how? — specific SingleStore capability + outcome (or 'Not a SingleStore fit: …')","category":"${LOU_CATEGORIES}","priority":"High|Medium|Low","timeframe":"short phase/timeframe e.g. 'Phase 1 - Evaluation (2 weeks)'"}]}`,
    maxSearches: 1,
  },
  threading: {
    type: "json",
    instruction:
      "Analyze the buying committee from the stakeholders provided. Classify each by role and disposition, give a one-line engagement strategy tuned to selling SingleStore: query-latency, freshness and pipeline pain → staff/principal data engineers, database architects, SRE/DBAs on hot OLTP clusters; the champion → head of data platform / data engineering / platform / real-time analytics / ML platform; budget and consolidation case → CTO, VP Engineering, Chief Data Officer, VP Data; database and warehouse spend → FinOps / cloud-cost owner; security review and procurement → security/compliance lead. Then identify coverage gaps and next actions to multi-thread the deal.",
    schema: `{"summary":"1-2 sentence committee read","stakeholders":[{"name":"","title":"","role":"Champion|Economic Buyer|Decision Maker|Influencer|Blocker|Unknown","disposition":"Supporter|Neutral|Detractor|Unknown","strategy":"one-line engagement plan"}],"gaps":["coverage gap"],"nextActions":["concrete next action"]}`,
    maxSearches: 1,
  },
  poc: {
    type: "json",
    heavy: true,
    instruction:
      "GROUNDING RULE (highest priority): every name, number, decision, system, and commitment in this document MUST be traceable to the provided transcript or summary. The standard STRUCTURE (scope, success criteria, metrics, data plan, environment, timeline, risks, exit criteria, sign-off) comes from this template; every DEAL-SPECIFIC fact (people, data volumes, query latencies, concurrency, systems, cloud, decisions, commitments, dates) comes from the SOURCE ONLY. When the source is silent on a specific, write a bracketed placeholder ('[unassigned — confirm]', '[agree at kickoff]', '[confirm volume]', '[scope TBD]') — NEVER invent a name, number, SLA, or decision. " +
      "Generate a precise Proof-of-Concept (technical evaluation) PLAN for SingleStore, grounded only in the notes. First read the source and extract: company name, the ONE workload to evaluate (the most painful query path, dashboard, or pipeline the source names), current systems behind it, data volume, ingest rate, peak concurrency, latency/freshness targets, cloud and region, their pain, and the real people with the roles the source gives them. " +
      "PEOPLE (no invented names): every person named in roles.customer, roles.singlestore, and nextSteps MUST appear verbatim in the source with that role. If a role has no named person in the source, output '[unassigned — confirm]' — do NOT invent a name, reuse a name from a different role, or use a generic/sample SingleStore name. Attribute each next-step owner to the person the source actually assigned it to. " +
      "PRODUCT NAMES (canonical spellings — use exactly these): SingleStore, SingleStore Helios, Helios BYOC, Pipelines, SingleStore Flow, SingleStore Kai, Notebooks, Snowflake, Databricks, ClickHouse, PostgreSQL, Aurora, MySQL, Elasticsearch, OpenSearch, Pinecone, Redis, MongoDB, DynamoDB, Kafka, Kinesis, Debezium, Apache Iceberg, Amazon S3, dbt, Fivetran, Looker, Tableau. Transcripts are speech-to-text and WILL contain garbles; normalize them and never inherit them: 'single store' -> SingleStore, 'click house' -> ClickHouse, 'snow flake' -> Snowflake, 'data bricks' -> Databricks, 'my sequel' -> MySQL, 'post grass'/'postgress' -> PostgreSQL, 'pine cone' -> Pinecone, 'elastic search' -> Elasticsearch, and any obvious mis-transcription -> the intended system from context. " +
      "INFRASTRUCTURE ROLES (never merge): a source/operational database (MySQL, PostgreSQL, Aurora), a streaming transport (Kafka, Kinesis), a CDC tool (Debezium, Flow), object storage (S3, Iceberg tables), a warehouse/lakehouse (Snowflake, Databricks), a consuming app or BI tool, and a cloud/region are DISTINCT roles. Preserve exactly the role each element has in the source; never fuse them into one phrase (e.g. never write 'Kafka CDC from Snowflake'). " +
      "OPEN DECISIONS (do not decide for the customer): if the source shows a decision as still open (deployment model Helios vs BYOC vs self-managed, which workload, production vs masked data, 'we haven't decided', 'TBD'), present it as OPEN with the stated options and attribute any recommendation to whoever made it — e.g. 'Helios recommended by Priya for speed; BYOC per Sam's security preference — confirm at kickoff'. Never assert an undecided thing as decided. " +
      "EVALUATION NORMS (from the POC section — follow exactly): the free Shared tier is for familiarization only and is NOT for benchmarking; performance tests run on a Standard (or Enterprise) Helios cluster using the $500 starter credits or a sales-led trial; start small (S-00/S-1) and scale online per the Helios sizing guidelines; load via a MySQL-compatible connection, Pipelines (Kafka, S3, Iceberg, etc.) or Flow (migration + CDC from MySQL/PostgreSQL/Oracle/SQL Server); prove ONE workload against agreed SLAs. Do NOT promise or schedule a head-to-head bake-off against the incumbent unless the source says the customer asked for one; if it did, require identical data, queries and concurrency, run by the customer's team. Never promise a speedup, latency, or saving before the customer's own test. " +
      "AUDIENCE & VOICE: this is a TECHNICAL EVALUATION DOCUMENT written for an engineering audience (CTO/VP Engineering, head of data platform, staff data engineers, DBAs). Write plainly and precisely, the way an engineer scoping an evaluation would. State mechanisms, conditions, and measurements. " +
      "DO NOT use marketing language: no taglines, no rhetorical contrasts ('not X, but Y'), no hype words (unlock as a verb, supercharge, transformative, game-changer, effortless, magic, blazing), no exclamation points, no second-person selling ('you'll love'), no adjectives doing the work that a number should. If a sentence would sound at home in a pitch deck, rewrite it as a factual statement. Follow these rules exactly:\n" +
      "1) SCOPE: name ONE workload (scope.workload). inScope = the tables/sources/queries/consumers included; outOfScope = what this evaluation deliberately excludes (other workloads, full migration, the warehouse that stays). fit = strong|adequate|weak, judged honestly against COMPETITIVE: e.g. append-only batch analytics with no latency/concurrency need is a weak fit where ClickHouse or the existing warehouse is strong; fitNote = one honest sentence.\n" +
      "2) SUCCESS CRITERIA: exactly 3, each tied to one of the metrics. target = the number the SOURCE states (e.g. 'p95 < 500 ms at 200 concurrent users'); if none is stated, '[agree at kickoff]' — never invent a target. measuredBy = the objective method.\n" +
      "3) METRICS: define four measurable signals, each with how it's measured in the evaluation and why it matters: (a) p95/p99 query latency at the target concurrency on the customer's real query set, vs the recorded baseline; (b) ingest-to-query freshness at the target ingest rate (time from an event landing to being queryable); (c) cost: MODELED monthly cost of the sized cluster from public list prices (credits × $3.96, plus storage) vs the recorded current monthly spend on the systems in scope — label it modeled; (d) migration effort: share of the query set that runs unchanged over the MySQL wire protocol, plus engineer-days to load and cut over. Set primary=true on exactly one: the metric the source names as the decision driver, else (a). 'why' must be a factual reason it matters, not a sales claim.\n" +
      "4) DATA & INGEST PLAN: sources (from the source), ingest (Pipelines from Kafka/S3/Iceberg, Flow CDC, or bulk load — matched to how their data arrives today), connectivity (MySQL-compatible drivers/ORMs/BI tools they named), volume (from the source or '[confirm volume]'). Note when production data needs masking or a synthetic set.\n" +
      "5) ENVIRONMENT: deployment (Helios on their cloud/region, BYOC, or self-managed — open if undecided), size (start S-00/S-1, scale online; name the target size only if grounded), costNote = MODELED credit burn for the evaluation using list prices (S-00 $0.99/h, S-1 $3.96/h, S-4 $15.84/h, storage $0.023/GB-month) with the hours assumption stated, and whether it fits inside the $500 starter credits; notes = the Shared tier is not used for benchmarking.\n" +
      "6) TIMELINE: 2 phases. Default to a 2-week window unless the source states another. Phase 1 checkpoint must be concrete — 'Data loaded via the agreed ingest path and the baseline query set running; first latency and freshness numbers recorded'. Phase 2 checkpoint = review measured results against the success criteria and exit criteria, then decide.\n" +
      "7) RISKS: 3 risks grounded in the source's stack and situation (e.g. MySQL-syntax gaps in their query set, data-access or security approval delays, unclear SLA, undersized cluster), each with a concrete mitigation (e.g. run the full query set in week 1 and log every rewrite). No generic filler.\n" +
      "8) EXIT CRITERIA: go = 2-3 conditions tied to the success criteria; noGo = 2-3 conditions that would end the evaluation honestly (e.g. target missed at agreed concurrency after tuning, required syntax unsupported).\n" +
      "9) REFERENCE POINT: cite ONE published prior evaluation from the POC/PROOF sections, the closest to this workload, stated factually as another customer's vendor-published result: Armis defined query SLAs of 1.5s/3s/10s over 3/7/30+ days of data and ran its POC with partner Twingo; Siemens went from trial deployment to selection in 5 days; or the Fortune 25 bank's own head-to-head (3x faster average query than SAP HANA in that test). Present it as a single prior result, not a guarantee, then describe how they set their own SLAs and baseline during the evaluation. No editorializing.\n" +
      "10) CHECKLIST — ECONOMIC & PERFORMANCE BASELINE: the checklist MUST include recording, BEFORE the evaluation starts and with a named owner, (i) the current monthly spend on the systems in scope (database, replicas, warehouse compute, search, cache, vector, ETL/CDC tooling) and (ii) current p95/p99 latency at peak concurrency for the query set — so results convert to a cost and performance comparison at readout. Make this item explicit and specific.\n" +
      "Keep every field specific to the prospect in the notes. " +
      "LENGTH: this renders as a 3-page document, so be tight — every string one sentence, ~22 words max. 2-4 inScope, 1-3 outOfScope, exactly 3 successCriteria, exactly the 4 metrics, 2 timeline phases, exactly 3 risks, 2-3 go and 2-3 noGo, 5-7 checklist items (one of which is the baseline above), 2-3 next steps. No filler.",
    schema: `{"company":"prospect company name","headline":"plain descriptive document title, <=9 words (NOT a marketing tagline)","scope":{"workload":"the ONE workload under evaluation, in one sentence","inScope":["included table/source/query/consumer"],"outOfScope":["deliberately excluded item"],"fit":"strong|adequate|weak","fitNote":"one honest sentence on how well this workload matches SingleStore's strengths"},"successCriteria":[{"criterion":"what must be true, tied to a metric","target":"number from the source, or [agree at kickoff]","measuredBy":"objective measurement method"}],"metrics":[{"name":"metric name","how":"how it is measured during the evaluation","why":"factual reason it matters for the evaluation","primary":false}],"dataPlan":{"sources":["source system named in the notes"],"ingest":"Pipelines / Flow / bulk load path matched to how their data arrives","connectivity":"MySQL-compatible drivers, ORMs, BI tools they named","volume":"data volume and ingest rate from the source, or [confirm volume]"},"environment":{"deployment":"Helios cloud/region, BYOC or self-managed (open if undecided)","size":"starting size and scale plan","costNote":"MODELED evaluation credit burn from list prices, with hours assumption","notes":"evaluation-environment notes (Shared tier not used for benchmarking)"},"timeline":[{"phase":"Week 1","activities":["activity"],"checkpoint":"concrete checkpoint"}],"roles":{"customer":["<role>: <person named in the source, or [unassigned — confirm]>"],"singlestore":["<role>: <SingleStore person named in the source, or [unassigned — confirm]>"]},"risks":[{"risk":"risk grounded in the source","mitigation":"concrete mitigation"}],"exitCriteria":{"go":["condition"],"noGo":["condition"]},"reference":{"anchor":"one published prior evaluation stated factually as another customer's result","yourVersion":"how they set their own SLAs and baseline during the evaluation","framing":"one neutral line on how to interpret it"},"checklist":["pre-evaluation item grounded in the source (include: the baseline above, representative query set + peak concurrency, dataset and masking decision, access to Kafka topic / S3 bucket / CDC source, network + security approval, Helios org + credits, POC lead + decision lead, start date)"],"nextSteps":["<owner named in the source>: <the action they committed to> (<date if the source states one>)"]}`,
    maxSearches: 2,
  },
  meddpicc: {
    type: "json",
    instruction:
      "Fill a MEDDPICC scorecard ONLY from what the notes actually contain. If an element was not discussed, set status to 'not_set' and leave notes empty. Status: 'strong' = solid, confirmed; 'weak' = partial/assumed; 'missing' = explicitly a gap/unknown that matters; 'not_set' = not discussed. Notes should be concise and specific. " +
      "This is a SingleStore deal; read each element through that lens: " +
      "METRICS = quantified outcomes the customer cares about — query latency (p95/p99) at a stated concurrency, ingest-to-query freshness, infrastructure and pipeline cost, number of systems consolidated, engineer time spent on pipelines. " +
      "ECONOMIC BUYER = whoever owns database/data-platform budget — usually CTO, VP Engineering, Chief Data Officer or VP Data. " +
      "DECISION CRITERIA = performance at concurrency on their real queries, MySQL compatibility of their query set and tools, vector + SQL (+ full-text) in one engine, TCO vs the current stack, deployment model (Helios, BYOC, self-managed) and security/compliance requirements. " +
      "DECISION PROCESS = the steps to a decision, including the technical evaluation/POC (who runs it, the workload, agreed SLAs, readout date) and who signs off after it. " +
      "PAPER PROCESS = security review, DPA/legal, procurement, and how it is bought (direct, AWS Marketplace billing, on-demand vs a 1-year committed credit volume). " +
      "IMPLICATE THE PAIN = the business cost of the problem — slow customer-facing dashboards, stale data, Postgres/MySQL single-writer limits, Elasticsearch or warehouse cost for serving queries, systems kept in sync by hand. A technology in their stack is not pain unless the notes say it hurts. " +
      "CHAMPION = usually the head of data platform / data engineering / platform; strong only if they have influence and are actively selling internally. " +
      "COMPETITION = the incumbent stack and status quo, build-it-yourself, and named alternatives (Snowflake, Databricks, ClickHouse, Postgres/Aurora, Elasticsearch/OpenSearch, Pinecone, Redis, MongoDB); judge fairly per COMPETITIVE. " +
      "For EVERY element (including weak, missing, and not_set ones), also return 2-4 'suggestions': concrete next moves on HOW to strengthen that element on THIS deal. Ground each suggestion in the notes — reference the real people, systems, workloads, competitors, numbers, and situations mentioned. Phrase them as specific discovery questions or actions the rep can take next (e.g. 'Ask Dana who signs off on database spend above $100k and whether it can go through AWS Marketplace', not 'Identify the economic buyer'). If the element is already strong, suggest how to confirm or leverage it. Never return generic, deal-agnostic advice.",
    schema: `{"elements":{"metrics":{"status":"strong|weak|missing|not_set","notes":"","suggestions":["",""]},"economicBuyer":{"status":"","notes":"","suggestions":[]},"decisionCriteria":{"status":"","notes":"","suggestions":[]},"decisionProcess":{"status":"","notes":"","suggestions":[]},"paperProcess":{"status":"","notes":"","suggestions":[]},"identifyPain":{"status":"","notes":"","suggestions":[]},"champion":{"status":"","notes":"","suggestions":[]},"competition":{"status":"","notes":"","suggestions":[]}}}`,
    maxSearches: 1,
  },
};

const TONES = new Set(["Direct", "Consultative", "Concise", "Technical"]);
// Must match PERSONAS in components/SalesAssist.tsx.
const PERSONAS = new Set([
  "VP Engineering",
  "CTO",
  "Chief Data Officer / VP Data",
  "Head of Data Platform",
  "Staff Data Engineer / DBA",
  "AI / ML Platform Lead",
  "Security Lead",
]);

// Which half of the product context leads. "realtime" (the default) leads with
// the core HTAP engine; "ai" leads with vector + full-text + AI functions when
// the work is clearly about gen-AI / RAG / vectors.
const AI_HINT =
  /\b(vectors?|rag|embeddings?|semantic search|llms?|gen-?ai|generative ai|ai agents?|agentic|pinecone|weaviate|milvus|qdrant|pgvector|chroma)\b/i;
function focusFor(text: string, persona?: string): S2Focus {
  if (persona === "AI / ML Platform Lead") return "ai";
  return AI_HINT.test(text) ? "ai" : "realtime";
}

export async function POST(req: NextRequest) {
  let body: {
    mode?: string;
    tone?: string;
    persona?: string;
    account?: string;
    notes?: string;
    extra?: string;
    messages?: { role: "user" | "assistant"; content: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const mode = body.mode && MODES[body.mode] ? body.mode : "ask";
  const cfg = MODES[mode];
  const tone = body.tone && TONES.has(body.tone) ? body.tone : "Direct";
  const persona =
    body.persona && PERSONAS.has(body.persona) ? body.persona : undefined;

  // Build the user content + history.
  let user = "";
  let history: { role: "user" | "assistant"; content: string }[] = [];

  if (cfg.type === "text") {
    if (body.messages !== undefined && !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: "`messages` must be an array of {role, content}." },
        { status: 400 },
      );
    }
    const msgs = (body.messages ?? []).filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    );
    if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") {
      return NextResponse.json({ error: "No message provided." }, { status: 400 });
    }
    user = msgs[msgs.length - 1].content;
    history = msgs.slice(0, -1);
  } else {
    const parts: string[] = [];
    if (typeof body.account === "string" && body.account.trim())
      parts.push(`ACCOUNT: ${body.account.trim()}`);
    if (typeof body.notes === "string" && body.notes.trim())
      parts.push(`NOTES / INPUT:\n${body.notes.trim()}`);
    if (typeof body.extra === "string" && body.extra.trim())
      parts.push(`ADDITIONAL:\n${body.extra.trim()}`);
    user = parts.join("\n\n");
    if (!user) {
      return NextResponse.json({ error: "No input provided." }, { status: 400 });
    }
  }

  const personaLine = persona
    ? ` TARGET PERSONA: the rep is selling to a ${persona} — frame value for that role.`
    : "";
  // Lead with the AI/vector context when the request is about gen-AI / RAG /
  // vectors (or the persona is the AI platform lead); otherwise the core
  // real-time engine leads. Both carry PROOF, COMPETITIVE, PRICING and POC.
  const productCtx = singlestoreContextFor(
    focusFor([...history.map((h) => h.content), user].join("\n"), persona),
  );
  const system =
    cfg.type === "text"
      ? `You are an expert AI sales engineer for SingleStore, helping SingleStore's own reps sell.

${productCtx}

TASK: ${cfg.instruction}
TONE: ${tone}.${personaLine}
FORMAT: clean plain text — SHORT CAPS headings and "- " bullets where structure helps. Be specific to SingleStore, never generic. Never fabricate prospect facts; if you didn't find it, say so. Keep MEASURED (published customer claim), COMMISSIONED BENCHMARK, MARKETING CLAIM and MODELED numbers visibly distinct.`
      : `You are an expert AI sales engineer for SingleStore.

${productCtx}

TASK: ${cfg.instruction}
TONE: ${tone}.${personaLine}
Only use web_search if a factual company detail genuinely needs verifying — the rep's notes are the primary source.

Respond with ONLY a single JSON object, no prose, no code fences, matching exactly this shape:
${cfg.schema}`;

  try {
    const result = await callClaudeWithWebSearch({
      system,
      user,
      history,
      // Structured tool modes (LOU, MEDDPICC, threading) extract and draft from
      // the rep's notes — Haiku handles them at lower cost. The
      // free-form research/email chat ("ask") and heavy modes (POC plan) stay on
      // the default Sonnet model for quality.
      model: cfg.type === "json" && !cfg.heavy ? FAST_MODEL : undefined,
      maxSearches: cfg.maxSearches,
      maxTokens: cfg.heavy ? 6000 : cfg.type === "json" ? 4000 : 2500,
      temperature: cfg.type === "json" ? 0.3 : 0.5,
    });

    if (cfg.type === "text") {
      if (!result.text) {
        return NextResponse.json(
          { error: "No response generated — try rephrasing." },
          { status: 502 },
        );
      }
      return NextResponse.json({
        text: result.text,
        citations: result.citations.slice(0, 8),
        searchCount: result.searchCount,
        // Surfaced as a notice in the UI — a cut-off answer must not pass as complete.
        truncated: result.truncated,
        searchErrors: result.searchErrors,
      });
    }

    const parsed = extractJSON<Record<string, unknown>>(result.text);
    if (!parsed) {
      const cause = result.truncated
        ? `the response was cut off (stop_reason: ${result.stopReason})`
        : "could not parse the AI output";
      return NextResponse.json(
        { error: `Tool pass failed — ${cause}. Try again or trim the notes.` },
        { status: 502 },
      );
    }
    return NextResponse.json({ data: parsed, truncated: result.truncated });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error talking to Anthropic.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
