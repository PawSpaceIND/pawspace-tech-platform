import { ensureTrainingProgrammeTables } from "./training-programme";
import { ensureOrderNotificationTables } from "./order-notification-governance";
import { ensureCommunicationTables } from "./communication-engine";

export type TrainingWorkflowEvent = "reschedule_requested" | "reschedule_approved" | "provider_replaced" | "session_cancelled" | "programme_cancellation_requested" | "programme_cancelled" | "rolling_change_proposed" | "rolling_change_rejected" | "rolling_appointments_confirmed";
export type TrainingWorkflowNotice = { key: string; bookingId: string; customerId: string; providerId: string; event: TrainingWorkflowEvent; sourceId: string; actorId: string; sessionId?: string; now?: number };
const copy: Record<TrainingWorkflowEvent, string> = {
  rolling_change_proposed: "A Training appointment change is proposed. The other party must agree; the original reservation remains active.",
  rolling_change_rejected: "The Training appointment change was declined. The original reservation remains active.",
  rolling_appointments_confirmed: "Your selected Training appointments are confirmed. View their dates in the Training calendar.",
  reschedule_requested: "Training reschedule requested. Operations must review; the existing reservation remains active.",
  reschedule_approved: "Training reschedule approved. View the updated session schedule.",
  provider_replaced: "Training trainer assignment updated. View the assigned trainer and session schedule.",
  session_cancelled: "This Training session has been cancelled.",
  programme_cancellation_requested: "Training programme cancellation requested. Finance must review; the programme has not yet been cancelled and no refund has been completed.",
  programme_cancelled: "Training programme cancellation approved. Remaining sessions are cancelled; any refund follows the separate Finance process.",
};

export async function ensureTrainingWorkflowNotificationTables(db: D1Database) {
  await ensureTrainingProgrammeTables(db);
  await ensureOrderNotificationTables(db);
  await ensureCommunicationTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS training_workflow_outbox (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,source_id TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'internal_available',external_delivery INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS training_provider_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unread',created_at INTEGER NOT NULL,read_at INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS training_workflow_notification_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1))"),
  ]);
}

// Append these statements to the SAME batch as the guarded business mutation. No external
// dispatcher is involved: availability in an authenticated inbox is neither delivery nor a read.
export function trainingWorkflowNotificationStatements(db: D1Database, input: TrainingWorkflowNotice): D1PreparedStatement[] {
  const body = copy[input.event];
  if (!body || !input.key || !input.sourceId || !input.actorId) throw new Error("Invalid Training workflow notice");
  const id = `training-workflow:${input.key}`, now = input.now ?? Date.now();
  const payload = JSON.stringify({ event: input.event, sourceId: input.sourceId, actorId: input.actorId, sessionId: input.sessionId ?? null, body, externalDelivery: false });
  const assertion = crypto.randomUUID();
  const team = input.event === "programme_cancellation_requested" ? "finance" : "operations";
  const request = input.event.endsWith("_requested");
  const ownership = input.sessionId ? "EXISTS (SELECT 1 FROM training_sessions WHERE id=? AND booking_id=? AND provider_id=?)" : "provider_id=?";
  const ownershipArgs = input.sessionId ? [input.sessionId,input.bookingId,input.providerId] : [input.providerId];
  const statements = [
    db.prepare(`INSERT INTO training_workflow_notification_assertions (id,ok) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM canonical_bookings WHERE id=? AND service_code='dog_training' AND customer_id=? AND ${ownership}) AND NOT EXISTS (SELECT 1 FROM training_workflow_outbox WHERE id=? AND (booking_id<>? OR customer_id<>? OR provider_id<>? OR event_type<>? OR source_id<>? OR payload_json<>?)) THEN 1 ELSE 0 END`).bind(assertion,input.bookingId,input.customerId,...ownershipArgs,id,input.bookingId,input.customerId,input.providerId,input.event,input.sourceId,payload),
    db.prepare("INSERT OR IGNORE INTO training_workflow_outbox (id,booking_id,customer_id,provider_id,event_type,source_id,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,input.bookingId,input.customerId,input.providerId,input.event,input.sourceId,payload,now),
    db.prepare("INSERT OR IGNORE INTO order_notifications (id,idempotency_key,customer_id,booking_id,service_code,event_type,severity,status,delivery_status,title,body,source_type,source_id,payload_json,created_at) SELECT ?,?,?,?,'dog_training',?,'info','unread','internal_available','Training update',?,'training_workflow',?,?,? WHERE EXISTS (SELECT 1 FROM canonical_customers WHERE id=?) AND NOT EXISTS (SELECT 1 FROM communication_preferences WHERE customer_id=? AND service_updates=0) AND NOT EXISTS (SELECT 1 FROM canonical_customers WHERE id=? AND json_extract(CASE WHEN json_valid(consent_json) THEN consent_json ELSE '{}' END,'$.serviceUpdates')=0)").bind(id,id,input.customerId,input.bookingId,input.event,body,input.sourceId,payload,now,input.customerId,input.customerId,input.customerId),
    db.prepare("INSERT OR IGNORE INTO training_provider_notifications (id,booking_id,provider_id,event_type,body,created_at) VALUES (?,?,?,?,?,?)").bind(id,input.bookingId,input.providerId,input.event,body,now),
  ];
  if (request) statements.push(db.prepare("INSERT OR IGNORE INTO staff_alerts (id,idempotency_key,alert_type,severity,status,source_type,source_id,title,body,team_code,recipient_role,customer_id,booking_id,case_id,due_at,created_at,updated_at) VALUES (?,?,?,'high','open','training_workflow',?,'Training request review',?,?,'manager',?,?,?,?,?,?)").bind(id,id,`training_${input.event}`,input.sourceId,body,team,input.customerId,input.bookingId,input.event === "programme_cancellation_requested" ? input.sourceId : null,now,now,now));
  if (request) statements.push(db.prepare("INSERT OR IGNORE INTO staff_alert_events (id,idempotency_key,alert_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,'created',?,?,?)").bind(`${id}:created`,`${id}:created`,id,input.actorId,payload,now));
  statements.push(db.prepare("DELETE FROM training_workflow_notification_assertions WHERE id=?").bind(assertion));
  return statements;
}

// Caller must authenticate provider ownership; the query additionally excludes foreign bookings.
export async function listTrainingProviderNotifications(db: D1Database, providerId: string) {
  await ensureTrainingWorkflowNotificationTables(db);
  return (await db.prepare("SELECT n.* FROM training_provider_notifications n JOIN canonical_bookings b ON b.id=n.booking_id WHERE n.provider_id=? AND (b.provider_id=? OR EXISTS (SELECT 1 FROM training_sessions s WHERE s.booking_id=b.id AND s.provider_id=n.provider_id)) AND b.service_code='dog_training' ORDER BY n.created_at DESC,n.id DESC LIMIT 50").bind(providerId,providerId).all()).results;
}
