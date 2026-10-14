// Hacker News discovery source via the Algolia Search API (free, keyless).
// Endpoint verified live: https://hn.algolia.com/api/v1/search
// (relevance-ranked; recency is enforced via numericFilters created_at_i).

import type { FetchResult, RawItem } from "./types";

const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
const HN_ITEM_URL = "https://news.ycombinator.com/item?id=";

interface HNHit {
  title?: unknown;
  url?: unknown;
  objectID?: unknown;
  created_at?: unknown;
  story_text?: unknown;
  points?: unknown;
  num_comments?: unknown;
}

/** Strip HTML tags and decode the entities Algolia emits in story_text. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchHNItems(
  query: string,
  opts?: { minPoints?: number; limit?: number; days?: number }
): Promise<FetchResult> {
  const minPoints = opts?.minPoints ?? 10;
  const limit = opts?.limit ?? 20;
  const days = opts?.days ?? 14;

  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const params = new URLSearchParams({
    query,
    tags: "story",
    numericFilters: `created_at_i>${cutoff},points>=${minPoints}`,
    hitsPerPage: String(Math.min(Math.max(limit, 1), 100)),
  });

  try {
    const res = await fetch(`${HN_SEARCH_URL}?${params.toString()}`, {
      headers: {
        "User-Agent": "s2-signal",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `HN Algolia API returned HTTP ${res.status}; check query/params or retry later (limit: 10k req/hour/IP)`,
        items: [],
      };
    }

    const data = (await res.json()) as { hits?: unknown };
    if (!Array.isArray(data.hits)) {
      return {
        ok: false,
        error: "HN Algolia response missing 'hits' array; API shape may have changed",
        items: [],
      };
    }

    const items: RawItem[] = [];
    for (const raw of data.hits) {
      if (items.length >= limit) break;
      const hit = raw as HNHit;

      const title = typeof hit.title === "string" ? hit.title.trim() : "";
      if (!title) continue;

      // Ask/Show text posts often have no url; fall back to the HN item page.
      const id =
        typeof hit.objectID === "string" || typeof hit.objectID === "number"
          ? String(hit.objectID)
          : "";
      const storyUrl =
        typeof hit.url === "string" && hit.url.trim()
          ? hit.url.trim()
          : id
            ? `${HN_ITEM_URL}${id}`
            : "";
      if (!storyUrl) continue;

      const item: RawItem = { title, url: storyUrl, source: "Hacker News" };

      if (typeof hit.created_at === "string" && hit.created_at) {
        item.date = hit.created_at;
      }

      if (typeof hit.story_text === "string" && hit.story_text) {
        const snippet = stripHtml(hit.story_text);
        if (snippet) {
          item.snippet =
            snippet.length > 500 ? `${snippet.slice(0, 500)}…` : snippet;
        }
      }

      const meta: Record<string, number> = {};
      if (typeof hit.points === "number") meta.points = hit.points;
      if (typeof hit.num_comments === "number") meta.comments = hit.num_comments;
      if (Object.keys(meta).length > 0) item.meta = meta;

      items.push(item);
    }

    return { ok: true, items };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === "TimeoutError"
        ? "request timed out after 10s"
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `HN Algolia fetch failed: ${msg}`, items: [] };
  }
}
