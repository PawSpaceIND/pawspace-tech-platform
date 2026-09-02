import * as base from "./voice-outbound-governance";
import { resolveCanonicalRecipientOwnership } from "./canonical-recipient-ownership";

export * from "./voice-outbound-governance";

type Db = D1Database;
type Env = Record<string, unknown>;
type VoiceRequest = Parameters<typeof base.requestOutboundVoiceCall>[2];
type RetryRequest = Parameters<typeof base.retryVoiceCall>[2];

async function canonicalRequest(db: Db, env: Env, input: VoiceRequest): Promise<VoiceRequest> {
  const owner = await resolveCanonicalRecipientOwnership(db, env, {
    phone: input.phone,
    customerId: input.customerId,
    leadId: input.leadId,
    bookingId: input.bookingId,
    requireSuppliedPhone: true,
  });
  return {
    ...input,
    customerId: owner.customerId,
    leadId: owner.leadId,
    bookingId: owner.bookingId,
    phone: owner.dialNumber,
  };
}

/** The production generic outbound entry point. Canonical ownership is proved before consent policy. */
export async function requestOutboundVoiceCall(db: Db, env: Env, input: VoiceRequest) {
  return base.requestOutboundVoiceCall(db, env, await canonicalRequest(db, env, input));
}

/** Policy previews use the same identity boundary as real dials so an operator cannot see a false PASS. */
export async function evaluateVoiceCallPolicy(db: Db, env: Env, input: VoiceRequest) {
  return base.evaluateVoiceCallPolicy(db, env, await canonicalRequest(db, env, input));
}

/**
 * Existing rows can predate this guard. Revalidate their stored customer/lead/booking/phone binding
 * before allowing the original retry implementation to create another provider contact.
 */
export async function retryVoiceCall(db: Db, env: Env, input: RetryRequest) {
  const row = await db.prepare("SELECT customer_id,lead_id,booking_id,dial_number,phone_key FROM voice_call_orders WHERE id=?").bind(input.callId).first<Record<string, unknown>>();
  if (!row) throw new Error("Voice call not found");
  await resolveCanonicalRecipientOwnership(db, env, {
    phone: String(row.dial_number || row.phone_key || ""),
    customerId: String(row.customer_id || "") || null,
    leadId: String(row.lead_id || "") || null,
    bookingId: String(row.booking_id || "") || null,
    requireSuppliedPhone: true,
  });
  return base.retryVoiceCall(db, env, input);
}
