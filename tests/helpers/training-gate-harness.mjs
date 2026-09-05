import { installWorkersHooks } from "./module-hooks.mjs";
import { makeD1, freshSqlite } from "./taxi-harness.mjs";

installWorkersHooks("__TRAINING_PHASE2_DB__", "__TRAINING_PHASE2_ENV__");

const commercial = await import("../../lib/training-commercial-governance.ts");
const capacity = await import("../../lib/provider-capacity-governance.ts");
const commercialTerms = await import("../../lib/provider-commercial-terms.ts");

export const {
  ensureTrainingCommercialTables,
  createTrainingQuote,
  captureTrainingQuoteSandbox,
  collectTrainingRemainingBalanceSandbox,
  trainingQuotePaymentState,
  requireTrainingQuoteSandboxCapture,
  governTrainingBooking,
  consumeTrainingQuote,
} = commercial;

export const {
  ensureProviderCapacityTables,
  ensureProviderBookingGuard,
  providerUnavailableForWindow,
  getGovernedProvider,
} = capacity;

export const {
  CommercialTermConfigurationRequired,
  ensureCommercialTermsTables,
  saveCommercialTerm,
  activateCommercialTerm,
  computeOrderPayout,
} = commercialTerms;

export const TRAINER_ID = "train_kiran";
export const CUSTOMER_ID = "CUST-TRAIN-PHASE2";
export const BOOKING_ID = "BKG-TRAIN-PHASE2";
export const GROUP_ID = "GRP-TRAIN-PHASE2";

export function futureTrainingStart(offsetHours = 72) {
  const date = new Date(Date.now() + offsetHours * 60 * 60_000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export function freshTrainingWorld({ production = false } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TRAINING_PHASE2_DB__ = db;
  globalThis.__TRAINING_PHASE2_ENV__ = production
    ? { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off", PAWSPACE_SCHEDULING_ENV: "production" }
    : { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_SCHEDULING_ENV: "uat" };

  sqlite.exec(`CREATE TABLE canonical_bookings (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    city_id TEXT NOT NULL,
    zone_id TEXT,
    service_code TEXT NOT NULL,
    provider_id TEXT,
    total_amount REAL NOT NULL,
    scheduled_start TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed'
  )`);
  sqlite.exec(`CREATE TABLE scheduling_reservations (
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
  )`);
  return { sqlite, db };
}

export function seedCanonicalTrainingBooking(world, {
  bookingId = BOOKING_ID,
  customerId = CUSTOMER_ID,
  providerId = TRAINER_ID,
  amount = 3500,
  scheduledStart = futureTrainingStart(),
  status = "confirmed",
} = {}) {
  world.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,provider_id,total_amount,scheduled_start,status) VALUES (?,?, 'blr','blr-east','dog_training',?,?,?,?)")
    .run(bookingId, customerId, providerId, amount, scheduledStart, status);
  return { bookingId, customerId, providerId, amount, scheduledStart };
}

export function seedTrainingReservation(world, {
  reservationId = "RES-TRAIN-PHASE2",
  groupId = GROUP_ID,
  providerId = TRAINER_ID,
  customerId = CUSTOMER_ID,
  start = futureTrainingStart(),
  durationMinutes = 60,
  status = "assigned",
} = {}) {
  const end = new Date(new Date(start).getTime() + durationMinutes * 60_000).toISOString();
  world.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'dog_training','blr','blr-east',?,'[]',?,?,1,1,NULL,?,'{}',?)")
    .run(reservationId, groupId, providerId, customerId, start, end, status, Date.now());
  return { reservationId, groupId, providerId, customerId, start, end };
}

export async function seedTrainingUnavailability(world, reservation) {
  await ensureProviderCapacityTables(world.db);
  await world.db.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .bind(`UNAV-${crypto.randomUUID()}`, reservation.providerId, reservation.start, reservation.end, "Phase 2 Training sabotage block", "ops@example.in", Date.now(), Date.now()).run();
}

export async function activateTrainingCommercialTerm(world, {
  providerId = TRAINER_ID,
  maker = "finance-maker@example.in",
  checker = "finance-checker@example.in",
} = {}) {
  const draft = await saveCommercialTerm(world.db, {
    serviceCode: "dog_training",
    providerId,
    engagementModel: "commission_standard",
    providerSharePct: 0.7,
    gstMode: "provider_gst_on_behalf",
    platformGstRate: 0.18,
    cashAllowed: false,
    effectiveFrom: "2026-08-01",
    reason: "Phase 2 executable Training finance fixture",
    actorId: maker,
  });
  await activateCommercialTerm(world.db, {
    termId: draft.id,
    approvalReference: "PHASE2-TRAINING",
    actorId: checker,
  });
  return draft;
}
