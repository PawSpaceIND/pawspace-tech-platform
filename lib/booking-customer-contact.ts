type Row = Record<string, unknown>;
export type BookingCustomer = { id: string; name: string; primaryPhone: string; secondaryPhone?: string; email?: string };
type SubmittedCustomer = { id: string; name?: string | null; primaryPhone?: string | null; secondaryPhone?: string | null; email?: string | null };

const text = (value: unknown) => String(value ?? "").trim();

/** A real phone is digits and the separators people type, 10 to 15 digits. "+91 ••••••1234" or "98XXXXXX12" is a masked copy. */
export function isRealPhone(value: unknown) {
  const phone = text(value), digits = phone.replace(/\D/g, "");
  return /^[+\d\s().-]+$/.test(phone) && digits.length >= 10 && digits.length <= 15;
}
/** A name or email carrying the mask characters staff screens show ("A•••• R•", "•••@pawspace.in", "a***@gmail.com"). */
export function isMaskedText(value: unknown) {
  return /[•●]|\*{2,}/.test(text(value));
}

async function storedContact(db: D1Database, customerId: string) {
  const canonical = await db.prepare("SELECT name,primary_phone,secondary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(() => null);
  if (canonical) return canonical;
  // A CRM lead that has not become a canonical customer yet keeps its real contact on the CRM contact.
  return db.prepare("SELECT name,primary_phone,secondary_phone,email FROM crm_contacts WHERE id=?").bind(customerId).first<Row>().catch(() => null);
}

/**
 * The contact details a booking may write onto the canonical customer.
 *
 * Staff screens hold a customer's contact details masked: Customer 360 serves "+91 ••••••1234" and "•••@domain".
 * The assisted Pet Taxi sent that copy with the booking, and the booking's customer upsert wrote it over the real
 * phone and email, so the customer's next OTP sign-in no longer found their account. Now a staff-assisted booking
 * always writes the stored contact (the browser's copy is ignored), and no booking ever writes a masked or malformed
 * value: it keeps what is stored, or is refused when nothing real is stored. A customer's own real details pass
 * through unchanged, without a read.
 */
export async function bookingCustomerContact(db: D1Database, submitted: SubmittedCustomer, options: { staffAssisted: boolean }): Promise<BookingCustomer> {
  const id = text(submitted.id);
  const secondary = text(submitted.secondaryPhone), email = text(submitted.email), name = text(submitted.name);
  const needsStored = options.staffAssisted || !isRealPhone(submitted.primaryPhone) || (secondary && !isRealPhone(secondary)) || isMaskedText(email) || !name || isMaskedText(name);
  const stored = needsStored && id ? await storedContact(db, id) : null;
  if (options.staffAssisted && stored && isRealPhone(stored.primary_phone)) {
    return { id, name: text(stored.name) || (isMaskedText(name) ? "" : name) || "PawSpace Customer", primaryPhone: text(stored.primary_phone), secondaryPhone: text(stored.secondary_phone) || undefined, email: text(stored.email) || undefined };
  }
  const primaryPhone = isRealPhone(submitted.primaryPhone) ? text(submitted.primaryPhone) : isRealPhone(stored?.primary_phone) ? text(stored?.primary_phone) : "";
  if (!primaryPhone) throw new Response("This customer has no real mobile number on record. Add it in the CRM before booking for them.", { status: 400 });
  return {
    id,
    name: name && !isMaskedText(name) ? name : text(stored?.name) || "PawSpace Customer",
    primaryPhone,
    secondaryPhone: !secondary ? undefined : isRealPhone(secondary) ? secondary : text(stored?.secondary_phone) || undefined,
    email: !email ? undefined : !isMaskedText(email) ? email : text(stored?.email) || undefined,
  };
}
