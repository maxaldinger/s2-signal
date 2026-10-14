// Thin wrapper around the Anthropic Messages API with the web_search server tool.
//
// We talk to the API over plain fetch (no SDK) so the bundle stays tiny and
// the route deploys cleanly as a Vercel function. The model is asked to ground
// every answer in web_search results — we never fall back to fabricated data.

import type { LiveCitation } from "./types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Sep 2026 list prices, per MTok in/out: Sonnet 5 $2/$10, Sonnet 4.6 $3/$15,
// Haiku 4.5 $1/$5; web search is $10 per 1,000 searches on top. Sonnet 5 is
// the cheapest Sonnet-class model and the current one, so it is the default
// for the research-grade calls (briefs, on-demand sections, proposals, rep
// chat). Its tokenizer counts ~30% more tokens than 4.6 for the same text, so
// the net saving on tokens is ~13%; the larger saving is the prompt caching
// below. ANTHROPIC_MODEL overrides this (a stale override pins the old price).
const DEFAULT_MODEL = "claude-sonnet-5";
// Cheaper, faster model for high-volume, structured, low/no-search calls
// (signal grading, card signals and blurbs, ICP classification, openers).
// Override with ANTHROPIC_MODEL_FAST; callers opt in via opts.model = FAST_MODEL.
export const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST?.trim() || "claude-haiku-4-5";

export type Effort = "low" | "medium" | "high";
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
// Effort (output_config.effort) applies to every output token and, in a
// tool loop, to how many tool calls the model makes. Sonnet 5 defaults to
// high; medium is its documented cost step-down and matches Sonnet 4.6 at
// high, the level every prompt here was written against. ANTHROPIC_EFFORT
// overrides it (low = fewer, terser searches and output).
const DEFAULT_EFFORT: Effort = (() => {
  const e = process.env.ANTHROPIC_EFFORT?.trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(e ?? "") ? (e as Effort) : "medium";
})();

// Per-model request shape (Sep 2026 docs). A wrong guess is not fatal: a 400
// that names one of these fields is retried once without it (see below).
// Sonnet 5, Opus 4.7+ and the Fable/Mythos line reject any non-default
// temperature on every request; Haiku 4.5, Sonnet 4.6/4.5, Opus 4.6/4.5 accept it.
const acceptsTemperature = (m: string) => /haiku|sonnet-4|opus-4-[56](?:-|$)/i.test(m);
// Sonnet 5 and Opus 5 think by default (billed as output tokens) and accept
// thinking: disabled. Opus 5.5 / Fable / Mythos cannot switch it off.
const thinksByDefault = (m: string) => /^claude-(?:sonnet-5|opus-5)(?:-\d{8})?$/i.test(m);
// Effort is supported on Sonnet 5, Sonnet 4.6, Opus 4.5+, Fable and Mythos; not Haiku.
const acceptsEffort = (m: string) => /sonnet-5|sonnet-4-6|opus-(?:4-[5-8]|5)|fable|mythos/i.test(m);
const OPTIONAL_FIELDS = ["cache_control", "output_config", "thinking", "temperature"] as const;

export interface AnthropicCallOptions {
  system: string;
  user: string;
  /**
   * Model override for this call. Defaults to ANTHROPIC_MODEL / Sonnet. Pass
   * FAST_MODEL for cheap structured/grading work.
   */
  model?: string;
  // Optional prior assistant/user history.
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * Attach the web_search tool (default true). Set false for pure
   * reasoning/grading calls — they bill only tokens, no $10/1K searches.
   */
  webSearch?: boolean;
  // Max searches the model may issue (default 5).
  maxSearches?: number;
  // Allow/block search domains.
  allowedDomains?: string[];
  blockedDomains?: string[];
  // Token cap for the model's reasoning + output. Defaults are generous so the
  // model can browse, summarize, and emit structured JSON in one shot.
  maxTokens?: number;
  /** Sampling temperature. Sent only to models that accept one (see
   *  acceptsTemperature); Sonnet 5 rejects it, so there it is silently omitted. */
  temperature?: number;
  /** Effort level for models that support it (default: ANTHROPIC_EFFORT or medium). */
  effort?: Effort;
  /**
   * Prompt caching (top-level automatic cache_control). Default: ON whenever
   * web search is on. With a cache marker present the API also places a
   * breakpoint after every server-tool result, so each search iteration reads
   * the growing prefix at 0.1x instead of re-buying it at full price; without
   * the marker there is no such breakpoint, and a six-search brief pays for
   * its context seven times over. Default OFF for single-shot no-search calls,
   * where a 5-minute cache write costs 1.25x and nothing follows to read it.
   */
  cache?: boolean;
}

/** Token accounting for one call, as billed (see the pricing note above). */
export interface AnthropicUsage {
  model: string;
  /** Input tokens bought at the base price (not served from cache). */
  inputTokens: number;
  /** Tokens written to the prompt cache this call (1.25x base). */
  cacheWriteTokens: number;
  /** Tokens read from the prompt cache (0.1x base). */
  cacheReadTokens: number;
  outputTokens: number;
  searches: number;
  ms: number;
  /** "off" when thinking was explicitly disabled, "default" otherwise. */
  thinking: "off" | "default";
  /** Effort sent, or undefined on models that do not take it. */
  effort?: Effort;
}

export interface AnthropicCallResult {
  text: string;             // concatenated text content
  citations: LiveCitation[]; // dedupe-by-url citations from web_search
  searchCount: number;       // how many searches the model actually issued
  /** error codes from failed web_search invocations (e.g. "max_uses_exceeded"). */
  searchErrors: string[];
  /** true when the response was cut off (stop_reason max_tokens / pause_turn). */
  truncated: boolean;
  stopReason: string | null;
  usage: AnthropicUsage;
  raw: unknown;              // pass-through for debugging
}

/**
 * Remove citation markup the model sometimes bakes into output as literal
 * text (e.g. `<cite index="21-1,21-3">…</cite>`). The structured citation
 * system only attaches to plain-text blocks, so when the model writes JSON it
 * can imitate the markup inside string values — which would otherwise render
 * raw in the UI.
 */
export function stripCiteMarkup(s: string): string {
  return s
    .replace(/<\/?(?:antml:)?cite[^>]*>/gi, "")
    .replace(/ {2,}/g, " ");
}

/** Every balanced {…} or […] span in `s`, outermost only, largest first.
 *
 *  Brace matching is string-aware: a `{` inside a JSON string value (a company
 *  blurb, a rationale, an outreach line) must not open a nesting level, and an
 *  escaped quote must not close the string.
 *
 *  This exists because first-`{`-to-last-`}` is wrong whenever the model says
 *  anything at all around its JSON. With web_search on, it usually does: the
 *  response is a run of text blocks, joined here, where the earlier ones are
 *  research commentary and only the last is the brief. One stray brace in that
 *  commentary and the slice spans from prose into the object, parses as
 *  nothing, and the whole research pass is reported as "no parseable brief". */
function balancedSpans(s: string): string[] {
  const spans: { text: string; len: number }[] = [];
  const pairs: Record<string, string> = { "{": "}", "[": "]" };
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "{" && open !== "[") continue;
    const close = pairs[open];
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          spans.push({ text: s.slice(i, j + 1), len: j + 1 - i });
          i = j; // outermost only — don't re-scan the nested objects
          break;
        }
      }
    }
  }
  return spans.sort((a, b) => b.len - a.len).map((x) => x.text);
}

/** Minimal, string-aware repair for model JSON: escapes raw control
 *  characters (newline, tab, ...) that sit INSIDE string literals, and drops
 *  trailing commas before } or ]. Both are invalid JSON that a model emits
 *  occasionally; neither changes the meaning of a well-formed document, which
 *  passes through unchanged. */
function repairJSON(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        out += ch;
      } else if (ch === "\\") {
        esc = true;
        out += ch;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      // Trailing comma: the next non-space character closes the container.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through to the repaired form */
  }
  try {
    return JSON.parse(repairJSON(s)) as T;
  } catch {
    return undefined;
  }
}

/** Pull the model's JSON out of a response that may carry prose around it.
 *  Tries the whole string, then every balanced span largest-first; each
 *  candidate is tried as-is and then once repaired (see repairJSON). */
export function extractJSON<T = unknown>(text: string): T | null {
  if (!text) return null;
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const whole = tryParse<T>(candidate);
  if (whole !== undefined) return whole;
  for (const span of balancedSpans(candidate)) {
    const parsed = tryParse<T>(span);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/** For logs when extractJSON returns null: whether the text holds a JSON
 *  attempt at all, and if so the parse error and ~80 characters around it. */
export function diagnoseJSON(text: string): { attempted: boolean; detail: string } {
  const spans = balancedSpans(text.trim());
  const largest = spans[0];
  if (!largest || largest.length < 200) return { attempted: false, detail: "no JSON object in the text" };
  try {
    JSON.parse(repairJSON(largest));
    return { attempted: true, detail: "largest span parses after repair" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const pos = Number(msg.match(/position (\d+)/)?.[1]);
    const ctx = Number.isFinite(pos) ? JSON.stringify(largest.slice(Math.max(0, pos - 40), pos + 40)) : "";
    return { attempted: true, detail: `${msg}${ctx ? ` near ${ctx}` : ""}` };
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  citations?: {
    type?: string;
    url?: string;
    title?: string;
    cited_text?: string;
  }[];
  // For web_search_tool_result blocks:
  content?:
    | {
        type: "web_search_result";
        url?: string;
        title?: string;
        page_age?: string;
      }[]
    | { type: "web_search_tool_result_error"; error_code?: string };
  name?: string;
  input?: { query?: string };
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
}

/**
 * Single round-trip to Anthropic Messages with the web_search tool enabled.
 *
 * Returns the model's concatenated text output plus an extracted, deduplicated
 * citation list pulled both from inline `citations` and `web_search_tool_result`
 * blocks. Throws on transport / auth / quota failures so route handlers can
 * surface a precise error to the UI.
 */
export async function callClaudeWithWebSearch(
  opts: AnthropicCallOptions,
): Promise<AnthropicCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it in Vercel project settings (or .env.local for dev).",
    );
  }

  const model = opts.model?.trim() || process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const maxUses = Math.max(
    1,
    Math.min(
      10,
      opts.maxSearches ?? Number(process.env.ANTHROPIC_WEB_SEARCH_MAX || 5),
    ),
  );

  const messages: { role: "user" | "assistant"; content: string }[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.user },
  ];

  const tool: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
  };
  if (opts.allowedDomains?.length) tool.allowed_domains = opts.allowedDomains;
  if (opts.blockedDomains?.length) tool.blocked_domains = opts.blockedDomains;

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages,
  };
  if (acceptsTemperature(model)) body.temperature = opts.temperature ?? 0.4;
  // Reasoning off: nothing here needs a scratchpad (research extraction into
  // a fixed schema, grading, drafting), and thinking tokens bill as output.
  const thinkingOff = thinksByDefault(model);
  if (thinkingOff) body.thinking = { type: "disabled" };
  const effort = acceptsEffort(model) ? (opts.effort ?? DEFAULT_EFFORT) : undefined;
  if (effort) body.output_config = { effort };
  if (opts.webSearch !== false) body.tools = [tool];
  const cache = opts.cache ?? opts.webSearch !== false;
  if (cache) body.cache_control = { type: "ephemeral" };

  const post = (b: Record<string, unknown>) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Org-level keys (not scoped to one workspace) must name the workspace.
        ...(process.env.ANTHROPIC_WORKSPACE_ID?.trim()
          ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() }
          : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(b),
    });

  const t0 = Date.now();
  let res = await post(body);
  if (res.status === 400) {
    // A model that rejects one of the optional knobs (a different default via
    // ANTHROPIC_MODEL, an API change) must still answer: drop exactly the
    // fields the error names and retry once, rather than fail the call.
    const errText = await res.clone().text().catch(() => "");
    const dropped = OPTIONAL_FIELDS.filter((k) => k in body && new RegExp(k, "i").test(errText));
    if (dropped.length) {
      const retry = { ...body };
      for (const k of dropped) delete retry[k];
      res = await post(retry);
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const snippet = errText.slice(0, 320).replace(/\s+/g, " ");
    if (res.status === 401) {
      throw new Error(
        "Anthropic API key invalid or revoked. Update ANTHROPIC_API_KEY and redeploy.",
      );
    }
    if (res.status === 400 && /anthropic-workspace-id/i.test(errText)) {
      throw new Error(
        "This Anthropic API key is org-level (not scoped to a workspace). Set ANTHROPIC_WORKSPACE_ID in .env.local, or use a workspace-scoped key.",
      );
    }
    if (res.status === 403 && /web_search|tool/i.test(errText)) {
      throw new Error(
        "Web search is not enabled for this Anthropic workspace. Enable it in the Anthropic Console → Settings → Privacy.",
      );
    }
    throw new Error(`Anthropic ${res.status}: ${snippet || res.statusText}`);
  }

  const data: AnthropicResponse = await res.json();
  const out = extractFromResponse(data, model, Date.now() - t0, thinkingOff ? "off" : "default", effort);
  // One line per call in the function logs, so spend can be reviewed by route
  // and the cache confirmed to be engaging (cacheRead > 0 on search calls).
  // Never logs prompt content.
  const u = out.usage;
  console.log(
    `[anthropic] ${u.model} think=${u.thinking} effort=${u.effort ?? "-"} in=${u.inputTokens} cacheWrite=${u.cacheWriteTokens} cacheRead=${u.cacheReadTokens} out=${u.outputTokens} searches=${u.searches} stop=${out.stopReason ?? "?"} ${u.ms}ms`,
  );
  return out;
}

function extractFromResponse(
  data: AnthropicResponse,
  model: string,
  ms: number,
  thinking: "off" | "default",
  effort: Effort | undefined,
): AnthropicCallResult {
  const blocks = Array.isArray(data.content) ? data.content : [];

  // 1. Concatenate the model's spoken text (cite markup stripped — see
  //    stripCiteMarkup; it would otherwise leak into UI strings and JSON).
  //    Consecutive text blocks are ONE continuous text that the API split at
  //    citation boundaries ("Based on the search results, " + the cited
  //    span), so they join with no separator. A newline goes only where a
  //    tool block sits between two runs of text. Joining every block with
  //    "\n" put raw newlines inside JSON string values wherever the model
  //    cited mid-string: Sonnet 5 does, and 10 of 22 briefs failed to parse.
  let joined = "";
  let prevText = false;
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      if (joined && !prevText) joined += "\n";
      joined += b.text;
      prevText = true;
    } else {
      prevText = false;
    }
  }
  const text = stripCiteMarkup(joined.trim());

  // 2. Citations come from two places:
  //    - inline `citations` arrays on text blocks, and
  //    - the bulk `web_search_tool_result` content arrays.
  const citationMap = new Map<string, LiveCitation>();
  const searchErrors: string[] = [];

  for (const block of blocks) {
    // 2a. inline citations
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (!c?.url) continue;
        const key = c.url;
        if (!citationMap.has(key)) {
          citationMap.set(key, {
            title: c.title || c.url,
            source: hostOf(c.url),
            url: c.url,
            kind: "other",
          });
        }
      }
    }
    // 2b. failed searches — record the error code instead of dropping it
    if (
      block.type === "web_search_tool_result" &&
      block.content &&
      !Array.isArray(block.content)
    ) {
      searchErrors.push(block.content.error_code ?? "unknown_search_error");
    }
    // 2c. raw search results
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (!("type" in r) || r.type !== "web_search_result") continue;
        const url = (r as { url?: string }).url;
        const title = (r as { title?: string }).title;
        const pageAge = (r as { page_age?: string }).page_age;
        if (!url) continue;
        if (!citationMap.has(url)) {
          citationMap.set(url, {
            title: title || url,
            source: hostOf(url),
            url,
            date: pageAge,
            kind: "other",
          });
        }
      }
    }
  }

  const stopReason = data.stop_reason ?? null;
  const searches = data.usage?.server_tool_use?.web_search_requests ?? 0;
  return {
    text,
    citations: Array.from(citationMap.values()),
    searchCount: searches,
    searchErrors,
    truncated: stopReason === "max_tokens" || stopReason === "pause_turn",
    stopReason,
    usage: {
      model,
      inputTokens: data.usage?.input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      searches,
      ms,
      thinking,
      effort,
    },
    raw: data,
  };
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
