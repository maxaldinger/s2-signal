import { NextRequest, NextResponse } from "next/server";
import { enrichHunter } from "@/lib/enrich/hunter";

// GET /api/enrich/hunter?domain=ramp.com[&email=jane@ramp.com]
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const domain = req.nextUrl.searchParams.get("domain")?.trim();
  const email = req.nextUrl.searchParams.get("email")?.trim() || undefined;
  if (!domain) {
    return NextResponse.json({ error: "Missing ?domain=" }, { status: 400 });
  }

  const result = await enrichHunter(domain, email);
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
