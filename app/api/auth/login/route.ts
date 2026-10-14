import { NextRequest, NextResponse } from "next/server";
import { routeClient } from "@/lib/auth";

// POST /api/auth/login — sign in against gtm_users. The signed session cookie is set by the
// ssr client through the route's cookie store.
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "Email and password required" }, { status: 400 });
  }

  const sb = await routeClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    // One generic message on purpose — never confirm whether the account exists.
    return NextResponse.json({ ok: false, error: "Wrong email or password" }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
