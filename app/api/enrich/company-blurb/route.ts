import { NextRequest, NextResponse } from "next/server";
import { apolloOrgBlurb } from "@/lib/enrich/apollo";
import { callClaudeWithWebSearch, FAST_MODEL } from "@/lib/anthropic";
import { updateSignalRow } from "@/lib/store";
import { stripEmDashes } from "@/lib/format";
import type { SignalTypeId } from "@/lib/types";

// GET /api/enrich/company-blurb?company=Ramp[&domain=ramp.com][&type=icp]
// A grounded 2-3 sentence "what the company does" blurb for a signal card.
// Source order: Apollo org description first (free, grounded), then a cheap
// Haiku + web-search fallback. Persists onto the cached signal row so it
// shows on reload without re-fetching.
export const maxDuration = 30;

const VALID_TYPES = ["hiring", "oss", "ma", "funding", "ai", "icp"];

// Keep it tight: collapse whitespace, cap at ~3 sentences / 400 chars.
function trimBlurb(text: string): string {
  const clean = stripEmDashes(text.replace(/\s+/g, " ").trim());
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  const out = sentences ? sentences.slice(0, 3).join(" ").trim() : clean;
  return out.length > 400 ? `${out.slice(0, 397).trimEnd()}…` : out;
}

const BLURB_SYSTEM =
  "You write tight, factual company descriptions for a B2B sales rep. In 2-3 sentences, say what the company does: its product, the market it serves, and roughly who its customers are. No marketing fluff, no superlatives, no funding/headcount trivia. State only what you can verify from search; if you can't confirm specifics, stay general rather than guessing. Plain punctuation only — never use em or en dashes.";

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim() || "";
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const typeParam = req.nextUrl.searchParams.get("type")?.trim().toLowerCase();
  const type = (VALID_TYPES.includes(typeParam ?? "") ? typeParam : undefined) as
    | SignalTypeId
    | undefined;

  if (!company) {
    return NextResponse.json({ error: "Pass ?company=" }, { status: 400 });
  }

  // 1) Apollo first — grounded, free, no LLM.
  let blurb = "";
  let source = "apollo";
  try {
    const apollo = await apolloOrgBlurb(company, domain);
    if (apollo && apollo.trim().length >= 60) blurb = trimBlurb(apollo);
  } catch {
    /* fall through to web search */
  }

  // 2) Web-search fallback (cheap model) when Apollo has nothing usable.
  if (!blurb) {
    try {
      const result = await callClaudeWithWebSearch({
        system: BLURB_SYSTEM,
        user: `Describe what ${company}${domain ? ` (${domain})` : ""} does, in 2-3 factual sentences.`,
        model: FAST_MODEL,
        maxSearches: 2,
        maxTokens: 320,
        temperature: 0.3,
      });
      const text = result.text?.trim();
      if (text) {
        blurb = trimBlurb(text);
        source = "web";
      }
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Blurb lookup failed" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  if (!blurb) {
    return NextResponse.json(
      { blurb: "", source: "none" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Persist onto the cached signal row (best-effort) so reloads reuse it.
  if (type) await updateSignalRow(company, type, { description: blurb });

  return NextResponse.json(
    { blurb, source },
    { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
  );
}
