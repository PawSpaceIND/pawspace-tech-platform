import { installWorkersHooks } from "./module-hooks.mjs";
import { makeD1, freshSqlite } from "./taxi-harness.mjs";

installWorkersHooks("__GROOMING_PHASE2_DB__", "__GROOMING_PHASE2_ENV__");

const governance = await import("../../lib/grooming-governance.ts");
const catalogue = await import("../../lib/grooming-commercial-catalogue.ts");
const policy = await import("../../lib/grooming-policy-governance.ts");
const capacity = await import("../../lib/provider-capacity-governance.ts");
const commercialTerms = await import("../../lib/provider-commercial-terms.ts");

export const {
  GROOMING_CATALOGUE_VERSION,
  groomingCatalogue,
  governGroomingBooking,
  ensureGroomingSubscriptionPlans,
  resolveGroomingSubscriptionPlan,
  subscriptionExpiry,
} = governance;

export const {
  GROOMING_COMMERCIAL_TRUTH_VERSION,
  groomingCommercialPackages,
  groomingCommercialAddOns,
  groomingCommercialPromotions,
  groomingSubscriptionCommercialTruth,
} = catalogue;

export const {
  ensureGroomingPolicyTables,
  resolveGroomingPolicy,
  evaluateBookingChange,
  policyVersion,
} = policy;

export const {
  ensureProviderCapacityTables,
  ensureProviderBookingGuard,
  providerUnavailableForWindow,
  loadGovernedProviders,
  setProviderAvailability,
} = capacity;

export const {
  CommercialTermConfigurationRequired,
  ensureCommercialTermsTables,
  saveCommercialTerm,
  activateCommercialTerm,
  computeOrderPayout,
} = commercialTerms;

export const GROOMER_ID = "groom_arun";
export const CUSTOMER_ID = "CUST-GROOM-PHASE2";
export const BOOKING_ID = "BKG-GROOM-PHASE2";
export const GROUP_ID = "GRP-GROOM-PHASE2";

const canonicalBookingDdl = `CREATE TABLE canonical_bookings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  city_id TEXT NOT NULL,
  zone_id TEXT,
  service_code TEXT NOT NULL,
  provider_id TEXT,
  total_amount REAL NOT NULL,
  scheduled_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
)`;

const schedulingReservationDdl = `CREATE TABLE scheduling_reservations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  city_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  pet_ids_json TEXT NOT NULL,
  scheduled_start TEXT NOT NULL,
  scheduled_end TEXT NOT NULL,
  capacity_units INTEGER NOT NULL DEFAULT 1,
  occurrence_number INTEGER NOT NULL DEFAULT 1,
  care_mode TEXT,
  status TEXT NOT NULL,
  explanation_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
)`;

export function freshGroomingWorld({ production = false } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__GROOMING_PHASE2_DB__ = db;
  globalThis.__GROOMING_PHASE2_ENV__ = production
    ? { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off", PAWSPACE_SCHEDULING_ENV: "production" }
    : { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_SCHEDULING_ENV: "uat" };
  sqlite.exec(canonicalBookingDdl);
  sqlite.exec(schedulingReservationDdl);
  return { sqlite, db };
}

export function futureSlot(offsetHours = 48, durationMinutes = 120) {
  const start = new Date(Date.now() + offsetHours * 60 * 60_000);
  start.setUTCSeconds(0, 0);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function seedCanonicalGroomingBooking(world, {
  bookingId = BOOKING_ID,
  customerId = CUSTOMER_ID,
  providerId = GROOMER_ID,
  amount = 1899,
  scheduledStart,
  status = "confirmed",
} = {}) {
  const start = scheduledStart ?? futureSlot().start;
  world.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,provider_id,total_amount,scheduled_start,status) VALUES (?,?, 'blr','blr-east','grooming',?,?,?,?)")
    .run(bookingId, customerId, providerId, amount, start, status);
  return { bookingId, customerId, providerId, amount, scheduledStart: start };
}

export function seedGroomingReservation(world, {
  reservationId = "RES-GROOM-PHASE2",
  groupId = GROUP_ID,
  providerId = GROOMER_ID,
  customerId = CUSTOMER_ID,
  start,
  end,
  status = "assigned",
} = {}) {
  const slot = start && end ? { start, end } : futureSlot();
  world.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'grooming','blr','blr-east',?,'[]',?,?,1,1,NULL,?,'{}',?)")
    .run(reservationId, groupId, providerId, customerId, slot.start, slot.end, status, Date.now());
  return { reservationId, groupId, providerId, customerId, ...slot };
}

export async function seedOverlappingUnavailability(world, reservation, {
  actorId = "ops-capacity@example.in",
  reason = "Phase 2 sabotage block",
} = {}) {
  await ensureProviderCapacityTables(world.db);
  const id = `UNAV-${crypto.randomUUID()}`;
  await world.db.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .bind(id, reservation.providerId, reservation.start, reservation.end, reason, actorId, Date.now(), Date.now()).run();
  return id;
}

export async function activateGroomingCommercialTerm(world, {
  providerId = GROOMER_ID,
  maker = "finance-maker@example.in",
  checker = "finance-checker@example.in",
} = {}) {
  const draft = await saveCommercialTerm(world.db, {
    serviceCode: "grooming",
    providerId,
    engagementModel: "commission_groomer",
    providerSharePct: 0.7,
    gstMode: "none",
    platformGstRate: 0.18,
    cashAllowed: true,
    effectiveFrom: "2026-08-01",
    reason: "Phase 2 executable Grooming finance fixture",
    actorId: maker,
  });
  await activateCommercialTerm(world.db, {
    termId: draft.id,
    approvalReference: "PHASE2-GROOMING",
    actorId: checker,
  });
  return draft;
}

export async function expectRejected(promise, pattern) {
  await import("node:assert/strict").then(({ default: assert }) => assert.rejects(promise, pattern));
}
