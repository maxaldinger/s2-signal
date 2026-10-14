// Auth on SingleStore — replaces Supabase Auth (GoTrue) from the original build.
//
// Users live in gtm_users (scrypt password hashes); sessions are the signed
// cookie from lib/session.ts. The gate is OFF until AUTH_SECRET is set: with
// it off (local demo) every request acts as one owner user, so per-user
// features (favorites, marks, proposals) work without a login screen. Set
// AUTH_SECRET and ALLOWED_SIGNUP_EMAILS to turn accounts on.
//
// Exports keep the names the routes already used (routeClient, adminClient,
// sessionUser…), so route code only changed its import path.

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { s2Client } from "./s2/client";
import { authConfigured, OWNER, SESSION_COOKIE, sessionCookieOptions, signSession, verifySession, type User } from "./session";

export { authConfigured, type User } from "./session";

// ---------------------------------------------------------------------------
// Signup gating — exact allowlist (ALLOWED_SIGNUP_EMAILS, comma-separated).
// ---------------------------------------------------------------------------

export function emailMayRegister(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  const allowed = (process.env.ALLOWED_SIGNUP_EMAILS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(e);
}

export function signupDomainLabel(): string {
  return process.env.SIGNUP_DOMAIN?.trim() || "invited team";
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The signed-in user, or the owner user when the gate is off. */
export async function sessionUser(): Promise<User | null> {
  if (!authConfigured()) return OWNER;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function sessionUserId(): Promise<string | null> {
  return (await sessionUser())?.id ?? null;
}

const scryptAsync = (password: string, salt: string) =>
  new Promise<Buffer>((res, rej) => scrypt(password, salt, 64, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await scryptAsync(password, salt)).toString("hex")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  const want = Buffer.from(hex, "hex");
  const got = await scryptAsync(password, salt);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** Per-request client: per-user tables are scoped to the session user (the
 *  RLS behaviour of the Postgres build), plus the auth calls the routes use. */
export async function routeClient() {
  const user = await sessionUser();
  return {
    ...s2Client(user?.id ?? null),
    auth: {
      async getUser() {
        return { data: { user: await sessionUser() }, error: null };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const { data } = await s2Client()
          .from("gtm_users")
          .select("id,email,password_hash")
          .eq("email", email.trim().toLowerCase())
          .maybeSingle();
        if (!data || !(await checkPassword(password, String(data.password_hash)))) {
          return { data: { user: null as User | null }, error: { message: "Invalid login credentials" } };
        }
        const u: User = { id: String(data.id), email: String(data.email) };
        (await cookies()).set(SESSION_COOKIE, await signSession(u), sessionCookieOptions);
        return { data: { user: u as User | null }, error: null };
      },
      async signOut() {
        (await cookies()).delete(SESSION_COOKIE);
        return { error: null };
      },
    },
  };
}

/** Service client — no user scoping (the Supabase service-role equivalent). */
export function adminClient() {
  const db = s2Client(null);
  return {
    ...db,
    auth: {
      admin: {
        async createUser({ email, password }: { email: string; password: string; email_confirm?: boolean }) {
          const e = email.trim().toLowerCase();
          const existing = await db.from("gtm_users").select("id").eq("email", e).maybeSingle();
          if (existing.data) return { data: { user: null as User | null }, error: { message: "User already registered" } };
          const id = randomUUID();
          const { error } = await db.from("gtm_users").insert({ id, email: e, password_hash: await hashPassword(password) });
          if (error) return { data: { user: null as User | null }, error };
          return { data: { user: { id, email: e } as User | null }, error: null };
        },
      },
    },
  };
}
