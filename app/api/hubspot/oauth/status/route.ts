import { NextResponse } from "next/server";
import { getConnection, oauthConfigured } from "@/lib/hubspotOAuth";
import { sessionUserId } from "@/lib/auth";

// GET /api/hubspot/oauth/status — the caller's own connection state, for the
// sidebar chip. Never returns tokens.
export async function GET() {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!oauthConfigured()) {
    return NextResponse.json(
      { ok: true, configured: false, connected: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const conn = await getConnection(uid);
  return NextResponse.json(
    {
      ok: true,
      configured: true,
      connected: !!conn,
      hubDomain: conn?.hub_domain ?? undefined,
      portalId: conn?.portal_id ?? undefined,
      ownerResolved: !!conn?.owner_id,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
