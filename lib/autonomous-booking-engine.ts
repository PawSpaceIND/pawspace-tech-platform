import { createAutonomousPaymentLink } from "./autonomous-payment-link";
import { enqueueCommunication } from "./communication-engine";
import { dispatchInteraktWhatsApp } from "./interakt-whatsapp";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { ensurePricingControlRuntime } from "./pricing-control-runtime";
import { resolveLivePrice } from "./live-pricing-resolver";
import { resolveZoneByPincode } from "./service-zones";
import { loadGovernedProviders } from "./provider-capacity-governance";
import { offerJobToProvider } from "./provider-workspace";
import { ensureCommercialTermsTables, resolveCommercialTerm } from "./provider-commercial-terms";
import { ensureCrmPipelineTables } from "./crm-pipeline-forecast";
import { createUnifiedCase, ensureUnifiedCaseTables } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;
type Runtime = Record<string, unknown>;

export type ServiceLocation = {
  address: string;
  pincode: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type AutonomousBookingInput = {
  customerId: string;
  customerPhone: string;
  petId?: string | null;
  breed?: string | null;
  serviceId: string;
  dateTimeSlot: string;
  serviceLocation: ServiceLocation;
  idempotencyKey: string;
  actorId: string;
  threadId?: string | null;
};

export type AutonomousBookingDependencies = {
  createPaymentLink?: typeof createAutonomousPaymentLink;
  dispatchWhatsApp?: typeof dispatchInteraktWhatsApp;
  now?: () => number;
};

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const money = (value: unknown) => Math.round(Number(value || 0) * 100) / 100;
const FIFTEEN_MINUTES = 15 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;
const DEFAULT_PAYMENT_EXPIRY_MS = THIRTY_MINUTES;
const HUMAN_EDGE_RE = /\b(medical|medicine|vet|veterinary|injur(?:y|ed)|bleeding|sick|seizure|emergency|custom\s+(?:quote|price)|special\s+(?:quote|price)|complaint|complain|refund|bad\s+experience|service\s+issue)\b/i;

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("091")) return `+${digits.slice(1)}`;
  return value.trim();
}

function samePhone(a: unknown, b: unknown) {
  return normalizePhone(text(a)) === normalizePhone(text(b));
}

function validCoordinate(value: unknown, min: number, max: number) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error("Service-location coordinates are invalid");
  return parsed;
}

function scheduledInstant(value: string, now: number) {
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) throw new Error("date_time_slot must be a valid ISO date-time");
  if (stamp <= now) throw new Error("date_time_slot must be in the future");
  return new Date(stamp).toISOString();
}

async function ensureCoreTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'razorpay',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomous_reservation_group_provider ON scheduling_reservations(group_id,provider_id,occurrence_number)"),
  ]);
}

export async function ensureAutonomousBookingTables(db: Db) {
  await ensureCoreTables(db);
  await ensurePaymentReconciliationTables(db);
  await ensureCommercialTermsTables(db);
  await ensureCrmPipelineTables(db);
  await ensureUnifiedCaseTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS autonomous_slot_holds (booking_id TEXT PRIMARY KEY,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'provisional',expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_autonomous_slot_holds_window ON autonomous_slot_holds(status,service_code,city_id,zone_id,scheduled_start,scheduled_end,expires_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS autonomous_provider_broadcasts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',payout_amount REAL NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,UNIQUE(booking_id,provider_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_autonomous_provider_broadcasts_booking ON autonomous_provider_broadcasts(booking_id,status,expires_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS autonomous_booking_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT NOT NULL,reason_code TEXT NOT NULL,case_id TEXT,status TEXT NOT NULL DEFAULT 'open',detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,UNIQUE(booking_id,reason_code))"),
    db.prepare("CREATE TABLE IF NOT EXISTS autonomous_booking_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  ]);
}

async function resolveCustomer(db: Db, customerId: string, customerPhone: string) {
  const row = await db.prepare("SELECT id,city_id,primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
  if (!row) throw new Error("Canonical customer was not found");
  if (!customerPhone.trim()) throw new Error("customer_phone is required");
  if (!samePhone(customerPhone, row.primary_phone) && !samePhone(customerPhone, row.secondary_phone)) {
    throw new Error("customer_phone does not match the canonical customer");
  }
  return row;
}

async function resolvePet(db: Db, input: Pick<AutonomousBookingInput, "customerId" | "petId" | "breed">) {
  const petId = text(input.petId), breed = text(input.breed);
  if (!petId && !breed) throw new Error("pet_id or breed is required");
  if (petId) {
    const pet = await db.prepare("SELECT * FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId, input.customerId).first<Row>();
    if (!pet) throw new Error("pet_id is not owned by the canonical customer");
    if (breed && text(pet.breed).toLowerCase() !== breed.toLowerCase()) throw new Error("breed does not match the canonical pet");
    return pet;
  }
  const rows = await db.prepare("SELECT * FROM canonical_pets WHERE customer_id=? AND LOWER(COALESCE(breed,''))=LOWER(?) ORDER BY updated_at DESC").bind(input.customerId, breed).all<Row>();
  if (rows.results.length !== 1) throw new Error(rows.results.length ? "breed matches more than one pet; pet_id is required" : "breed does not match an owned canonical pet");
  return rows.results[0];
}

async function resolvePackage(db: Db, serviceId: string, scheduledStart: string) {
  await ensurePricingControlRuntime(db);
  if (!serviceId.trim()) throw new Error("service_id is required");
  const date = scheduledStart.slice(0, 10);
  const row = await db.prepare("SELECT * FROM service_packages WHERE package_code=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)").bind(serviceId, date, date).first<Row>();
  if (!row) throw new Error("service_id is not an active catalogue package for the requested date");
  return row;
}

async function assertSlotCapacity(db: Db, input: { serviceCode: string; cityId: string; zoneId: string; start: string; end: string; providerCount: number; now: number }) {
  const row = await db.prepare("SELECT COUNT(*) n FROM autonomous_slot_holds WHERE status IN ('provisional','confirmed') AND service_code=? AND city_id=? AND zone_id=? AND expires_at>? AND scheduled_start<? AND scheduled_end>?")
    .bind(input.serviceCode, input.cityId, input.zoneId, input.now, input.end, input.start).first<Row>();
  const activeHolds = Number(row?.n || 0);
  if (activeHolds >= input.providerCount) throw new Error("date_time_slot has no governed provider capacity left");
}

function providerPayoutEstimate(orderValue: number, term: Row | null) {
  if (!term) return { amount: 0, configured: false };
  const model = text(term.engagement_model), share = Math.max(0, Math.min(1, Number(term.provider_share_pct || 0)));
  if (model === "direct_employee") return { amount: 0, configured: true };
  if (model === "commission_standard") return { amount: money(orderValue * 100 / 118 * share), configured: true };
  return { amount: money(orderValue * share), configured: true };
}

function closingScript(dateTime: string) {
  const printable = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(dateTime));
  return `I have reserved your slot for ${printable}. I just sent the secure confirmation link to your WhatsApp. Once approved, your booking is locked in.`;
}

async function queuePaymentMessage(db: Db, runtime: Runtime, input: { customerId: string; bookingId: string; threadId?: string | null; paymentPath: string; scheduledStart: string; actorId: string }, dispatcher: typeof dispatchInteraktWhatsApp) {
  const templateKey = text(runtime.AUTONOMOUS_BOOKING_PAYMENT_TEMPLATE) || "booking_payment_link";
  const queued = await enqueueCommunication(db, {
    customerId: input.customerId,
    cityId: "blr",
    channel: "whatsapp",
    purpose: "transactional",
    idempotencyKey: `autonomous-booking-payment:${input.bookingId}`,
    templateKey,
    payload: {
      bodyValues: [input.scheduledStart, input.paymentPath],
      payment_link: input.paymentPath,
      booking_id: input.bookingId,
      source: "autonomous_voice_booking",
    },
    bookingId: input.bookingId,
    createdBy: input.actorId,
  });
  const messageId = "messageId" in queued ? text(queued.messageId) : text((queued as { message?: Row }).message?.id);
  if (!messageId) return { queued, dispatch: { status: "duplicate_or_unresolved" } };
  try {
    const dispatch = await dispatcher(db, runtime, { messageId });
    return { queued, dispatch };
  } catch (error) {
    return { queued, dispatch: { status: "queued_for_retry", reason: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The single autonomous mutation boundary. Every required customer parameter is locked to a canonical
 * server-side fact before the first D1 booking write. The AI never supplies price, provider or payment
 * state. A payment link may be created here, but only a signed provider webhook can confirm payment.
 */
export async function createAutonomousBooking(db: Db, runtime: Runtime, input: AutonomousBookingInput, deps: AutonomousBookingDependencies = {}) {
  await ensureAutonomousBookingTables(db);
  const nowFn = deps.now || Date.now;
  const now = nowFn();
  const customerPhone = text(input.customerPhone), serviceId = text(input.serviceId), location = input.serviceLocation;
  if (!input.customerId || !customerPhone || !serviceId || !text(input.dateTimeSlot) || !location || !text(location.address) || !text(location.pincode)) {
    throw new Error("customer_phone, pet_id/breed, service_id, date_time_slot and service_location are all required before booking.create");
  }
  if (!text(input.idempotencyKey)) throw new Error("booking.create requires an idempotency key");

  const prior = await db.prepare("SELECT * FROM canonical_bookings WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
  if (prior) {
    const payment = await db.prepare("SELECT detail_json FROM booking_payments WHERE booking_id=?").bind(prior.id).first<Row>();
    let detail: Row = {};
    try { detail = JSON.parse(text(payment?.detail_json) || "{}"); } catch {}
    return {
      bookingId: text(prior.id), status: text(prior.status), paymentLink: detail.payment_link || null,
      closingScript: closingScript(text(prior.scheduled_start)), duplicatePrevented: true, autonomousExecution: true,
    };
  }

  const scheduledStart = scheduledInstant(input.dateTimeSlot, now);
  const customer = await resolveCustomer(db, input.customerId, customerPhone);
  const pet = await resolvePet(db, input);
  const zone = await resolveZoneByPincode(db, text(location.pincode));
  if (!zone || !zone.zone.serviceAvailable) throw new Error("service_location is outside an active PawSpace service zone");
  const cityId = text(zone.assignment.cityId || customer.city_id).toLowerCase();
  if (!cityId || cityId !== text(customer.city_id).toLowerCase()) throw new Error("service_location city does not match the canonical customer city");
  const pkg = await resolvePackage(db, serviceId, scheduledStart);
  const serviceCode = text(pkg.service_code), zoneId = text(zone.assignment.zoneId);
  const durationMinutes = Math.max(15, Number(pkg.blocking_minutes || pkg.slot_minutes || 60));
  const scheduledEnd = new Date(Date.parse(scheduledStart) + durationMinutes * 60_000).toISOString();
  const candidates = await loadGovernedProviders(db, cityId, zoneId, serviceCode, new Date(scheduledStart));
  if (!candidates.length) throw new Error("date_time_slot has no active provider matching service and locality/geofence");
  await assertSlotCapacity(db, { serviceCode, cityId, zoneId, start: scheduledStart, end: scheduledEnd, providerCount: candidates.length, now });

  const price = await resolveLivePrice(db, { packageCode: serviceId, fallbackPrice: Number(pkg.base_price), scheduledStart, cityId, zoneId });
  const totalAmount = money(price.price);
  if (!(totalAmount > 0)) throw new Error("Active catalogue package does not have a valid payable price");

  const bookingId = uid("BKG-AUTO"), paymentId = uid("PAY-AUTO"), groupId = uid("SG-AUTO");
  const paymentCreator = deps.createPaymentLink || createAutonomousPaymentLink;
  const expiresAt = now + DEFAULT_PAYMENT_EXPIRY_MS;
  const paymentLink = await paymentCreator(runtime, {
    bookingId, paymentId, referenceId: paymentId, customerId: input.customerId,
    amount: totalAmount, currency: text(pkg.currency) || "INR", expiresAt,
  });
  if (!paymentLink.connected) throw new Error(paymentLink.reason);
  const linkId = text(paymentLink.paymentLink.id), paymentPath = text(paymentLink.paymentLink.short_url);
  const latitude = validCoordinate(location.latitude, -90, 90), longitude = validCoordinate(location.longitude, -180, 180);
  const petIds = JSON.stringify([text(pet.id)]), pricingJson = JSON.stringify({ source: price.source, cataloguePackageId: pkg.id, catalogueVersion: pkg.version, serverAuthoritative: true });
  const detailJson = JSON.stringify({ payment_link: paymentPath, payment_link_id: linkId, environment: paymentLink.environment, expires_at: expiresAt, source: "autonomous_voice_booking" });

  await db.batch([
    db.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisional_awaiting_payment','voice',?,?,?,?,?,?,?)")
      .bind(bookingId,input.idempotencyKey,input.customerId,petIds,petIds,cityId,zoneId,serviceCode,serviceId,text(pkg.name),groupId,"unassigned",scheduledStart,scheduledEnd,totalAmount,text(pkg.currency)||"INR",pricingJson,input.actorId,now,now),
    db.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'upi','prepaid','created','razorpay',?,?,?,?)")
      .bind(paymentId,bookingId,input.customerId,totalAmount,totalAmount,text(pkg.currency)||"INR",`autonomous:${input.idempotencyKey}`,detailJson,now,now),
    db.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?, 'unassigned', ?,?,?,'voice_booking','active',?,?)")
      .bind(bookingId,input.customerId,text(location.address),latitude,longitude,now,now),
    db.prepare("INSERT INTO autonomous_slot_holds (booking_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'provisional',?,?,?)")
      .bind(bookingId,serviceCode,cityId,zoneId,scheduledStart,scheduledEnd,expiresAt,now,now),
    db.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,gateway_payment_link_id,status,created_at,updated_at) VALUES (?,?,?,'razorpay',?,?,'active',?,?)")
      .bind(uid("PAYLINK"),bookingId,paymentId,paymentLink.environment,linkId,now,now),
    db.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay',?,?,0,0,?,'payment_link_created','pending',0,NULL,?)")
      .bind(paymentId,bookingId,paymentLink.environment,totalAmount,text(pkg.currency)||"INR",now),
    db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?, 'provisional_awaiting_payment','booking',?,?,?,?)")
      .bind(uid("BLE"),bookingId,bookingId,input.actorId,JSON.stringify({ source:"voice", paymentLinkId:linkId, slotExpiresAt:expiresAt }),now),
    db.prepare("INSERT INTO autonomous_booking_events (id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?, 'booking.create',?,?,?)")
      .bind(uid("ABE"),bookingId,input.actorId,JSON.stringify({ customerPhoneValidated:true,petId:pet.id,serviceId,zoneId,providerCandidates:candidates.length }),now),
  ]);

  const whatsapp = await queuePaymentMessage(db, runtime, { customerId: input.customerId, bookingId, threadId: input.threadId, paymentPath, scheduledStart, actorId: input.actorId }, deps.dispatchWhatsApp || dispatchInteraktWhatsApp);
  return {
    bookingId, paymentId, status: "provisional_awaiting_payment", paymentLink: paymentPath,
    paymentExpiresAt: expiresAt, scheduledStart, scheduledEnd, zoneId, serviceCode, packageCode: serviceId,
    closingScript: closingScript(scheduledStart), whatsapp, duplicatePrevented: false,
    autonomousExecution: true, humanApprovalRequired: false,
  };
}

async function ensureWonOpportunity(db: Db, booking: Row, actorId: string, now: number) {
  await ensureCrmPipelineTables(db);
  const existing = await db.prepare("SELECT * FROM crm_opportunities WHERE customer_id=? AND service_code=? AND status='open' ORDER BY updated_at DESC LIMIT 1")
    .bind(booking.customer_id, booking.service_code).first<Row>();
  if (existing) {
    await db.batch([
      db.prepare("UPDATE crm_opportunities SET stage='won',status='won',amount=?,amount_basis='captured_booking',stage_probability=1,next_best_action='Booking confirmed; provider assignment in progress',next_action_at=NULL,won_booking_id=?,lost_reason=NULL,updated_at=? WHERE id=? AND status='open'")
        .bind(Number(booking.total_amount||0),booking.id,now,existing.id),
      db.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,?,'won',1,?,'Signed payment capture confirmed autonomous booking',?,?)")
        .bind(uid("OPH"),existing.id,existing.stage,Number(booking.total_amount||0),actorId,now),
    ]);
    return { opportunityId: text(existing.id), created: false, stage: "won" };
  }
  const id = uid("OPP");
  await db.batch([
    db.prepare("INSERT INTO crm_opportunities (id,lead_id,customer_id,service_code,owner,stage,status,amount,amount_basis,stage_probability,next_best_action,next_action_at,won_booking_id,lost_reason,source,created_by,created_at,updated_at) VALUES (?,NULL,?,?,?,'won','won',?,'captured_booking',1,'Booking confirmed; provider assignment in progress',NULL,?,NULL,'autonomous_voice_booking',?,?,?,?)")
      .bind(id,booking.customer_id,booking.service_code,"AI Voice",Number(booking.total_amount||0),booking.id,actorId,now,now),
    db.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,NULL,'won',1,?,'Autonomous voice booking won on signed payment capture',?,?)")
      .bind(uid("OPH"),id,Number(booking.total_amount||0),actorId,now),
  ]);
  return { opportunityId: id, created: true, stage: "won" };
}

async function providerBroadcastDetail(db: Db, booking: Row, provider: Row) {
  const [petRows, location, term] = await Promise.all([
    db.prepare("SELECT id,name,species,breed FROM canonical_pets WHERE id IN (SELECT value FROM json_each(?))").bind(text(booking.pet_ids_json) || "[]").all<Row>().catch(()=>({results:[] as Row[]})),
    db.prepare("SELECT address_text,latitude,longitude FROM booking_service_locations WHERE booking_id=?").bind(booking.id).first<Row>(),
    resolveCommercialTerm(db, { serviceCode:text(booking.service_code), providerId:text(provider.id), atDate:text(booking.scheduled_start).slice(0,10) }),
  ]);
  const payout = providerPayoutEstimate(Number(booking.total_amount||0), term as Row | null);
  return {
    payout,
    detail: {
      serviceCode: booking.service_code, packageCode: booking.package_code, packageName: booking.package_name,
      scheduledStart: booking.scheduled_start, scheduledEnd: booking.scheduled_end,
      pets: petRows.results.map(row=>({ id:row.id,name:row.name,species:row.species,breed:row.breed })),
      address: location?.address_text || null, latitude: location?.latitude ?? null, longitude: location?.longitude ?? null,
      payoutAmount: payout.amount, payoutConfigured: payout.configured, source: "autonomous_booking_confirmed",
    },
  };
}

/** Called only after the signed gateway path has committed a canonical capture. */
export async function confirmAutonomousBookingAfterPayment(db: Db, bookingId: string, actorId = "system:payment-webhook") {
  await ensureAutonomousBookingTables(db);
  const booking = await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  if (!booking || text(booking.status) !== "provisional_awaiting_payment") return { handled:false, reason:"not_autonomous_provisional" };
  const payment = await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(bookingId).first<Row>();
  if (!payment || text(payment.status) !== "captured") throw new Error("Autonomous booking cannot confirm before canonical payment capture");
  const now = Date.now();
  const claimed = await db.prepare("UPDATE canonical_bookings SET status='confirmed',updated_at=? WHERE id=? AND status='provisional_awaiting_payment' AND EXISTS (SELECT 1 FROM booking_payments p WHERE p.booking_id=? AND p.status='captured')")
    .bind(now,bookingId,bookingId).run();
  if (Number(claimed.meta?.changes||0) !== 1) return { handled:false, reason:"already_confirmed_or_capture_missing" };
  await db.batch([
    db.prepare("UPDATE autonomous_slot_holds SET status='confirmed',expires_at=?,updated_at=? WHERE booking_id=?").bind(now+FIFTEEN_MINUTES,now,bookingId),
    db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'confirmed','booking',?,?,?,?)").bind(uid("BLE"),bookingId,bookingId,actorId,JSON.stringify({source:"signed_payment_capture"}),now),
    db.prepare("INSERT INTO autonomous_booking_events (id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,'payment.captured',?,?,?)").bind(uid("ABE"),bookingId,actorId,JSON.stringify({paymentId:payment.id}),now),
  ]);

  const refreshed = await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>() as Row;
  const crm = await ensureWonOpportunity(db, refreshed, actorId, now);
  const candidates = await loadGovernedProviders(db,text(refreshed.city_id),text(refreshed.zone_id),text(refreshed.service_code),new Date(text(refreshed.scheduled_start)));
  const offers = [] as Array<Record<string,unknown>>;
  const expiresAt = now + FIFTEEN_MINUTES;
  for (const provider of candidates) {
    try {
      const offered = await offerJobToProvider(db,{providerId:text(provider.id),bookingId,expiresAt});
      const broadcast = await providerBroadcastDetail(db,refreshed,provider as unknown as Row);
      await db.prepare("INSERT INTO autonomous_provider_broadcasts (id,booking_id,provider_id,status,payout_amount,detail_json,offered_at,expires_at) VALUES (?,?,?,'offered',?,?,?,?) ON CONFLICT(booking_id,provider_id) DO UPDATE SET status='offered',payout_amount=excluded.payout_amount,detail_json=excluded.detail_json,offered_at=excluded.offered_at,expires_at=excluded.expires_at,responded_at=NULL")
        .bind(uid("APB"),bookingId,provider.id,broadcast.payout.amount,JSON.stringify(broadcast.detail),now,expiresAt).run();
      await db.prepare("UPDATE provider_job_offers SET detail_json=? WHERE booking_id=? AND provider_id=?").bind(JSON.stringify(broadcast.detail),bookingId,provider.id).run();
      offers.push({providerId:provider.id,status:offered.status,payout: broadcast.payout.amount});
    } catch (error) {
      offers.push({providerId:provider.id,status:"ineligible_at_broadcast",reason:error instanceof Error?error.message:String(error)});
    }
  }
  await db.prepare("INSERT INTO autonomous_booking_events (id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,'provider.broadcast',?,?,?)")
    .bind(uid("ABE"),bookingId,actorId,JSON.stringify({offers:offers.length,expiresAt}),now).run();
  return { handled:true, bookingId, status:"confirmed", crm, offers, humanApprovalRequired:false };
}

export async function finalizeAutonomousProviderAssignment(db: Db, input:{bookingId:string;providerId:string;actorId?:string}) {
  await ensureAutonomousBookingTables(db);
  const booking = await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND provider_id=?").bind(input.bookingId,input.providerId).first<Row>();
  if (!booking) return { handled:false };
  const now = Date.now(), actorId = input.actorId || `provider:${input.providerId}`;
  await db.batch([
    db.prepare("UPDATE booking_service_locations SET provider_id=?,updated_at=? WHERE booking_id=?").bind(input.providerId,now,input.bookingId),
    db.prepare("UPDATE autonomous_provider_broadcasts SET status=CASE WHEN provider_id=? THEN 'accepted' ELSE 'closed_other_provider_won' END,responded_at=? WHERE booking_id=? AND status='offered'").bind(input.providerId,now,input.bookingId),
    db.prepare("INSERT OR IGNORE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,'doorstep','assigned',?,?)")
      .bind(uid("RES-AUTO"),booking.schedule_group_id,input.providerId,booking.service_code,booking.city_id,booking.zone_id,booking.customer_id,booking.pet_ids_json,booking.scheduled_start,booking.scheduled_end,JSON.stringify({source:"autonomous_first_accept",bookingId:input.bookingId}),now),
    db.prepare("UPDATE autonomous_slot_holds SET status='assigned',expires_at=?,updated_at=? WHERE booking_id=?").bind(Date.parse(text(booking.scheduled_end)),now,input.bookingId),
    db.prepare("INSERT INTO autonomous_booking_events (id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,'provider.assigned',?,?,?)").bind(uid("ABE"),input.bookingId,actorId,JSON.stringify({providerId:input.providerId,firstAcceptWins:true}),now),
  ]);
  return { handled:true, bookingId:input.bookingId, providerId:input.providerId, slotLocked:true };
}

async function createException(db: Db, input:{bookingId?:string|null;customerId:string;reasonCode:string;title:string;description:string;actorId:string;detail?:unknown}) {
  await ensureAutonomousBookingTables(db);
  const bookingId = text(input.bookingId) || null;
  const prior = bookingId ? await db.prepare("SELECT * FROM autonomous_booking_exceptions WHERE booking_id=? AND reason_code=?").bind(bookingId,input.reasonCode).first<Row>() : null;
  if (prior) return { duplicatePrevented:true, caseId:prior.case_id };
  const caseResult = await createUnifiedCase(db,{idempotencyKey:`autonomous:${bookingId||input.customerId}:${input.reasonCode}`,caseType:"operations",severity:"high",title:input.title,description:input.description,customerId:input.customerId,bookingId,sourceType:"autonomous_booking_exception",sourceId:bookingId||input.customerId,ownerTeam:"operations",actorId:input.actorId});
  const caseId = text((caseResult as Row).id || (caseResult as Row).caseId);
  await db.prepare("INSERT OR IGNORE INTO autonomous_booking_exceptions (id,booking_id,customer_id,reason_code,case_id,status,detail_json,created_at) VALUES (?,?,?,?,?,'open',?,?)")
    .bind(uid("ABX"),bookingId,input.customerId,input.reasonCode,caseId||null,JSON.stringify(input.detail||{}),Date.now()).run();
  return { duplicatePrevented:false, caseId:caseId||null };
}

export function detectAutonomousHumanException(transcript: string) {
  const match = transcript.match(HUMAN_EDGE_RE);
  if (!match) return null;
  const token = match[0].toLowerCase();
  const reasonCode = /medical|medicine|vet|injur|bleeding|sick|seizure|emergency/.test(token)
    ? "explicit_medical_issue"
    : /custom|special/.test(token) ? "explicit_custom_quote" : "explicit_active_complaint";
  return { reasonCode, matchedIntent: match[0] };
}

export async function createExplicitAutonomousException(db: Db, input:{customerId:string;transcript:string;actorId:string}) {
  const edge = detectAutonomousHumanException(input.transcript);
  if (!edge) return null;
  const title = edge.reasonCode === "explicit_medical_issue" ? "Voice booking: medical issue requires human review" : edge.reasonCode === "explicit_custom_quote" ? "Voice booking: custom quote requested" : "Voice booking: active complaint requires human review";
  return createException(db,{customerId:input.customerId,reasonCode:edge.reasonCode,title,description:input.transcript,actorId:input.actorId,detail:{matchedIntent:edge.matchedIntent}});
}

/** The only scheduled routes to Ops from an otherwise autonomous happy path. */
export async function runAutonomousBookingExceptionSweep(db: Db, input:{asOf?:number;actorId?:string}={}) {
  await ensureAutonomousBookingTables(db);
  const asOf = input.asOf || Date.now(), actorId = input.actorId || "system:autonomous-booking-sweep";
  const unpaid = await db.prepare("SELECT b.id,b.customer_id,b.scheduled_start FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id WHERE b.status='provisional_awaiting_payment' AND p.status NOT IN ('captured','refunded','partially_refunded') AND b.created_at<=?")
    .bind(asOf-THIRTY_MINUTES).all<Row>();
  const unassigned = await db.prepare("SELECT b.id,b.customer_id,b.scheduled_start FROM canonical_bookings b WHERE b.status='confirmed' AND b.provider_id='unassigned' AND EXISTS (SELECT 1 FROM autonomous_provider_broadcasts a WHERE a.booking_id=b.id AND a.offered_at<=?) AND NOT EXISTS (SELECT 1 FROM provider_job_offers o WHERE o.booking_id=b.id AND o.status='accepted')")
    .bind(asOf-FIFTEEN_MINUTES).all<Row>();
  const created:Record<string,unknown>[]=[];
  for (const row of unpaid.results) created.push(await createException(db,{bookingId:text(row.id),customerId:text(row.customer_id),reasonCode:"payment_uncompleted_30m",title:"Autonomous booking payment pending >30 minutes",description:"Customer did not complete the secure payment link within 30 minutes.",actorId,detail:{scheduledStart:row.scheduled_start}}));
  for (const row of unassigned.results) created.push(await createException(db,{bookingId:text(row.id),customerId:text(row.customer_id),reasonCode:"provider_unaccepted_15m",title:"Autonomous provider assignment SLA breached",description:"No eligible provider accepted the confirmed booking within 15 minutes.",actorId,detail:{scheduledStart:row.scheduled_start}}));
  return { unpaid:unpaid.results.length, providerSlaBreaches:unassigned.results.length, exceptions:created.length };
}
