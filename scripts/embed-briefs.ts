// npm run db:embed-briefs — (re)index every cached intel brief into
// gtm_brief_vectors. New and expanded briefs index themselves; this backfills
// briefs saved before semantic search existed, or after changing the model.
import "./_env";
import { pool, q } from "../lib/s2/db";
import { indexBrief } from "../lib/briefVectors";
import type { CompanyIntel } from "../lib/types";

async function main() {
  const r = await q<{ company_key: string; company: string; intel: unknown }>(`SELECT company_key, company, intel FROM gtm_briefs`);
  let ok = 0;
  for (const row of r.rows) {
    const intel = (typeof row.intel === "string" ? JSON.parse(row.intel) : row.intel) as CompanyIntel;
    const done = await indexBrief(row.company, intel, row.company_key);
    console.log(`${done ? "ok " : "ERR"} ${row.company}`);
    if (done) ok++;
  }
  console.log(`indexed ${ok}/${r.rows.length}`);
  await pool().end();
  if (ok < r.rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
