import { ensureAiAnalytics } from "./ai-analytics";
import { ensureLeadAssignmentTables } from "./lead-assignment-governance";
import { ensureWhatsAppChatbotTables } from "./whatsapp-chatbot";
import { ensureWhatsAppConversionFeedback } from "./whatsapp-conversion-feedback";
import { ensureWhatsAppInboxProductivity } from "./whatsapp-inbox-productivity";

type Db = D1Database;
type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value || 0);
const text = (value: unknown) => String(value ?? "");
const countWhere = (rows: Row[], predicate: (row: Row) => boolean) => rows.filter(predicate).reduce((sum, row) => sum + num(row.count), 0);

export async function ensureWhatsAppAiAnalytics(db: Db) {
  await ensureAiAnalytics(db);
  await ensureWhatsAppChatbotTables(db);
  await ensureWhatsAppConversionFeedback(db);
  await ensureWhatsAppInboxProductivity(db);
  await ensureLeadAssignmentTables(db);
}

export async function buildWhatsAppAiAnalytics(db: Db, input: { from?: number; to?: number } = {}) {
  await ensureWhatsAppAiAnalytics(db);
  const from = input.from ?? 0;
  const to = input.to ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) throw new Response("Valid analytics date range is required", { status: 400 });

  const [messages, delivery, templateMessages, templateDelivery, response, resolution, ai, chatbot, agents, queues, consent, attribution, feedback, sources] = await Promise.all([
    db.prepare("SELECT direction,status,COUNT(*) count FROM communication_messages WHERE channel='whatsapp' AND created_at>=? AND created_at<=? GROUP BY direction,status").bind(from, to).all<Row>(),
    db.prepare("SELECT e.event_type,COUNT(*) count FROM communication_message_delivery_events e JOIN communication_messages m ON m.id=e.message_id WHERE m.channel='whatsapp' AND e.created_at>=? AND e.created_at<=? GROUP BY e.event_type").bind(from, to).all<Row>(),
    db.prepare("SELECT template_key,status,COUNT(*) count FROM communication_messages WHERE channel='whatsapp' AND template_key IS NOT NULL AND template_key!='' AND created_at>=? AND created_at<=? GROUP BY template_key,status ORDER BY template_key,status").bind(from, to).all<Row>(),
    db.prepare("SELECT m.template_key,e.event_type,COUNT(*) count FROM communication_message_delivery_events e JOIN communication_messages m ON m.id=e.message_id WHERE m.channel='whatsapp' AND m.template_key IS NOT NULL AND m.template_key!='' AND e.created_at>=? AND e.created_at<=? GROUP BY m.template_key,e.event_type ORDER BY m.template_key,e.event_type").bind(from, to).all<Row>(),
    db.prepare("SELECT AVG(first_outbound-first_inbound) avg_ms,COUNT(*) threads FROM (SELECT thread_id,MIN(CASE WHEN direction='inbound' THEN created_at END) first_inbound,MIN(CASE WHEN direction='outbound' THEN created_at END) first_outbound FROM communication_messages WHERE channel='whatsapp' AND created_at>=? AND created_at<=? GROUP BY thread_id) WHERE first_inbound IS NOT NULL AND first_outbound IS NOT NULL AND first_outbound>=first_inbound").bind(from, to).first<Row>(),
    db.prepare("SELECT AVG(resolved_at-first_inbound) avg_ms,COUNT(*) threads FROM (SELECT m.thread_id,MIN(m.created_at) first_inbound,MIN(CASE WHEN a.action IN ('status_resolved','status_closed') THEN a.created_at END) resolved_at FROM communication_messages m LEFT JOIN conversation_audit_events a ON a.thread_id=m.thread_id WHERE m.channel='whatsapp' AND m.direction='inbound' AND m.created_at>=? AND m.created_at<=? GROUP BY m.thread_id) WHERE resolved_at IS NOT NULL AND resolved_at>=first_inbound").bind(from, to).first<Row>(),
    db.prepare("SELECT COUNT(*) turns,SUM(CASE WHEN outcome='handoff' THEN 1 ELSE 0 END) handoffs FROM ai_conversation_turns WHERE channel='whatsapp' AND created_at>=? AND created_at<=?").bind(from, to).first<Row>(),
    db.prepare("SELECT COUNT(*) turns,SUM(CASE WHEN action='human_handoff' THEN 1 ELSE 0 END) handoffs,COUNT(DISTINCT CASE WHEN to_state='qualified' THEN thread_id END) qualified_threads FROM whatsapp_chatbot_turns WHERE created_at>=? AND created_at<=?").bind(from, to).first<Row>(),
    db.prepare("SELECT assigned_to,COUNT(*) assignments,AVG(CASE WHEN ended_at IS NOT NULL THEN ended_at-created_at END) avg_ownership_ms FROM conversation_assignments WHERE created_at>=? AND created_at<=? GROUP BY assigned_to ORDER BY assignments DESC").bind(from, to).all<Row>(),
    db.prepare("SELECT COALESCE(a.team_code,'unassigned') team_code,COALESCE(a.fallback_queue,'') queue,COUNT(*) conversations FROM communication_threads t LEFT JOIN lead_assignments a ON a.lead_id=t.lead_id AND a.status='current' WHERE t.updated_at>=? AND t.updated_at<=? GROUP BY COALESCE(a.team_code,'unassigned'),COALESCE(a.fallback_queue,'') ORDER BY conversations DESC").bind(from, to).all<Row>(),
    db.prepare("SELECT COUNT(*) profiles,SUM(CASE WHEN opt_out=1 THEN 1 ELSE 0 END) opt_outs,SUM(CASE WHEN opt_out=1 OR whatsapp_consent!=1 THEN 1 ELSE 0 END) whatsapp_suppressed,SUM(CASE WHEN opt_out=1 OR whatsapp_consent!=1 OR marketing_consent!=1 THEN 1 ELSE 0 END) marketing_suppressed FROM customer_contact_preferences WHERE updated_at>=? AND updated_at<=?").bind(from, to).first<Row>().catch(() => null),
    db.prepare("SELECT COUNT(DISTINCT f.booking_id) bookings,COALESCE(SUM(b.total_amount),0) revenue FROM whatsapp_conversion_facts f JOIN whatsapp_lead_attribution a ON a.lead_id=f.lead_id AND a.customer_id=f.customer_id AND a.thread_id=f.thread_id JOIN canonical_bookings b ON b.id=f.booking_id WHERE f.event_type='booking_created' AND f.occurred_at>=? AND f.occurred_at<=?").bind(from, to).first<Row>(),
    db.prepare("SELECT platform,status,COUNT(*) count,SUM(attempts) attempts FROM whatsapp_conversion_feedback_outbox WHERE created_at>=? AND created_at<=? GROUP BY platform,status ORDER BY platform,status").bind(from, to).all<Row>(),
    db.prepare("SELECT source_platform,campaign_id,utm_source,utm_campaign,COUNT(*) leads FROM whatsapp_lead_attribution WHERE created_at>=? AND created_at<=? GROUP BY source_platform,campaign_id,utm_source,utm_campaign ORDER BY leads DESC").bind(from, to).all<Row>(),
  ]);

  const messageRows = messages.results || [];
  const deliveryRows = delivery.results || [];
  const turns = num(ai?.turns);
  const handoffs = num(ai?.handoffs);
  const chatbotTurns = num(chatbot?.turns);
  const chatbotHandoffs = num(chatbot?.handoffs);
  return {
    generatedAt: Date.now(),
    from,
    to,
    whatsapp: {
      funnel: {
        inboundMessages: countWhere(messageRows, (row) => text(row.direction) === "inbound"),
        outboundMessages: countWhere(messageRows, (row) => text(row.direction) === "outbound"),
        sentMessages: countWhere(messageRows, (row) => ["sent", "delivered", "read", "queued"].includes(text(row.status))),
        failedMessages: countWhere(messageRows, (row) => text(row.status) === "failed"),
        deliveredEvents: countWhere(deliveryRows, (row) => text(row.event_type) === "delivered"),
        readEvents: countWhere(deliveryRows, (row) => text(row.event_type) === "read"),
      },
      messages: messageRows,
      delivery: deliveryRows,
      templateFunnel: { messageStatus: templateMessages.results || [], deliveryEvents: templateDelivery.results || [] },
      firstResponse: { threads: num(response?.threads), averageMs: response?.avg_ms == null ? null : num(response.avg_ms) },
      resolutionSla: { threads: num(resolution?.threads), averageMs: resolution?.avg_ms == null ? null : num(resolution.avg_ms) },
    },
    automation: {
      aiTurns: turns,
      aiHandoffs: handoffs,
      aiContainedTurns: Math.max(0, turns - handoffs),
      aiContainmentRate: turns ? Number(((turns - handoffs) / turns).toFixed(4)) : null,
      chatbotTurns,
      chatbotHandoffs,
      chatbotContainedTurns: Math.max(0, chatbotTurns - chatbotHandoffs),
      chatbotQualifiedThreads: num(chatbot?.qualified_threads),
      humanHandoffs: handoffs + chatbotHandoffs,
    },
    people: {
      byAssignee: (agents.results || []).map((row) => ({ assignee: text(row.assigned_to), assignments: num(row.assignments), averageOwnershipMs: row.avg_ownership_ms == null ? null : num(row.avg_ownership_ms) })),
      byQueueTeam: (queues.results || []).map((row) => ({ teamCode: text(row.team_code), queue: text(row.queue), conversations: num(row.conversations) })),
    },
    consent: {
      profiles: num(consent?.profiles),
      optOuts: num(consent?.opt_outs),
      whatsappSuppressed: num(consent?.whatsapp_suppressed),
      marketingSuppressed: num(consent?.marketing_suppressed),
    },
    conversion: { leadAttributedBookings: num(attribution?.bookings), leadAttributedRevenue: num(attribution?.revenue) },
    feedback: { byPlatformStatus: feedback.results || [] },
    sources: sources.results || [],
    definitions: {
      firstResponse: "First canonical WhatsApp outbound after the first canonical WhatsApp inbound in each thread",
      resolutionSla: "First canonical resolved/closed audit event after the first WhatsApp inbound in each thread",
      aiContainment: "AI WhatsApp turns not ending in governed handoff",
      chatbotContainment: "Deterministic chatbot turns not ending in governed handoff; qualified threads are reported separately",
      queueTeam: "Current canonical lead-assignment team/fallback queue joined to the conversation lead",
      consentSuppression: "Canonical contact-preference rows whose opt-out or required WhatsApp/marketing consent blocks the corresponding send class",
      revenue: "Canonical booking total for source-attributed WhatsApp conversion facts of type booking_created",
      feedback: "UAT/simulator feedback outbox status and retry attempts only; no live ad-account mutation",
    },
    liveAdMutation: false,
  };
}

export function whatsappAnalyticsCsv(report: Awaited<ReturnType<typeof buildWhatsAppAiAnalytics>>) {
  const rows: Array<[string, string]> = [
    ["metric", "value"],
    ["inbound_messages", String(report.whatsapp.funnel.inboundMessages)],
    ["outbound_messages", String(report.whatsapp.funnel.outboundMessages)],
    ["delivered_events", String(report.whatsapp.funnel.deliveredEvents)],
    ["read_events", String(report.whatsapp.funnel.readEvents)],
    ["first_response_avg_ms", String(report.whatsapp.firstResponse.averageMs ?? "")],
    ["resolution_avg_ms", String(report.whatsapp.resolutionSla.averageMs ?? "")],
    ["ai_turns", String(report.automation.aiTurns)],
    ["ai_handoffs", String(report.automation.aiHandoffs)],
    ["ai_containment_rate", String(report.automation.aiContainmentRate ?? "")],
    ["chatbot_turns", String(report.automation.chatbotTurns)],
    ["chatbot_handoffs", String(report.automation.chatbotHandoffs)],
    ["chatbot_qualified_threads", String(report.automation.chatbotQualifiedThreads)],
    ["opt_outs", String(report.consent.optOuts)],
    ["whatsapp_suppressed", String(report.consent.whatsappSuppressed)],
    ["marketing_suppressed", String(report.consent.marketingSuppressed)],
    ["lead_attributed_bookings", String(report.conversion.leadAttributedBookings)],
    ["lead_attributed_revenue", String(report.conversion.leadAttributedRevenue)],
  ];
  return rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
}
