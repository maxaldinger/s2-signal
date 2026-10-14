import { NextRequest, NextResponse } from "next/server";
import { apolloPersonContact, type RevealKind } from "@/lib/enrich/apollo";
import { cachedResponse, readRevealCache, writeRevealCache } from "@/lib/enrich/revealCache";
import { sessionUserId } from "@/lib/auth";

// GET /api/enrich/apollo/person?id=<apolloId>&reveal=email|phone|profile
//   — or — ?name=Jane%20Doe&reveal=…[&company=Ramp][&domain=ramp.com][&linkedin=…]
//
// WS4: the shared reveal cache lives HERE, next to the spend. An id-keyed
// reveal checks gtm_reveal_cache first — a contact any teammate already paid
// to reveal costs nothing, ever again. Real Apollo responses are written back
// (email "" = attempted-but-none, so a known-empty contact doesn't re-spend
// either). Name-based lookups skip the cache: no stable key.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")?.trim() || undefined;
  const name = req.nextUrl.searchParams.get("name")?.trim() || undefined;
  const revealParam = req.nextUrl.searchParams.get("reveal")?.trim();
  const company = req.nextUrl.searchParams.get("company")?.trim() || undefined;
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const linkedinUrl = req.nextUrl.searchParams.get("linkedin")?.trim() || undefined;

  if (!id && !name) {
    return NextResponse.json({ error: "Pass ?id= or ?name=" }, { status: 400 });
  }
  // "profile" is free: people/match with no reveal_* flag. It returns the real
  // name, the LinkedIn URL and the employer domain, and it repairs contacts
  // whose email was revealed before those fields were being captured.
  if (revealParam !== "email" && revealParam !== "phone" && revealParam !== "profile") {
    return NextResponse.json(
      { error: "Pass ?reveal=email, ?reveal=phone or ?reveal=profile" },
      { status: 400 },
    );
  }
  const reveal = revealParam as RevealKind;

  if (id) {
    const row = await readRevealCache(id);
    if (row) {
      const hit = cachedResponse(row, reveal);
      if (hit) return NextResponse.json(hit, { headers: { "Cache-Control": "no-store" } });
    }
  }

  const result = await apolloPersonContact({ id, name, company, domain, linkedinUrl, reveal });

  // Write back whatever the call produced, including "attempted, none found" —
  // ok:false with a match still tells us Apollo has nothing, and that answer
  // is worth caching so nobody re-spends on it.
  if (id && result.configured) {
    const matched = result.ok || /no email on file|no phone/i.test(result.error ?? "");
    if (matched) {
      await writeRevealCache(
        id,
        {
          name: result.name ?? undefined,
          country: result.country ?? undefined,
          linkedin_url: result.linkedinUrl ?? undefined,
          company_domain: result.companyDomain ?? undefined,
          ...(reveal === "email" ? { email: result.email ?? "", email_status: result.emailStatus ?? null } : {}),
          ...(reveal === "phone" && result.phone ? { phone: result.phone } : {}),
        },
        (await sessionUserId()) ?? undefined,
      );
    }
  }

  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, { status });
}
