import { NextRequest, NextResponse } from "next/server";
import { routeClient, sessionUser } from "@/lib/auth";

// Cross-device client state — PER-USER ONLY as of WS4.
//
// Stores here (marks, favorites, review flags…) live in gtm_user_state, read
// and written through the caller's OWN session: per-user scoping in lib/s2
// (auth.uid() = user_id) scopes every query, so this route physically cannot
// serve one user's marks to another even if the code forgets a filter.
//
// The shared caches that used to ride this route moved to row-per-entry
// tables served by /api/cache (WS4); the reveal cache lives inside the
// person route, next to the Apollo spend. Legacy gtm_state is retired.
export const maxDuration = 20;

/** Per-user under the multi-tenant split. */
const PER_USER = new Set([
  "s2-prospected",
  "s2-favorites",
  "s2-reviewed",
  "s2-collapsed",
  "s2-lowpriority",
  "s2-last-due",
  "s2-hs-presence",
]);

const CLIENT_VERSION = ".v3";

function baseOf(store: string): string {
  return store.replace(/\.v\d+$/, "");
}

export async function GET() {
  const user = await sessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const state: Record<string, unknown> = {};
  const sb = await routeClient();
  const { data, error } = await sb.from("gtm_user_state").select("store,value");
  if (error) {
    return NextResponse.json({ ok: false, configured: true, error: error.message }, { status: 502 });
  }
  for (const row of data ?? []) {
    if (PER_USER.has(baseOf(row.store))) state[row.store] = row.value;
  }
  return NextResponse.json({ configured: true, ok: true, state });
}

export async function POST(req: NextRequest) {
  const user = await sessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { store?: string; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const store = body.store ?? "";
  const base = baseOf(store);
  // Version-pinned, same as always: un-versioned names from stale tabs must
  // not re-seed wiped state.
  if (!store.endsWith(CLIENT_VERSION) || !PER_USER.has(base)) {
    return NextResponse.json({ ok: false, error: "Unknown store" }, { status: 400 });
  }

  const sb = await routeClient();
  const { error } = await sb
    .from("gtm_user_state")
    .upsert(
      { user_id: user.id, store, value: body.value ?? {}, updated_at: new Date().toISOString() },
      { onConflict: "user_id,store" },
    );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true });
}
