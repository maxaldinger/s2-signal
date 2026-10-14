// Enrollment — the gate between "this looks like a good prospect" and "we are
// going to email this person on a schedule". See SEQUENCER_ROADMAP.md.
//
// Everything here runs BEFORE a row exists. The scheduler re-checks stop
// conditions before every send too (accounts get blacklisted mid-sequence), so
// this is the first gate, not the only one.

import { adminClient } from "@/lib/auth";
import { normCompany } from "@/lib/companyKey";
import { hubspotSuppression, type HsSuppression } from "@/lib/hubspot";

/** What a surface knows about a person when the rep clicks "Add to sequence".
 *  Contacts in three of the four sections are live Apollo fetches that were
 *  never persisted, so this is also the moment the prospect row is created. */
export interface ProspectInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  title?: string;
  company?: string;
  companyDomain?: string;
  country?: string;
  timezone?: string;
  linkedinUrl?: string;
  apolloPersonId?: string;
  githubLogin?: string;
  hubspotContactId?: string;
  classification?: "qualified" | "router" | "unresolved";
  evidenceDepth?: "title_only" | "profile_verified";
  sourceSection?: "signal_feed" | "signal_2000" | "github" | "title_search";
}

export type PrecheckVerdict = "allow" | "warn" | "block";

export interface Precheck {
  verdict: PrecheckVerdict;
  /** Machine-readable so the UI can style it; `reason` is the human sentence. */
  code:
    | "ok"
    | "no_email"
    | "do_not_contact"
    | "account_blacklisted"
    | "already_enrolled"
    | "sequence_unavailable"
    | "hubspot_live_thread"
    | "hubspot_open_deal"
    | "hubspot_check_failed";
  reason?: string;
  /** Present once the prospect row exists or was found. */
  prospectId?: string;
  hubspot?: HsSuppression;
}

const splitName = (input: ProspectInput): { first?: string; last?: string } => {
  if (input.firstName || input.lastName) return { first: input.firstName, last: input.lastName };
  const parts = (input.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
};

/** Create or update the prospect row. Identity is lower(email) in Phase 1 —
 *  deliberately NOT the app's existing contact_key (apolloId || name), which
 *  collapses two different people who share a name and have no Apollo id. */
export async function materializeProspect(
  input: ProspectInput,
  userId: string,
): Promise<{ ok: true; id: string; doNotContact: boolean } | { ok: false; error: string }> {
  const email = input.email?.trim().toLowerCase();
  if (!email) return { ok: false, error: "An email address is required to enroll" };

  const admin = adminClient();
  const { first, last } = splitName(input);
  const companyKey = input.company ? normCompany(input.company) : null;

  // Look first: an existing row may already carry do_not_contact, and the
  // upsert must never clear that.
  const { data: existing, error: readErr } = await admin
    .from("gtm_prospects")
    .select("id, do_not_contact")
    .eq("email", email)
    .maybeSingle();
  if (readErr) return { ok: false, error: `Prospect lookup failed: ${readErr.message}` };

  const fields = {
    email,
    first_name: first ?? null,
    last_name: last ?? null,
    title: input.title ?? null,
    company: input.company ?? null,
    company_key: companyKey,
    company_domain: input.companyDomain ?? null,
    country: input.country ?? null,
    timezone: input.timezone ?? null,
    linkedin_url: input.linkedinUrl ?? null,
    apollo_person_id: input.apolloPersonId ?? null,
    github_login: input.githubLogin ?? null,
    hubspot_contact_id: input.hubspotContactId ?? null,
    classification: input.classification ?? null,
    evidence_depth: input.evidenceDepth ?? null,
    source_section: input.sourceSection ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await admin.from("gtm_prospects").update(fields).eq("id", existing.id);
    if (error) return { ok: false, error: `Prospect update failed: ${error.message}` };
    return { ok: true, id: existing.id, doNotContact: existing.do_not_contact === true };
  }

  const { data, error } = await admin
    .from("gtm_prospects")
    .insert({ ...fields, created_by: userId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: `Prospect insert failed: ${error?.message ?? "no row"}` };
  return { ok: true, id: data.id as string, doNotContact: false };
}

/** Run every gate. Cheap local checks first, the HubSpot round-trip last. */
export async function precheck(
  input: ProspectInput,
  sequenceId: string,
  userId: string,
): Promise<Precheck> {
  const email = input.email?.trim().toLowerCase();
  if (!email) {
    return { verdict: "block", code: "no_email", reason: "No email address — cannot enroll in an email sequence" };
  }

  const admin = adminClient();

  // The sequence itself must exist and be live.
  const { data: seq } = await admin
    .from("gtm_sequences")
    .select("id, active")
    .eq("id", sequenceId)
    .maybeSingle();
  if (!seq) return { verdict: "block", code: "sequence_unavailable", reason: "Sequence not found" };
  if (seq.active !== true) {
    return { verdict: "block", code: "sequence_unavailable", reason: "That sequence is deactivated" };
  }

  const mat = await materializeProspect(input, userId);
  if (!mat.ok) return { verdict: "block", code: "no_email", reason: mat.error };
  const prospectId = mat.id;

  // A reply or bounce anywhere is permanent and outranks everything below.
  if (mat.doNotContact) {
    const { data: p } = await admin
      .from("gtm_prospects")
      .select("dnc_reason, dnc_channel, dnc_at")
      .eq("id", prospectId)
      .maybeSingle();
    const when = p?.dnc_at ? new Date(p.dnc_at as string).toLocaleDateString("en-US") : "previously";
    return {
      verdict: "block",
      code: "do_not_contact",
      reason: `Do not contact — ${p?.dnc_reason ?? "stopped"}${p?.dnc_channel ? ` on ${p.dnc_channel}` : ""} (${when})`,
      prospectId,
    };
  }

  // "Not a fit" is account suppression, and it's checked here AND before every
  // send: accounts get blacklisted halfway through a running sequence.
  if (input.company) {
    const { data: bl } = await admin
      .from("gtm_blacklist")
      .select("company")
      .eq("company_key", normCompany(input.company))
      .maybeSingle();
    if (bl) {
      return {
        verdict: "block",
        code: "account_blacklisted",
        reason: `${bl.company} is marked "Not a fit"`,
        prospectId,
      };
    }
  }

  // One live enrollment per person. The DB enforces this too (partial unique
  // index) — this check exists to give a readable reason instead of a 23505.
  const { data: active } = await admin
    .from("gtm_enrollments")
    .select("id, sequence_id, created_at")
    .eq("prospect_id", prospectId)
    .eq("state", "active")
    .maybeSingle();
  if (active) {
    return {
      verdict: "block",
      code: "already_enrolled",
      reason: `Already in an active sequence (since ${new Date(active.created_at as string).toLocaleDateString("en-US")})`,
      prospectId,
    };
  }

  // Last, because it is the only network call. Reads the CRM rather than this
  // app's sync events: Amar sends by hand and never touches the dashboard.
  const hs = await hubspotSuppression(
    { email, companyDomain: input.companyDomain },
    { asUser: userId },
  );
  if (!hs.ok) {
    return {
      verdict: "block",
      code: "hubspot_check_failed",
      reason: hs.reason ?? hs.error ?? "HubSpot check failed",
      prospectId,
      hubspot: hs,
    };
  }
  if (hs.verdict === "block") {
    return { verdict: "block", code: "hubspot_live_thread", reason: hs.reason, prospectId, hubspot: hs };
  }
  if (hs.verdict === "warn") {
    return { verdict: "warn", code: "hubspot_open_deal", reason: hs.reason, prospectId, hubspot: hs };
  }

  return { verdict: "allow", code: "ok", prospectId, hubspot: hs };
}

export interface EnrollResult {
  ok: boolean;
  error?: string;
  precheck: Precheck;
  enrollmentId?: string;
}

/** Enroll, honouring the precheck. A WARN needs explicit acknowledgement —
 *  otherwise "warn" would just be a differently-coloured "allow". */
export async function enroll(
  input: ProspectInput,
  sequenceId: string,
  userId: string,
  opts: { acknowledgeWarning?: boolean } = {},
): Promise<EnrollResult> {
  const pre = await precheck(input, sequenceId, userId);
  if (pre.verdict === "block") return { ok: false, error: pre.reason, precheck: pre };
  if (pre.verdict === "warn" && !opts.acknowledgeWarning) {
    return { ok: false, error: pre.reason, precheck: pre };
  }
  if (!pre.prospectId) return { ok: false, error: "No prospect row", precheck: pre };

  const admin = adminClient();
  const { data, error } = await admin
    .from("gtm_enrollments")
    .insert({
      prospect_id: pre.prospectId,
      sequence_id: sequenceId,
      enrolled_by_user_id: userId,
      current_step: 0,
      state: "active",
      // Due immediately; the worker applies business-hours and timezone gating
      // when it picks the row up, so enrolling at 9pm doesn't send at 9pm.
      next_action_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = the one-active-enrollment index. Two tabs, or a double click.
    if (error.code === "23505") {
      return {
        ok: false,
        error: "That person was enrolled a moment ago by another tab or user",
        precheck: { ...pre, verdict: "block", code: "already_enrolled" },
      };
    }
    return { ok: false, error: `Enrollment failed: ${error.message}`, precheck: pre };
  }
  return { ok: true, precheck: pre, enrollmentId: data.id as string };
}
