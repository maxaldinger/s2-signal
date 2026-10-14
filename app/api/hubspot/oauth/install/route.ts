import { NextRequest, NextResponse } from "next/server";
import { HS_OAUTH_SCOPES, oauthConfigured, redirectUri, signState } from "@/lib/hubspotOAuth";
import { sessionUserId } from "@/lib/auth";

// GET /api/hubspot/oauth/install — start the connect flow: bounce the signed-in
// user to HubSpot's authorize screen for THEIR portal. The signed state ties
// the eventual callback to this exact session.
export async function GET(req: NextRequest) {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  if (!oauthConfigured()) {
    return NextResponse.json(
      { error: "HubSpot OAuth env not configured (HS_CLIENT_ID / HS_CLIENT_SECRET / TOKEN_ENCRYPTION_KEY)" },
      { status: 501 },
    );
  }
  const url =
    "https://app.hubspot.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(process.env.HS_CLIENT_ID!.trim())}` +
    `&scope=${encodeURIComponent(HS_OAUTH_SCOPES.join(" "))}` +
    `&redirect_uri=${encodeURIComponent(redirectUri(req.nextUrl.origin))}` +
    `&state=${encodeURIComponent(signState(uid))}`;
  return NextResponse.redirect(url);
}
