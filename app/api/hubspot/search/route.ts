import { NextRequest, NextResponse } from "next/server";
import { hubspotSearch, type HsKind } from "@/lib/hubspot";
import { sessionUserId } from "@/lib/auth";

// GET /api/hubspot/search?kind=company&name=Ramp[&domain=ramp.com]
//   — or — ?kind=contact&name=Jane%20Doe[&email=jane@ramp.com]
// Looks up whether a company/contact already exists in the HubSpot CRM.
export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const kindParam = req.nextUrl.searchParams.get("kind");
  if (kindParam !== "company" && kindParam !== "contact") {
    return NextResponse.json({ error: "Pass ?kind=company or ?kind=contact" }, { status: 400 });
  }
  const kind = kindParam as HsKind;
  const name = req.nextUrl.searchParams.get("name")?.trim() || undefined;
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const email = req.nextUrl.searchParams.get("email")?.trim() || undefined;

  if (!name && !domain && !email) {
    return NextResponse.json({ error: "Pass a name, domain, or email to search" }, { status: 400 });
  }

  // WS5: the check runs against the CALLER's portal via their OAuth
  // connection. No connection -> a clear "connect first" error, never a silent
  // fallback to someone else's portal.
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await hubspotSearch(kind, { name, domain, email }, { asUser: uid });
  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, { status });
}
