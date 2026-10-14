import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCode,
  introspect,
  redirectUri,
  resolveOwnerId,
  saveConnection,
  verifyState,
} from "@/lib/hubspotOAuth";
import { sessionUserId } from "@/lib/auth";

// GET /api/hubspot/oauth/callback — HubSpot redirects here after the user
// approves. Verify the state belongs to THIS session (signature + freshness +
// same uid), exchange the code, learn which portal and who they are there,
// resolve their owner id so their tasks land in their own queue, store the
// encrypted token pair. Then back into the app.
export const maxDuration = 30;

function bounce(req: NextRequest, param: string): NextResponse {
  const url = req.nextUrl.clone();
  // Success lands in the app; failures land back on the connect page, which
  // explains the state and offers retry.
  url.pathname = param === "hs=connected" ? "/" : "/connect";
  url.search = `?${param}`;
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (!code) return bounce(req, "hs=denied"); // user clicked cancel on the consent screen
  if (!verifyState(state, uid)) return bounce(req, "hs=state_mismatch");

  try {
    const tok = await exchangeCode(code, redirectUri(req.nextUrl.origin));
    const info = await introspect(tok.accessToken);
    if (!info.hubId) throw new Error("token introspection returned no portal id");
    const ownerId = await resolveOwnerId(tok.accessToken, info.userEmail);
    await saveConnection({
      userId: uid,
      portalId: String(info.hubId),
      hubDomain: info.hubDomain,
      userEmail: info.userEmail,
      ownerId,
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresInSec: tok.expiresIn,
      scopes: info.scopes,
    });
    return bounce(req, "hs=connected");
  } catch (e) {
    console.error(`[hs-oauth] callback failed for ${uid}:`, e instanceof Error ? e.message : e);
    return bounce(req, "hs=error");
  }
}
