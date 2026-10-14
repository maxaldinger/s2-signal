// Per-user HubSpot OAuth — WS5 of MULTI_TENANT_PLAN.md.
//
// Each user connects their OWN portal: the install route sends them to
// HubSpot's authorize screen, the callback exchanges the code, and the token
// pair lands here — AES-256-GCM encrypted, in gtm_hubspot_connections, a
// table with RLS on and ZERO policies (no user JWT can read it, only the
// service-role client this module uses).
//
// Access tokens live ~30 minutes. resolveUserAccessToken() refreshes on
// demand when <5 minutes remain, behind a per-user single-flight lock so a
// page's burst of HubSpot calls produces one refresh, not five. HubSpot does
// NOT rotate refresh tokens on refresh (they stay valid until the user
// disconnects or reauthorizes), so a cross-lambda double-refresh is
// harmless — both get valid access tokens. The stored refresh token is only
// replaced when HubSpot explicitly returns a new one.

import crypto from "node:crypto";
import { adminClient } from "./auth";

const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const INTROSPECT_URL = "https://api.hubapi.com/oauth/v1/access-tokens";

export const HS_OAUTH_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.owners.read",
];

/** The deployed app's origin, as registered on the HubSpot app (set
 *  APP_ORIGIN, e.g. https://s2-signal.vercel.app). Empty → the request's own
 *  origin is used. */
export const PROD_ORIGIN = (process.env.APP_ORIGIN?.trim() ?? "").replace(/\/+$/, "");

/** The redirect URI must EXACTLY match one registered on the app. Local dev is
 *  registered only at port 3000; anything else goes to the production origin. */
export function redirectUri(origin: string): string {
  return origin === "http://localhost:3000"
    ? "http://localhost:3000/api/hubspot/oauth/callback"
    : `${PROD_ORIGIN || origin}/api/hubspot/oauth/callback`;
}

export function oauthConfigured(): boolean {
  return Boolean(
    process.env.HS_CLIENT_ID?.trim() &&
      process.env.HS_CLIENT_SECRET?.trim() &&
      process.env.TOKEN_ENCRYPTION_KEY?.trim(),
  );
}

// ---------------------------------------------------------------------------
// Encryption at rest. AES-256-GCM; TOKEN_ENCRYPTION_KEY is 32 bytes hex.
// Rotating the key invalidates every stored connection — users reconnect.
// ---------------------------------------------------------------------------

function keyBytes(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  if (hex.length !== 64) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const [iv, tag, data] = stored.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Signed OAuth state: proves the callback belongs to the session that started
// the install, and that it's fresh. HMAC over uid + timestamp with the same
// TOKEN_ENCRYPTION_KEY (a second secret would add nothing here).
// ---------------------------------------------------------------------------

export function signState(userId: string): string {
  const ts = Date.now().toString(36);
  const payload = `${userId}.${ts}`;
  const sig = crypto.createHmac("sha256", keyBytes()).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyState(state: string, sessionUserId: string): boolean {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const [uid, ts, sig] = raw.split(".");
    if (!uid || !ts || !sig) return false;
    const expect = crypto.createHmac("sha256", keyBytes()).update(`${uid}.${ts}`).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    if (uid !== sessionUserId) return false; // callback must land on the SAME session
    const age = Date.now() - parseInt(ts, 36);
    return age >= 0 && age < 10 * 60_000; // 10-minute window
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Connection store
// ---------------------------------------------------------------------------

export interface HsConnection {
  user_id: string;
  portal_id: string;
  hub_domain: string | null;
  hs_user_email: string | null;
  owner_id: string | null;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scopes: string | null;
}

export async function getConnection(userId: string): Promise<HsConnection | null> {
  const { data } = await adminClient()
    .from("gtm_hubspot_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as HsConnection | null) ?? null;
}

export async function saveConnection(c: {
  userId: string;
  portalId: string;
  hubDomain?: string;
  userEmail?: string;
  ownerId?: string;
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scopes?: string[];
}): Promise<void> {
  const { error } = await adminClient()
    .from("gtm_hubspot_connections")
    .upsert(
      {
        user_id: c.userId,
        portal_id: c.portalId,
        hub_domain: c.hubDomain ?? null,
        hs_user_email: c.userEmail ?? null,
        owner_id: c.ownerId ?? null,
        access_token_enc: encryptToken(c.accessToken),
        refresh_token_enc: encryptToken(c.refreshToken),
        expires_at: new Date(Date.now() + c.expiresInSec * 1000).toISOString(),
        scopes: c.scopes?.join(" ") ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`connection save failed: ${error.message}`);
}

export async function deleteConnection(userId: string): Promise<void> {
  await adminClient().from("gtm_hubspot_connections").delete().eq("user_id", userId);
}

// ---------------------------------------------------------------------------
// Code exchange + introspection (used by the callback)
// ---------------------------------------------------------------------------

export async function exchangeCode(code: string, redirect: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.HS_CLIENT_ID!.trim(),
    client_secret: process.env.HS_CLIENT_SECRET!.trim(),
    redirect_uri: redirect,
    code,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !j.access_token || !j.refresh_token) {
    throw new Error(`code exchange failed (${res.status}): ${j.message ?? "no tokens returned"}`);
  }
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in ?? 1800 };
}

export async function introspect(accessToken: string): Promise<{
  hubId?: number;
  hubDomain?: string;
  userEmail?: string;
  scopes?: string[];
}> {
  const res = await fetch(`${INTROSPECT_URL}/${encodeURIComponent(accessToken)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return {};
  const j = (await res.json()) as { hub_id?: number; hub_domain?: string; user?: string; scopes?: string[] };
  return { hubId: j.hub_id, hubDomain: j.hub_domain, userEmail: j.user, scopes: j.scopes };
}

/** The connecting user's own owner id in their portal — how their tasks land
 *  in THEIR "my tasks" queue instead of unassigned. */
export async function resolveOwnerId(accessToken: string, email?: string): Promise<string | undefined> {
  if (!email) return undefined;
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return undefined;
  const j = (await res.json()) as { results?: { id?: string }[] };
  return j.results?.[0]?.id ?? undefined;
}

// ---------------------------------------------------------------------------
// Access-token resolution with refresh-on-demand
// ---------------------------------------------------------------------------

/** Per-user in-flight refresh, so one page's burst of calls refreshes once per
 *  lambda instance. Cross-instance duplicates are safe (see header). */
const inflight = new Map<string, Promise<string>>();

async function doRefresh(userId: string, conn: HsConnection): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.HS_CLIENT_ID!.trim(),
    client_secret: process.env.HS_CLIENT_SECRET!.trim(),
    refresh_token: decryptToken(conn.refresh_token_enc),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${j.message ?? "no token"} — reconnect HubSpot`);
  }
  // Persist the new access token; replace the refresh token ONLY when HubSpot
  // returned a new one.
  const patch: Record<string, string> = {
    access_token_enc: encryptToken(j.access_token),
    expires_at: new Date(Date.now() + (j.expires_in ?? 1800) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (j.refresh_token) patch.refresh_token_enc = encryptToken(j.refresh_token);
  await adminClient().from("gtm_hubspot_connections").update(patch).eq("user_id", userId);
  return j.access_token;
}

export interface UserTokenResult {
  ok: boolean;
  token?: string;
  ownerId?: string;
  portalId?: string;
  error?: string;
}

/** A valid access token for this user's portal, refreshing when <5 min
 *  remains. `error` distinguishes "never connected" from "refresh failed". */
export async function resolveUserAccessToken(userId: string): Promise<UserTokenResult> {
  const conn = await getConnection(userId);
  if (!conn) {
    return { ok: false, error: "HubSpot not connected — use Connect HubSpot in the sidebar" };
  }
  const msLeft = new Date(conn.expires_at).getTime() - Date.now();
  if (msLeft > 5 * 60_000) {
    try {
      return {
        ok: true,
        token: decryptToken(conn.access_token_enc),
        ownerId: conn.owner_id ?? undefined,
        portalId: conn.portal_id,
      };
    } catch {
      return { ok: false, error: "Stored HubSpot token unreadable (encryption key changed?) — reconnect HubSpot" };
    }
  }
  let p = inflight.get(userId);
  if (!p) {
    p = doRefresh(userId, conn).finally(() => inflight.delete(userId));
    inflight.set(userId, p);
  }
  try {
    const token = await p;
    return { ok: true, token, ownerId: conn.owner_id ?? undefined, portalId: conn.portal_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "HubSpot token refresh failed" };
  }
}
