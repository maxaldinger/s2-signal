// Generic RSS/Atom feed fetcher (zero deps). Verified live against
// https://techcrunch.com/category/venture/feed/ (the old fundings-exits slug
// now returns an HTML 404 page — with an rss+xml content-type — so we sniff
// the body, never the header) and https://xkcd.com/atom.xml.
import type { FetchResult, RawItem } from "./types";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function fromCodePointSafe(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => fromCodePointSafe(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// CDATA first (raw HTML inside), then decode (Atom escapes its HTML), then strip.
function cleanText(raw: string): string {
  return stripHtml(decodeEntities(unwrapCdata(raw)));
}

function tagContent(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : undefined;
}

// Atom <link href="..." rel="alternate"/> — prefer alternate, else first href.
function atomLinkHref(block: string): string | undefined {
  let fallback: string | undefined;
  for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attrs = m[1] ?? "";
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const rel = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    if (!rel || rel[1] === "alternate") return href[1];
    fallback = fallback ?? href[1];
  }
  return fallback;
}

function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(decodeEntities(unwrapCdata(raw)).trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export async function fetchRssItems(
  feedUrl: string,
  opts?: { limit?: number }
): Promise<FetchResult> {
  const limit = opts?.limit ?? 20;
  try {
    const res = await fetch(feedUrl, {
      headers: {
        "User-Agent": "s2-signal",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Feed request failed: HTTP ${res.status} for ${feedUrl}`,
        items: [],
      };
    }

    const xml = (await res.text()).replace(/^﻿/, "").trim();
    const start = xml.slice(0, 2048).toLowerCase();
    if (start.startsWith("<!doctype html") || start.startsWith("<html")) {
      return { ok: false, error: `Got an HTML page, not a feed: ${feedUrl}`, items: [] };
    }
    const isRss = /<rss[\s>]|<rdf:rdf[\s>]/i.test(xml);
    const isAtom = !isRss && /<feed[\s>]/i.test(xml);
    if (!isRss && !isAtom) {
      return { ok: false, error: `Response is not RSS or Atom XML: ${feedUrl}`, items: [] };
    }

    const blockRe = isRss
      ? /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
      : /<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi;
    const blocks = xml.match(blockRe) ?? [];

    // Feed title = first <title> before any item/entry; hostname as fallback.
    const firstBlockAt = xml.search(/<item[\s>]|<entry[\s>]/i);
    const header = firstBlockAt > 0 ? xml.slice(0, firstBlockAt) : xml;
    const feedTitle = cleanText(tagContent(header, "title") ?? "");
    const source = feedTitle || new URL(feedUrl).hostname;

    const items: RawItem[] = [];
    for (const block of blocks) {
      if (items.length >= limit) break;

      const title = cleanText(tagContent(block, "title") ?? "");
      const rawLink = isRss
        ? tagContent(block, "link")
        : atomLinkHref(block) ?? tagContent(block, "link");
      const url = rawLink ? decodeEntities(unwrapCdata(rawLink)).trim() : "";
      if (!title || !/^https?:\/\//i.test(url)) continue;

      const date = isRss
        ? toIsoDate(tagContent(block, "pubDate") ?? tagContent(block, "dc:date"))
        : toIsoDate(tagContent(block, "published") ?? tagContent(block, "updated"));

      const rawSnippet = isRss
        ? tagContent(block, "description")
        : tagContent(block, "summary") ?? tagContent(block, "content");
      const snippet = rawSnippet ? truncate(cleanText(rawSnippet), 280) : undefined;

      const item: RawItem = { title, url, source };
      if (date) item.date = date;
      if (snippet) item.snippet = snippet;
      items.push(item);
    }

    return { ok: true, items };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = e instanceof Error && e.name === "TimeoutError"
      ? "timed out after 10s"
      : msg;
    return { ok: false, error: `RSS fetch failed for ${feedUrl}: ${hint}`, items: [] };
  }
}
