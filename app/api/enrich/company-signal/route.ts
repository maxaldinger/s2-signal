import { NextRequest, NextResponse } from "next/server";
import { apolloOrgBlurb } from "@/lib/enrich/apollo";
import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "@/lib/anthropic";
import { updateSignalRow } from "@/lib/store";
import { stripEmDashes } from "@/lib/format";
import type { SignalTypeId } from "@/lib/types";

// GET /api/enrich/company-signal?company=X[&domain=Y][&type=icp]
// For an Apollo profile-fit card (no event signal), research the SINGLE most
// relevant recent buying signal for SingleStore, plus a company blurb. Lazy + cached:
// the card fetches this only when on screen, and the result is persisted onto
// the signal row so the headline becomes the real signal on reload.
export const maxDuration = 45;

const VALID_TYPES = ["hiring", "oss", "ma", "funding", "ai", "icp"];

function clean(s: unknown): string {
  return typeof s === "string" ? stripEmDashes(s.replace(/\s+/g, " ").trim()) : "";
}

const SIGNAL_SYSTEM = `You are a GTM research analyst for SingleStore. SingleStore sells one distributed SQL database for transactions AND real-time analytics (HTAP), with vector and full-text search in the same engine, so teams can serve millisecond, high-concurrency queries on fresh data and consolidate the separate OLTP database, cache, search index, real-time analytics store and vector DB they otherwise keep in sync. SingleStore's ICP is data-intensive companies (roughly 50+ engineers, larger orgs qualify) running customer-facing or latency-sensitive applications: SaaS analytics, adtech, cybersecurity, fintech, IoT/industrial, media, and enterprises building real-time dashboards or gen-AI features.

Using web search, do TWO things for the given company:

1. SIGNAL — find the SINGLE most relevant, RECENT (last ~6 months) buying signal: concrete public evidence of data-infrastructure growth, strain or change. Good signals: data-platform, database, streaming or real-time analytics hiring; funding earmarked for data / AI platform or scale; a gen-AI, RAG, semantic-search or agent launch in their own product; an engineering-blog post on scaling Postgres/MySQL, moving off Elasticsearch, real-time pipelines (Kafka, Flink, CDC) or a data-stack migration; or an acquisition that leaves two data estates to consolidate. A technology being present is not a signal by itself, and never state pain the source does not state. It MUST be real and citable. If you cannot find a concrete, recent, cited signal, return null — never invent one. Pick the type from: hiring, funding, ai, oss, ma.

2. DESCRIPTION — a 2-3 sentence factual description of what the company does.

Plain punctuation only; never use em or en dashes.

Return ONLY this JSON object, no prose, no code fences:
{"signal": {"title": "hook, max ~70 chars", "description": "1-2 sentences quoting the evidence", "type": "hiring|funding|ai|oss|ma", "url": "citation url"} , "description": "2-3 sentence company description"}
If there is no real signal, use "signal": null.`;

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company")?.trim() || "";
  const domain = req.nextUrl.searchParams.get("domain")?.trim() || undefined;
  const typeParam = req.nextUrl.searchParams.get("type")?.trim().toLowerCase();
  const type = (VALID_TYPES.includes(typeParam ?? "") ? typeParam : "icp") as SignalTypeId;

  if (!company) return NextResponse.json({ error: "Pass ?company=" }, { status: 400 });

  let signal: { title: string; description: string; type?: string; url?: string } | null = null;
  let blurb = "";

  try {
    const result = await callClaudeWithWebSearch({
      system: SIGNAL_SYSTEM,
      user: `Company: ${company}${domain ? ` (${domain})` : ""}.`,
      model: FAST_MODEL,
      maxSearches: 4,
      maxTokens: 700,
      temperature: 0.3,
    });
    const parsed = extractJSON<{
      signal?: { title?: string; description?: string; type?: string; url?: string } | null;
      description?: string;
    }>(result.text);
    if (parsed) {
      blurb = clean(parsed.description);
      const s = parsed.signal;
      if (s && clean(s.title) && clean(s.description)) {
        const t = String(s.type || "").toLowerCase();
        signal = {
          title: clean(s.title),
          description: clean(s.description),
          type: VALID_TYPES.includes(t) && t !== "icp" ? t : undefined,
          url: typeof s.url === "string" && /^https?:\/\//.test(s.url) ? s.url : undefined,
        };
      }
    }
  } catch (e) {
    // Web search failed — fall back to an Apollo-only blurb so the card still
    // gets a description rather than erroring.
    try {
      const apollo = await apolloOrgBlurb(company, domain);
      if (apollo) blurb = clean(apollo);
    } catch {
      /* leave blank */
    }
    if (!blurb)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Signal lookup failed" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
  }

  // Persist: a real signal becomes the headline (title + description + source);
  // otherwise just fill the description with the blurb.
  if (signal) {
    await updateSignalRow(company, type, {
      title: signal.title,
      description: signal.description,
      url: signal.url,
    });
  } else if (blurb) {
    await updateSignalRow(company, type, { description: blurb });
  }

  return NextResponse.json(
    { signal, blurb },
    { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
  );
}
