import { NextResponse } from "next/server";
import { adminClient, sessionUserId } from "@/lib/auth";

// GET /api/sync-events — WS6: who synced what to their HubSpot, latest event
// per company / per contact, with display names. Shared truth: every signed-in
// user sees the same map, which is what makes "synced by Rohan · Aug 3"
// possible on a card Max is looking at. `me` lets the client suppress chips
// for the viewer's own events (their orange badge already covers those).
export const maxDuration = 20;

interface EventOut {
  by: string;
  user: string;
  at: string;
}

export async function GET() {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const admin = adminClient();

  const [{ data: events, error }, { data: profiles }] = await Promise.all([
    admin
      .from("gtm_sync_events")
      .select("kind,key,company_key,contact_key,user_id,synced_at")
      .order("synced_at", { ascending: true }),
    admin.from("gtm_profiles").select("user_id,display_name"),
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });

  const names = new Map((profiles ?? []).map((p) => [p.user_id as string, p.display_name as string]));
  const companies: Record<string, EventOut> = {};
  const contacts: Record<string, EventOut> = {};
  // Ascending order + overwrite = latest event per key wins.
  for (const e of events ?? []) {
    const out: EventOut = {
      by: names.get(e.user_id as string) ?? "a teammate",
      user: e.user_id as string,
      at: e.synced_at as string,
    };
    if (e.kind === "company" && e.company_key) companies[e.company_key as string] = out;
    if (e.kind === "contact" && e.contact_key) contacts[e.contact_key as string] = out;
  }
  return NextResponse.json(
    { ok: true, me: uid, companies, contacts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
