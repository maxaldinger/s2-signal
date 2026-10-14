// GDELT DOC 2.0 fetcher (free, keyless global news index).
// Endpoint: https://api.gdeltproject.org/api/v2/doc/doc (mode=artlist, format=json)
// Quirks handled: 429 plain-text rate limit (1 req / 5s), non-JSON bodies on
// bad queries, `{}` (no `articles` key) on zero results, seendate format
// YYYYMMDDTHHMMSSZ, heavy syndication (dedupe by normalized title), and
// top-level OR queries requiring parentheses.

import type { RawItem, FetchResult } from "./types";

const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const DEFAULT_LIMIT = 25;
const DEFAULT_TIMESPAN = "2w";

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// GDELT requires parentheses around top-level OR expressions.
function prepareQuery(query: string): string {
  const trimmed = query.trim();
  if (/\sOR\s/i.test(trimmed) && !trimmed.startsWith("(")) {
    return `(${trimmed})`;
  }
  return trimmed;
}

// "20260611T023000Z" -> "2026-06-11T02:30:00Z"
function seendateToIso(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// GDELT titles come back with erratic spacing ("IPO : Valuations , ...") and
// the same story syndicates across many domains -> normalize aggressively.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchGdeltItems(
  query: string,
  opts?: { limit?: number; timespan?: string }
): Promise<FetchResult> {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 250);
  const timespan = opts?.timespan ?? DEFAULT_TIMESPAN;

  if (!query.trim()) {
    return { ok: false, error: "GDELT: query must be a non-empty string.", items: [] };
  }

  const q = `${prepareQuery(query)} sourcelang:english`;
  const url =
    `${ENDPOINT}?query=${encodeURIComponent(q)}` +
    `&mode=artlist&format=json&maxrecords=${limit}` +
    `&timespan=${encodeURIComponent(timespan)}&sort=datedesc`;

  let text: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "s2-signal", Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    text = await res.text();
    if (!res.ok) {
      const detail =
        res.status === 429
          ? "rate limited (GDELT allows ~1 request per 5 seconds); retry after a pause"
          : stripHtml(text).slice(0, 200) || res.statusText;
      return { ok: false, error: `GDELT: HTTP ${res.status} — ${detail}`, items: [] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `GDELT: request failed — ${msg}`, items: [] };
  }

  // GDELT returns plain-text error prose (sometimes with HTTP 200) on
  // malformed queries — surface it instead of throwing on parse.
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const hint = stripHtml(text).slice(0, 200) || "empty body";
    return {
      ok: false,
      error: `GDELT: non-JSON response (likely bad query syntax) — ${hint}`,
      items: [],
    };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "GDELT: unexpected response shape.", items: [] };
  }

  // Zero results -> `{}` with no `articles` key.
  const articles = (data as { articles?: unknown }).articles;
  if (articles === undefined) return { ok: true, items: [] };
  if (!Array.isArray(articles)) {
    return { ok: false, error: "GDELT: `articles` is not an array.", items: [] };
  }

  const seen = new Set<string>();
  const items: RawItem[] = [];

  for (const raw of articles as GdeltArticle[]) {
    if (items.length >= limit) break;
    const title = typeof raw.title === "string" ? stripHtml(raw.title) : "";
    const articleUrl = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!title || !articleUrl) continue;

    const key = normalizeTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
    const date =
      typeof raw.seendate === "string" ? seendateToIso(raw.seendate) : undefined;

    const item: RawItem = {
      title,
      url: articleUrl,
      source: domain || "GDELT",
    };
    if (date) item.date = date;
    if (domain) item.meta = { domain };
    items.push(item);
  }

  return { ok: true, items };
}
