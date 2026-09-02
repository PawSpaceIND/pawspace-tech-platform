import { canonicalDialNumber, normalisedDialKey } from "./voice-call-gate";

type Row = Record<string, unknown>;
type Env = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();

export class CanonicalRecipientOwnershipError extends Error {
  readonly code = "canonical_recipient_ownership_refused";
  constructor(message: string) {
    super(message);
    this.name = "CanonicalRecipientOwnershipError";
  }
}

export type CanonicalRecipientInput = {
  phone?: string | null;
  customerId?: string | null;
  leadId?: string | null;
  bookingId?: string | null;
  requireSuppliedPhone?: boolean;
};

function dialCandidate(env: Env, value: unknown) {
  const dialNumber = canonicalDialNumber(env, value);
  const phoneKey = dialNumber ? normalisedDialKey(dialNumber) : "";
  return dialNumber && phoneKey ? { dialNumber, phoneKey } : null;
}

/**
 * Resolve a communication recipient from canonical platform ownership before any provider boundary.
 *
 * The caller may name a customer, a lead, or both, but the phone number is never authoritative. A lead
 * must resolve to lead_work_items.customer_id, the customer must exist in canonical_customers, and a
 * booking (when supplied) must belong to that exact customer. The supplied phone must then match one of
 * that customer's canonical phones after the same canonicalisation used by the telephony provider.
 *
 * Finally we check uniqueness across primary AND secondary phones. A last-10 normalisation collision is
 * refused instead of guessing which customer owns the number. This deliberately favours a false refusal
 * over contacting the wrong person.
 */
export async function resolveCanonicalRecipientOwnership(db: D1Database, env: Env, input: CanonicalRecipientInput) {
  const claimedCustomerId = text(input.customerId);
  const leadId = text(input.leadId);
  let leadCustomerId = "";

  if (leadId) {
    const lead = await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(leadId).first<Row>().catch(() => null);
    leadCustomerId = text(lead?.customer_id);
    if (!lead || !leadCustomerId) throw new CanonicalRecipientOwnershipError("Lead is not linked to a canonical customer");
  }

  if (claimedCustomerId && leadCustomerId && claimedCustomerId !== leadCustomerId) {
    throw new CanonicalRecipientOwnershipError("Lead/customer ownership mismatch");
  }

  const customerId = claimedCustomerId || leadCustomerId;
  if (!customerId) throw new CanonicalRecipientOwnershipError("A canonical customer is required for outbound communication");

  const customer = await db.prepare("SELECT id,primary_phone,secondary_phone FROM canonical_customers WHERE id=? LIMIT 1").bind(customerId).first<Row>().catch(() => null);
  if (!customer) throw new CanonicalRecipientOwnershipError("Canonical customer is unavailable");

  const bookingId = text(input.bookingId);
  if (bookingId) {
    const booking = await db.prepare("SELECT id,customer_id FROM canonical_bookings WHERE id=? LIMIT 1").bind(bookingId).first<Row>().catch(() => null);
    if (!booking) throw new CanonicalRecipientOwnershipError("Booking is unavailable for canonical ownership validation");
    if (text(booking.customer_id) !== customerId) throw new CanonicalRecipientOwnershipError("Booking/customer ownership mismatch");
  }

  const primary = dialCandidate(env, customer.primary_phone);
  const secondary = dialCandidate(env, customer.secondary_phone);
  const owned = [primary, secondary].filter((value): value is { dialNumber: string; phoneKey: string } => Boolean(value));
  if (!owned.length) throw new CanonicalRecipientOwnershipError("Canonical customer has no dialable phone");

  const supplied = text(input.phone);
  if (input.requireSuppliedPhone && !supplied) throw new CanonicalRecipientOwnershipError("A supplied recipient phone is required");
  const selected = supplied ? dialCandidate(env, supplied) : primary;
  if (!selected) throw new CanonicalRecipientOwnershipError("Recipient phone could not be canonicalised");
  if (!owned.some((candidate) => candidate.phoneKey === selected.phoneKey)) {
    throw new CanonicalRecipientOwnershipError("Supplied recipient phone does not belong to the canonical customer");
  }

  // There is no durable normalized-phone ownership table in the current schema, so do the conservative
  // collision check at the dispatch boundary. This catches primary/secondary and formatting collisions
  // before a network request can be formed. The result set contains only identifiers and phones and is
  // never returned or logged.
  const customers = await db.prepare("SELECT id,primary_phone,secondary_phone FROM canonical_customers").all<Row>();
  const owners = new Set<string>();
  for (const row of customers.results || []) {
    for (const candidate of [dialCandidate(env, row.primary_phone), dialCandidate(env, row.secondary_phone)]) {
      if (candidate?.phoneKey === selected.phoneKey) owners.add(text(row.id));
    }
  }
  if (owners.size !== 1 || !owners.has(customerId)) {
    throw new CanonicalRecipientOwnershipError("Recipient phone is not uniquely owned by the canonical customer");
  }

  return {
    customerId,
    leadId: leadId || null,
    bookingId: bookingId || null,
    dialNumber: selected.dialNumber,
    phoneKey: selected.phoneKey,
    phoneSource: primary?.phoneKey === selected.phoneKey ? "primary" : "secondary",
  } as const;
}
