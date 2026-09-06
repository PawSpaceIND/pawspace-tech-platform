import { processInteraktInbound } from "./interakt-whatsapp";
import { scrubPersistedInboundMessage } from "./trust-safety-governance";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

async function removeStoredRawIdentity(db: Db, messageId: string, asOf: number) {
  const row = await db.prepare("SELECT payload_json FROM communication_messages WHERE id=?").bind(messageId).first<Row>();
  if (!row) return;
  let payload: Row = {};
  try { payload = JSON.parse(text(row.payload_json) || "{}") as Row; } catch { payload = {}; }
  delete payload.providerIdentity;
  delete payload.customerPhone;
  delete payload.providerPhone;
  await db.prepare("UPDATE communication_messages SET payload_json=?,updated_at=? WHERE id=?")
    .bind(JSON.stringify(payload), asOf, messageId).run();
}

/**
 * Interakt verifies the signed raw body inside processInteraktInbound. We deliberately leave that body
 * byte-for-byte intact for authentication, then immediately scrub the canonical message before the
 * request completes. The raw content is never copied to the T&S ledger: only a SHA-256 digest and the
 * detection classes are retained there. The sender phone used for canonical ownership resolution is
 * also removed from the persisted message payload after verification so message history never becomes
 * a secondary raw-phone store.
 */
export async function processInteraktInboundTrustSafe(db: Db, env: Env, input: { rawBody: string; headers: Headers }) {
  const result = await processInteraktInbound(db, env, input) as Row;
  if (!result.accepted || !result.messageId || result.duplicatePrevented) return result;
  let body: Row = {};
  try { body = JSON.parse(input.rawBody) as Row; } catch { return result; }
  const data = object(body.data);
  const messageNode = object(data.message);
  const message = text(messageNode.message || messageNode.text || body.message || body.text || body.body);
  const asOf = Number(data.timestamp || body.timestamp || Date.now());
  let inspected = { detected: false, detections: [] as string[] };
  if (message) {
    inspected = await scrubPersistedInboundMessage(db, {
      messageId: text(result.messageId),
      text: message,
      channel: "whatsapp",
      sourceReference: `interakt:${text(result.eventId || body.event_id || body.eventId || body.id)}`,
      actorType: "customer",
      customerId: text(result.customerId) || null,
      asOf,
    });
  }
  await removeStoredRawIdentity(db, text(result.messageId), asOf);
  return { ...result, trustSafetyRedacted: inspected.detected, trustSafetyDetections: inspected.detections };
}
