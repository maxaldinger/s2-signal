import { NextRequest, NextResponse } from "next/server";
import { enrichApollo } from "@/lib/enrich/apollo";

// GET /api/enrich/apollo?company=Ramp[&domain=ramp.com]
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  if (!company && !domain) {
    return NextResponse.json(
      { error: "Pass ?company= and/or ?domain=" },
      { status: 400 },
    );
  }

  const result = await enrichApollo(company || domain!, domain);
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
