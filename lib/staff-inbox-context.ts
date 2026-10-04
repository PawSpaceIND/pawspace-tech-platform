import { actorCanAccessConversation, type ConversationAccessActor } from "./conversation-access";
import { customerDataAccessResolver } from "./purpose-based-access";

type Row = Record<string, unknown>;
const field = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180) || null : null;
async function optionalRow(db: D1Database, table: string, sql: string, args: unknown[]) {
  try { return await db.prepare(sql).bind(...args).first<Row>(); }
  catch (error) {
    if (String(error instanceof Error ? error.message : error).includes(`no such table: ${table}`)) return null;
    throw error;
  }
}
export async function readStaffInboxContext(db: D1Database, input: { actor: ConversationAccessActor; threadId: string }) {
  if (!await actorCanAccessConversation(db, input.actor, input.threadId)) throw new Response("Conversation access denied", { status: 403 });
  const thread = await db.prepare("SELECT id,customer_id,lead_id,assigned_to,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
  if (!thread) throw new Response("Conversation not found", { status: 404 });
  const leadId = field(thread.lead_id), customerId = String(thread.customer_id);
  // Attribution is read only from an exact canonical link. Arrival channel never invents acquisition.
  const lead = leadId ? await optionalRow(db, "lead_work_items", "SELECT id,source,created_at FROM lead_work_items WHERE id=? AND customer_id=?", [leadId, customerId]) : null;
  const intake = lead ? await optionalRow(db, "lead_intake_ad_attribution", "SELECT source_platform,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,created_at FROM lead_intake_ad_attribution WHERE lead_id=? AND contact_id=?", [leadId, customerId]) : null;
  const whatsapp = lead ? await optionalRow(db, "whatsapp_lead_attribution", "SELECT source_platform,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,created_at FROM whatsapp_lead_attribution WHERE lead_id=? AND customer_id=? AND thread_id=? ORDER BY created_at,id LIMIT 1", [leadId, customerId, input.threadId]) : null;
  const attribution = intake || whatsapp;
  const address = await optionalRow(db, "customer_addresses", "SELECT area,city FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,created_at,id LIMIT 1", [customerId]);
  const access = await customerDataAccessResolver(db);
  const view = access.view({ actor: input.actor, purpose: "operations", subject: { customerId, name: "", address: address ? { area: field(address.area), city: field(address.city) } : null } });
  return {
    acquisition: {
      origin: field(lead?.source), platform: field(attribution?.source_platform),
      utmSource: field(attribution?.utm_source), utmMedium: field(attribution?.utm_medium), utmCampaign: field(attribution?.utm_campaign),
      campaignId: field(attribution?.campaign_id), adId: field(attribution?.ad_id),
      recordedAt: Number(attribution?.created_at || lead?.created_at) || null,
      evidence: intake ? "lead_intake_ad_attribution" : whatsapp ? "whatsapp_lead_attribution" : lead ? "lead_work_items" : null,
    },
    // Saved locality is useful contact context, never an assertion about a booking's service address.
    savedLocality: address ? { area: view.address.area, city: view.address.city, kind: "saved_contact_locality" as const } : null,
  };
}
