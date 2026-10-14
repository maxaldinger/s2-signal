import { NextRequest, NextResponse } from "next/server";
import { lookAlikes, searchAccounts } from "@/lib/briefVectors";

// Semantic search over researched accounts (vectors stored in SingleStore).
//   GET /api/semantic?like=Coinbase[&k=5]                      look-alike accounts
//   GET /api/semantic?q=<theme>[&segment=fintech][&minIcp=70]  free-text theme search
// Responses include the SQL that ran and its latency.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const k = Math.max(1, Math.min(25, Number(p.get("k")) || 6));
  const like = p.get("like")?.trim();
  const text = p.get("q")?.trim();
  if (!like && !text) return NextResponse.json({ ok: false, error: "Pass ?like=<company> or ?q=<text>", hits: [] }, { status: 400 });
  const r = like
    ? await lookAlikes(like, k)
    : await searchAccounts(text!, { k, segment: p.get("segment")?.trim() || undefined, minIcp: Number(p.get("minIcp")) || undefined });
  const status = r.ok ? 200 : r.configured ? 502 : 501;
  return NextResponse.json(r, { status, headers: { "Cache-Control": "no-store" } });
}
