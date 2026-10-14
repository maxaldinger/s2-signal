import { NextRequest, NextResponse } from "next/server";
import { adminClient, emailMayRegister, routeClient, signupDomainLabel } from "@/lib/auth";

// POST /api/auth/signup — the ONLY way an account gets created.
//
// There is no public self-registration: this route creates accounts
// server-side (scrypt hash in gtm_users), gated to an exact email allowlist
// (ALLOWED_SIGNUP_EMAILS). On success it also seeds gtm_profiles — display names drive the
// "synced by Rohan" attribution — and signs the new user straight in.
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const displayName = (body.displayName ?? "").trim().slice(0, 60);

  if (!emailMayRegister(email)) {
    return NextResponse.json(
      // Invite-only now: the address must be on the allowlist Max maintains.
      // Deliberately does not reveal whether the domain or the list failed.
      { ok: false, error: `Sign-up is invite-only for the ${signupDomainLabel()} — ask Max to add your email` },
      { status: 403 },
    );
  }
  if (password.length < 10) {
    return NextResponse.json(
      { ok: false, error: "Password must be at least 10 characters" },
      { status: 400 },
    );
  }
  if (!displayName) {
    return NextResponse.json(
      { ok: false, error: "Enter a display name — teammates see it on sync history" },
      { status: 400 },
    );
  }

  const admin = adminClient();
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // internal tool, domain-gated — no confirmation email loop
  });
  if (error || !created.user) {
    const exists = /already|registered|exists/i.test(error?.message ?? "");
    return NextResponse.json(
      { ok: false, error: exists ? "An account with this email already exists — sign in instead" : `Could not create the account (${error?.message ?? "unknown"})` },
      { status: exists ? 409 : 502 },
    );
  }

  // Seed the profile. Service role bypasses RLS, so this works before the user
  // has ever held a session.
  const { error: pErr } = await admin
    .from("gtm_profiles")
    .upsert({ user_id: created.user.id, display_name: displayName }, { onConflict: "user_id" });
  if (pErr) console.error(`[signup] profile seed failed for ${email}: ${pErr.message}`);

  // Sign them in immediately so the flow ends inside the app, not on a form.
  const sb = await routeClient();
  const { error: sErr } = await sb.auth.signInWithPassword({ email, password });
  if (sErr) {
    return NextResponse.json({ ok: true, signedIn: false }); // account exists; they can sign in manually
  }
  return NextResponse.json({ ok: true, signedIn: true });
}
