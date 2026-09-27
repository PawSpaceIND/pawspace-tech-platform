import { planPublicLeadIdentity } from "./public-lead-outbound";
import { storedCustomerPhone } from "./customer-phone";

export type StaffLeadCustomer = { customerId: string; newCanonicalCustomer: boolean; existingCustomer: boolean; identityReview: boolean; candidateCustomerIds: string[] };

/**
 * The customer a lead added by staff ("＋ Add lead" in /crm) belongs to.
 *
 * A staff lead used to be a CRM contact only (CU-12345) with no canonical customer. When the person then
 * signed in with the same number, sign-in created a different customer (CUS-OTP-...), their booking landed
 * there and never converted the lead; and a lead for someone PawSpace already knew became a second contact
 * beside their real account. Now, like a website enquiry, the lead joins the canonical customer its number
 * already belongs to (in any written form), or that customer is created now under the CRM id, so sign-in,
 * bookings and the lead share one customer id. A number already on two customers is never guessed: the lead
 * stays a CRM-only contact and the ambiguity is reported for review, as for a public enquiry.
 */
export async function resolveStaffLeadCustomer(db: D1Database, input: { proposedCustomerId: string; name: string; phone: string; email?: string | null; cityId: string; now: number }): Promise<StaffLeadCustomer> {
  const phone = storedCustomerPhone(input.phone);
  const plan = await planPublicLeadIdentity(db, { proposedCustomerId: input.proposedCustomerId, phone });
  if (plan.identityReview) return { customerId: input.proposedCustomerId, newCanonicalCustomer: false, existingCustomer: false, identityReview: true, candidateCustomerIds: plan.candidateCustomerIds };
  let customerId = plan.customerId;
  if (plan.newCanonicalCustomer) {
    // The CRM's 5-digit id can already belong to another person's contact: the new customer never adopts it.
    const taken = await db.prepare("SELECT id FROM crm_contacts WHERE id=? UNION ALL SELECT id FROM canonical_customers WHERE id=? LIMIT 1").bind(customerId, customerId).first().catch(() => null);
    if (taken) customerId = `CU-${crypto.randomUUID()}`;
    await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,?,'staff_crm','{}',?,?)")
      .bind(customerId, input.cityId || "blr", input.name, phone, input.email || null, input.now, input.now).run();
  }
  return { customerId, newCanonicalCustomer: plan.newCanonicalCustomer, existingCustomer: !plan.newCanonicalCustomer, identityReview: false, candidateCustomerIds: plan.candidateCustomerIds };
}
