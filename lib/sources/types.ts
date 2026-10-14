// Shared contract for free discovery sources (Hacker News, GitHub, GDELT,
// RSS). Fetchers return raw candidate items for ~$0; a single cheap Claude
// call (no web_search) then filters, extracts the company, and scores them
// into Signals. Fetchers NEVER throw and never fabricate fields.

export interface RawItem {
  title: string;
  url: string;
  /** Human-readable source, e.g. "Hacker News", "GitHub", "TechCrunch". */
  source: string;
  /** ISO date when known. */
  date?: string;
  /** Description / excerpt / readme blurb when the source provides one. */
  snippet?: string;
  /** Source-specific extras (stars, points, org, domain…). */
  meta?: Record<string, string | number>;
}

export interface FetchResult {
  ok: boolean;
  error?: string;
  items: RawItem[];
}
