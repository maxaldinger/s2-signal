import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/auth";
import { enroll, precheck, type ProspectInput } from "@/lib/sequencer/enroll";

// POST /api/sequencer/enroll — add one person to an email sequence.
//
// `dryRun: true` runs every gate and returns the verdict WITHOUT writing an
// enrollment. That's what the UI calls to decide whether to show a red block, an
// amber "open opp here, proceed?" or a plain button — so the checks the user
// sees are literally the same code that enforces them.
//
// A WARN verdict requires `acknowledgeWarning: true` on the real call.
export const maxDuration = 30;

interface Body {
  prospect?: ProspectInput;
  sequenceId?: string;
  dryRun?: boolean;
  acknowledgeWarning?: boolean;
}

export async function POST(req: NextRequest) {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const prospect = body.prospect;
  const sequenceId = body.sequenceId?.trim();
  if (!prospect || !sequenceId) {
    return NextResponse.json({ ok: false, error: "Pass prospect and sequenceId" }, { status: 400 });
  }
  if (!prospect.email?.trim()) {
    return NextResponse.json(
      { ok: false, error: "No email address — cannot enroll in an email sequence" },
      { status: 400 },
    );
  }

  if (body.dryRun) {
    const pre = await precheck(prospect, sequenceId, uid);
    return NextResponse.json({ ok: true, dryRun: true, precheck: pre });
  }

  const result = await enroll(prospect, sequenceId, uid, {
    acknowledgeWarning: body.acknowledgeWarning === true,
  });
  // A refusal is a 200 with ok:false — the client renders the reason rather than
  // treating a correctly-blocked enrollment as a server error.
  return NextResponse.json(result);
}
