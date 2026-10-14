// npm run db:reconcile-briefs — bring cached briefs in line with the current
// rules: ICP total recomputed from the sub-scores (sum + streaming bonus,
// capped at 99), segment re-chosen against the segment definitions (one small
// no-search model call per brief), the card score cache updated, and the
// brief re-embedded. Prints every change. Add --dry to preview only.
import "./_env";
import { pool, q } from "../lib/s2/db";
import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "../lib/anthropic";
import { computeIcpTotal, SEGMENT_GUIDE } from "../lib/icpScore";
import { SEGMENT_MAP, SEGMENTS } from "../lib/data";
import { indexBrief } from "../lib/briefVectors";
import { normCompanyName } from "../lib/githubProspect/store";
import type { CompanyIntel, SegmentId } from "../lib/types";

const dry = process.argv.includes("--dry");
const VALID = new Set<string>(SEGMENTS.map((s) => s.id));

async function chooseSegment(intel: CompanyIntel): Promise<SegmentId | null> {
  const r = await callClaudeWithWebSearch({
    model: FAST_MODEL,
    webSearch: false,
    maxTokens: 60,
    system: `${SEGMENT_GUIDE}\n\nReply with ONLY {"segment":"<id>"}.`,
    user: `${intel.name}: ${intel.oneLiner}\n${intel.summary}`.slice(0, 2500),
  });
  const seg = extractJSON<{ segment?: string }>(r.text)?.segment;
  return seg && VALID.has(seg) ? (seg as SegmentId) : null;
}

async function main() {
  const rows = await q<{ company_key: string; company: string; intel: unknown }>(`SELECT company_key, company, intel FROM gtm_briefs`);
  for (const row of rows.rows) {
    const intel = (typeof row.intel === "string" ? JSON.parse(row.intel) : row.intel) as CompanyIntel;
    const before = { total: intel.icp?.total, segment: intel.segment?.id };
    const total = computeIcpTotal(intel.icp);
    const seg = (await chooseSegment(intel)) ?? (before.segment as SegmentId);
    const changed = total !== before.total || seg !== before.segment;
    console.log(
      `${changed ? "fix" : "ok "} ${row.company.padEnd(14)} total ${String(before.total).padStart(2)} -> ${String(total).padStart(2)}   segment ${before.segment} -> ${seg}`,
    );
    if (dry || !changed) continue;
    intel.icp.total = total;
    intel.segment = SEGMENT_MAP[seg];
    await q(`UPDATE gtm_briefs SET intel = ? WHERE company_key = ?`, [JSON.stringify(intel), row.company_key]);
    // The card's "SingleStore ICP fit" reads this cache, keyed by normalized name.
    for (const name of new Set([row.company, intel.name])) {
      await q(`UPDATE gtm_scores SET score = ? WHERE company_key = ?`, [total, normCompanyName(name)]);
    }
    await indexBrief(row.company, intel, row.company_key);
  }
  await pool().end();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
