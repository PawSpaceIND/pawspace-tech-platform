// Private helpers for 70-partner-due-lifecycle (files starting with "_" never run as suites).
// Pure code only - no Playwright, no network - so the D1 SQL and the due-window classification can be validated
// against a local SQLite built from the repo schema. The windows below mirror the code that enforces them on staging,
// where serviceExecutionNow() is the wall clock (no PAWSPACE_UAT_EXECUTION_NOW_MS outside isolated test UAT).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Run-scoped OTP customers are created with this name by lib.mjs (otpCustomerSession default / customerSession). */
export const MASTER_NAME_PREFIX = "Master E2E";
export const SERVICES = ["boarding", "pet_sitting", "pet_taxi"];
export const LABEL = { boarding: "Boarding", pet_sitting: "Pet Sitting", pet_taxi: "Pet Taxi" };

/** What the lifecycle code allows, and when (quoted in the report and in every "not yet due" row). */
export const WINDOW_RULES = {
  pet_taxi: "accept any time while confirmed (full-time drivers get no expiring offer); confirm_pickup only from scheduled_start - 30 min, no upper bound (lib/taxi-lifecycle.ts PICKUP_EARLY_MS); start_trip after pickup; 2 route samples only while in_progress (arrive_dropoff refuses without them); complete_trip raises the final balance, payable only after completion (lib/payment-balance-window.ts)",
  pet_sitting: "accept needs a pending, unexpired offer (commission sitters: acceptance_timeout_minutes after booking, 30 by default); check_in only when scheduled_start <= now < scheduled_end, within 250 m of the doorstep, care plan ready, split balance paid; care events only before scheduled_end; check_out any time while in_progress (lib/sitting-lifecycle.ts)",
  boarding: "accept needs captured payment and a pending, unexpired offer (commission hosts: 30 min by default); check_in only when check_in_at <= now < check_out_at, care plan ready, split balance paid; meal/play and the verified daily photo only before check_out_at; check_out needs meal+play+verified photo for every stay day (lib/boarding-stay-lifecycle.ts, lib/boarding-proof-governance.ts)",
};
export const TAXI_PICKUP_EARLY_MS = 30 * MIN;
/** A late Pet Taxi ride (no upper bound in code) is still driven for up to this long after its pickup time. */
export const TAXI_STALE_AFTER_MS = 3 * DAY;
/** Do not start a Pet Sitting check-in with less than this left in the care window (check-in is the first step). */
export const SITTING_MIN_LEFT_MS = 5 * MIN;
/** Boarding needs check-in, meal, play, a photo, staff verification and the daily update before check_out_at. */
export const BOARDING_MIN_LEFT_MS = 15 * MIN;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
/** IST calendar day of an instant (the Boarding milestone day, lib/boarding-stay-lifecycle.ts istDate). */
export const istDate = (value) => new Date(new Date(value).getTime() + 330 * MIN).toISOString().slice(0, 10);
/** Mirror of stayDays(): every IST day from check-in (inclusive) to check-out (exclusive); a same-day stay is one day. */
export function stayDays(checkInAt, checkOutAt) {
  const start = istDate(checkInAt), end = istDate(checkOutAt), days = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); cursor < new Date(`${end}T00:00:00Z`); cursor = new Date(cursor.getTime() + DAY)) days.push(cursor.toISOString().slice(0, 10));
  return days.length ? days : [start];
}
export const oneLine = (value, n = 400) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const short = (bookingId) => String(bookingId || "").replace(/[^A-Za-z0-9]+/g, "").slice(-8) || "booking";
export const escRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// Read-only D1 discovery. canonical_customers.primary_phone holds the normalised 10-digit phone (lib/customer-otp.ts);
// run-scoped master customers are "97" + 7 run digits + slot (lib.mjs runPhone), their id is CUS-OTP-<hash> and their
// name starts with "Master E2E". All four conditions must hold, so a real customer whose number starts with 97 is
// never touched. Optional tables are only joined when they exist (D1 fails the whole query on a missing table).
// ---------------------------------------------------------------------------------------------------------------
export const DISCOVERY_TABLES = [
  "canonical_bookings", "canonical_customers", "booking_payments", "provider_work_orders", "provider_assignment_offers",
  "boarding_stays", "stay_payment_schedules", "sitting_care_plan_snapshots", "taxi_trips", "taxi_payment_schedules",
  "taxi_ride_booking_details", "taxi_trip_payment_events", "scheduling_assignment_decisions", "booking_service_locations",
  "booking_service_addresses",
];
export const tablesSql = () => `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${DISCOVERY_TABLES.map(name => `'${name}'`).join(",")})`;

export function discoverySql(present) {
  const has = (table) => present.has(table);
  const col = (table, expr, alias) => (has(table) ? `${expr} ${alias}` : `NULL ${alias}`);
  const sub = (table, sql, alias) => (has(table) ? `(${sql}) ${alias}` : `NULL ${alias}`);
  const json = (path, alias) => (has("scheduling_assignment_decisions") ? `CASE WHEN json_valid(d.shortlist_json) THEN json_extract(d.shortlist_json,'${path}') END ${alias}` : `NULL ${alias}`);
  const columns = [
    "b.id booking_id", "b.service_code", "b.package_code", "b.package_name", "b.status booking_status", "b.scheduled_start", "b.scheduled_end",
    "b.provider_id", "b.schedule_group_id group_id", "b.total_amount", "b.created_at", "b.zone_id",
    "c.id customer_id", "c.name customer_name", "c.primary_phone phone",
    col("booking_payments", "p.status", "payment_status"), col("booking_payments", "p.mode", "payment_mode"),
    col("booking_payments", "p.amount", "payment_amount"), col("booking_payments", "p.amount_due_now", "amount_due_now"),
    col("provider_work_orders", "w.status", "work_order_status"), col("provider_work_orders", "w.provider_model", "provider_model"),
    col("provider_assignment_offers", "o.status", "offer_status"), col("provider_assignment_offers", "o.expires_at", "offer_expires_at"),
    col("provider_assignment_offers", "o.provider_id", "offer_provider_id"),
    col("boarding_stays", "s.id", "stay_id"), col("boarding_stays", "s.status", "stay_status"), col("boarding_stays", "s.check_in_at", "check_in_at"),
    col("boarding_stays", "s.check_out_at", "check_out_at"), col("boarding_stays", "s.care_plan_status", "stay_care_plan_status"),
    col("boarding_stays", "s.check_in_status", "check_in_status"), col("boarding_stays", "s.check_out_status", "check_out_status"),
    col("boarding_stays", "s.host_provider_id", "host_provider_id"),
    col("stay_payment_schedules", "sp.status", "stay_schedule_status"), col("stay_payment_schedules", "sp.balance_amount", "stay_balance"),
    col("sitting_care_plan_snapshots", "sc.status", "sitting_care_status"),
    col("taxi_trips", "t.id", "trip_id"), col("taxi_trips", "t.status", "trip_status"), col("taxi_trips", "t.vehicle_id", "trip_vehicle_id"),
    col("taxi_payment_schedules", "ts.status", "taxi_schedule_status"), col("taxi_payment_schedules", "ts.balance_amount", "taxi_balance"),
    col("taxi_payment_schedules", "ts.booking_fee_amount", "taxi_fee"),
    col("taxi_ride_booking_details", "td.origin_latitude", "origin_lat"), col("taxi_ride_booking_details", "td.origin_longitude", "origin_lng"),
    col("taxi_ride_booking_details", "td.destination_latitude", "dest_lat"), col("taxi_ride_booking_details", "td.destination_longitude", "dest_lng"),
    sub("taxi_trip_payment_events", "SELECT e.status FROM taxi_trip_payment_events e WHERE e.booking_id=b.id LIMIT 1", "trip_payment_status"),
    sub("booking_service_locations", "SELECT l.latitude FROM booking_service_locations l WHERE l.booking_id=b.id AND l.status='active' LIMIT 1", "loc_lat"),
    sub("booking_service_locations", "SELECT l.longitude FROM booking_service_locations l WHERE l.booking_id=b.id AND l.status='active' LIMIT 1", "loc_lng"),
    sub("booking_service_addresses", "SELECT a.latitude FROM booking_service_addresses a WHERE a.booking_id=b.id LIMIT 1", "addr_lat"),
    sub("booking_service_addresses", "SELECT a.longitude FROM booking_service_addresses a WHERE a.booking_id=b.id LIMIT 1", "addr_lng"),
    json("$.request.latitude", "req_lat"), json("$.request.longitude", "req_lng"), json("$.request.customerId", "req_customer_id"),
  ];
  const joins = [
    ["booking_payments", "LEFT JOIN booking_payments p ON p.booking_id=b.id"],
    ["provider_work_orders", "LEFT JOIN provider_work_orders w ON w.booking_id=b.id"],
    ["provider_assignment_offers", "LEFT JOIN provider_assignment_offers o ON o.group_id=b.schedule_group_id"],
    ["boarding_stays", "LEFT JOIN boarding_stays s ON s.booking_id=b.id"],
    ["stay_payment_schedules", "LEFT JOIN stay_payment_schedules sp ON sp.booking_id=b.id"],
    ["sitting_care_plan_snapshots", "LEFT JOIN sitting_care_plan_snapshots sc ON sc.booking_id=b.id"],
    ["taxi_trips", "LEFT JOIN taxi_trips t ON t.booking_id=b.id"],
    ["taxi_payment_schedules", "LEFT JOIN taxi_payment_schedules ts ON ts.booking_id=b.id"],
    ["taxi_ride_booking_details", "LEFT JOIN taxi_ride_booking_details td ON td.booking_id=b.id"],
    ["scheduling_assignment_decisions", "LEFT JOIN scheduling_assignment_decisions d ON d.group_id=b.schedule_group_id"],
  ].filter(([table]) => has(table)).map(([, sql]) => sql);
  return `SELECT ${columns.join(",")} FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id ${joins.join(" ")}`
    + " WHERE b.service_code IN ('boarding','pet_sitting','pet_taxi') AND c.primary_phone LIKE '97%' AND length(c.primary_phone)=10"
    + " AND c.name LIKE ? AND c.id LIKE 'CUS-OTP-%' AND b.created_at>=? AND substr(b.scheduled_start,1,10)<=? AND substr(b.scheduled_end,1,10)>=?"
    + " ORDER BY b.scheduled_start LIMIT 300";
}
/** Near-term master bookings: created in the last 21 days, scheduled between 4 days ago and 8 days ahead (coarse, UTC dates). */
export const discoveryParams = (now) => [`${MASTER_NAME_PREFIX}%`, now - 21 * DAY, isoDate(now + 8 * DAY), isoDate(now - 4 * DAY)];

/** Where the provider stands: sitting check-in is geofenced against resolveBookingDoorstep()'s precedence. */
export function doorstepOf(row) {
  // The scheduler snapshot only counts when it was taken for this booking's own customer (same rule as the server).
  const snapshotOwned = row.req_customer_id == null || String(row.req_customer_id) === String(row.customer_id);
  for (const [lat, lng, source] of [[row.loc_lat, row.loc_lng, "booking_service_locations"], [row.addr_lat, row.addr_lng, "booking_service_addresses"], [snapshotOwned ? row.req_lat : null, snapshotOwned ? row.req_lng : null, "scheduling_assignment_decisions"]]) {
    const latitude = num(lat), longitude = num(lng);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude || longitude)) return { latitude, longitude, source };
  }
  return null;
}
/** A point ~11 m north-east of a coordinate: "standing at the door", well inside the 250 m sitting geofence. */
export const nearby = (point) => (point ? { latitude: round6(point.latitude + 0.0001), longitude: round6(point.longitude + 0.0001) } : null);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
export function haversineMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180, dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371_000 * Math.asin(Math.sqrt(h)));
}

const CLOSED = new Set(["cancelled", "canceled", "refunded", "failed", "expired"]);
const CAPTURED = new Set(["captured", "partially_refunded"]);

/**
 * Where one discovered booking stands right now. phase:
 *  due       - a partner action is possible now (or an in-flight lifecycle can continue);
 *  upcoming  - becomes actionable at actionableAt;
 *  missed    - its window closed before this run (check-in / milestones can no longer be recorded);
 *  done      - already completed (and, for Pet Taxi, fully paid);
 *  inactive  - cancelled, unpaid or otherwise not a paid live booking.
 */
export function classifyBooking(row, now = Date.now()) {
  const service = String(row.service_code);
  const start = Date.parse(String(row.scheduled_start || "")), end = Date.parse(String(row.scheduled_end || ""));
  const bookingStatus = String(row.booking_status || ""), paymentStatus = String(row.payment_status || "");
  const providerId = String((service === "boarding" ? row.host_provider_id : "") || row.provider_id || "");
  const base = {
    service, bookingId: String(row.booking_id), providerId, customerId: String(row.customer_id), customerName: String(row.customer_name || ""),
    phone: String(row.phone || ""), packageCode: String(row.package_code || ""), packageName: String(row.package_name || ""),
    bookingStatus, paymentStatus, paymentMode: String(row.payment_mode || ""), total: num(row.total_amount), groupId: String(row.group_id || ""),
    start, end, startIso: iso(start), endIso: iso(end), providerModel: String(row.provider_model || ""),
    offer: row.offer_status ? { status: String(row.offer_status), expiresAt: num(row.offer_expires_at), providerId: String(row.offer_provider_id || "") } : null,
    doorstep: doorstepOf(row), notes: [], row,
  };
  const out = (phase, actionableAt, closesAt, reason) => ({ ...base, phase, actionableAt, closesAt, actionableAtUtc: iso(actionableAt), closesAtUtc: iso(closesAt), reason });
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out("inactive", null, null, "booking has no valid schedule");
  if (CLOSED.has(bookingStatus)) return out("inactive", null, null, `booking ${bookingStatus}`);
  if (bookingStatus === "payment_pending") return out("inactive", null, null, "booking fee / payment not captured (payment_pending)");
  const offerOpen = base.offer && base.offer.status === "pending" && Number(base.offer.expiresAt) >= now;
  const offerNote = base.offer && base.offer.status === "pending" && !offerOpen ? `provider offer expired ${iso(Number(base.offer.expiresAt))} - acceptance will be refused (Operations recovery)` : null;

  if (service === "pet_taxi") {
    const trip = String(row.trip_status || ""), actionableAt = start - TAXI_PICKUP_EARLY_MS;
    base.trip = { id: String(row.trip_id || ""), status: trip, vehicleId: row.trip_vehicle_id || null };
    base.taxi = { scheduleStatus: String(row.taxi_schedule_status || ""), balance: num(row.taxi_balance), fee: num(row.taxi_fee), tripPayment: String(row.trip_payment_status || "") };
    base.pickup = coords(row.origin_lat, row.origin_lng) || base.doorstep;
    base.dropoff = coords(row.dest_lat, row.dest_lng);
    if (!row.trip_id) return out("inactive", actionableAt, null, "no taxi_trips row for this booking");
    if (trip === "completed" && (base.taxi.scheduleStatus === "paid" || base.taxi.tripPayment === "gateway_paid")) return out("done", actionableAt, null, "trip completed and final balance settled");
    if (trip === "completed") return out("due", actionableAt, null, "trip completed; final balance still due from the customer");
    if (["recovery_pending"].includes(trip) || ["reassignment_needed", "reassignment_offered"].includes(bookingStatus)) return out("inactive", actionableAt, null, `trip in driver recovery (${bookingStatus}/${trip}) - Operations owns it`);
    if (now < actionableAt) return out("upcoming", actionableAt, null, `pickup can be confirmed from ${iso(actionableAt)}`);
    if (now > start + TAXI_STALE_AFTER_MS) return out("missed", actionableAt, null, `pickup was ${iso(start)}; older than ${TAXI_STALE_AFTER_MS / DAY} days`);
    return out("due", actionableAt, null, `pickup window open since ${iso(actionableAt)}`);
  }

  if (service === "pet_sitting") {
    const careReady = String(row.sitting_care_status || "") === "ready";
    base.carePlanReady = careReady;
    base.balance = row.stay_schedule_status ? { status: String(row.stay_schedule_status), amount: num(row.stay_balance) } : null;
    if (bookingStatus === "completed") return out("done", start, end, "sitting completed");
    if (!CAPTURED.has(paymentStatus) && bookingStatus !== "in_progress") base.notes.push(`payment status ${paymentStatus || "unknown"}`);
    if (!careReady) base.notes.push("care plan not submitted (the customer will submit it before check-in)");
    if (base.balance && base.balance.status !== "paid") base.notes.push(`split balance ${base.balance.status} (paid before check-in)`);
    if (offerNote && ["confirmed", "awaiting_provider_acceptance"].includes(bookingStatus)) base.notes.push(offerNote);
    if (!base.doorstep) base.notes.push("no doorstep coordinates found - geofenced check-in will be refused");
    if (bookingStatus === "in_progress") return out("due", start, end, "checked in; proof and check-out still open");
    if (now < start) return out("upcoming", start, end, `check-in opens ${iso(start)} and closes ${iso(end)}`);
    if (now >= end - SITTING_MIN_LEFT_MS) return out("missed", start, end, `check-in window closed at ${iso(end)} before the sitter checked in`);
    return out("due", start, end, `check-in window open until ${iso(end)}`);
  }

  if (service === "boarding") {
    const checkIn = Date.parse(String(row.check_in_at || row.scheduled_start)), checkOut = Date.parse(String(row.check_out_at || row.scheduled_end));
    const stayStatus = String(row.stay_status || "");
    base.stay = { id: String(row.stay_id || ""), status: stayStatus, carePlan: String(row.stay_care_plan_status || ""), checkIn: String(row.check_in_status || ""), checkOut: String(row.check_out_status || ""), checkInAt: iso(checkIn), checkOutAt: iso(checkOut), days: stayDays(checkIn, checkOut) };
    base.balance = row.stay_schedule_status ? { status: String(row.stay_schedule_status), amount: num(row.stay_balance) } : null;
    if (!row.stay_id) return out("inactive", checkIn, checkOut, "no boarding_stays row for this booking");
    if (stayStatus === "completed" || bookingStatus === "completed") return out("done", checkIn, checkOut, "stay checked out");
    if (stayStatus === "cancelled") return out("inactive", checkIn, checkOut, "stay cancelled");
    if (!CAPTURED.has(paymentStatus)) base.notes.push(`payment status ${paymentStatus || "unknown"} - host acceptance needs a captured payment`);
    if (base.stay.carePlan !== "ready") base.notes.push("care plan not submitted (the customer will submit it before check-in)");
    if (base.balance && base.balance.status !== "paid") base.notes.push(`split balance ${base.balance.status} (paid before check-in)`);
    if (offerNote && ["awaiting_host_acceptance", "recovery_pending"].includes(stayStatus)) base.notes.push(offerNote);
    if (base.stay.days.length > 1) base.notes.push(`${base.stay.days.length}-day stay: check-out needs a meal, play and verified photo on each of ${base.stay.days.join(", ")}`);
    if (stayStatus === "in_progress") return out("due", checkIn, checkOut, now < checkOut ? `checked in; milestones open until ${iso(checkOut)}` : "checked in; window over - only check-out can still be tried");
    if (now < checkIn) return out("upcoming", checkIn, checkOut, `check-in opens ${iso(checkIn)}; finish by ${iso(checkOut - BOARDING_MIN_LEFT_MS)}`);
    if (now >= checkOut - BOARDING_MIN_LEFT_MS) return out("missed", checkIn, checkOut, `stay window ends ${iso(checkOut)}; too late to check in and record the day's milestones`);
    return out("due", checkIn, checkOut, `check-in window open until ${iso(checkOut)}`);
  }
  return out("inactive", null, null, `unsupported service ${service}`);
}
function coords(lat, lng) {
  const latitude = num(lat), longitude = num(lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude || longitude) ? { latitude, longitude } : null;
}
/** Most urgent first: the soonest closing window (Sitting, Boarding), then Pet Taxi by pickup time. */
export const byUrgency = (a, b) => (a.closesAt ?? Infinity) - (b.closesAt ?? Infinity) || a.start - b.start;

/** One-line schedule entry for a "not yet due" row (the main session schedules the next run from these). */
export const scheduleEntry = (b) => ({
  bookingId: b.bookingId, provider: b.providerId, package: b.packageCode, start: b.startIso, end: b.endIso,
  actionableAtUtc: b.actionableAtUtc, closesAtUtc: b.closesAtUtc,
  latestUsefulStartUtc: b.service === "boarding" && b.closesAt ? iso(b.closesAt - BOARDING_MIN_LEFT_MS) : b.service === "pet_sitting" && b.closesAt ? iso(b.closesAt - SITTING_MIN_LEFT_MS) : null,
  state: [b.bookingStatus, b.stay?.status, b.trip?.status].filter(Boolean).join("/"), notes: b.notes, reason: b.reason,
});

// ---------------------------------------------------------------------------------------------------------------
// D1 read-backs after a lifecycle (each query runs on its own, so one missing table cannot hide the others).
// ---------------------------------------------------------------------------------------------------------------
export function readbackQueries(service, bookingId) {
  const q = (name, sql, params = [bookingId]) => ({ name, sql, params });
  const common = [
    q("booking", "SELECT b.status booking_status,b.total_amount,b.provider_id,w.status work_order_status,p.status payment_status,p.amount,p.amount_due_now FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=?"),
    q("payoutComputation", "SELECT provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,term_id FROM provider_payout_computations WHERE booking_id=?"),
    q("orderCommission", "SELECT provider_id,status,commission_amount,order_amount FROM provider_order_commissions WHERE booking_id=?"),
    q("journal", "SELECT COUNT(*) lines,ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=?"),
    q("media", "SELECT id,purpose,scan_status,access_status FROM service_media_assets WHERE booking_id=? ORDER BY created_at"),
    q("reconciliation", "SELECT expected_amount,captured_amount,reconciliation_status,gateway_status FROM payment_reconciliation_records WHERE booking_id=?"),
  ];
  if (service === "boarding") return [...common,
    q("stay", "SELECT id,status,check_in_status,check_out_status,care_plan_status FROM boarding_stays WHERE booking_id=?"),
    q("capacityLock", "SELECT status FROM boarding_capacity_locks WHERE booking_id=?"),
    q("events", "SELECT event_type,COUNT(*) n FROM boarding_stay_events WHERE booking_id=? GROUP BY event_type ORDER BY MIN(created_at)"),
    q("providerLifecycle", "SELECT to_status,COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? GROUP BY to_status ORDER BY MIN(created_at)"),
  ];
  if (service === "pet_sitting") return [...common,
    q("carePlan", "SELECT status FROM sitting_care_plan_snapshots WHERE booking_id=?"),
    q("events", "SELECT event_type,COUNT(*) n FROM sitting_care_events WHERE booking_id=? GROUP BY event_type ORDER BY MIN(created_at)"),
    q("providerLifecycle", "SELECT to_status,COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? GROUP BY to_status ORDER BY MIN(created_at)"),
  ];
  return [...common,
    q("trip", "SELECT status,vehicle_id,pickup_verification_status,dropoff_verification_status FROM taxi_trips WHERE booking_id=?"),
    q("schedule", "SELECT status,booking_fee_amount,balance_amount,total_amount,CASE WHEN final_paid_at IS NULL THEN 0 ELSE 1 END final_paid FROM taxi_payment_schedules WHERE booking_id=?"),
    q("tripPayment", "SELECT status,amount FROM taxi_trip_payment_events WHERE booking_id=?"),
    q("ownerPayout", "SELECT vehicle_id,ownership_model,order_value,owner_commission_amount,pawspace_gross_share,gst_liability,beneficiary_status FROM taxi_vehicle_owner_payout_computations WHERE booking_id=?"),
    q("fleet", "SELECT status FROM taxi_fleet_reservations WHERE booking_id=?"),
    q("events", "SELECT event_type,COUNT(*) n FROM taxi_trip_events WHERE booking_id=? GROUP BY event_type ORDER BY MIN(created_at)"),
  ];
}
/** Provider-wide job count (the partner job feed reads only the first 500 by scheduled_start). */
export const providerJobCountSql = "SELECT COUNT(*) n, SUM(CASE WHEN scheduled_start<? THEN 1 ELSE 0 END) older FROM canonical_bookings WHERE provider_id=?";

const first = (value) => (Array.isArray(value) ? value[0] || null : null);
const eventSet = (value) => new Map((Array.isArray(value) ? value : []).map(row => [String(row.event_type ?? row.to_status), Number(row.n || 0)]));
/** What the books must show once a lifecycle completed. Returns {checked, problems[], facts}. */
export function evaluateReadback(service, rb, { providerId, total } = {}) {
  const problems = [], facts = {};
  const skipped = Object.values(rb).some(value => value && value.skipped);
  if (skipped) return { checked: false, problems: [], facts: { skipped: true } };
  const booking = first(rb.booking), payout = first(rb.payoutComputation), journal = first(rb.journal);
  facts.booking = booking; facts.payout = payout && { provider: payout.provider_id, net: payout.provider_net_payout, order: payout.order_value }; facts.journal = journal;
  if (!booking) problems.push("canonical booking row not readable");
  else if (booking.booking_status !== "completed") problems.push(`canonical_bookings.status=${booking.booking_status} (expected completed)`);
  if (!payout) problems.push("no provider_payout_computations row (completion finance not resolved)");
  if (!journal || Number(journal.lines) < 2) problems.push("no SERVICE-COMPLETION journal lines");
  else if (Math.abs(Number(journal.debit) - Number(journal.credit)) > 0.01) problems.push(`completion journal unbalanced: debit ${journal.debit} credit ${journal.credit}`);
  if (service === "boarding") {
    const stay = first(rb.stay), lock = first(rb.capacityLock), events = eventSet(rb.events), life = eventSet(rb.providerLifecycle);
    facts.stay = stay; facts.events = Object.fromEntries(events); facts.lifecycle = Object.fromEntries(life);
    if (!stay || stay.status !== "completed" || stay.check_out_status !== "complete") problems.push(`boarding_stays ${JSON.stringify(stay)}`);
    if (lock && lock.status !== "released") problems.push(`capacity lock still ${lock.status}`);
    for (const type of ["checked_in", "care_meal", "care_play", "proof_daily_update", "checked_out"]) if (!events.get(type)) problems.push(`no ${type} stay event`);
    if (!life.get("completed")) problems.push("no provider lifecycle transition to completed");
    if (payout && providerId && payout.provider_id !== providerId) problems.push(`payout computed for ${payout.provider_id}, host is ${providerId}`);
  } else if (service === "pet_sitting") {
    const events = eventSet(rb.events), life = eventSet(rb.providerLifecycle);
    facts.events = Object.fromEntries(events); facts.lifecycle = Object.fromEntries(life);
    if (booking && booking.work_order_status !== "completed") problems.push(`work order ${booking.work_order_status} (expected completed)`);
    for (const type of ["checked_in", "checked_out", "report_card_dispatched"]) if (!events.get(type)) problems.push(`no ${type} care event`);
    if (!life.get("completed")) problems.push("no provider lifecycle transition to completed");
    if (payout && providerId && payout.provider_id !== providerId) problems.push(`payout computed for ${payout.provider_id}, sitter is ${providerId}`);
  } else {
    const trip = first(rb.trip), schedule = first(rb.schedule), tripPayment = first(rb.tripPayment), owner = first(rb.ownerPayout), recon = first(rb.reconciliation), events = eventSet(rb.events);
    facts.trip = trip; facts.schedule = schedule; facts.tripPayment = tripPayment; facts.owner = owner; facts.reconciliation = recon; facts.events = Object.fromEntries(events);
    if (!trip || trip.status !== "completed") problems.push(`taxi_trips ${JSON.stringify(trip)}`);
    if (!schedule || schedule.status !== "paid" || Number(schedule.final_paid) !== 1) problems.push(`taxi_payment_schedules ${JSON.stringify(schedule)} (expected paid with final_paid_at)`);
    if (!tripPayment || tripPayment.status !== "gateway_paid") problems.push(`taxi_trip_payment_events ${JSON.stringify(tripPayment)} (expected gateway_paid)`);
    if (booking && booking.payment_status !== "captured") problems.push(`booking_payments.status=${booking.payment_status}`);
    const expected = Number(total ?? booking?.total_amount);
    if (!recon) problems.push("no payment_reconciliation_records row");
    else if (Math.abs(Number(recon.captured_amount) - expected) > 0.01 || recon.reconciliation_status !== "matched") problems.push(`reconciliation captured ${recon.captured_amount} of ${expected}, ${recon.reconciliation_status}`);
    if (!owner) problems.push("no taxi_vehicle_owner_payout_computations row");
    for (const type of ["vehicle_assigned", "pickup_confirmed", "trip_started", "arrived_dropoff", "dropoff_confirmed", "trip_completed"]) if (!events.get(type)) problems.push(`no ${type} trip event`);
    if ((events.get("route_location_sample") || 0) < 2) problems.push(`${events.get("route_location_sample") || 0} route samples`);
  }
  return { checked: true, problems, facts };
}

// ---- deterministic PNG (gradient) for proof uploads, same generator as the round-1 partner helpers -----------------
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
export function makePng(file, w = 96, h = 96, rgb = [40, 150, 90]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (rgb[0] + x) & 255; raw[o + 1] = (rgb[1] + y) & 255; raw[o + 2] = rgb[2]; }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, png); return file;
}
