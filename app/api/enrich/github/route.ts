import { NextRequest, NextResponse } from "next/server";
import { enrichGitHub } from "@/lib/enrich/github";

// GET /api/enrich/github?company=Ramp[&org=ramp-org]
export const maxDuration = 45;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  const org = req.nextUrl.searchParams.get("org")?.trim() || undefined;
  if (!company && !org) {
    return NextResponse.json(
      { error: "Pass ?company= and/or ?org=" },
      { status: 400 },
    );
  }

  const result = await enrichGitHub(company || org!, org);
  const status = result.ok ? 200 : 502;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
