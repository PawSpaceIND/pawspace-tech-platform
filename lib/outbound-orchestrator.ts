export { decideOutboundRoute, OUTBOUND_POLICY_VERSION } from "./outbound-routing-policy";
export { ensureOutboundOrchestratorTables } from "./outbound-schema";
export { runOutboundOrchestrationSweep } from "./outbound-sweep";
export { detectAiOutboundEscalation, enqueueHumanEscalation } from "./outbound-escalation";
export {
  claimNextHumanQueue,
  releaseHumanQueueClaim,
  recordPowerDiallerDisposition,
  type PowerDiallerDisposition,
} from "./outbound-human-queue";

import { createDegradationLog, type DegradationLog } from "./degraded-reads";
import { ensureOutboundOrchestratorTables } from "./outbound-schema";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

async function all(
  db: Db,
  sql: string,
  bindings: unknown[],
  degradation: DegradationLog,
  source: string,
) {
  try {
    let query = db.prepare(sql);
    if (bindings.length) query = query.bind(...bindings);
    return (await query.all<Row>()).results || [];
  } catch (error) {
    return degradation.note(source, error, [] as Row[]);
  }
}

async function first(
  db: Db,
  sql: string,
  bindings: unknown[],
  degradation: DegradationLog,
  source: string,
) {
  try {
    let query = db.prepare(sql);
    if (bindings.length) query = query.bind(...bindings);
    return await query.first<Row>();
  } catch (error) {
    return degradation.note(source, error, null as Row | null);
  }
}

function objectJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text(value) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function getPowerDiallerHud(db: Db, id: string) {
  await ensureOutboundOrchestratorTables(db);
  const queue = await db.prepare("SELECT * FROM outbound_routing_queue WHERE id=?").bind(id).first<Row>();
  if (!queue) return null;

  const customerId = text(queue.customer_id);
  const degradation = createDegradationLog();
  const [customer, pets, history, score, handoff, messages] = await Promise.all([
    first(db, "SELECT id,name,primary_phone,email,city_id FROM canonical_customers WHERE id=?", [customerId], degradation, "customer_profile"),
    all(db, "SELECT id,name,species,breed FROM canonical_pets WHERE customer_id=? LIMIT 10", [customerId], degradation, "customer_pets"),
    all(db, "SELECT id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,currency FROM canonical_bookings WHERE customer_id=? ORDER BY scheduled_start DESC LIMIT 12", [customerId], degradation, "service_history"),
    queue.lead_id
      ? first(db, "SELECT * FROM lead_scores WHERE lead_id=?", [queue.lead_id], degradation, "lead_score")
      : null,
    first(db, "SELECT summary_json FROM ai_handoffs WHERE customer_id=? ORDER BY created_at DESC LIMIT 1", [customerId], degradation, "ai_handoff"),
    all(db, "SELECT direction,channel,payload_json,created_at FROM communication_messages WHERE customer_id=? ORDER BY created_at DESC LIMIT 8", [customerId], degradation, "recent_communications"),
  ]);

  const context = objectJson(queue.context_json);
  const aiSummary = handoff
    ? objectJson(handoff.summary_json)
    : context.aiSummary
      ? { transcript: [{ direction: "customer", text: text(context.aiSummary) }] }
      : null;
  const recentConversation = messages
    .reverse()
    .map((row) => {
      const payload = objectJson(row.payload_json);
      return {
        direction: text(row.direction),
        channel: text(row.channel),
        text: text(payload.text || payload.message || payload.body || payload.content),
        createdAt: Number(row.created_at || 0),
      };
    })
    .filter((item) => item.text);

  return {
    queue: {
      id: text(queue.id),
      status: text(queue.status),
      lifecycleCode: text(queue.lifecycle_code),
      priorityScore: Number(queue.priority_score),
      highIntent: Number(queue.high_intent) === 1,
      targetOffer: text(queue.target_offer) || null,
      nextBestService: text(queue.next_best_service) || null,
      expectedRevenue: queue.expected_revenue == null ? null : Number(queue.expected_revenue),
      ltv: Number(queue.ltv || 0),
      callbackAt: queue.callback_at == null ? null : Number(queue.callback_at),
      attemptCount: Number(queue.attempt_count || 0),
      reasons: Array.isArray(context.decisionReasons) ? context.decisionReasons : [],
    },
    customer,
    pets,
    serviceHistory: history,
    leadScore: score
      ? {
          total: Number(score.total_score || 0),
          grade: text(score.grade),
          engagement: Number(score.engagement_score || 0),
          profile: Number(score.profile_score || 0),
          recency: Number(score.recency_score || 0),
          value: Number(score.value_score || 0),
        }
      : { total: Number(context.leadScore || 0), grade: null },
    aiSummary,
    recentConversation,
    degradedReads: degradation.entries(),
  };
}

export async function outboundQueueStats(db: Db) {
  await ensureOutboundOrchestratorTables(db);
  const degradation = createDegradationLog();
  const rows = await all(
    db,
    "SELECT lane,status,COUNT(*) count FROM outbound_routing_queue GROUP BY lane,status",
    [],
    degradation,
    "outbound_queue_stats",
  );
  return {
    byLaneStatus: rows,
    humanWaiting: rows
      .filter((row) => text(row.lane) === "human" && text(row.status) === "queued")
      .reduce((count, row) => count + Number(row.count || 0), 0),
    aiWaiting: rows
      .filter((row) => text(row.lane) === "ai" && text(row.status) === "queued")
      .reduce((count, row) => count + Number(row.count || 0), 0),
    degradedReads: degradation.entries(),
  };
}
