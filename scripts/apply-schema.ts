// npm run db:schema — create every table in sql/schema.sql (idempotent).
// Also drops the tables of the earlier minimal prototype, which this app
// replaces (they hold nothing the app reads).
import "./_env";
import fs from "node:fs";
import { pool } from "../lib/s2/db";

const RETIRED = [
  "accounts", "research_sources", "technology_signals", "buying_signals", "contacts", "account_intelligence",
  "icp_scores", "opportunity_hypotheses", "prospecting_activities", "research_chunks",
];

async function main() {
  for (const t of RETIRED) await pool().query(`DROP TABLE IF EXISTS ${t}`);
  const sql = fs.readFileSync("sql/schema.sql", "utf8").replace(/^\s*--.*$/gm, "");
  for (const stmt of sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    const name = stmt.match(/TABLE IF NOT EXISTS (\w+)/)?.[1] ?? stmt.slice(0, 40);
    await pool().query(stmt);
    console.log(`ok  ${name}`);
  }
  await pool().end();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
