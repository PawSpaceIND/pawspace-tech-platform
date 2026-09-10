import { ensureCustomer360Tables } from "./customer-360";
import { ensureHaptikTables } from "./haptik-integration-governance";

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const digits = (value: unknown) => text(value).replace(/\D/g, "").slice(-10);
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

/**
 * Safely creates the minimum canonical identity + CRM lead required for an unknown inbound caller.
 * Existing customers are never merged or rewritten here; ambiguous phone matches fail closed.
 */
export async function resolveOrCaptureInboundCaller(db: D1Database, caller: string, asOf = Date.now()) {
  await Promise.all([ensureCustomer360Tables(db), ensureHaptikTables(db)]);
  await db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  const callerKey = digits(caller);
  if (callerKey.length !== 10) throw new Response("Inbound caller number is invalid", { status: 400 });

  const customers = (await db.prepare(
    "SELECT id,primary_phone,secondary_phone FROM canonical_customers WHERE substr(replace(replace(replace(replace(primary_phone,'+',''),' ',''),'-',''),'(',''),-10)=? OR substr(replace(replace(replace(replace(COALESCE(secondary_phone,''),'+',''),' ',''),'-',''),'(',''),-10)=? LIMIT 3",
  ).bind(callerKey, callerKey).all<Row>()).results;
  if (customers.length > 1) throw new Response("Inbound caller maps to multiple customers", { status: 409 });
  if (customers.length === 1) return { customerId: text(customers[0].id), leadId: null as string | null, callerKey, capturedLead: false };

  const contact = await db.prepare(
    "SELECT id FROM crm_contacts WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 1",
  ).bind(`%${callerKey}`).first<Row>();
  const contactId = contact ? text(contact.id) : `INBOUND-${callerKey}`;
  if (!contact) {
    await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?, 'New lead','Unassigned','inbound_voice',?,?)")
      .bind(contactId, `Inbound caller ${callerKey.slice(-4)}`, caller, null, asOf, asOf).run();
  }

  let lead = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status IN ('active','sla_breached','qualified') ORDER BY created_at DESC LIMIT 1")
    .bind(contactId).first<Row>();
  if (!lead) {
    const leadId = uid("LWI");
    await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?, 'inbound_voice','pet_care','Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)")
      .bind(leadId, contactId, asOf, asOf + 30 * 60_000, asOf + 60 * 60_000, asOf, asOf).run();
    lead = { id: leadId };
  }

  await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?, ?,NULL,NULL,'inbound_voice_lead','{}',?,?)")
    .bind(contactId, "blr", `Inbound caller ${callerKey.slice(-4)}`, caller, asOf, asOf).run();
  return { customerId: contactId, leadId: text(lead.id), callerKey, capturedLead: true };
}
