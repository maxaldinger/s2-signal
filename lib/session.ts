// Edge-safe session primitives: the signed session cookie and the gate switch.
// No database or Node-only imports here — middleware.ts runs on the Edge
// runtime. Database-backed auth (passwords, users) lives in lib/auth.ts.

import type { NextRequest, NextResponse } from "next/server";

export interface User {
  id: string;
  email?: string;
}

export const SESSION_COOKIE = "s2_session";
const SESSION_DAYS = 14;

/** Stand-in identity when the gate is off (local demo): one owner user. */
export const OWNER: User = { id: "owner", email: process.env.OWNER_EMAIL?.trim() || "owner@localhost" };

/** The login gate is OFF until AUTH_SECRET is set. */
export function authConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET?.trim());
}

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlText = (s: string) => b64url(enc.encode(s).buffer as ArrayBuffer);
const fromB64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(process.env.AUTH_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signSession(user: User): Promise<string> {
  const payload = b64urlText(JSON.stringify({ id: user.id, email: user.email, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySession(token: string | undefined): Promise<User | null> {
  if (!token || !authConfigured()) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(payload);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const p = JSON.parse(fromB64url(payload)) as { id: string; email?: string; exp: number };
    return p.exp > Date.now() ? { id: p.id, email: p.email } : null;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_DAYS * 86400,
};

/** Middleware: verify the cookie only (no database on the Edge). */
export async function middlewareUser(
  req: NextRequest,
  makeResponse: () => NextResponse,
): Promise<{ user: User | null; res: NextResponse }> {
  const res = makeResponse();
  if (!authConfigured()) return { user: OWNER, res };
  return { user: await verifySession(req.cookies.get(SESSION_COOKIE)?.value), res };
}
