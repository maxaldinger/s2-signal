import { NextResponse } from "next/server";
import { routeClient } from "@/lib/auth";

// POST /api/auth/logout — end the session (clears the signed cookie).
export async function POST() {
  const sb = await routeClient();
  await sb.auth.signOut();
  return NextResponse.json({ ok: true });
}
