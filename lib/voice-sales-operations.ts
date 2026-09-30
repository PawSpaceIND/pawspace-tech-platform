/** Read-only operational evidence. Missing tables are unknown, never zero or launch approval. */
type Row = Record<string, unknown>;
export type VoiceSalesOperations = {
  asOf: number;
  productionCertified: false;
  certificationReason: string;
  sources: Array<{ name: string; available: boolean }>;
  inbound: Row[] | null;
  offers: Row[] | null;
  funnel: { offered: number; booked: number; linkQueued: number; linkDelivered: number; paid: number; providerAssigned: number } | null;
  pendingWebhooks: number | null;
  pendingCrmWrites: number | null;
  quality: { sampledTurns: number; measuredTurns: number; processingP50Ms: number | null; processingP95Ms: number | null; handoffs: number; turnsWithCost: number } | null;
};

export async function voiceSalesOperations(db: D1Database): Promise<VoiceSalesOperations> {
  const sources: VoiceSalesOperations['sources'] = [];
  async function read<T>(name: string, query: () => Promise<T>): Promise<T | null> {
    try { const result = await query(); sources.push({ name, available: true }); return result; }
    catch { sources.push({ name, available: false }); return null; }
  }
  const since=Date.now()-24*60*60*1000, funnelSince=Date.now()-30*24*60*60*1000;
  const voiceOfferJoin=`FROM voice_sales_offers o
       JOIN ai_turn_reservations r ON r.idempotency_key=o.turn_key AND r.thread_id=o.thread_id AND r.customer_id=o.customer_id AND r.channel='voice'
       LEFT JOIN canonical_bookings b ON b.id=CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.bookingId') END AND b.customer_id=o.customer_id
       LEFT JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=o.customer_id
       LEFT JOIN communication_messages m ON m.id=CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.paymentMessageId') END AND m.customer_id=o.customer_id AND m.booking_id=b.id`;
  const [inbound, offers, funnel, webhooks, turns, crm] = await Promise.all([
    read('Inbound sessions', async () => (await db.prepare(
      "SELECT id,thread_id,status,language,turn_index,started_at,ended_at FROM inbound_ai_voice_sessions ORDER BY started_at DESC LIMIT 30"
    ).all<Row>()).results),
    read('Voice booking journey', async () => (await db.prepare(
      `SELECT o.id,o.service_code,o.status,o.created_at,o.completed_at,
        b.id booking_id,b.status booking_status,b.provider_id,
        m.status payment_link_status,p.status payment_status,
        CASE WHEN json_valid(o.result_json) THEN json_extract(o.result_json,'$.orderId') END order_id
       ${voiceOfferJoin}
       ORDER BY o.created_at DESC LIMIT 30`
    ).all<Row>()).results),
    read('Voice sales funnel', () => db.prepare(`SELECT COUNT(*) offered,
      COALESCE(SUM(CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END),0) booked,
      COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.status<>'suppressed' THEN 1 ELSE 0 END),0) linkQueued,
      COALESCE(SUM(CASE WHEN m.status IN ('delivered','read') THEN 1 ELSE 0 END),0) linkDelivered,
      COALESCE(SUM(CASE WHEN p.status='captured' THEN 1 ELSE 0 END),0) paid,
      COALESCE(SUM(CASE WHEN b.provider_id IS NOT NULL AND b.provider_id<>'' THEN 1 ELSE 0 END),0) providerAssigned
      ${voiceOfferJoin} WHERE o.created_at>=?`).bind(funnelSince).first<{offered:number;booked:number;linkQueued:number;linkDelivered:number;paid:number;providerAssigned:number}>()),
    read('Post-call reconciliation', () => db.prepare("SELECT COUNT(*) count FROM elevenlabs_voice_webhooks WHERE status<>'processed'").first<{ count: number }>()),
    read('AI processing measurements', async()=> (await db.prepare("SELECT latency_ms,outcome,cost_minor FROM ai_conversation_turns WHERE channel='voice' AND created_at>=? ORDER BY created_at DESC LIMIT 1000").bind(since).all<Row>()).results),
    read('CRM write reconciliation', () => db.prepare("SELECT COUNT(*) count FROM bot_call_disposition_operations WHERE status<>'completed'").first<{ count: number }>()),
  ]);
  const timings=(turns??[]).map(turn=>Number(turn.latency_ms)).filter(value=>Number.isFinite(value)&&value>0).sort((a,b)=>a-b);
  const percentile=(p:number)=>timings.length?timings[Math.max(0,Math.ceil(timings.length*p)-1)]:null;
  return {
    quality:turns?{sampledTurns:turns.length,measuredTurns:timings.length,processingP50Ms:percentile(.5),processingP95Ms:percentile(.95),handoffs:turns.filter(turn=>turn.outcome==='handoff').length,turnsWithCost:turns.filter(turn=>turn.cost_minor!=null).length}:null,
    asOf: Date.now(), productionCertified: false,
    certificationReason: 'Operational records do not certify attended audio quality, payment completion, or launch approval.',
    sources, inbound, offers, funnel: funnel ? {offered:Number(funnel.offered),booked:Number(funnel.booked),linkQueued:Number(funnel.linkQueued),linkDelivered:Number(funnel.linkDelivered),paid:Number(funnel.paid),providerAssigned:Number(funnel.providerAssigned)} : null, pendingWebhooks: webhooks ? Number(webhooks.count) : null,
    pendingCrmWrites: crm ? Number(crm.count) : null,
  };
}
