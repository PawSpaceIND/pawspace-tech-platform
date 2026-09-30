/** Read-only operational evidence. Missing tables are unknown, never zero or launch approval. */
type Row = Record<string, unknown>;
export type VoiceSalesOperations = {
  asOf: number;
  productionCertified: false;
  certificationReason: string;
  sources: Array<{ name: string; available: boolean }>;
  inbound: Row[] | null;
  offers: Row[] | null;
  pendingWebhooks: number | null;
  pendingCrmWrites: number | null;
};

export async function voiceSalesOperations(db: D1Database): Promise<VoiceSalesOperations> {
  const sources: VoiceSalesOperations['sources'] = [];
  async function read<T>(name: string, query: () => Promise<T>): Promise<T | null> {
    try { const result = await query(); sources.push({ name, available: true }); return result; }
    catch { sources.push({ name, available: false }); return null; }
  }
  const [inbound, offers, webhooks, crm] = await Promise.all([
    read('Inbound sessions', async () => (await db.prepare(
      "SELECT id,thread_id,status,language,turn_index,started_at,ended_at FROM inbound_ai_voice_sessions ORDER BY started_at DESC LIMIT 30"
    ).all<Row>()).results),
    read('Voice booking journey', async () => (await db.prepare(
      `SELECT o.id,o.service_code,o.status,o.created_at,o.completed_at,
        b.id booking_id,b.status booking_status,b.provider_id,
        m.status payment_link_status,p.status payment_status,
        CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.orderId') END order_id
       FROM voice_sales_offers o
       LEFT JOIN canonical_bookings b ON b.id=CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.bookingId') END AND b.customer_id=o.customer_id
       LEFT JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=o.customer_id
       LEFT JOIN communication_messages m ON m.id=CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.paymentMessageId') END AND m.customer_id=o.customer_id AND m.booking_id=b.id
       ORDER BY o.created_at DESC LIMIT 30`
    ).all<Row>()).results),
    read('Post-call reconciliation', () => db.prepare("SELECT COUNT(*) count FROM elevenlabs_voice_webhooks WHERE status<>'processed'").first<{ count: number }>()),
    read('CRM write reconciliation', () => db.prepare("SELECT COUNT(*) count FROM bot_call_disposition_operations WHERE status<>'completed'").first<{ count: number }>()),
  ]);
  return {
    asOf: Date.now(), productionCertified: false,
    certificationReason: 'Operational records do not certify attended audio quality, payment completion, or launch approval.',
    sources, inbound, offers, pendingWebhooks: webhooks ? Number(webhooks.count) : null,
    pendingCrmWrites: crm ? Number(crm.count) : null,
  };
}
