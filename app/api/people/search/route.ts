import { NextRequest, NextResponse } from "next/server";
import { apolloTitleSearch } from "@/lib/enrich/apollo";

// POST /api/people/search — find people by TITLE across all companies.
//
// The org-scoped people search (/api/enrich/apollo/people) answers "who at this
// company?". This answers "who anywhere?", which is a different prospecting
// motion: pull everyone running a data platform, then pick the accounts.
//
// Apollo search consumes no credits and this route reveals no emails, so a
// query is free apart from the classifier's Haiku tokens — and the hard title
// exclusions run before the model, so the "Solutions Architect" and "Field
// Engineering" noise a loose title query drags in costs nothing at all.
export const maxDuration = 60;

interface Body {
  titles?: string[];
  seniorities?: string[];
  employeeRanges?: string[];
  locations?: string[];
  page?: number;
  perPage?: number;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const titles = (body.titles ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
  if (titles.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Enter at least one title to search for" },
      { status: 400 },
    );
  }

  const result = await apolloTitleSearch({
    titles,
    seniorities: body.seniorities,
    employeeRanges: body.employeeRanges,
    locations: body.locations,
    page: body.page,
    perPage: body.perPage,
    signal: `Sourced by a title search for: ${titles.join(", ")}. No company-level buying signal was observed for this account.`,
  });

  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, {
    status,
    // Never cached: the rep changes the query constantly and a stale page here
    // is indistinguishable from a query that returned nothing.
    headers: { "Cache-Control": "no-store" },
  });
}
