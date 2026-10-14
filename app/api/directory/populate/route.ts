import { NextResponse } from "next/server";
import { upsertDirectory } from "@/lib/store";
import { DIRECTORY_SEED } from "@/lib/directorySeed";

// Populate the Signal 2000 directory from the static seed — the ~2,000 largest
// US companies (Fortune 1000 by revenue + the largest by market cap), broad
// across every sector. Fast (no Apollo, no LLM): just a chunked upsert. The
// short brief and full intel are fetched on demand per company.
//
//   POST (or GET) /api/directory/populate
export const maxDuration = 60;

async function seed() {
  const entries = DIRECTORY_SEED;
  let upserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const r = await upsertDirectory(chunk);
    if (r.ok) upserted += chunk.length;
    else errors.push(r.error || "upsert failed");
  }
  return NextResponse.json({ ok: errors.length === 0, total: entries.length, upserted, errors });
}

export async function POST() {
  return seed();
}

export async function GET() {
  return seed();
}
