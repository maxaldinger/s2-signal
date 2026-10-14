// npm run db:check — prove the app's SingleStore connection works end to end:
// version, row counts, and a write/read/delete round trip through the same
// supabase-compatible client the API routes use.
import "./_env";
import { pool, q } from "../lib/s2/db";
import { s2Client } from "../lib/s2/client";

async function main() {
  const v = await q<{ v: string }>("SELECT @@memsql_version AS v");
  console.log(`connected  SingleStore ${v.rows[0].v}  (${v.ms} ms)`);
  for (const t of ["gtm_signals", "gtm_briefs", "gtm_directory", "gtm_monitored_repos", "gtm_github_signals", "gtm_enriched_contacts", "gtm_user_state", "gtm_proposals"]) {
    const r = await q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`${t.padEnd(24)} ${r.rows[0].n}`);
  }
  // Round trip through the builder, including RLS-style user scoping.
  const db = s2Client("__healthcheck");
  const w = await db.from("bito_user_state").upsert({ store: "check.v3", value: { ok: true } }, { onConflict: "user_id,store" });
  const r = await db.from("bito_user_state").select("store,value").eq("store", "check.v3").maybeSingle();
  const other = await s2Client("someone-else").from("bito_user_state").select("store").eq("store", "check.v3");
  await q(`DELETE FROM gtm_user_state WHERE user_id = '__healthcheck'`);
  console.log(`builder write/read        ${!w.error && r.data?.value?.ok === true ? "ok" : `FAILED ${w.error?.message ?? ""}`}`);
  console.log(`per-user scoping          ${other.data && other.data.length === 0 ? "ok (other user sees nothing)" : "FAILED"}`);
  await pool().end();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
