// Server-side Apollo reveal cache — WS4 of MULTI_TENANT_PLAN.md.
//
// The cache lives NEXT TO THE SPEND: /api/enrich/apollo/person consults it
// before calling Apollo and writes back after, so a contact any teammate has
// already paid to reveal is never paid for again — by anyone, from any device.
// This replaces the old client-side blob (2,696 entries in ONE jsonb value,
// synced whole-object with last-writer-wins, which loses concurrent writes).
//
// Uses the service-role client on purpose: this is shared, non-user-scoped
// cache data, and the writes must also work from non-user contexts (cron).
// The `authenticated` RLS policies on the table remain for any future direct
// client access; server access simply doesn't route through them.

import { adminClient } from "../auth";
import type { ApolloPersonContact } from "./apollo";

export interface RevealCacheRow {
  apollo_id: string;
  name: string | null;
  email: string | null; // "" = attempted, Apollo has none (mirrors the old blob's semantics)
  email_status: string | null;
  phone: string | null;
  country: string | null;
  linkedin_url: string | null;
  company_domain: string | null;
}

export async function readRevealCache(apolloId: string): Promise<RevealCacheRow | null> {
  try {
    const { data } = await adminClient()
      .from("gtm_reveal_cache")
      .select("apollo_id,name,email,email_status,phone,country,linkedin_url,company_domain")
      .eq("apollo_id", apolloId)
      .maybeSingle();
    return (data as RevealCacheRow | null) ?? null;
  } catch {
    return null; // cache miss on error — the paid path still works
  }
}

/** Merge-write: only fields present in `patch` overwrite. `revealedBy` records
 *  which user's action funded the reveal (attribution, not access control). */
export async function writeRevealCache(
  apolloId: string,
  patch: Partial<Omit<RevealCacheRow, "apollo_id">>,
  revealedBy?: string,
): Promise<void> {
  try {
    const admin = adminClient();
    const existing = await readRevealCache(apolloId);
    const row = {
      apollo_id: apolloId,
      ...(existing ?? {}),
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      ...(revealedBy ? { revealed_by: revealedBy } : {}),
      updated_at: new Date().toISOString(),
    };
    await admin.from("gtm_reveal_cache").upsert(row, { onConflict: "apollo_id" });
  } catch (e) {
    console.error(`[revealCache] write failed for ${apolloId}:`, e instanceof Error ? e.message : e);
  }
}

/** Shape a cached row as the person-route response for a given reveal kind, or
 *  null when the cache can't answer that kind yet. */
export function cachedResponse(
  row: RevealCacheRow,
  kind: "email" | "phone" | "profile",
): (ApolloPersonContact & { cached: true }) | null {
  const base = {
    configured: true as const,
    cached: true as const,
    name: row.name ?? undefined,
    linkedinUrl: row.linkedin_url ?? undefined,
    country: row.country ?? undefined,
    companyDomain: row.company_domain ?? undefined,
  };
  if (kind === "email") {
    if (row.email === null) return null; // never attempted — spend the credit
    if (row.email === "") {
      return { ...base, ok: false, error: "Apollo matched this person but has no email on file for them" };
    }
    return { ...base, ok: true, email: row.email, emailStatus: row.email_status ?? undefined };
  }
  if (kind === "profile") {
    if (!row.linkedin_url && !row.name) return null;
    return row.email && row.email !== ""
      ? { ...base, ok: true, email: row.email, emailStatus: row.email_status ?? undefined }
      : { ...base, ok: true };
  }
  // phone reveals always fail live today (webhook-only) — never cache-answer them.
  return null;
}
