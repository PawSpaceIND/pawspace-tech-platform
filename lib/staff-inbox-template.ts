import { centralConsentAllows } from "./communication-governance";
import { actorCanAccessConversation, conversationAccessPredicate } from "./conversation-access";
import type { AuthenticatedActor } from "./server-auth";
import { ensureWhatsAppTemplateLifecycle } from "./whatsapp-template-lifecycle";
import { whatsappConversationControlSnapshot } from "./whatsapp-conversation-control";
import { queueWhatsAppUatOutbound, ensureWhatsAppUatTables, whatsappUatProviders, type WhatsAppUatProvider } from "./whatsapp-uat-adapter";

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
export type InboxTemplate = { key: string; label: string; language: string; body: string; eligible: boolean; unavailableReason: string | null };
function present(row: Row): InboxTemplate {
  let variables: unknown;
  try { variables = JSON.parse(text(row.variables_json)); } catch { variables = null; }
  const reason = text(row.status) !== "approved" || text(row.meta_reconciliation_status) !== "approved" || !text(row.meta_reference) ? "Meta approval has not been verified"
    : text(row.category) !== "utility" ? "Use the dedicated workspace for this template category"
    : !text(row.body) ? "Approved body is not recorded"
    : !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(text(row.approved_language)) ? "Approved language is not recorded"
    : !Array.isArray(variables) || variables.length || /\{\{/.test(text(row.body)) ? "Variable templates need transport support; unavailable in this inbox"
    : null;
  return { key: text(row.template_key), label: text(row.display_name) || text(row.template_key), language: text(row.approved_language), body: typeof row.body === "string" ? row.body : "", eligible: reason === null, unavailableReason: reason };
}
/** Server-only SQL, evaluated with the message insert in the existing D1 atomic queue batch. */
function templateCommitGuard(input: { actor: AuthenticatedActor; provider: WhatsAppUatProvider; template: InboxTemplate; now: number }) {
  const access = conversationAccessPredicate(input.actor, "t", input.now);
  return {
    sql: `(${access.sql})
      AND COALESCE((SELECT mode FROM whatsapp_conversation_routing_modes WHERE thread_id=t.id),'human_only')='human_only'
      AND EXISTS (SELECT 1 FROM whatsapp_uat_provider_controls WHERE provider=? AND disabled=0)
      AND COALESCE((SELECT CASE WHEN provider IN ('limechat','meta_whatsapp','sandbox_simulator') THEN provider ELSE 'sandbox_simulator' END FROM communication_messages WHERE thread_id=t.id AND channel='whatsapp' ORDER BY created_at DESC LIMIT 1),'')=?
      AND NOT EXISTS (SELECT 1 FROM communication_consent WHERE customer_id=t.customer_id AND (global_opt_out=1 OR (whatsapp_allowed IS NOT NULL AND whatsapp_allowed!=1)))
      AND EXISTS (
        SELECT 1 FROM canonical_customers c LEFT JOIN customer_contact_preferences p ON p.customer_id=c.id
        WHERE c.id=t.customer_id AND COALESCE(p.opt_out,0)!=1
          AND CASE WHEN p.whatsapp_consent IS NOT NULL THEN p.whatsapp_consent=1
            ELSE CASE WHEN json_valid(c.consent_json) THEN json_extract(c.consent_json,'$.whatsapp')=1 OR json_extract(c.consent_json,'$.whatsappConsent')=1 ELSE 0 END END=1
      )
      AND NOT EXISTS (SELECT 1 FROM whatsapp_uat_sessions WHERE customer_id=t.customer_id AND provider=? AND last_inbound_at>?-86400000)
      AND EXISTS (
        SELECT 1 FROM whatsapp_uat_templates approved JOIN whatsapp_template_lifecycle lifecycle ON lifecycle.template_key=approved.template_key
        WHERE approved.template_key=? AND approved.status='approved' AND approved.category='utility' AND approved.approved_language=?
          AND lifecycle.meta_reconciliation_status='approved' AND length(trim(COALESCE(lifecycle.meta_reference,'')))>0
          AND lifecycle.body=? AND instr(lifecycle.body,'{{')=0
          AND CASE WHEN json_valid(lifecycle.variables_json) THEN json_type(lifecycle.variables_json)='array' AND json_array_length(lifecycle.variables_json)=0 ELSE 0 END=1
      )`,
    binds: [...access.binds, input.provider, input.provider, input.provider, input.now, input.template.key, input.template.language, input.template.body],
  };
}
export async function listStaffInboxTemplates(db: D1Database) {
  await ensureWhatsAppTemplateLifecycle(db);
  const rows = await db.prepare("SELECT t.template_key,t.status,t.category,t.approved_language,l.display_name,l.body,l.variables_json,l.meta_reconciliation_status,l.meta_reference FROM whatsapp_uat_templates t LEFT JOIN whatsapp_template_lifecycle l ON l.template_key=t.template_key ORDER BY t.template_key LIMIT 100").all<Row>();
  return rows.results.map(present);
}
export async function readStaffInboxWhatsAppWindow(db: D1Database, threadId: string) {
  await ensureWhatsAppUatTables(db);
  const row = await db.prepare("SELECT t.customer_id,m.provider FROM communication_threads t JOIN communication_messages m ON m.thread_id=t.id AND m.channel='whatsapp' WHERE t.id=? ORDER BY m.created_at DESC LIMIT 1").bind(threadId).first<Row>();
  if (!row) return null;
  const provider = whatsappUatProviders.includes(text(row.provider) as WhatsAppUatProvider) ? text(row.provider) : "sandbox_simulator";
  const session = await db.prepare("SELECT last_inbound_at FROM whatsapp_uat_sessions WHERE customer_id=? AND provider=?").bind(row.customer_id, provider).first<Row>();
  const lastInboundAt = Number(session?.last_inbound_at) || 0, checkedAt = Date.now();
  const expiresAt = lastInboundAt > 0 && lastInboundAt <= checkedAt ? lastInboundAt + 24 * 60 * 60_000 : null;
  return { checkedAt, expiresAt, withinWindow: Boolean(expiresAt && checkedAt < expiresAt) };
}
export async function queueStaffInboxTemplate(db: D1Database, input: { actor: AuthenticatedActor; threadId: string; templateKey: string; language: string; clientRequestId: string }) {
  if (!await actorCanAccessConversation(db, input.actor, input.threadId)) throw new Response("Conversation access denied", { status: 403 });
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(input.clientRequestId)) throw new Response("A stable client request ID is required", { status: 400 });
  const canonicalThread = await db.prepare("SELECT customer_id FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
  if (!canonicalThread) throw new Response("Conversation not found", { status: 404 });
  const idempotencyKey = `staff-inbox-template:${input.threadId}:${input.actor.email}:${input.clientRequestId}`;
  const requestFingerprint = JSON.stringify([input.threadId, canonicalThread.customer_id, input.actor.email, input.templateKey, input.language]);
  const replay = async () => {
    const prior = await db.prepare("SELECT id,status,policy_json FROM communication_messages WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
    if (!prior) return null;
    let policy: Row = {};
    try { policy = JSON.parse(text(prior.policy_json)); } catch { /* A malformed receipt cannot match. */ }
    if (policy.requestFingerprint !== requestFingerprint) throw new Response("Client request ID is already bound to another template", { status: 409 });
    return { messageId: text(prior.id), status: text(prior.status), queued: true, duplicatePrevented: true, externalDelivery: false };
  };
  // Once accepted, a lost-response retry reads the receipt without re-queuing or changing the body.
  const prior = await replay();
  if (prior) return prior;
  const control = await whatsappConversationControlSnapshot(db, { actor: input.actor, threadId: input.threadId });
  if (control.customerId !== canonicalThread.customer_id) throw new Response("Conversation customer changed; reload before sending a template", { status: 409 });
  if (control.routing.mode !== "human_only") throw new Response("Take over the conversation before sending a template", { status: 409 });
  const thread = await db.prepare("SELECT status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
  if (thread?.status !== "open") throw new Response("Reopen the conversation before sending a template", { status: 409 });
  const preference = await db.prepare("SELECT opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(control.customerId).first<Row>();
  if (Number(preference?.opt_out) === 1 || !await centralConsentAllows(db, control.customerId, "whatsapp")) throw new Response("WhatsApp consent or opt-out policy blocks this template", { status: 409 });
  const session = await db.prepare("SELECT last_inbound_at FROM whatsapp_uat_sessions WHERE customer_id=? AND provider=?").bind(control.customerId, control.provider).first<Row>();
  const lastInboundAt = Number(session?.last_inbound_at) || 0, checkedAt = Date.now();
  if (lastInboundAt > 0 && lastInboundAt <= checkedAt && checkedAt < lastInboundAt + 24 * 60 * 60_000) throw new Response("The WhatsApp reply window is open; use the reply composer", { status: 409 });
  const template = (await listStaffInboxTemplates(db)).find(row => row.key === input.templateKey);
  if (!template?.eligible || template.language !== input.language) throw new Response(template?.unavailableReason || "An approved template with the exact language is required", { status: 409 });
  try {
    const result = await queueWhatsAppUatOutbound(db, { provider: control.provider as WhatsAppUatProvider, threadId: input.threadId, customerId: control.customerId, text: template.body, templateKey: template.key, language: template.language, idempotencyKey, requestFingerprint, createdBy: input.actor.email, commitGuard: templateCommitGuard({ actor: input.actor, provider: control.provider as WhatsAppUatProvider, template, now: Date.now() }) });
    if (!result.queued) {
      const accepted = await replay();
      if (accepted) return accepted;
      throw new Response(`Template was not queued: ${text(result.reason).replaceAll("_", " ")}; reload the conversation`, { status: 409 });
    }
    // The shared queue can swallow a raced UNIQUE conflict. Validate its winning receipt too.
    if (result.duplicatePrevented) {
      const accepted = await replay();
      if (!accepted) throw new Response("The accepted template receipt could not be verified", { status: 409 });
      return accepted;
    }
    return result;
  } catch (error) {
    if (/UNIQUE constraint failed: communication_messages.idempotency_key/.test(String(error))) { const accepted = await replay(); if (accepted) return accepted; }
    throw error;
  }
}
