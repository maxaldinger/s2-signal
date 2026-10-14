import { NextResponse } from "next/server";
import { deleteConnection } from "@/lib/hubspotOAuth";
import { sessionUserId } from "@/lib/auth";

// POST /api/hubspot/oauth/disconnect — drop the caller's own connection.
// Their portal keeps the app installed until they uninstall it in HubSpot;
// this just forgets our tokens.
export async function POST() {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  await deleteConnection(uid);
  return NextResponse.json({ ok: true });
}
