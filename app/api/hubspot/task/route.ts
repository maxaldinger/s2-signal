import { adminClient, sessionUserId } from "@/lib/auth";
import { normCompany } from "@/lib/companyKey";
import { getConnection } from "@/lib/hubspotOAuth";
import { NextRequest, NextResponse } from "next/server";
import { hubspotCreateTask, type HsKind, type HsTaskType } from "@/lib/hubspot";
import { apolloPersonContact } from "@/lib/enrich/apollo";
import { isSendableEmail } from "@/lib/enrich/emailTrust";
import { readRevealCache, writeRevealCache } from "@/lib/enrich/revealCache";

// POST /api/hubspot/task
// body: {
//   kind, subject, body, dueDateMs, taskType?, objectId?,
//   // company task: name (company), domain
//   // contact task: name (contact), email?, phone?, jobtitle?, apolloId?,
//   //               companyName?, companyDomain?
// }
// Creates a HubSpot task with a fully-populated record behind it. For a contact,
// any missing email/phone is revealed from Apollo (by apolloId) so the CRM
// contact lands complete.
export const maxDuration = 30;

const TASK_TYPES = new Set(["CALL", "EMAIL", "TODO"]);

export async function POST(req: NextRequest) {
  let body: {
    kind?: string;
    name?: string;
    domain?: string;
    email?: string;
    phone?: string;
    jobtitle?: string;
    apolloId?: string;
    companyName?: string;
    companyDomain?: string;
    objectId?: string;
    subject?: string;
    body?: string;
    dueDateMs?: number;
    taskType?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.kind !== "company" && body.kind !== "contact") {
    return NextResponse.json({ error: "kind must be 'company' or 'contact'" }, { status: 400 });
  }
  if (!body.subject?.trim()) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }
  if (typeof body.dueDateMs !== "number" || !Number.isFinite(body.dueDateMs)) {
    return NextResponse.json({ error: "dueDateMs (epoch ms) is required" }, { status: 400 });
  }
  const taskType =
    body.taskType && TASK_TYPES.has(body.taskType) ? (body.taskType as HsTaskType) : "CALL";

  // Complete the contact: reveal any missing email/phone from Apollo so the
  // HubSpot record gets real contact info (best-effort — never blocks the task).
  let email = body.email;
  let phone = body.phone;
  if (body.kind === "contact" && body.apolloId) {
    if (!email) {
      // WS4: the shared reveal cache first — a teammate may already have paid
      // for this contact, and "attempted, none found" is cached too.
      const cached = await readRevealCache(body.apolloId);
      if (cached && cached.email !== null) {
        if (cached.email && isSendableEmail(cached.email_status)) email = cached.email;
      } else {
        const r = await apolloPersonContact({ id: body.apolloId, reveal: "email" });
        // Apply the SAME verification bar the UI does. This fill-in runs
        // server-side on an address the rep never saw, so without the check it
        // was the one path that could write a guessed/extrapolated email into
        // HubSpot no matter what the card displayed.
        if (r.ok && r.email && isSendableEmail(r.emailStatus)) email = r.email;
        if (r.configured && (r.ok || /no email on file/i.test(r.error ?? ""))) {
          await writeRevealCache(body.apolloId, {
            name: r.name ?? undefined,
            email: r.email ?? "",
            email_status: r.emailStatus ?? null,
            linkedin_url: r.linkedinUrl ?? undefined,
            company_domain: r.companyDomain ?? undefined,
          });
        }
      }
    }
    if (!phone) {
      const r = await apolloPersonContact({ id: body.apolloId, reveal: "phone" });
      if (r.ok && r.phone) phone = r.phone;
    }
  }

  // Only use a COMPANY-domain email. A personal/off-domain one (Apollo often
  // returns these) would mis-associate the contact, so drop it — the push then
  // proceeds as a LinkedIn-connect task with no email rather than being blocked.
  if (body.kind === "contact" && email && body.companyDomain) {
    const root = (d?: string) => {
      if (!d) return "";
      const p = d.toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
      return p.length <= 2 ? p.join(".") : p.slice(-2).join(".");
    };
    if (root(email.split("@")[1]) !== root(body.companyDomain)) email = undefined;
  }

  const uid = await sessionUserId();
  if (!uid) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const result = await hubspotCreateTask({
    kind: body.kind as HsKind,
    objectId: body.objectId,
    name: body.name,
    domain: body.domain,
    email,
    phone,
    jobtitle: body.jobtitle,
    companyName: body.companyName,
    companyDomain: body.companyDomain,
    subject: body.subject,
    body: body.body ?? "",
    dueDateMs: body.dueDateMs,
    taskType,
  }, { asUser: uid });

  // WS6 — a successful push is a SYNC EVENT: shared, attributed history so
  // teammates see "synced by Max · date" on this account/contact. Best-effort;
  // the task already landed, so a logging failure must never fail the push.
  if (result.ok) {
    try {
      const conn = await getConnection(uid);
      const companyName = body.kind === "company" ? body.name : body.companyName;
      await adminClient().from("gtm_sync_events").insert({
        kind: body.kind,
        key: body.kind === "contact" ? body.apolloId || body.name || "" : normCompany(body.name ?? ""),
        company_key: companyName ? normCompany(companyName) : null,
        contact_key: body.kind === "contact" ? body.apolloId || body.name || null : null,
        user_id: uid,
        portal_id: conn?.portal_id ?? null,
        task_url: result.taskUrl ?? null,
      });
    } catch (e) {
      console.error("[sync-event] log failed:", e instanceof Error ? e.message : e);
    }
  }

  const status = result.ok ? 200 : result.configured ? 502 : 501;
  return NextResponse.json(result, { status });
}
