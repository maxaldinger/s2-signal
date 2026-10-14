import { NextRequest, NextResponse } from "next/server";
import { enrichCrunchbase } from "@/lib/enrich/crunchbase";

// GET /api/enrich/crunchbase?company=Ramp
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  if (!company) {
    return NextResponse.json({ error: "Missing ?company=" }, { status: 400 });
  }

  const result = await enrichCrunchbase(company);
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
