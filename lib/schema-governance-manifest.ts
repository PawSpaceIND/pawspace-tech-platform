export type LogicalForeignKey = {
  name: string;
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
};

/**
 * Logical relationships that are intentionally not declared as SQLite FOREIGN KEY constraints.
 * These are mostly immutable financial/audit references where delete cascades are forbidden and
 * where legacy D1 tables pre-date hard constraints. Schema governance executes anti-joins for each
 * relation that exists in the database and treats any returned row as an integrity failure.
 */
export const LOGICAL_FOREIGN_KEYS: readonly LogicalForeignKey[] = [
  { name: "payment_intent_booking", childTable: "payment_intents", childColumn: "booking_id", parentTable: "canonical_bookings", parentColumn: "id" },
  { name: "payment_intent_customer", childTable: "payment_intents", childColumn: "customer_id", parentTable: "canonical_customers", parentColumn: "id" },
  { name: "journal_entry_booking", childTable: "journal_entries", childColumn: "booking_id", parentTable: "canonical_bookings", parentColumn: "id" },
  { name: "partner_earning_booking", childTable: "partner_earning_pending", childColumn: "booking_id", parentTable: "canonical_bookings", parentColumn: "id" },
  { name: "partner_earning_provider", childTable: "partner_earning_pending", childColumn: "partner_id", parentTable: "provider_capacity_profiles", parentColumn: "id" },
  { name: "partner_payable_booking", childTable: "partner_payable_released", childColumn: "booking_id", parentTable: "canonical_bookings", parentColumn: "id" },
  { name: "partner_payable_provider", childTable: "partner_payable_released", childColumn: "partner_id", parentTable: "provider_capacity_profiles", parentColumn: "id" },
  { name: "provider_offer_provider", childTable: "provider_assignment_offers", childColumn: "provider_id", parentTable: "provider_capacity_profiles", parentColumn: "id" },
  { name: "provider_unavailability_provider", childTable: "provider_unavailability", childColumn: "provider_id", parentTable: "provider_capacity_profiles", parentColumn: "id" },
  { name: "provider_performance_provider", childTable: "provider_performance_events", childColumn: "provider_id", parentTable: "provider_capacity_profiles", parentColumn: "id" },
] as const;
