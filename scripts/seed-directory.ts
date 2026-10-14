// npm run db:seed-directory — load the Signal 2000 directory (public list of
// the ~2,000 largest US companies, remapped to SingleStore's segments and fit
// priors) into gtm_directory. Same data the in-app "populate" action writes.
import "./_env";
import { pool } from "../lib/s2/db";
import { upsertDirectory, countDirectory } from "../lib/store";
import { DIRECTORY_SEED } from "../lib/directorySeed";

async function main() {
  const r = await upsertDirectory(DIRECTORY_SEED);
  if (!r.ok) throw new Error(r.error);
  const bySeg: Record<string, number> = {};
  for (const e of DIRECTORY_SEED) bySeg[e.segment] = (bySeg[e.segment] ?? 0) + 1;
  console.log(`upserted ${DIRECTORY_SEED.length}; table now holds ${await countDirectory()}`);
  console.log(bySeg);
  await pool().end();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
