// Company-name normalization — THE canonical key for anything keyed by company
// name (prospected marks, scores, blurbs, blacklist, sync events).
//
// Extracted from lib/clientStore.ts (a "use client" module) so SERVER code —
// the sync-event writer, the seed script's TS twin — normalizes identically.
// Two spellings normalizing differently is exactly the class of bug that made
// orange marks vanish across feed/brief name drift; one function, one place.

// Company names arrive from sources that spell the SAME company differently:
// the Apollo sweep ("Instabug") vs the live-research brief ("Instabug, Inc.").
// Strip punctuation + common legal suffixes so keys match across all of them.
const COMPANY_SUFFIX =
  /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|gmbh|plc|sa|ag|nv|bv|pte|pvt|private|holdings)\b/g;

export function normCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(COMPANY_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
