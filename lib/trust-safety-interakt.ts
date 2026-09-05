import { processInteraktInbound } from "./interakt-whatsapp";
import { scrubPersistedInboundMessage } from "./trust-safety-governance";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

/**
 * Interakt verifies the signed raw body inside processInteraktInbound. We deliberately leave that body
 * byte-for-byte intact for authentication, then immediately scrub the canonical message before the
 * request completes. The raw content is never copied to the T&S ledger: only a SHA-256 digest and the
 * detection classes are retained there.
 */
export async function processInteraktInboundTrustSafe(db: Db, env: Env, input: { rawBody: string; headers: Headers }) {
  const result = await processInteraktInbound(db, env, input) as Row;
  if (!result.accepted || !result.messageId || result.duplicatePrevented) return result;
  let body: Row = {};
  try { body = JSON.parse(input.rawBody) as Row; } catch { return result; }
  const message = text(body.message || body.text || body.body);
  if (!message) return result;
  const inspected = await scrubPersistedInboundMessage(db, {
    messageId: text(result.messageId),
    text: message,
    channel: "whatsapp",
    sourceReference: `interakt:${text(result.eventId || body.event_id || body.eventId || body.id)}`,
    actorType: "customer",
    customerId: text(result.customerId) || null,
    asOf: Number(body.timestamp || Date.now()),
  });
  return { ...result, trustSafetyRedacted: inspected.detected, trustSafetyDetections: inspected.detections };
}
