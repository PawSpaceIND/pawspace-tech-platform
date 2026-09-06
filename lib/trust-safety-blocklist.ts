import { BLOCKLIST_REASONS, ensureTrustSafetyTables, normaliseTrustSafetyPhone, type BlocklistReason } from "./trust-safety-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

async function tableExists(db: Db, name: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
}

export async function ensureGlobalBlocklistDispatchGuard(db: Db) {
  await ensureTrustSafetyTables(db);
  await db.exec(`CREATE TRIGGER IF NOT EXISTS trg_global_blocklist_outbox_dispatch
    AFTER UPDATE OF status ON communication_outbox
    WHEN NEW.status='dispatching' AND EXISTS (
      SELECT 1
      FROM communication_messages m
      JOIN global_blocklist_customer_links l ON l.customer_id=m.customer_id
      JOIN global_blocklist g ON g.phone_e164=l.phone_e164 AND g.status='active'
      WHERE m.id=NEW.message_id
    )
    BEGIN
      UPDATE communication_outbox
      SET status='suppressed',last_error='global_blocklist',locked_at=NULL,updated_at=unixepoch()*1000
      WHERE message_id=NEW.message_id;
      UPDATE communication_messages
      SET status='suppressed',updated_at=unixepoch()*1000
      WHERE id=NEW.message_id AND status NOT IN ('delivered','read','dead_letter');
    END;`);
}

async function linkCustomers(db: Db, phone: { e164: string; key: string }, asOf: number) {
  if (!await tableExists(db, "canonical_customers")) return [] as string[];
  const rows = await db.prepare("SELECT id,primary_phone,secondary_phone FROM canonical_customers").all<Row>();
  const customerIds = rows.results
    .filter(row => [row.primary_phone, row.secondary_phone].some(value => normaliseTrustSafetyPhone(value)?.key === phone.key))
    .map(row => text(row.id)).filter(Boolean);
  for (const customerId of customerIds) {
    await db.prepare("INSERT INTO global_blocklist_customer_links (customer_id,phone_e164,linked_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at")
      .bind(customerId, phone.e164, asOf).run();
  }
  return customerIds;
}

async function suppressOutbound(db: Db, customerIds: string[], actorId: string, asOf: number) {
  for (const customerId of customerIds) {
    await db.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,0,0,NULL,'Asia/Kolkata','global_blocklist',?) ON CONFLICT(customer_id) DO UPDATE SET service_updates=0,marketing=0,source='global_blocklist',updated_at=excluded.updated_at")
      .bind(customerId, asOf).run();
    if (await tableExists(db, "customer_contact_preferences")) {
      await db.prepare("UPDATE customer_contact_preferences SET marketing_consent=0,service_consent=0,whatsapp_consent=0,sms_consent=0,email_consent=0,opt_out=1,source='global_blocklist',updated_by=?,updated_at=? WHERE customer_id=?")
        .bind(actorId, asOf, customerId).run();
    }
    await db.prepare("UPDATE communication_outbox SET status='suppressed',last_error='global_blocklist',locked_at=NULL,updated_at=? WHERE message_id IN (SELECT id FROM communication_messages WHERE customer_id=?) AND status IN ('queued','retry_pending','scheduled','dispatching')")
      .bind(asOf, customerId).run();
    await db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE customer_id=? AND status IN ('queued','retry_pending','scheduled')")
      .bind(asOf, customerId).run();
    if (await tableExists(db, "lead_work_items")) {
      const columns = await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>();
      if (columns.results.some(row => text(row.name) === "opt_out")) {
        await db.prepare("UPDATE lead_work_items SET opt_out=1,updated_at=? WHERE customer_id=?").bind(asOf, customerId).run();
      }
    }
  }
}

export async function flagCustomerOnGlobalBlocklistSafe(db: Db, input: {
  phone: string;
  reasonCode: BlocklistReason;
  actorId: string;
  actorType: "provider" | "staff";
  customerId?: string | null;
  bookingId?: string | null;
  detail?: Record<string, unknown>;
  asOf?: number;
}) {
  await ensureGlobalBlocklistDispatchGuard(db);
  if (!BLOCKLIST_REASONS.includes(input.reasonCode)) throw new Response("Unsupported blocklist reason", { status: 400 });
  const phone = normaliseTrustSafetyPhone(input.phone);
  if (!phone) throw new Response("A valid E.164 customer phone is required", { status: 400 });
  const now = input.asOf ?? Date.now();
  await db.prepare("INSERT INTO global_blocklist (phone_e164,phone_key,customer_id,reason_code,status,flagged_by,flagged_by_type,booking_id,detail_json,created_at,updated_at,cleared_at) VALUES (?,?,?,?,'active',?,?,?,?,?,?,NULL) ON CONFLICT(phone_e164) DO UPDATE SET customer_id=COALESCE(excluded.customer_id,global_blocklist.customer_id),reason_code=excluded.reason_code,status='active',flagged_by=excluded.flagged_by,flagged_by_type=excluded.flagged_by_type,booking_id=COALESCE(excluded.booking_id,global_blocklist.booking_id),detail_json=excluded.detail_json,updated_at=excluded.updated_at,cleared_at=NULL")
    .bind(phone.e164, phone.key, text(input.customerId) || null, input.reasonCode, input.actorId, input.actorType, text(input.bookingId) || null, JSON.stringify(input.detail || {}), now, now).run();
  const customerIds = await linkCustomers(db, phone, now);
  if (input.customerId && !customerIds.includes(input.customerId)) {
    await db.prepare("INSERT INTO global_blocklist_customer_links (customer_id,phone_e164,linked_at) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET phone_e164=excluded.phone_e164,linked_at=excluded.linked_at")
      .bind(input.customerId, phone.e164, now).run();
    customerIds.push(input.customerId);
  }
  await suppressOutbound(db, customerIds, input.actorId, now);
  await db.prepare("INSERT INTO voice_call_opt_outs (phone_key,source,reason,recorded_by,recorded_at) VALUES (?,'global_blocklist',?,?,?) ON CONFLICT(phone_key) DO UPDATE SET source='global_blocklist',reason=excluded.reason,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at")
    .bind(phone.key, input.reasonCode, input.actorId, now).run();
  return { blocked: true, phoneE164: phone.e164, reasonCode: input.reasonCode, linkedCustomerIds: customerIds };
}
