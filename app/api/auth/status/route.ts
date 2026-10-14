// GET /api/auth/status — who is signed in. Drives the sidebar's sign-out
// control and (later) per-user UI like the HubSpot connection chip. Open in
// middleware, so it must reveal nothing beyond the caller's own session.

import { NextResponse } from "next/server";
import { adminClient, sessionUser } from "@/lib/auth";

export async function GET() {
  const user = await sessionUser();
  if (!user) {
    return NextResponse.json(
      { enabled: true, signedIn: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // Display name from the profile the signup route seeded. Service role read:
  // one row, own user only — the caller is that user.
  let displayName: string | undefined;
  try {
    const { data } = await adminClient()
      .from("gtm_profiles")
      .select("display_name")
      .eq("user_id", user.id)
      .maybeSingle();
    displayName = data?.display_name ?? undefined;
  } catch {
    /* profile missing is cosmetic */
  }
  return NextResponse.json(
    { enabled: true, signedIn: true, email: user.email, displayName },
    { headers: { "Cache-Control": "no-store" } },
  );
}
