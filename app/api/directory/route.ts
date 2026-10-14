import { NextRequest, NextResponse } from "next/server";
import { fetchDirectory } from "@/lib/store";
import { isRegionId } from "@/lib/data";

// GET /api/directory?region=us|in|global — one region's Signal 2000 directory
// (strongest-fit first). The client sorts/filters/paginates in memory, same
// as the signal feed. Region follows the header toggle.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const regionParam = req.nextUrl.searchParams.get("region")?.trim().toLowerCase();
  const region = isRegionId(regionParam) ? regionParam : "us";
  const r = await fetchDirectory(region);
  return NextResponse.json(r);
}
