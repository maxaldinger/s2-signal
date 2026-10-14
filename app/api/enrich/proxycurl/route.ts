import { NextRequest, NextResponse } from "next/server";
import { enrichProxycurl } from "@/lib/enrich/proxycurl";

// GET /api/enrich/proxycurl?company=Ramp[&domain=ramp.com][&linkedin=https://www.linkedin.com/company/ramp]
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim();
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const linkedin = req.nextUrl.searchParams.get("linkedin")?.trim() || undefined;
  if (!company && !domain && !linkedin) {
    return NextResponse.json(
      { error: "Pass ?company=, ?domain= or ?linkedin=" },
      { status: 400 },
    );
  }

  const result = await enrichProxycurl(company || domain || "", domain, linkedin);
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
