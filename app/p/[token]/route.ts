import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/auth";
import { buildProposalHtml, type ProposalFields } from "@/lib/proposalDoc";

// GET /p/<token> — the PUBLIC prospect-facing proposal page. Exempted from
// the auth middleware; the only key is the unguessable 32-hex token, and the
// page carries only what the rep chose to publish for that one account.
export const maxDuration = 15;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!/^[0-9a-f]{32}$/.test(token ?? "")) {
    return new NextResponse("Not found", { status: 404 });
  }
  const { data, error } = await adminClient()
    .from("gtm_proposals")
    .select("fields")
    .eq("token", token)
    .maybeSingle();
  if (error || !data?.fields) {
    return new NextResponse("Not found", { status: 404 });
  }
  const html = buildProposalHtml(data.fields as ProposalFields);
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // No CDN caching: proposals now update IN PLACE at the same link
      // ("Update proposal"), and a cached copy would make the refresh look
      // broken — the rep reloads and still sees the old numbers. One DB read
      // per view is nothing at this traffic.
      "Cache-Control": "no-store",
    },
  });
}
