// SingleStore-fit priors for the Signal 2000 directory.
//
// The directory seed is a public list of the ~2,000 largest US companies
// (name, domain, headcount, Fortune industry). Its original segment and
// strength values were tuned to a different product, so they're remapped here
// to SingleStore's ICP before anything reads them:
//
//   segment  — Fortune industry → SingleStore target segment
//   strength — a SORTING PRIOR (0-99), not a score: segment data-intensity
//              (transaction volume, event/telemetry streams, customer-facing
//              analytics, real-time decisioning) plus a size adjustment.
//
// The real, evidence-based ICP score comes from the intel brief, which
// supersedes this prior once an account has been researched.

import type { DirectoryEntry, SegmentId } from "./types";

/** How data-intensive a segment's core workloads typically are. */
const SEGMENT_PRIOR: Record<SegmentId, number> = {
  adtech: 82,
  cybersecurity: 82,
  fintech: 80,
  marketplace: 80,
  ai: 80,
  saas: 78,
  telecom: 78,
  media: 76,
  logistics: 72,
  retail: 72,
  health: 68,
  industrial: 66,
  enterprise: 62,
};

/** Fortune industry labels that map to a sharper segment than the seed had. */
const INDUSTRY_SEGMENT: [RegExp, SegmentId][] = [
  [/telecommunications|network and other communications/i, "telecom"],
  [/advertising|marketing/i, "adtech"],
  [/internet services and retailing/i, "marketplace"],
  [/entertainment|publishing|hotels, casinos/i, "media"],
  [/financial data services|securities|commercial banks|diversified financials|insurance/i, "fintech"],
  [/airlines|railroads|trucking|transportation|mail, package|motor vehicles|automotive/i, "logistics"],
  [/aerospace and defense/i, "industrial"],
  [/computer software|information technology services/i, "saas"],
];

/** Segment ids that no longer exist in the SingleStore taxonomy. */
const RETIRED: Record<string, SegmentId> = {
  devtools: "saas",
  auto: "logistics",
  defense: "industrial",
};

export function s2Segment(e: Pick<DirectoryEntry, "segment" | "shortBrief">): SegmentId {
  const industry = (e.shortBrief ?? "").split(" · ")[0];
  for (const [re, seg] of INDUSTRY_SEGMENT) if (re.test(industry)) return seg;
  const seg = String(e.segment);
  return RETIRED[seg] ?? (seg in SEGMENT_PRIOR ? (seg as SegmentId) : "enterprise");
}

export function s2Prior(segment: SegmentId, employees?: number): number {
  let s = SEGMENT_PRIOR[segment] ?? 62;
  if (typeof employees === "number") {
    if (employees >= 100_000) s += 6;
    else if (employees >= 20_000) s += 4;
    else if (employees >= 5_000) s += 2;
    else if (employees < 1_000) s -= 4;
  }
  return Math.max(0, Math.min(95, s));
}

/** Remap one seed row to SingleStore's taxonomy and fit prior. */
export function toS2Directory(e: DirectoryEntry): DirectoryEntry {
  const segment = s2Segment(e);
  return { ...e, segment, strength: s2Prior(segment, e.estimatedEmployees) };
}
