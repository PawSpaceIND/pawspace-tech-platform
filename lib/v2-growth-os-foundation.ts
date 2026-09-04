/**
 * V2 Growth OS foundation contracts.
 *
 * These types are intentionally standalone and are not imported by V1 runtime code.
 * They describe the additive persistence contract introduced by the V2 foundation
 * migrations and can be adopted incrementally by later V2 epics.
 */

export type SubscriptionEntitlementScope = "customer" | "pet" | "household";

export type SubscriptionEntitlementStatus =
  | "pending"
  | "active"
  | "paused"
  | "exhausted"
  | "expired"
  | "suspended"
  | "cancelled";

export type SubscriptionEntitlementUnitType =
  | "session"
  | "visit"
  | "day"
  | "walk"
  | "credit"
  | "other";

export interface SubscriptionEntitlement {
  id: string;
  customerId: string;
  petId: string | null;
  serviceCode: string;
  planCode: string;
  planVersion: string;
  entitlementScope: SubscriptionEntitlementScope;
  unitType: SubscriptionEntitlementUnitType;
  totalUnits: number;
  reservedUnits: number;
  consumedUnits: number;
  releasedUnits: number;
  status: SubscriptionEntitlementStatus;
  startedAt: number;
  expiresAt: number | null;
  graceEndsAt: number | null;
  renewalWindowStartsAt: number | null;
  sourceBookingId: string | null;
  sourcePaymentId: string | null;
  sourceContractId: string | null;
  policySnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubscriptionEntitlementBalance {
  total: number;
  reserved: number;
  consumed: number;
  released: number;
  available: number;
}

export type SubscriptionEntitlementEventType =
  | "created"
  | "activated"
  | "reserved"
  | "consumed"
  | "released"
  | "paused"
  | "resumed"
  | "expired"
  | "suspended"
  | "cancelled"
  | "renewed"
  | "adjusted";

export interface SubscriptionEntitlementEvent {
  id: string;
  entitlementId: string;
  bookingId: string | null;
  eventType: SubscriptionEntitlementEventType;
  units: number;
  availableUnitsAfter: number;
  idempotencyKey: string;
  actorId: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export type CanonicalRevenueOpportunityType =
  | "new_lead"
  | "repeat_due"
  | "win_back"
  | "subscription_pitch"
  | "subscription_renewal"
  | "subscription_low_balance"
  | "payment_recovery"
  | "cross_sell"
  | "loyalty"
  | "service_recovery";

export type CanonicalRevenueOpportunityStatus =
  | "ready"
  | "suppressed"
  | "review_required"
  | "converted"
  | "closed";

export interface CanonicalRevenueOpportunity {
  id: string;
  idempotencyKey: string;
  customerId: string;
  opportunityType: string;
  serviceCode: string | null;
  reason: string;
  status: CanonicalRevenueOpportunityStatus;
  preferredChannel: string;
  estimatedValue: number;
  confidence: number;
  signalSnapshot: Record<string, unknown>;
  suppressionReasons: string[];
  policyId: string;
  policyVersion: number;
  sourceKey: string;
  convertedBookingId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CanonicalRevenueOpportunityContext {
  opportunityId: string;
  petId: string | null;
  householdId: string | null;
  normalizedOpportunityType: CanonicalRevenueOpportunityType;
  targetServiceCode: string | null;
  reasonCodes: string[];
  explanation: Record<string, unknown>;
  sourceFeatures: Record<string, unknown>;
  expectedContribution: number | null;
  urgencyScore: number;
  priorityScore: number;
  recommendedChannel: string | null;
  recommendedOfferStrategy: string | null;
  ownerId: string | null;
  eligibleAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type CanonicalRevenueOpportunityAttributionEventType =
  | "contacted"
  | "engaged"
  | "interested"
  | "booked"
  | "payment_collected"
  | "completed"
  | "refunded"
  | "cancelled"
  | "suppressed"
  | "closed";

export interface CanonicalRevenueOpportunityAttribution {
  id: string;
  opportunityId: string;
  eventType: CanonicalRevenueOpportunityAttributionEventType;
  bookingId: string | null;
  paymentId: string | null;
  serviceCode: string | null;
  grossRevenue: number | null;
  collectedRevenue: number | null;
  contribution: number | null;
  detail: Record<string, unknown>;
  idempotencyKey: string;
  occurredAt: number;
  createdAt: number;
}

export interface V2GrowthOpportunityView {
  opportunity: CanonicalRevenueOpportunity;
  context: CanonicalRevenueOpportunityContext | null;
  attribution: CanonicalRevenueOpportunityAttribution[];
}

export interface V2NextBestServiceRecommendation {
  customerId: string;
  petId: string | null;
  targetServiceCode: string;
  opportunityType: Extract<CanonicalRevenueOpportunityType, "cross_sell" | "win_back" | "repeat_due">;
  reasonCodes: string[];
  explanation: string;
  confidence: number;
  urgencyScore: number;
  expectedRevenue: number;
  expectedContribution: number | null;
  recommendedChannel: string | null;
  recommendedOfferStrategy: string | null;
  ownerId: string | null;
  eligibleAt: number | null;
  expiresAt: number | null;
}
