import { NextResponse } from "next/server";
import { fetchCompanyAliasGroups } from "@/lib/store";

// GET /api/company-aliases — groups of names that are the SAME company.
//
// One account reaches the UI under several spellings and the client stores are
// keyed by name, so a mark written under one spelling leaves the others grey:
//
//   "Tesla Motors"  the Signal 2000 row the rep opened
//   "Tesla, Inc."   what the research resolved it to
//   "Tesla Inc."    a SECOND Signal 2000 row for the same business
//
// Two sources, both already in the database:
//   - gtm_briefs: the row's company name and the brief's resolved intel.name
//     are the same company by construction.
//   - gtm_directory: two rows sharing a domain are the same company.
// Chained transitively, so Tesla Motors -> Tesla, Inc. -> tesla.com -> Tesla Inc.
//
// The CLIENT applies these to its own store. That is the whole point: state is
// pushed to the database as one whole object per store, last writer wins, so a
// server-side repair is overwritten by the next push from any open tab. A
// repair made through the client's own store survives, because it is pushed the
// same way every other change is.
export const revalidate = 300;

export async function GET() {
  const r = await fetchCompanyAliasGroups();
  return NextResponse.json(r, {
    status: r.ok ? 200 : 502,
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
