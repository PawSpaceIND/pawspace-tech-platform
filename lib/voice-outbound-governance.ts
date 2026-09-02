/**
 * Public voice-governance boundary.
 *
 * The implementation lives in voice-outbound-governance-core.ts. This boundary adds the enterprise
 * recipient invariant that must hold before the core policy gate ever reads consent: the requested
 * number must resolve to the named canonical customer (or to the canonical customer owned by the
 * named lead). A caller therefore cannot borrow consent from one number and dial another.
 */
export * from "./voice-outbound-governance-core";
import { requestOutboundVoiceCall as requestCore, type VoiceCallRequest } from "./voice-outbound-governance-core";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const phoneKey = (value: unknown) => text(value).replace(/\D/g, "").slice(-10);

export async function resolveCanonicalVoiceRecipient(db: Db, input: Pick<VoiceCallRequest, "customerId" | "leadId" | "phone">) {
  let customerId = text(input.customerId);
  if (!customerId && text(input.leadId)) {
    const lead = await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(text(input.leadId)).first<Row>().catch(() => null);
    customerId = text(lead?.customer_id);
  }
  if (!customerId) throw new Error("A voice call must name the customer or lead it is about");

  const customer = await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?")
    .bind(customerId).first<Row>().catch(() => null);
  if (!customer) throw new Error("Canonical customer not found for outbound voice recipient");

  const requested = phoneKey(input.phone);
  if (requested.length !== 10) throw new Error("Recipient number could not be read as a dialable number");
  const candidates = [customer.primary_phone, customer.secondary_phone]
    .map((raw) => ({ raw: text(raw), key: phoneKey(raw) }))
    .filter((candidate) => candidate.raw && candidate.key.length === 10);
  const matched = candidates.find((candidate) => candidate.key === requested);
  if (!matched) throw new Error("Requested outbound voice number does not belong to the canonical customer");
  return { customerId, phone: matched.raw };
}

export async function requestOutboundVoiceCall(db: Db, env: Env, input: VoiceCallRequest) {
  // Ownership is resolved FIRST. The core's consent, opt-out, allow-list and frequency reads therefore
  // all run against the stored canonical number rather than against caller-controlled input.
  const canonical = await resolveCanonicalVoiceRecipient(db, input);
  return requestCore(db, env, { ...input, customerId: canonical.customerId, phone: canonical.phone });
}
