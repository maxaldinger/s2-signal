import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminClient, sessionUserId } from "@/lib/auth";
import { normCompany } from "@/lib/companyKey";
import type { ProposalFields } from "@/lib/proposalDoc";
import { generateProposalFields, type ProposalResearch } from "@/lib/proposalGen";

// POST /api/proposal — generate a personalized SingleStore proposal for an
// account and store it under an unguessable token; the prospect-facing page
// is served publicly at /p/<token> (middleware exempts that path).
//
// CACHED per rep + account: a repeat click returns the existing link instead
// of generating a duplicate; `force: true` regenerates with the latest facts
// IN PLACE (same token), so a link already emailed out shows the new content.
//
// POSITIONING: one generation pipeline (lib/proposalGen.ts), BOTH narratives
// every time — Operational and ROI, rendered as tabs on the one page.
// Stored proposals with no narratives render as they always did.
export const maxDuration = 60;

interface Body {
  company?: string;
  /** The feed's stable name for the account — the proposal-cache key. */
  companyKey?: string;
  domain?: string;
  contactName?: string;
  contactTitle?: string;
  /** Legacy free-text context: signal, blurb, brief summary, call hook. */
  context?: string;
  /** Structured research from the surface (the brief fills most of it). */
  research?: ProposalResearch;
  /** Engineering headcount (software + data engineers). */
  sweEstimate?: number;
  /** True when the engineer count was confirmed by the account on a call (the
   *  rep's manual override) — changes how the number is framed. */
  sweConfirmed?: boolean;
  /** Call-confirmed monthly spend on the data systems SingleStore could
   *  consolidate, in USD THOUSANDS ($K/month; 120 = $120,000/month). Replaces
   *  the modeled per-engineer default in the ROI table. Thousands because the
   *  shared override store accepts 1..100,000 ($1K..$100M a month). */
  spendMo?: number;
  employees?: number;
  icpTotal?: number;
  /** Regenerate even when a proposal exists — updates it at the SAME link. */
  force?: boolean;
}

// A prospect's spend on the systems SingleStore could consolidate (serving-
// layer databases and replicas, real-time analytics store, cache, search
// cluster, vector DB, ETL/CDC tooling, pipeline upkeep) is almost never
// public. With no confirmed figure, the ROI table MODELS it as engineering
// headcount × this per-engineer CUSTOMER ASSUMPTION, labelled as such on the
// page. Overridden per account via the brief header's spend chip once the real
// number comes up on a call. Keep in sync with DEFAULT_DATA_SPEND_PER_ENG_MO in
// components/CompanyIntel.tsx.
const DEFAULT_DATA_SPEND_PER_ENG_MO = 250;

export async function POST(req: NextRequest) {
  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const company = body.company?.trim();
  if (!company) return NextResponse.json({ ok: false, error: "Pass company" }, { status: 400 });
  const contactName = body.contactName?.trim() || undefined;
  // The >= 20 floor sanity-filters MODELED estimates; a rep-confirmed count
  // from a call is exactly the case where a small number is trustworthy, so
  // confirmation lowers the floor to 1 (matching what the engineer chip accepts).
  const swe =
    typeof body.sweEstimate === "number" && body.sweEstimate >= (body.sweConfirmed === true ? 1 : 20)
      ? Math.round(body.sweEstimate)
      : undefined;
  const sweConfirmed = body.sweConfirmed === true && !!swe;
  const spendMo =
    typeof body.spendMo === "number" && body.spendMo >= 1 && body.spendMo <= 100_000
      ? Math.round(body.spendMo)
      : undefined;
  const confirmedSpendMo = spendMo ? spendMo * 1000 : undefined;

  // Proposal cache: one live proposal per rep + account. A repeat click
  // returns the existing link (no duplicate doc, no duplicate spend); `force`
  // falls through to regenerate and update that row in place.
  const companyKey = normCompany(body.companyKey?.trim() || company);
  const admin = adminClient();
  const { data: existing, error: lookupError } = await admin
    .from("gtm_proposals")
    .select("token, fields")
    .eq("created_by", uid)
    .eq("company_key", companyKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A failed lookup must FAIL the request — falling through would mint a
  // duplicate proposal at a new URL and strand the link already sent out.
  if (lookupError) {
    return NextResponse.json(
      { ok: false, error: `Proposal lookup failed: ${lookupError.message}` },
      { status: 502 },
    );
  }
  if (existing?.token && !body.force) {
    const f = existing.fields as Partial<ProposalFields> | null;
    return NextResponse.json({
      ok: true,
      url: `${req.nextUrl.origin}/p/${existing.token}`,
      cached: true,
      generatedAt: f?.generatedAt,
      // Docs generated before the tabs existed carry one narrative; the UI
      // can offer Update to get both.
      dual: !!f?.narratives,
    });
  }

  // Facts the CURRENT surface doesn't know must not erase what a richer one
  // already published: an Update clicked on the feed card (which knows no
  // contact or employee count) would otherwise strip the brief-generated
  // proposal's contact record and employees fact from the live link.
  const prev = (existing?.fields ?? undefined) as Partial<ProposalFields> | undefined;
  const mergedContactName =
    contactName ?? (typeof prev?.contactName === "string" && prev.contactName ? prev.contactName : undefined);
  const employees =
    typeof body.employees === "number"
      ? Math.round(body.employees)
      : typeof prev?.employees === "number"
        ? prev.employees
        : undefined;

  const gen = await generateProposalFields({
    company,
    domain: body.domain?.trim() || undefined,
    context: body.context,
    research: body.research,
    contactName: mergedContactName,
    contactTitle: body.contactTitle,
    employees,
    swe,
    sweConfirmed,
    confirmedSpendMo,
    perEngMo: DEFAULT_DATA_SPEND_PER_ENG_MO,
    icpTotal: typeof body.icpTotal === "number" ? body.icpTotal : undefined,
  });
  if (!gen.ok) return NextResponse.json({ ok: false, error: gen.error }, { status: 502 });
  const fields = gen.fields;

  // Regenerating keeps the SAME token — the link the rep already sent out
  // starts showing the updated content. The update matches on the KEY, not
  // one token: pre-cache double-clicks left duplicate rows for a few accounts
  // (two live tokens each), and updating only the newest would leave whichever
  // link was actually emailed serving stale content forever. Matching the key
  // converges every live link for the account onto the new content.
  const updateAllForKey = async () => {
    const { error } = await admin
      .from("gtm_proposals")
      .update({
        company,
        contact_name: mergedContactName ?? null,
        fields,
        updated_at: new Date().toISOString(),
      })
      .eq("created_by", uid)
      .eq("company_key", companyKey);
    return error;
  };

  if (existing?.token) {
    const error = await updateAllForKey();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    return NextResponse.json({ ok: true, url: `${req.nextUrl.origin}/p/${existing.token}`, updated: true, dual: true });
  }

  // The lookup → generate → insert sequence spans the ~15s generation, and a
  // second click can land in that window (the card and the open brief each
  // mount their own button; propBusy doesn't cross instances or tabs).
  // Re-check before inserting: if a row appeared, update it instead of
  // minting a second link for the same account.
  const { data: raced } = await admin
    .from("gtm_proposals")
    .select("token")
    .eq("created_by", uid)
    .eq("company_key", companyKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (raced?.token) {
    const error = await updateAllForKey();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
    return NextResponse.json({ ok: true, url: `${req.nextUrl.origin}/p/${raced.token}`, updated: true, dual: true });
  }

  const token = randomBytes(16).toString("hex");
  const { error } = await admin
    .from("gtm_proposals")
    .insert({ token, company, company_key: companyKey, contact_name: mergedContactName ?? null, fields, created_by: uid });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });

  return NextResponse.json({ ok: true, url: `${req.nextUrl.origin}/p/${token}`, dual: true });
}
