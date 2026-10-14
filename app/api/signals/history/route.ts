import { NextRequest, NextResponse } from "next/server";
import { fetchSignalPage, fetchAllSignals, dbConfigured } from "@/lib/store";
import { isRegionId, type RegionId } from "@/lib/data";

// Paged read over the SingleStore signal cache. 50 results per page.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  if (!dbConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        signals: [],
        total: 0,
        page: 1,
        pageSize: PAGE_SIZE,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const regionParam = req.nextUrl.searchParams.get("region")?.trim().toLowerCase();
  const region: RegionId = isRegionId(regionParam) ? regionParam : "us";
  // all=1 returns the whole region cache so the client can sort/paginate
  // globally; otherwise a single server page (legacy / fallback).
  const all = req.nextUrl.searchParams.get("all") === "1";
  const result = all
    ? await fetchAllSignals(region)
    : await fetchSignalPage(page, PAGE_SIZE, region);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, configured: true },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      configured: true,
      signals: result.signals,
      total: result.total,
      capped: result.capped ?? false,
      page,
      pageSize: PAGE_SIZE,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
