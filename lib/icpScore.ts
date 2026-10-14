// ICP score arithmetic and segment guidance, shared by the brief route and
// the reconcile script.
//
// The model rates the five sub-scores (0-20 each) and the streaming bonus
// (0-10, only with evidence). The TOTAL is computed here, never taken from the
// model: a model-written total drifted from its own sub-scores (Coinbase's
// sub-scores summed to 92 while the saved total said 86).

import { SEGMENTS } from "./data";
import type { ICPScore } from "./types";

export const ICP_SUBSCORES = ["dataScale", "architectureComplexity", "realtimeWorkload", "scalingActivity", "aiWorkload"] as const;

/** A real number, not null / "" / NaN (Number(null) is 0, which is the trap). */
export function isScore(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Every sub-score present and numeric. */
export function subScoresComplete(icp: Partial<Record<(typeof ICP_SUBSCORES)[number], unknown>> | undefined): boolean {
  return Boolean(icp) && ICP_SUBSCORES.every((k) => isScore(icp![k]));
}

const bound = (v: unknown, hi: number) => (isScore(v) ? Math.max(0, Math.min(hi, Math.round(v))) : 0);

/** Sum of the five sub-scores plus the streaming bonus (when detected with
 *  evidence), capped at 99. */
export function computeIcpTotal(icp: Pick<ICPScore, (typeof ICP_SUBSCORES)[number]> & { streaming?: ICPScore["streaming"] }): number {
  const sub = ICP_SUBSCORES.reduce((n, k) => n + bound(icp[k], 20), 0);
  const s = icp.streaming;
  const bonus = s?.detected && String(s.evidence || "").trim() ? bound(s.bonus, 10) : 0;
  return Math.min(99, sub + bonus);
}

/** Segment definitions for the brief prompt, so the model chooses by meaning
 *  rather than by guessing from a bare list of ids. */
export const SEGMENT_GUIDE = [
  "SEGMENT — choose the ONE id whose definition best matches how the company makes money and where its data load comes from:",
  ...SEGMENTS.map((s) => `  ${s.id}: ${s.label}. ${s.blurb}`),
  "Tie-breakers: a security / observability / edge-network company is cybersecurity, not industrial. An online marketplace or delivery platform is marketplace, not retail. A customer-engagement, marketing or ad platform is adtech, not saas. Use industrial only for physical-world operators (IoT devices, manufacturing, energy). Use enterprise only when nothing else fits.",
].join("\n");
