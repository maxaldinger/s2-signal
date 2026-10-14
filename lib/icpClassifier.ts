// Contact pull & classification — Max Aldinger's spec, Aug 4 2026, retargeted
// to SingleStore's buying group (data platform / database / engineering).
//
// The problem this fixes, in his words: the pull returned eight CIOs per
// enterprise account with identical boilerplate rationale, badged everyone
// TARGET or ROUTER so the badge carried no information, and spent enrichment
// and email-verification credits on people who would never be worked.
//
// So exclusion happens BEFORE enrichment, deterministically, by title and by
// account. What survives gets one of three states, and UNRESOLVED is expected
// to be the common answer — the tool has to be willing to say it does not know.
//
// Scoring runs a page at a time on FAST_MODEL (Haiku) with web_search OFF: the
// spec forbids identical rationales across contacts, which is impossible when
// each call is blind to the others, and a page of ~30 concurrent calls is the
// burst shape that draws a 429.

import { callClaudeWithWebSearch, extractJSON, FAST_MODEL } from "./anthropic";

/** STAGE 4. Three live states plus the excluded bucket. Deliberately NOT a
 *  seniority ladder: QUALIFIED requires a named function or product surface,
 *  not a big title. */
export type ICPClass = "QUALIFIED" | "UNRESOLVED" | "ROUTER" | "EXCLUDED";
export type ICPConfidence = "high" | "medium" | "low";

/** Verdicts stored before Aug 4 2026 used the ANCHOR/TARGET/PASS vocabulary.
 *  Map them rather than leave cached briefs rendering blank badges.
 *  TARGET becomes UNRESOLVED, not QUALIFIED: "adjacent to the decision" is
 *  precisely the ambiguity the new spec wants stated out loud. */
const LEGACY_CLASS: Record<string, ICPClass> = {
  ANCHOR: "QUALIFIED",
  TARGET: "UNRESOLVED",
  ROUTER: "ROUTER",
  PASS: "EXCLUDED",
  UNSCORED: "UNRESOLVED",
};

export function normalizeClass(v: unknown): ICPClass {
  const s = String(v ?? "").toUpperCase();
  if (s === "QUALIFIED" || s === "UNRESOLVED" || s === "ROUTER" || s === "EXCLUDED") return s;
  return LEGACY_CLASS[s] ?? "UNRESOLVED";
}

/** Fixed vocabulary for WHY a contact landed where it did. Free prose is
 *  unauditable: two contacts get dropped for the same reason described two
 *  different ways, and a badge with no vocabulary behind it is decoration. */
export type ICPReasonCode =
  // STAGE 2 exclusions — deterministic, by title, before the model is consulted.
  | "EXEC_IT_SECURITY"
  | "INFRA_OPS"
  | "FIELD_CUSTOMER"
  | "DATA_ML_RESEARCH"
  | "PRODUCT_PROGRAM"
  | "NOT_ENGINEERING"
  // STAGE 1 exclusion — the whole account.
  | "HARDWARE_ACCOUNT"
  // Live states, assigned by the scorer.
  | "OWNS_APP_ENGINEERING"
  | "OWNS_DEV_PLATFORM"
  | "AMBIGUOUS_TITLE"
  | "NAMED_ROUTE"
  ;

export const REASON_LABEL: Record<ICPReasonCode, string> = {
  EXEC_IT_SECURITY: "security / compliance",
  INFRA_OPS: "ops / network / release",
  FIELD_CUSTOMER: "field / customer-facing",
  DATA_ML_RESEARCH: "data science / research",
  PRODUCT_PROGRAM: "product / program",
  NOT_ENGINEERING: "not technical",
  HARDWARE_ACCOUNT: "builds or sells its own database",
  OWNS_APP_ENGINEERING: "owns engineering / data budget",
  OWNS_DEV_PLATFORM: "owns the data platform",
  AMBIGUOUS_TITLE: "ambiguous title",
  NAMED_ROUTE: "named route to the buyer",
};

export interface ICPVerdict {
  classification: ICPClass;
  confidence: ICPConfidence;
  /** Owns (or directly controls) the data-infrastructure decision: the data
   *  platform, databases, or the engineering/data budget. Field name kept for
   *  stored verdicts. */
  ownsDevTooling: boolean;
  reason: string;
  recommendedAction: string;
  reasonCode: ICPReasonCode;
  /** STAGE 4 ROUTER requirement: who they would route you to, and why. A ROUTER
   *  without this is the lazy fallback the spec bans. */
  routesTo?: string;
  /** Tier came from the deterministic filter, not the model. */
  hardFiltered?: boolean;
  /** The call failed. `classification` is a placeholder, NOT a judgement. */
  failed?: boolean;
}

// ---------------------------------------------------------------------------
// STAGE 1 — ACCOUNT-LEVEL EXCLUSION
//
// Accounts where a SingleStore deal cannot happen: hyperscalers that build
// their own databases, and companies that SELL a competing database or data
// platform (and SingleStore itself). Checked before any contact is pulled, so
// an excluded account costs one string comparison instead of a page of Apollo
// results and a classifier pass. The code id stays HARDWARE_ACCOUNT for stored
// verdicts; its label says what it means now.
//
// A named division (e.g. a hyperscaler's retail arm buying for its own app) is
// pullable for that division only — hence `divisionOverride`.
// ---------------------------------------------------------------------------

/** Builds its data infrastructure internally, or sells a competing database;
 *  procurement is a wall either way. */
const BUILDS_INTERNALLY = [
  "meta",
  "facebook",
  "google",
  "alphabet",
  "amazon",
  "singlestore",
  "memsql",
  "snowflake",
  "databricks",
  "clickhouse",
  "mongodb",
];

// The HARDWARE-PRIMARY screen (a name list + an industry-category regex) is
// GONE (2026-08-12, Max). It contradicted the ICP head-on: the Signal 2000
// universe is mostly non-software companies with large engineering and data
// orgs, and "revenue comes from hardware" says nothing about how much data
// they run. The engineering-size gates elsewhere already handle scale.

export interface AccountExclusion {
  excluded: boolean;
  reason: string;
  code: "HARDWARE_ACCOUNT";
}

/**
 * STAGE 1. Decide whether to pull contacts for this account at all.
 * @param company  Account name.
 * @param context  Industry / segment / description text, when known.
 * @param division Set when the caller is deliberately targeting a software
 *   division of a hardware parent — that is pullable, for that division only.
 */
export function accountExcluded(
  company: string,
  context?: string,
  division?: string,
): AccountExclusion | undefined {
  const name = (company || "").toLowerCase();
  if (!name) return undefined;
  // A named software division overrides the parent's category. The spec allows
  // pulling those, scoped to the division.
  if (division && division.trim()) return undefined;
  void context; // industry text no longer screens accounts (see note above)

  const internal = BUILDS_INTERNALLY.find((h) => new RegExp(`\\b${h}\\b`).test(name));
  if (internal) {
    return {
      excluded: true,
      code: "HARDWARE_ACCOUNT",
      reason: `${company} builds its own data infrastructure or sells a competing database, so procurement is a wall.`,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// STAGE 2 — TITLE EXCLUSION
//
// "Never pull, enrich, or display anyone whose title matches these. No
// exceptions, no 'but this one might be different.'" Applied before the model,
// so an excluded contact costs nothing.
//
// Retargeted to SingleStore's buying group. Data engineering, data platform,
// databases, analytics, ML platform, CIO and Chief Data Officer are now the
// BUYERS and champions, so they are no longer excluded; SRE / DBA leads on hot
// OLTP clusters feel the pain first and pass through too. What stays excluded
// is everyone who never owns the database decision: security / compliance,
// release / CI-CD, network and embedded, field and customer-facing roles,
// data SCIENCE and research (they consume the platform), and product/program.
//
// Order matters: the first match wins, so the compound cases (Network DevOps,
// Cloud Operations vs Cloud Platform Engineering) sit ahead of the general ones.
// ---------------------------------------------------------------------------

// Explicitly ALLOWED even though a nearby phrase is excluded. Checked first.
// Cloud Platform Engineering is a buyer; Cloud Operations is not.
const TITLE_ALLOWLIST =
  /\bcloud\s+platform\s+engineering\b|\bplatform\s+engineering\b|\bdata\s+(?:platform|engineering|infrastructure|architect(?:ure)?)\b|\bdatabases?\b|\breal[-\s]?time\s+(?:analytics|data)\b|\b(?:ml|ai|machine\s+learning)\s+(?:platform|infrastructure)\b|\binfrastructure\s+engineering\b|\bapplication\s+engineering\b|\bsoftware\s+engineering\b|\bsite\s+reliability\b/i;

const HARD_EXCLUSIONS: Array<{ code: ICPReasonCode; re: RegExp; why: string }> = [
  {
    // Business functions that borrow a technical word ("Head of Infrastructure
    // Marketing", "VP, People (AI, Tech, Analytics)", "Chief Investment Officer
    // (CIO)"). Checked first so the technical word can't carry them through.
    code: "NOT_ENGINEERING",
    re: /\bmarketing\b|\bbrand\b|\bcommunications\b|\bpublic\s+relations\b|\bpeople\b|\bhuman\s+resources\b|\bhr\b|\btalent\b|\brecruit|\baccounting\b|\bcontroller\b|\btax\b|\btreasury\b|\blegal\b|\bcounsel\b|\bcorporate\s+development\b|\binvestor\s+relations\b|\binvestments?\b|\bpartnerships?\b/i,
    why: "A business function (marketing, people, finance, legal, corporate development, investment) that borrows a technical word. It never owns the database decision.",
  },
  {
    // Compound first: Network DevOps is infrastructure on both axes.
    code: "INFRA_OPS",
    re: /\bnetwork\s+(?:dev\s*ops|devops|sre|reliability|engineering|operations)\b/i,
    why: "Network engineering, not the data platform.",
  },
  {
    // Cloud OPERATIONS is excluded; Cloud PLATFORM ENGINEERING is allowed and
    // is caught by the allowlist above before this rule is reached.
    code: "INFRA_OPS",
    re: /\bcloud\s+(?:operations|ops)\b/i,
    why: "Cloud operations runs the estate; it does not choose the database behind the product.",
  },
  {
    code: "EXEC_IT_SECURITY",
    re: /\bciso\b|\bchief\s+(?:information\s+)?security\s+officer\b|\bchief\s+security\b|\binformation\s+security\b|\bcyber\b|\bsecurity\s+(?:engineer(?:ing)?|architect|operations|leadership)\b/i,
    why: "Security reviews the evaluation (encryption, audit, SOC 2 / PCI) but never owns the database purchase.",
  },
  {
    code: "EXEC_IT_SECURITY",
    re: /\bgrc\b|\bcompliance\b|\bchief\s+risk\b|\brisk\s+(?:management|officer|manager|analyst)\b|\baudit\b|\bprivacy\b/i,
    why: "Standards, risk and compliance sign-off. An influencer on the evaluation, with no data-platform budget.",
  },
  {
    code: "INFRA_OPS",
    re: /\bdev\s*ops\b|\bdevsecops\b|\bbuild\s*(?:&|and)\s*release\b|\brelease\s+engineering\b|\bci\s*\/?\s*cd\b/i,
    why: "DevOps / release budget is CI/CD and deployment pipelines, not the database serving layer.",
  },
  {
    code: "INFRA_OPS",
    re: /\bnetwork\b|\bwireless\b|\brf\b|\bradio\b|\bbroadband\b|\baccess\s+(?:network|engineering|technolog)|\bfiber\b|\bembedded\b|\bfirmware\b|\bhardware\b|\bsilicon\b/i,
    why: "Network / RF / embedded work, not the data platform.",
  },
  {
    code: "INFRA_OPS",
    re: /\bit\s+operations\b|\bservice\s+delivery\b|\bdata\s*cent(?:er|re)\b|\bit\s+infrastructure\b|\bend[-\s]?user\s+computing\b/i,
    why: "Runs the corporate IT estate, not the product's data platform.",
  },
  {
    code: "FIELD_CUSTOMER",
    re: /\bsolutions?\s+(?:architect|engineer|consult)|\bsolution\s+architect|\bsales\s+engineer|\bpre-?sales\b|\bfield\s+(?:engineer|experience|technolog|operations)|\bfield\b|\bcustomer\s+(?:engineer|success|experience)|\bclient\s+(?:engineer|partner)|\bprofessional\s+services\b|\btechnical\s+account\s+manage|\bsupport\s+engineer|\bsupport\b/i,
    why: "Customer-facing or pre-sales. Advisory against someone else's data stack.",
  },
  {
    code: "DATA_ML_RESEARCH",
    re: /\bdata\s+scien(?:ce|tist)s?\b|\bresearch\s+scien|\bapplied\s+scien|\bai\s+research\b|\bactuar(?:y|ial)\b|\bmodel\s+risk\b|\bquantitative\b|\bquant\b/i,
    why: "Builds models and analyses on top of the data platform. Consumes it, does not choose it.",
  },
  {
    code: "PRODUCT_PROGRAM",
    re: /\bproduct\s+(?:owner|manage|management|manager)\b|\btechnical\s+product\b|\bprogram\s+manage|\bscrum\b|\bagile\s+coach\b|\bgeneral\s+manager\b|\bbusiness\s+development\b|\bstrategy\b/i,
    why: "Owns process, roadmap or the P&L. Not the data platform.",
  },
];

// Anything technical or data at all. A title matching none of this is Finance,
// HR, Legal, Merchandising — the bulk a seniority sweep returns at a large
// enterprise. Two groups on purpose: acronyms need BOTH word boundaries or
// "ai" matches "Aircraft"; stems need only a leading one. FinOps / cloud-cost
// owners are influencers on warehouse and database spend, so they pass.
const TECHNICAL =
  /\b(?:cto|ctpo|cdo|cdao|cio|sre|dba|ml|ai|bi|finops)\b|\b(?:engineer|technolog|technical|software|platform|develop|architect|application|digital|data|analytic|infrastructure|observability|business\s+intelligence|machine\s+learning|cloud\s+cost|chief\s+(?:information|data|digital|analytics|ai)\s+officer)/i;

/**
 * STAGE 2. Deterministic exclusion by TITLE. Never consults a model.
 *
 * Title only, deliberately. A headline usually carries the employer ("VP
 * Engineering at Juniper Networks"), and /\bnetwork\b/ against that would screen
 * out every contact at Juniper, F5, Arista and Palo Alto.
 */
export function hardExclude(titles?: string): ICPVerdict | undefined {
  const t = (titles || "").trim();
  if (!t) return undefined;

  const pass = (code: ICPReasonCode, why: string): ICPVerdict => ({
    classification: "EXCLUDED",
    confidence: "high",
    ownsDevTooling: false,
    reason: why,
    recommendedAction: "skip",
    reasonCode: code,
    hardFiltered: true,
  });

  // The allowlist wins. "Director, Cloud Platform Engineering" contains
  // "cloud" and would otherwise be caught by the infra rules.
  if (TITLE_ALLOWLIST.test(t)) {
    // ...unless it ALSO carries an unambiguous disqualifier. "Solutions
    // Architect, Data Platform" is pre-sales wearing a platform label.
    const disqualified = HARD_EXCLUSIONS.find(
      (r) =>
        (r.code === "DATA_ML_RESEARCH" || r.code === "FIELD_CUSTOMER" || r.code === "NOT_ENGINEERING") && r.re.test(t),
    );
    if (!disqualified) return undefined;
    return pass(disqualified.code, disqualified.why);
  }

  for (const rule of HARD_EXCLUSIONS) {
    if (rule.re.test(t)) return pass(rule.code, rule.why);
  }
  if (!TECHNICAL.test(t)) {
    return pass(
      "NOT_ENGINEERING",
      "No technical or data scope in the title. A seniority sweep at a large enterprise returns Finance, HR, Legal and business leadership in bulk.",
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// STAGE 3 — RANK CORRECTION
// ---------------------------------------------------------------------------

/** Firms where "Vice President" is a rank near senior IC / first-line manager,
 *  not an executive. Meaningful ranks there: Managing Director, Executive
 *  Director, Head of [named function]. */
const VP_IS_A_RANK =
  /\b(?:blackrock|goldman|jpmorgan|jp morgan|morgan stanley|citi(?:group|bank)?|wells fargo|barclays|deutsche bank|ubs|credit suisse|hsbc|bank of america|merrill|nomura|jefferies|state street|bny mellon)\b/i;

export function vpIsARank(company?: string): boolean {
  return VP_IS_A_RANK.test(company || "");
}

// ---------------------------------------------------------------------------
// Queue + ordering
// ---------------------------------------------------------------------------

/** Everything that is not EXCLUDED reaches the review queue. */
export const QUEUE_CLASSES: ICPClass[] = ["QUALIFIED", "UNRESOLVED", "ROUTER"];

export const TIER_RANK: Record<ICPClass, number> = {
  QUALIFIED: 0,
  ROUTER: 1,
  UNRESOLVED: 2,
  EXCLUDED: 3,
};

/** Badge styling per state. Lives here so every surface shows the same one. */
export const TIER_STYLE: Record<ICPClass, string> = {
  QUALIFIED: "border border-neon-600/50 bg-neon-500/20 text-neon-200",
  ROUTER: "border border-amber-500/40 bg-amber-500/15 text-amber-300",
  UNRESOLVED: "border border-ink-700 bg-ink-800 text-ink-400",
  EXCLUDED: "border border-ink-700 bg-ink-800 text-ink-500",
};

export function isQueueWorthy(v?: ICPVerdict | null): boolean {
  return !!v && QUEUE_CLASSES.includes(v.classification);
}

// ---------------------------------------------------------------------------
// STAGE 6 — ACTION GATING
// ---------------------------------------------------------------------------

export interface AllowedActions {
  linkedin: boolean;
  draftEmail: boolean;
  hubspotTask: boolean;
  /** ROUTER gets "Who owns this?" in place of Draft email. */
  whoOwnsThis: boolean;
  /** UNRESOLVED must not show an address at all — the rationale says we do not
   *  know this is a buyer, so surfacing a verified address invites a send. */
  showEmail: boolean;
}

export function allowedActions(cls: ICPClass): AllowedActions {
  switch (cls) {
    case "QUALIFIED":
    case "UNRESOLVED":
      // Max, 2026-08-12: "don't treat unresolved any different than you would
      // qualified." UNRESOLVED is almost every contact on every pull — the
      // badge and the AMBIGUOUS-TITLE reason stay as a caution LABEL, but all
      // actions work. Locking the majority of results made the tool unusable.
      return { linkedin: true, draftEmail: true, hubspotTask: true, whoOwnsThis: false, showEmail: true };
    case "ROUTER":
      return { linkedin: true, draftEmail: false, hubspotTask: true, whoOwnsThis: true, showEmail: false };
    default:
      return { linkedin: false, draftEmail: false, hubspotTask: false, whoOwnsThis: false, showEmail: false };
  }
}

// ---------------------------------------------------------------------------
// STAGE 5 — RATIONALE RULES, enforced in code
// ---------------------------------------------------------------------------

/** Hedges dressed as analysis. Banned by name in the spec. */
const HEDGES = [
  /title alone does not\b/i,
  /title does not (?:confirm|establish)\b/i,
  /\blikely (?:influences|owns|reports)\b/i,
  /\bsuggests? (?:leadership|ownership|influence)\b/i,
  /\bmay report into\b/i,
  /\bcould (?:be|own|influence)\b/i,
  /\bappears? to (?:own|lead|influence)\b/i,
];

export const NO_EVIDENCE = "No evidence beyond title. Needs profile review.";

/** Replace a hedged rationale with the honest one. */
function deHedge(reason: string): string {
  const r = (reason || "").trim();
  if (!r) return NO_EVIDENCE;
  return HEDGES.some((h) => h.test(r)) ? NO_EVIDENCE : r;
}

/** Spec: "identical rationale text across two or more contacts" means the model
 *  is generating boilerplate. Every duplicate after the first is replaced. */
function dedupeRationales(verdicts: ICPVerdict[]): ICPVerdict[] {
  const seen = new Set<string>();
  return verdicts.map((v) => {
    const key = v.reason.trim().toLowerCase();
    if (!key || v.hardFiltered) return v;
    if (seen.has(key)) return { ...v, reason: NO_EVIDENCE };
    seen.add(key);
    return v;
  });
}

const SYSTEM = `You classify contacts at a target account for SingleStore, which sells a distributed SQL database for transactions, real-time analytics and vector search, bought out of a DATA INFRASTRUCTURE / ENGINEERING budget. The buying group: economic buyers (CTO, VP/SVP Engineering, CIO, Chief Data Officer, VP Data/Analytics); champions (heads and directors of data engineering, data platform, platform/infrastructure, database engineering/architecture, real-time analytics, ML/AI platform); people who feel the pain (staff/principal data engineers, database architects, DBAs and SREs on busy database clusters, engineers building customer-facing analytics or RAG); influencers (data and enterprise architects, FinOps / cloud-cost owners).

Contacts that match the hard exclusion list have already been removed before you see them. Do not re-litigate exclusions. Your job is the three live states.

THE THREE STATES. Every contact gets exactly one.

QUALIFIED — The title EXPLICITLY names ownership of the data platform, data engineering, databases, data infrastructure, real-time analytics or an ML/AI platform, OR it is an economic buyer whose title names engineering or data scope. It requires a named function or product surface, not seniority.
Qualifying examples: Head of Data Platform. Director of Data Engineering. VP Data & Analytics. Director, Database Engineering. Head of ML Platform. Chief Data Officer. SVP Engineering, Payments.
A big title with no named surface is NOT qualified.

UNRESOLVED — The title is ambiguous and cannot be settled from the string alone. THIS IS THE CORRECT ANSWER MOST OF THE TIME and you must be willing to say it. Do not upgrade an ambiguous title to QUALIFIED to seem useful.
Examples that are UNRESOLVED, not QUALIFIED: "Technical Director" (a hands-on engine owner in games, a program authority in aerospace, a delivery lead in consulting). "Head of Engineering" at a company you do not recognise. "Engineering Manager". "Director of Engineering" with no domain. "VP Technology". "Principal Engineer" with no domain. "Director of Analytics" (could own the analytics platform, or could be a business-reporting team).
Practitioners who feel the pain (a Staff Data Engineer, a DBA, an SRE) are UNRESOLVED unless the title names ownership; they are valuable, but they do not sign.

ROUTER — Genuinely useful as a path to the buyer, for a SPECIFIC stated reason. Not a fallback. You MUST name who they would route to and why, in the routes_to field. If you cannot name that, it is UNRESOLVED, not ROUTER. Influencers (a data architect, an enterprise architect who owns database standards, a FinOps lead who owns warehouse spend) are the usual ROUTER candidates.

DISTRIBUTION. A healthy account pull is MOSTLY UNRESOLVED, a few QUALIFIED, AT MOST ONE ROUTER. If you are about to give every contact the same state, you have not evaluated them. More than one ROUTER on an account means you are being lazy.

RANK CORRECTION. At BlackRock, Goldman Sachs, JPMorgan, Morgan Stanley, Citi, Wells Fargo and comparable financial institutions, "Vice President" is a rank roughly equivalent to senior IC or first-line manager, NOT an executive. Do not read it as seniority. The meaningful ranks there are Managing Director, Executive Director, and Head of [named function].

RATIONALE. Cite evidence. If the only input you have is a title string, say exactly that.
Allowed shapes:
  "No evidence beyond title. Needs profile review."
  "About section names ownership of [X] across [Y] systems."
  "Public post [date] describes [specific thing]."
BANNED, and rejected in code: "title alone does not confirm", "title does not establish", "likely influences", "suggests leadership of", "may report into". These are hedges dressed as analysis. If that is all you have, write "No evidence beyond title. Needs profile review." instead.
BANNED: the same rationale sentence on two contacts. Duplicates are replaced with "No evidence beyond title" automatically, so writing them wastes your output.

REASON CODE, one per contact, from this list and no other:
  OWNS_APP_ENGINEERING  economic buyer, or owns engineering for a named product surface (QUALIFIED)
  OWNS_DEV_PLATFORM     owns the data platform / data engineering / databases / data infrastructure / ML platform (QUALIFIED)
  AMBIGUOUS_TITLE       cannot be settled from the title (UNRESOLVED)
  NAMED_ROUTE           can route you to a named owner (ROUTER)

OUTPUT FORMAT
You are given a numbered list. Respond with ONLY a JSON array, no fences, one object per contact IN ORDER:
[
  {
    "n": 1,
    "state": "QUALIFIED" | "UNRESOLVED" | "ROUTER",
    "reason_code": "<one code from the list above>",
    "confidence": "high" | "medium" | "low",
    "owns_data_infra": true | false,
    "rationale": "<one or two sentences, evidence only, no hedges>",
    "routes_to": "<ROUTER only: who they route to and why, max 15 words. Omit otherwise>",
    "next_step": "<max 12 words>"
  }
]
Return exactly one object for every contact you were given.`;

interface RawVerdict {
  n?: unknown;
  state?: unknown;
  tier?: unknown;
  reason_code?: unknown;
  confidence?: unknown;
  owns_data_infra?: unknown;
  /** Pre-retrofit key, still read for cached responses. */
  owns_dev_tooling?: unknown;
  rationale?: unknown;
  routes_to?: unknown;
  next_step?: unknown;
}

const SCORER_CODES: ICPReasonCode[] = [
  "OWNS_APP_ENGINEERING",
  "OWNS_DEV_PLATFORM",
  "AMBIGUOUS_TITLE",
  "NAMED_ROUTE",
];

function codeForState(cls: ICPClass): ICPReasonCode {
  if (cls === "QUALIFIED") return "OWNS_APP_ENGINEERING";
  if (cls === "ROUTER") return "NAMED_ROUTE";
  return "AMBIGUOUS_TITLE";
}

function toVerdict(raw: RawVerdict | undefined): ICPVerdict {
  const rawState = raw?.state ?? raw?.tier;
  if (rawState === undefined || rawState === null || String(rawState).trim() === "") {
    return failedVerdict("Scorer returned no usable state for this contact");
  }
  const cls = normalizeClass(rawState);
  const conf = String(raw?.confidence ?? "").toLowerCase() as ICPConfidence;
  const rawCode = String(raw?.reason_code ?? "").toUpperCase() as ICPReasonCode;
  const routesTo = String(raw?.routes_to ?? "").trim().slice(0, 140) || undefined;
  // A ROUTER that cannot name where it routes is the lazy fallback the spec
  // bans. Demote rather than display it.
  const state: ICPClass = cls === "ROUTER" && !routesTo ? "UNRESOLVED" : cls;
  return {
    classification: state,
    confidence: ["high", "medium", "low"].includes(conf) ? conf : "low",
    ownsDevTooling: raw?.owns_data_infra === true || raw?.owns_dev_tooling === true,
    reason: deHedge(String(raw?.rationale ?? "")).slice(0, 300),
    recommendedAction: String(raw?.next_step ?? "").slice(0, 120),
    reasonCode: SCORER_CODES.includes(rawCode) ? rawCode : codeForState(state),
    routesTo: state === "ROUTER" ? routesTo : undefined,
  };
}

function failedVerdict(why: string): ICPVerdict {
  return {
    classification: "UNRESOLVED",
    confidence: "low",
    ownsDevTooling: false,
    reason: why,
    recommendedAction: "retry",
    reasonCode: "AMBIGUOUS_TITLE",
    failed: true,
  };
}

export interface ICPProfileInput {
  company?: string;
  headline?: string;
  titles?: string;
  description?: string;
  companySignals?: string;
}

function renderProfile(p: ICPProfileInput, n: number): string {
  return [
    `${n}. Company: ${p.company || "(unknown)"}`,
    `   Current title(s): ${p.titles || "(none)"}`,
    `   Scope / role description: ${p.description || "(none)"}`,
    vpIsARank(p.company)
      ? "   NOTE: at this firm 'Vice President' is a rank near senior IC, not an executive."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Score one page in a single call, so rationales are written against each
 *  other rather than in isolation. Never throws. */
async function scoreBatch(items: ICPProfileInput[]): Promise<ICPVerdict[]> {
  const context = items.find((i) => i.companySignals)?.companySignals;
  const user = [
    context ? `Account context (applies to all contacts below):\n${context}\n` : "",
    `Classify these ${items.length} contact${items.length === 1 ? "" : "s"}. Return exactly ${items.length} object${items.length === 1 ? "" : "s"} in order. Remember: mostly UNRESOLVED, a few QUALIFIED, at most one ROUTER.\n`,
    items.map((p, i) => renderProfile(p, i + 1)).join("\n\n"),
  ].join("\n");

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await callClaudeWithWebSearch({
        system: SYSTEM,
        user,
        model: FAST_MODEL,
        webSearch: false,
        maxTokens: Math.min(4000, 280 * items.length + 400),
        temperature: 0,
      });
      const arr = extractJSON<RawVerdict[]>(res.text);
      if (Array.isArray(arr) && arr.length > 0) {
        // Map by the model's own `n`. Positional fallback ONLY when the array is
        // exactly the right length — a short array would otherwise shift every
        // later verdict onto the wrong person.
        const aligned = arr.length === items.length;
        const mapped = items.map((_, i) => {
          const byN = arr.find((r) => Number(r?.n) === i + 1);
          if (byN) return toVerdict(byN);
          if (aligned) return toVerdict(arr[i]);
          return failedVerdict("Scorer omitted this contact from its response");
        });
        return dedupeRationales(mapped);
      }
      lastError = "scorer returned no JSON array";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 400)));
  }
  return items.map(() => failedVerdict(`Scorer unavailable (${lastError.slice(0, 80)})`));
}

export async function classifyProfile(p: ICPProfileInput): Promise<ICPVerdict> {
  const [v] = await classifyProfiles([p], (x) => x);
  return v ?? failedVerdict("Scorer returned nothing");
}

/** Classify many contacts. Hard exclusions run first and never reach the model,
 *  so an account full of DevOps, Security and Network titles costs almost nothing. */
export async function classifyProfiles<T>(
  items: T[],
  toInput: (item: T) => ICPProfileInput,
  batchSize = 10,
): Promise<ICPVerdict[]> {
  if (items.length === 0) return [];
  const inputs = items.map(toInput);

  const excluded = inputs.map((p) => hardExclude(p.titles));
  const survivors: { i: number; p: ICPProfileInput }[] = [];
  inputs.forEach((p, i) => {
    if (!excluded[i]) survivors.push({ i, p });
  });

  const out: ICPVerdict[] = excluded.map((v) => v ?? failedVerdict("Not classified"));
  if (survivors.length === 0) return out;

  const batches: { i: number; p: ICPProfileInput }[][] = [];
  for (let i = 0; i < survivors.length; i += batchSize) batches.push(survivors.slice(i, i + batchSize));
  const results = await Promise.all(batches.map((b) => scoreBatch(b.map((s) => s.p))));
  batches.forEach((batch, bi) => {
    batch.forEach((s, si) => {
      out[s.i] = results[bi][si] ?? failedVerdict("Scorer returned nothing for this contact");
    });
  });
  // Dedupe across the WHOLE page, not just within a batch — two batches can
  // independently produce the same sentence.
  return dedupeRationales(out);
}
