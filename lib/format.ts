export function timeAgo(dateISO: string): string {
  if (!dateISO) return "";
  const then = new Date(dateISO).getTime();
  if (Number.isNaN(then)) return dateISO;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return new Date(dateISO).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const days = Math.floor(diffMs / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Short calendar date from an epoch-ms timestamp, e.g. "Jun 15, 2026". */
export function fmtDate(ms: number): string {
  if (!ms || Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtUSD(n: number): string {
  if (!n) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

export function fmtNum(n: number): string {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toString();
}

/**
 * Strip the AI-writing "tell" of em/en dashes from generated outreach.
 * Em dash (—) acts as a clause separator → comma; en dash (–) → hyphen.
 * Deterministic so it catches dashes even when the model ignores the prompt.
 */
export function stripEmDashes(text: string): string {
  if (!text) return text;
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, "-")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Strip Markdown syntax the model sometimes emits (bold, headings, code ticks,
 * `---` rules) so it doesn't show up as literal **asterisks** / dashes in a
 * plain-text destination like a HubSpot task note.
 */
export function stripMarkdown(text: string): string {
  if (!text) return text;
  return text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`+/g, "")
    .replace(/(^|\n)[ \t]*([-*=_]){3,}[ \t]*(?=\n|$)/g, "$1") // horizontal rules
    .replace(/(^|\n)#{1,6}[ \t]+/g, "$1") // headings
    .replace(/[ \t]{2,}/g, " ");
}

/**
 * Turn a plain-text note (with `\n` line breaks and "LABEL:" lines) into clean
 * HTML for HubSpot's rich-text task body, which otherwise collapses whitespace
 * into one wall of text. Strips markdown + em dashes and bold-faces leading
 * ALL-CAPS labels (WHO:, COMPANY:, SIGNAL:, …) and "Subject:".
 */
export function plainToHtml(text: string): string {
  const clean = stripEmDashes(stripMarkdown(text || "")).trim();
  if (!clean) return "";
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmtLine = (line: string) => {
    const m = line.match(/^([A-Z][A-Z ]{1,30}|Subject):(.*)$/);
    return m ? `<strong>${esc(m[1])}:</strong>${esc(m[2])}` : esc(line);
  };
  return clean
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split("\n").map(fmtLine).join("<br>")}</p>`)
    .join("");
}
