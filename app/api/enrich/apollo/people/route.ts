import { NextRequest, NextResponse } from "next/server";
import { apolloPeopleByTitle } from "@/lib/enrich/apollo";

// GET /api/enrich/apollo/people?company=Ramp[&domain=ramp.com]
// Free people-by-title search — returns real engineering leaders with stable
// Apollo ids (last names obfuscated until revealed per-person). Drives the
// stakeholder cards in a deep dive.
// 60s: the Apollo search is fast, but the ICP classifier adds a few Haiku
// waves over the page. The s-maxage below means a reopened brief serves from
// the CDN and re-classifies nothing.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim() || "";
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  // Only look up the pinned (motion) contact on the first page.
  const pin = page <= 1 ? req.nextUrl.searchParams.get("pin")?.trim() || undefined : undefined;
  // The brief's "what I saw" signal, forwarded so the ICP classifier can reason
  // about THIS account rather than the job title alone. Capped: it only needs
  // to be context, and it rides in a URL.
  const signal = req.nextUrl.searchParams.get("signal")?.trim().slice(0, 600) || undefined;
  // Rep override for the account-level exclusion (the "Pull contacts anyway"
  // button). Rides the URL, so the CDN caches forced and unforced separately.
  const force = req.nextUrl.searchParams.get("force") === "1";

  if (!company && !domain) {
    return NextResponse.json({ error: "Pass ?company= and/or ?domain=" }, { status: 400 });
  }

  const result = await apolloPeopleByTitle(company, domain, page, pin, signal, undefined, force);
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    // SHORT cache. This was s-maxage=3600 + stale-while-revalidate=86400, which
    // meant a company viewed once served the SAME contact list to everyone for
    // an hour, and could serve it stale for a further day. Every improvement to
    // the search or the ICP classifier was therefore invisible on exactly the
    // accounts being looked at — Goldman Sachs kept rendering a 1-contact list
    // that predated the widened search, while Apollo held 34 engineering
    // leaders. 60s still absorbs re-renders and rapid back-and-forth without
    // freezing results. The upstream Apollo call is a SEARCH (no credits), so
    // the only cost of a miss is a few Haiku classifier tokens.
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
  });
}
