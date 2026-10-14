import { NextRequest, NextResponse } from "next/server";
import { callClaudeWithWebSearch, extractJSON } from "@/lib/anthropic";
import { singlestoreContextFor, type S2Focus } from "@/lib/singlestore";
import { dbConfigured, mergeIntoBrief } from "@/lib/store";
import type { CompanyIntel } from "@/lib/types";

// On-demand brief sections. The main /api/intel call stays lean (summary, ICP,
// people, motion+outreach) to cut cost and latency; the heavier evidence sections
// are pulled here only when the rep clicks to expand. Each result is merged back
// into the cached brief so a re-open is free.
export const maxDuration = 120;

interface SectionCfg {
  /** Per-focus instruction; realtime is the default focus. */
  instruction: string | ((product: S2Focus) => string);
  schema: string;
  maxSearches: number;
  // Merge the parsed result into the cached brief.
  merge: (intel: CompanyIntel, parsed: Record<string, unknown>) => void;
}

const SECTIONS: Record<string, SectionCfg> = {
  whySingleStore: {
    instruction: (product) =>
      product === "ai"
        ? "Give 3-4 evidence-tied reasons THIS company is a fit for SingleStore as the database layer for its gen-AI, RAG, vector or semantic-search work: vector + full-text + SQL filters and joins on fresh operational data in one query and one system. Ground each reason in a specific, real fact about them (AI features shipped or announced, vector DB or search stack in use, data volume, freshness needs). State each as a likely consequence for them, not a diagnosis. No generic claims, no proof figure that is not in PROOF."
        : "Give 3-4 evidence-tied reasons THIS company is a fit for SingleStore's core engine: transactions and real-time analytics on fresh data in one distributed SQL database, high concurrency at low latency, streaming ingest, and consolidation of the serving-layer systems they stitch together. Ground each reason in a specific, real fact about them (data stack evidenced in job posts or blogs, data volume, customer-facing analytics, concurrency, streaming, migrations). A technology being present is not evidence of pain: frame each consequence as a hypothesis worth testing. Say which lever each reason rests on (real-time analytics on fresh data, scale-out beyond a single node, or consolidating systems). No generic claims.",
    schema: `{"whySingleStore":["evidence-tied reason","...","..."]}`,
    maxSearches: 2,
    merge: (intel, p) => {
      intel.whySingleStore = (Array.isArray(p.whySingleStore) ? p.whySingleStore : [])
        .map(String)
        .filter(Boolean)
        .slice(0, 5);
    },
  },
  painPoints: {
    instruction: (product) =>
      product === "ai"
        ? "Identify up to 4 likely data-infrastructure pain points for this company's gen-AI / RAG / vector or search work that SingleStore addresses, each grounded in a specific evidenced fact and stated as a hypothesis, not a diagnosis. For each: a short title, severity (HIGH|MEDIUM|LOW, how likely and how costly if true), a category, the evidence, and how SingleStore addresses it (vector + full-text + SQL on live operational data in one system, no sync pipeline between a vector DB and the source of truth). Never promise a specific result."
        : "Identify up to 4 likely data-infrastructure pain points for this company that SingleStore addresses, each grounded in a specific evidenced fact and stated as a hypothesis, not a diagnosis. Typical shapes: dashboards lagging ingest, an operational database hitting single-node limits, a warehouse or Elasticsearch serving app queries it was not built for, several stores kept in sync for one product, pipeline and licence cost. For each: a short title, severity (HIGH|MEDIUM|LOW, how likely and how costly if true), a category, the evidence, and how SingleStore addresses it, naming the lever (HTAP on fresh data, scale-out SQL, streaming ingest via Pipelines, MySQL wire compatibility, consolidation). Cite a proof point only from PROOF, with what it measured. Never promise a specific result.",
    schema: `{"painPoints":[{"title":"","severity":"HIGH|MEDIUM|LOW","category":"","evidence":"specific fact/quote","s2Solution":"how SingleStore addresses it"}]}`,
    maxSearches: 3,
    merge: (intel, p) => {
      const arr = Array.isArray(p.painPoints) ? (p.painPoints as Record<string, unknown>[]) : [];
      intel.painPoints = arr
        .filter((x) => x?.title)
        .map((x) => ({
          title: String(x.title),
          severity: ["HIGH", "MEDIUM", "LOW"].includes(String(x.severity))
            ? (x.severity as "HIGH" | "MEDIUM" | "LOW")
            : "MEDIUM",
          category: String(x.category || "General"),
          evidence: String(x.evidence || ""),
          s2Solution: String(x.s2Solution || ""),
        }))
        .slice(0, 6);
    },
  },
  dataCost: {
    instruction:
      "Estimate this company's monthly spend on the data systems SingleStore could consolidate: warehouse compute that serves application queries, OLTP replicas, search clusters, vector DBs, caches, ETL/CDC tooling, plus engineer time spent maintaining the pipelines between them. Count ONLY systems you found evidence for (job posts, engineering blogs, talks, public repos), list them in `systems`, and set systemsCount to that list's length. Price each with a public list-price anchor you can cite for that vendor, or a stated assumption where none is public; the warehouse/lakehouse used for history and training is NOT in scope. This is a MODELED estimate: state every assumption and anchor in notes and label it as modeled, never as the company's known spend. s2OffsetUsd = the modeled monthly reduction if the in-scope systems were consolidated onto SingleStore, using a published consolidation claim from PRICING as the scenario rate (GigaOm's SingleStore-commissioned ~50% 3-yr TCO study, or Fathom's -60% database TCO customer claim), applied to the in-scope portion only. Name which claim you used in notes and say it is another company's result, not a prediction for them. If the evidence is too thin for a credible estimate, return 0 and say so in notes.",
    schema: `{"dataCost":{"estimatedMonthlyUsd":number,"systemsCount":number,"perSystemUsd":number,"systems":["evidenced system","..."],"notes":"assumptions, anchors used, which published claim drives the offset","s2OffsetUsd":number or null}}`,
    maxSearches: 3,
    merge: (intel, p) => {
      const t = (p.dataCost ?? {}) as Record<string, unknown>;
      const num = (v: unknown, max: number) =>
        typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(max, v)) : 0;
      intel.dataCost = {
        estimatedMonthlyUsd: num(t.estimatedMonthlyUsd, 100_000_000),
        systemsCount: num(t.systemsCount, 50),
        perSystemUsd: num(t.perSystemUsd, 10_000_000),
        systems: Array.isArray(t.systems) ? t.systems.map(String).filter(Boolean).slice(0, 10) : undefined,
        notes: String(t.notes || ""),
        s2OffsetUsd: typeof t.s2OffsetUsd === "number" ? num(t.s2OffsetUsd, 100_000_000) : undefined,
      };
    },
  },
  motionDetail: {
    instruction:
      "Justify the recommended GTM motion for this account in 1-2 sentences (reasoning), and give 2-3 concrete watch-outs / risks for the deal (for example an incumbent that is genuinely strong for this workload, migration effort, procurement, or skills). Ground both in the company's real situation.",
    schema: `{"reasoning":"why this motion fits","watchOuts":["concrete risk","concrete risk"]}`,
    maxSearches: 1,
    merge: (intel, p) => {
      intel.motion.reasoning = String(p.reasoning || "");
      intel.motion.watchOuts = (Array.isArray(p.watchOuts) ? p.watchOuts : []).map(String).slice(0, 4);
    },
  },
};

export async function POST(req: NextRequest) {
  let body: {
    company?: string;
    segment?: string;
    summary?: string;
    section?: string;
    /** The brief's entry-workload focus; realtime when absent (older briefs). */
    productFocus?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const company = body.company?.trim();
  const section = body.section ?? "";
  const cfg = SECTIONS[section];
  if (!company) return NextResponse.json({ error: "company is required" }, { status: 400 });
  if (!cfg) return NextResponse.json({ error: "unknown section" }, { status: 400 });

  const product: S2Focus = body.productFocus === "ai" ? "ai" : "realtime";
  const instruction = typeof cfg.instruction === "function" ? cfg.instruction(product) : cfg.instruction;
  const system = `${singlestoreContextFor(product)}

You are SingleStore's GTM analyst. For the company below, produce ONLY the requested section as JSON — grounded in real, web-verified facts. The brief this section belongs to leads with ${
    product === "ai" ? "the AI / vector entry workload (vector + full-text + SQL on live data)" : "the real-time entry workload (HTAP, real-time analytics, consolidation)"
  }; stay on that focus. Keep measured results (published customer claims from PROOF, with what each measured), modeled estimates and customer assumptions visibly distinct. A technology being present is not evidence of pain. Proof points come only from PROOF. Context you already have:
COMPANY: ${company}${body.segment ? ` (${body.segment})` : ""}
SUMMARY: ${body.summary || "(none provided — research the company)"}

TASK: ${instruction}

Respond with ONLY this JSON shape, no prose, no code fences:
${cfg.schema}`;

  try {
    const result = await callClaudeWithWebSearch({
      system,
      user: `Produce the "${section}" section for ${company}. Today: ${new Date().toISOString().slice(0, 10)}.`,
      maxSearches: cfg.maxSearches,
      maxTokens: 1800,
      temperature: 0.3,
    });
    let parsed = extractJSON<Record<string, unknown>>(result.text);
    // Models sometimes wrap the answer in the section name
    // ({"motionDetail": {...}}); unwrap so merge and UI see the schema shape.
    const wrapped = parsed?.[section];
    if (parsed && Object.keys(parsed).length === 1 && wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      parsed = wrapped as Record<string, unknown>;
    }
    if (!parsed) {
      return NextResponse.json({ error: "Could not generate that section — try again." }, { status: 502 });
    }

    // Best-effort: merge into the cached brief so a re-open shows it for free.
    if (dbConfigured()) {
      await mergeIntoBrief(company, (brief) => cfg.merge(brief, parsed));
    }

    return NextResponse.json({ ok: true, section, data: parsed, citations: result.citations.slice(0, 8) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Section generation failed" },
      { status: 500 },
    );
  }
}
