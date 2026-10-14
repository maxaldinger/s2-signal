import { NextResponse } from "next/server";
import { adminClient, sessionUserId } from "@/lib/auth";

// GET /api/sequencer/sequences — the picker's list. Active sequences only,
// with a step count so the UI can warn about enrolling into an empty one.
export const maxDuration = 15;

export async function GET() {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const admin = adminClient();
  const { data, error } = await admin
    .from("gtm_sequences")
    .select("id, name, owner_user_id, default_timezone, gtm_sequence_steps(id, channel)")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });

  const sequences = (data ?? []).map((s) => {
    const steps = (s.gtm_sequence_steps ?? []) as { id: string; channel: string }[];
    return {
      id: s.id as string,
      name: s.name as string,
      mine: s.owner_user_id === uid,
      timezone: s.default_timezone as string,
      stepCount: steps.length,
      emailSteps: steps.filter((x) => x.channel === "email").length,
    };
  });
  return NextResponse.json({ ok: true, sequences }, { headers: { "Cache-Control": "no-store" } });
}
