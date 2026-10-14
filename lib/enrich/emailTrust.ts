// Single source of truth for "is this address safe to actually send to", and
// for WHERE it came from.
//
// STAGE 8 of the Aug 4 2026 spec: "Every address displayed must carry its
// source, not a bare (verified) label. A (verified) label with no provenance is
// worse than no label, because it invites sends that damage sending
// reputation." Two hard failures are already traced to it:
//   jyeager@paylocity.com        550 5.7.367
//   sachin.menon@priceline.com   550 5.2.1 disabled user
//
// The allowlist below is separate from provenance and stays an ALLOWLIST on
// purpose: an unrecognized, empty or missing status means "we do not know", and
// not-known must never mean "send it".

/** Apollo email_status values that represent a real, checked mailbox. */
const SENDABLE_STATUSES = new Set(["verified"]);

/** True only when the provider positively asserts the address is verified. */
export function isSendableEmail(status?: string | null): boolean {
  if (!status) return false;
  return SENDABLE_STATUSES.has(status.trim().toLowerCase());
}

/** Where an address came from. Displayed instead of a bare "(verified)".
 *  - pattern: inferred from the company's known format. NOT verified.
 *  - smtp:    the receiving server accepted the mailbox.
 *  - source:  published by, or provided by, the person.
 *  - unknown: the provider said nothing usable. Treated as pattern. */
export type EmailProvenance = "pattern" | "smtp" | "source" | "unknown";

/** Map Apollo's own email_status onto provenance.
 *
 *  Apollo's "verified" means Apollo ran a mailbox check, so it is reported as
 *  SMTP — but attributed, because two Apollo-"verified" addresses hard-bounced.
 *  "extrapolated" and "guessed" are explicitly pattern inference. Anything we
 *  do not recognise is treated as pattern, never as verified. */
export function emailProvenance(status?: string | null): EmailProvenance {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "verified") return "smtp";
  if (s === "extrapolated" || s === "guessed" || s === "likely" || s === "unverified") return "pattern";
  return "unknown";
}

/** The label shown next to an address. Never a bare "verified". */
export function provenanceLabel(status?: string | null): string {
  switch (emailProvenance(status)) {
    case "smtp":
      return "(SMTP · apollo)";
    case "pattern":
      return "(pattern)";
    case "source":
      return "(source)";
    default:
      return "(pattern · unconfirmed)";
  }
}

/** True when the label should render muted, i.e. the address is not verified. */
export function provenanceIsWeak(status?: string | null): boolean {
  return emailProvenance(status) !== "smtp";
}

/** Short, honest label for the UI. Never claims more than the provider said. */
export function emailStatusLabel(status?: string | null): string {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "unconfirmed";
  if (s === "verified") return "verified";
  return s;
}

/** Why an address was withheld from outreach, for the UI and for task notes. */
export function unsendableReason(status?: string | null): string {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return "Apollo returned no verification status for this address";
  return `Apollo status "${s}" — pattern-inferred, not a checked mailbox`;
}

// ---------------------------------------------------------------------------
// Bounce taxonomy.
//
// Spec: "550 5.7.367 is a relay rejection at the recipient's edge, not proof
// the address is wrong. Log bounce codes distinctly: address-invalid,
// mailbox-disabled, and relay-rejected are three different problems and only
// the first two mean bad data."
//
// NOTE: nothing feeds this yet. There is no ESP or mailbox integration in this
// app, so bounces are observed by Max in his sending tool, not here. This
// exists so that when a bounce IS recorded, it is classified correctly rather
// than all being filed as "bad address" — which would wrongly punish an address
// that was fine and simply blocked at a relay.
// ---------------------------------------------------------------------------

export type BounceKind = "address-invalid" | "mailbox-disabled" | "relay-rejected" | "unknown";

export function classifyBounce(codeOrMessage: string): BounceKind {
  const s = (codeOrMessage || "").toLowerCase();
  // Enhanced status codes are the reliable signal; the prose varies by server.
  if (/\b5\.7\.(?:36[0-9]|1)\b/.test(s) || /relay(?:ing)? (?:denied|not permitted|access denied)/.test(s))
    return "relay-rejected";
  if (/\b5\.2\.1\b/.test(s) || /disabled|deactivat|suspended|inactive mailbox/.test(s))
    return "mailbox-disabled";
  if (/\b5\.1\.[01]\b/.test(s) || /(?:user|recipient|address|mailbox) (?:unknown|not found|does not exist)|no such user/.test(s))
    return "address-invalid";
  return "unknown";
}

/** Only the first two mean the DATA was wrong. A relay rejection says the
 *  recipient's edge blocked us, which is a sending-reputation or policy
 *  problem, not evidence the address is bad. */
export function bounceMeansBadAddress(kind: BounceKind): boolean {
  return kind === "address-invalid" || kind === "mailbox-disabled";
}
