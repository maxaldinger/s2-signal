// Semantic search over researched accounts, stored and queried in SingleStore.
//
// Every saved intel brief gets one row in gtm_brief_vectors: the research text
// that says what the account's data situation is, its embedding, and the
// structured fields (segment, ICP score) the searches filter on. Two queries:
//
//   lookAlikes(company)   accounts whose research is closest to this one's
//   searchAccounts(text)  accounts matching a free-text theme, e.g. "teams
//                         replicating several OLTP databases through Kafka"
//
// Both are ONE SQL statement: an ANN lookup on the HNSW vector index (`<*>`,
// dot product on unit vectors = cosine) with relational filters in the same
// WHERE clause. Indexing never throws into the brief save path.

import { q, s2Configured, toSqlValue } from "./s2/db";
import { embed, embeddingsConfigured, EMBEDDING_MODEL, toVectorLiteral } from "./embeddings";
import type { CompanyIntel } from "./types";

const briefKey = (company: string) => company.trim().toLowerCase();

/** The text that represents an account for similarity: what they run, what
 *  they're building, and the evidence-backed reasons they fit. */
export function briefText(intel: CompanyIntel): string {
  const parts: (string | undefined)[] = [
    `${intel.name}. ${intel.segment?.label ?? ""}. ${intel.oneLiner ?? ""}`,
    intel.summary,
    intel.callHook,
    intel.focusReason,
    intel.icp?.rationale,
    intel.icp?.streaming?.detected ? `Streaming: ${intel.icp.streaming.evidence}` : "",
    ...(intel.painPoints ?? []).map((p) => `${p.title}: ${p.evidence}`),
    ...(intel.whySingleStore ?? []),
    intel.dataCost?.notes,
    intel.outreach?.proof,
  ];
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .slice(0, 20_000);
}

/** Embed and upsert one brief. Returns false (never throws) when indexing is
 *  unavailable or fails, so a brief always saves even if its vector doesn't. */
export async function indexBrief(company: string, intel: CompanyIntel, key = briefKey(company)): Promise<boolean> {
  if (!s2Configured() || !embeddingsConfigured()) return false;
  try {
    const content = briefText(intel);
    if (!content) return false;
    const [vec] = await embed([content]);
    await q(
      `INSERT INTO gtm_brief_vectors (company_key, company, segment, icp_total, product_focus, content, embedding, model, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ? :> VECTOR(1536, F32), ?, ?)
       ON DUPLICATE KEY UPDATE company = VALUES(company), segment = VALUES(segment), icp_total = VALUES(icp_total),
         product_focus = VALUES(product_focus), content = VALUES(content), embedding = VALUES(embedding),
         model = VALUES(model), updated_at = VALUES(updated_at)`,
      [key, intel.name || company, intel.segment?.id ?? null, intel.icp?.total ?? null, intel.productFocus ?? null, content,
        toVectorLiteral(vec), EMBEDDING_MODEL, toSqlValue(new Date())],
    );
    return true;
  } catch (e) {
    console.error(`[briefVectors] index failed for ${company}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface SemanticHit {
  companyKey: string;
  company: string;
  segment: string | null;
  icpTotal: number | null;
  productFocus: string | null;
  similarity: number;
  /** First lines of the indexed research, so a hit shows why it matched. */
  snippet: string;
}

export interface SemanticResult {
  ok: boolean;
  configured: boolean;
  error?: string;
  hits: SemanticHit[];
  /** The SQL that ran, for the "show me the query" moment in a demo. */
  sql?: string;
  ms?: number;
  indexed?: number;
}

type Row = { company_key: string; company: string; segment: string | null; icp_total: number | null; product_focus: string | null; similarity: number; content: string };

const toHit = (r: Row): SemanticHit => ({
  companyKey: r.company_key,
  company: r.company,
  segment: r.segment,
  icpTotal: r.icp_total,
  productFocus: r.product_focus,
  similarity: Math.round(Number(r.similarity) * 1000) / 1000,
  snippet: String(r.content).split("\n").slice(1, 3).join(" ").slice(0, 280),
});

/** Look-alikes compare vectors already stored in SingleStore, so they need
 *  only the database; theme search must embed the query text too. */
function unavailable(needsEmbedding: boolean): SemanticResult | null {
  if (!s2Configured()) return { ok: false, configured: false, error: "SingleStore is not configured.", hits: [] };
  if (needsEmbedding && !embeddingsConfigured()) {
    return { ok: false, configured: false, error: "Set OPENAI_API_KEY to turn on theme search.", hits: [] };
  }
  return null;
}

async function indexedCount(): Promise<number> {
  const r = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM gtm_brief_vectors`);
  return Number(r.rows[0]?.n ?? 0);
}

/** Accounts whose research is closest to this account's (excluding itself). */
export async function lookAlikes(company: string, k = 5): Promise<SemanticResult> {
  const off = unavailable(false);
  if (off) return off;
  try {
    const key = briefKey(company);
    // Match the anchor by cache key or by the resolved name stored in the row.
    const anchor = await q<{ company_key: string; v: string }>(
      `SELECT company_key, embedding :> JSON AS v FROM gtm_brief_vectors WHERE company_key = ? OR LOWER(company) = ? LIMIT 1`,
      [key, key],
    );
    if (!anchor.rows.length) {
      return { ok: true, configured: true, hits: [], indexed: await indexedCount(), error: "This account's brief isn't indexed yet. It's added the next time the brief is saved." };
    }
    const anchorKey = anchor.rows[0].company_key;
    // A constant query vector lets the ANN search use the HNSW index.
    const sql = `SELECT company_key, company, segment, icp_total, product_focus, content,
       embedding <*> (? :> VECTOR(1536, F32)) AS similarity
FROM gtm_brief_vectors
WHERE company_key <> ?
ORDER BY similarity DESC
LIMIT ?`;
    const anchorVec = typeof anchor.rows[0].v === "string" ? anchor.rows[0].v : JSON.stringify(anchor.rows[0].v);
    const r = await q<Row>(sql, [anchorVec, anchorKey, k]);
    return { ok: true, configured: true, hits: r.rows.map(toHit), sql, ms: r.ms, indexed: await indexedCount() };
  } catch (e) {
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e), hits: [] };
  }
}

/** Accounts matching a free-text theme, optionally filtered by segment / ICP. */
export async function searchAccounts(
  text: string,
  opts: { k?: number; segment?: string; minIcp?: number } = {},
): Promise<SemanticResult> {
  const off = unavailable(true);
  if (off) return off;
  const query = text.trim().slice(0, 2000);
  if (!query) return { ok: false, configured: true, error: "Enter something to search for.", hits: [] };
  try {
    const [vec] = await embed([query]);
    const where: string[] = [];
    const params: unknown[] = [toVectorLiteral(vec)];
    if (opts.segment) (where.push("segment = ?"), params.push(opts.segment));
    if (opts.minIcp) (where.push("icp_total >= ?"), params.push(opts.minIcp));
    params.push(Math.max(1, Math.min(25, opts.k ?? 8)));
    const sql = `SELECT company_key, company, segment, icp_total, product_focus, content,
       embedding <*> (? :> VECTOR(1536, F32)) AS similarity
FROM gtm_brief_vectors
${where.length ? `WHERE ${where.join(" AND ")}\n` : ""}ORDER BY similarity DESC
LIMIT ?`;
    const r = await q<Row>(sql, params);
    return { ok: true, configured: true, hits: r.rows.map(toHit), sql, ms: r.ms, indexed: await indexedCount() };
  } catch (e) {
    return { ok: false, configured: true, error: e instanceof Error ? e.message : String(e), hits: [] };
  }
}
