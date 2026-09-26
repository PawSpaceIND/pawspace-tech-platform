/**
 * The Booking Command Center snapshot: the same JSON for every row, at a fixed number of D1 calls.
 * [staging master E2E run 36243387701 row 40]
 *
 * MEASURED: GET /api/booking-command-center read the pets and seven child tables of each booking with
 * 8 queries per row, row after row. The default 150-row window cost 1,209 D1 calls with a serial depth
 * of ~158; at the ~0.3 s per call staging showed, that is ~49 s, and the staff page sat on "Loading
 * connected booking records…" while the E2E searched for a Training booking it had just made. Six of
 * those child tables had no booking_id index, so each of the 1,050 child reads was also a table scan.
 *
 * The reads are now one per chunk of booking ids. This suite proves:
 *   - the response is field-identical to the per-row reads for every row. The oracle below is the
 *     snapshot exactly as it stood at a3928d2, run against the same seeded database with the schema
 *     production has today (before this change's indexes); the data has ties on every timestamp and on
 *     pet names, a pet another customer owns, duplicate and missing pet ids, tickets without a
 *     booking, unified complaint cases, and windows that span several chunks;
 *   - the call count no longer depends on the window size (within a chunk) or on child rows;
 *   - every child read searches a booking_id index, and the route's DDL runs once per D1 binding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__BCC_QUERY_BUDGET_DB__", "__BCC_QUERY_BUDGET_ENV__");

const route = await import("../app/api/booking-command-center/route.ts");
const { bookingPaymentBalances } = await import("../lib/booking-payment-balances.ts");
const { bookingSupportCases } = await import("../lib/booking-support-cases.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
const { ensureUnifiedCaseTables } = await import("../lib/unified-case-center.ts");

const ORIGIN = "https://app.pawspace.in";
const MANAGER_EMAIL = "manager.query-budget@pawspace.in";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const CHILD_TABLES = ["booking_lifecycle_events", "booking_operational_events", "booking_customer_notifications", "booking_rebooking_cases", "booking_refund_cases", "customer_experience_tickets", "booking_admin_actions"];

/** A counting D1 (bind cap and call meter from helpers/d1-harness.mjs) that also records every SQL text it runs. */
function recordingD1(sqlite) {
  const counting = makeCountingD1(sqlite);
  const sql = [];
  const wrap = (statement) => ({
    ...statement,
    bind: (...args) => wrap(statement.bind(...args)),
    first: () => { sql.push(statement.sql); return statement.first(); },
    run: () => { sql.push(statement.sql); return statement.run(); },
    all: () => { sql.push(statement.sql); return statement.all(); },
  });
  return {
    db: {
      prepare: (text) => wrap(counting.db.prepare(text)),
      batch: (statements) => { for (const statement of statements) sql.push(statement.sql); return counting.db.batch(statements); },
      exec: (text) => { sql.push(text); return counting.db.exec(text); },
    },
    sql,
    calls: counting.calls,
    reset: () => { counting.reset(); sql.length = 0; },
  };
}

/** The DDL string literals a source file passes to prepare(), as its own module would run them. */
const preparedDdl = (source) => [...source.matchAll(/prepare\("((?:CREATE TABLE|CREATE INDEX)[^"]*)"\)/g)].map((match) => match[1]);

/*
 * The snapshot as it stood at a3928d2 - bookingRows, bookingSnapshot and parse - with its per-row
 * reads unchanged, plus the per-row reschedule read #1111 added. It is the oracle: the route must answer
 * exactly what this answered.
 */
const legacyParse = (value) => { try { return JSON.parse(String(value || "{}")); } catch { return {}; } };
async function legacySnapshot(db, scope, options = {}) {
  const where = [], binds = [];
  if (scope) { where.push("lower(b.city_id)=?"); binds.push(scope.cityId); }
  const q = String(options.q || "").trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    where.push("(lower(b.id) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\' OR c.primary_phone LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' OR lower(w.provider_name) LIKE ? ESCAPE '\\' OR lower(b.package_name) LIKE ? ESCAPE '\\')");
    binds.push(like, like, like, like, like, like);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 150)));
  const order = options.sort === "schedule" ? "b.scheduled_start DESC" : "b.created_at DESC, b.scheduled_start DESC";
  const sql = `SELECT b.*,c.name customer_name,c.primary_phone,c.secondary_phone,c.email customer_email,c.source customer_source,
    w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,w.assignment_json,
    p.id payment_id,p.amount payment_amount,p.amount_due_now,p.method payment_method,p.mode payment_mode,p.status payment_status,p.gateway,p.detail_json payment_detail_json
    FROM canonical_bookings b
    JOIN canonical_customers c ON c.id=b.customer_id
    JOIN provider_work_orders w ON w.booking_id=b.id
    JOIN booking_payments p ON p.booking_id=b.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order} LIMIT ${limit}`;
  const rows = await db.prepare(sql).bind(...binds).all();
  const balances = await bookingPaymentBalances(db, rows.results.map((row) => String(row.id)));
  const supportCases = await bookingSupportCases(db, rows.results.map((row) => String(row.id)));
  const casesByBooking = new Map();
  for (const supportCase of supportCases) { const id = String(supportCase.booking_id); casesByBooking.set(id, [...(casesByBooking.get(id) || []), supportCase]); }
  const bookings = [];
  for (const row of rows.results) {
    const [pets, lifecycle, operations, notifications, rebooking, refunds, tickets, adminActions] = await Promise.all([
      db.prepare("SELECT id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.customer_id, row.pet_ids_json).all(),
      db.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM booking_operational_events WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM booking_customer_notifications WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM booking_rebooking_cases WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM customer_experience_tickets WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
      db.prepare("SELECT * FROM booking_admin_actions WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all(),
    ]);
    const rescheduleRequests = (await db.prepare("SELECT id,status,from_start,to_start,difference_amount,new_total_amount,target_provider_id,refund_case_id,failure_reason,created_at,updated_at FROM grooming_reschedule_requests WHERE booking_id=? ORDER BY created_at DESC").bind(row.id).all()).results;
    const balance = balances.get(String(row.id));
    if (!balance) throw new Error("Canonical payment balance unavailable");
    bookings.push({ ...row, rescheduleRequests, original_amount_due_now: row.amount_due_now, amount_due_now: balance.dueNow, payment_stage: balance.stage, outstanding_balance: balance.outstandingBalance, pricing: legacyParse(row.pricing_json), assignment: legacyParse(row.assignment_json), paymentDetail: legacyParse(row.payment_detail_json), pets: pets.results, lifecycle: lifecycle.results, operations: operations.results, notifications: notifications.results, rebooking: rebooking.results, refunds: refunds.results, tickets: [...tickets.results, ...(casesByBooking.get(String(row.id)) || [])], adminActions: adminActions.results });
  }
  return { source: "canonical UAT database snapshot + live stream", bookings, organizationalScope: scope ?? "global" };
}

async function get(path = "") {
  const response = await route.GET(new Request(`${ORIGIN}/api/booking-command-center${path}`, { headers: { "oai-authenticated-user-email": MANAGER_EMAIL } }));
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 300));
  return { text, body: JSON.parse(text) };
}

/*
 * A database shaped like production today: the twelve tables this route creates, WITHOUT the booking_id
 * indexes this change adds, plus the two indexes app/api/canonical-bookings/route.ts has long created
 * there (every booking goes through it). Taken from the sources, not copied, so they cannot drift.
 */
async function productionShapedWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const harness = recordingD1(sqlite);
  globalThis.__BCC_QUERY_BUDGET_DB__ = harness.db;
  globalThis.__BCC_QUERY_BUDGET_ENV__ = {};
  await ensureSecurityTables(harness.db);
  await ensurePeopleTables(harness.db);
  await ensureUnifiedCaseTables(harness.db);
  const routeTables = preparedDdl(read("app/api/booking-command-center/route.ts")).filter((sql) => sql.startsWith("CREATE TABLE"));
  assert.equal(routeTables.length, 12);
  for (const sql of routeTables) sqlite.exec(sql);
  // The pay-the-difference reschedule table (#1111), exactly as lib/grooming-reschedule-schema.ts creates it.
  const rescheduleDdl = [...read("lib/grooming-reschedule-schema.ts").matchAll(/prepare\("(CREATE [^"]*)"\)/g)].map((match) => match[1]);
  assert.equal(rescheduleDdl.length, 4);
  for (const sql of rescheduleDdl) sqlite.exec(sql);
  const canonicalIndexes = preparedDdl(read("app/api/canonical-bookings/route.ts")).filter((sql) => /idx_booking_lifecycle_events_booking|idx_canonical_pets_customer/.test(sql));
  assert.equal(canonicalIndexes.length, 2);
  for (const sql of canonicalIndexes) sqlite.exec(sql);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").run("USR-BUDGET-MANAGER", MANAGER_EMAIL, "Ops Manager", "manager", now, now);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)")
    .run("EMP-BUDGET-MANAGER", MANAGER_EMAIL, "EMP-OPS-BUDGET", "Ops Manager", MANAGER_EMAIL, "9999999998", now - 86_400_000, now, now);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time','confirmed','Operations Manager','operations',NULL,'CC-OPERATIONS','BLR','Scoped operations manager','test',?)")
    .run("EEV-BUDGET-MANAGER", "EMP-BUDGET-MANAGER", now - 86_400_000, now);
  return { sqlite, ...harness };
}

const BASE = Date.parse("2026-09-01T00:00:00.000Z");
const CUSTOMERS = 20;
const customerId = (n) => `CUS-BUDGET-${String(n % CUSTOMERS).padStart(2, "0")}`;
const bookingId = (n) => `BK-BUDGET-${String(n).padStart(4, "0")}`;

/*
 * Seeds `count` Bengaluru bookings (the manager is BLR-scoped) with `children` rows per child table, and
 * pets, payments and work orders for each. Child rows are inserted round-robin across
 * bookings and with ids that run AGAINST insertion order, and every pair of rows shares a timestamp, so
 * a read that ordered ties by id, or by whichever index it happened to use, would give a different list.
 */
function seed(sqlite, { count, children }) {
  const run = (sql, ...args) => sqlite.prepare(sql).run(...args);
  for (let c = 0; c < CUSTOMERS; c += 1) {
    const id = customerId(c);
    run("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", id, "blr", `Budget Customer ${c}`, `90000${String(c).padStart(5, "0")}`, null, `budget${c}@example.test`, "test", "{}", BASE, BASE);
    // Two pets share a name; "z" is inserted before "a", so name ties come back in insertion order, not id order.
    run("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", `PET-${id}-z`, id, "Bruno", "dog", "Indie", "verified", null, BASE, BASE);
    run("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", `PET-${id}-a`, id, "Bruno", "dog", null, "not_provided", null, BASE, BASE);
    run("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", `PET-${id}-m`, id, "Alpha", "cat", "Persian", "verified", null, BASE, BASE);
  }
  // Owned by someone who books nothing here; it sorts first by name, so a leak could not hide.
  run("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "CUS-BUDGET-OTHER", "blr", "Other Owner", "9111111111", null, null, "test", "{}", BASE, BASE);
  run("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "PET-OTHER-OWNER", "CUS-BUDGET-OTHER", "Aaron", "dog", null, "verified", null, BASE, BASE);

  for (let n = 1; n <= count; n += 1) {
    const id = bookingId(n), customer = customerId(n), created = BASE + n * 1000, start = new Date(BASE + 30 * 86_400_000 + n * 3_600_000).toISOString();
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    const pets = [[], [`PET-${customer}-z`, `PET-${customer}-a`], [`PET-${customer}-z`, "PET-OTHER-OWNER", `PET-${customer}-a`, "PET-MISSING", `PET-${customer}-z`], [`PET-${customer}-m`, `PET-${customer}-z`], [`PET-${customer}-a`]][n % 5];
    run("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, `IDEM-${id}`, customer, JSON.stringify(pets), "[]", "blr", "blr-central", n % 2 ? "dog_training" : "grooming", "pkg", n % 2 ? "Basic Obedience" : "Essential Bath", `GROUP-${id}`, "PRV-BUDGET", start, end, n % 3 ? "confirmed" : "completed", "customer_app", 1000 + n, "INR", JSON.stringify({ discount: n % 4 }), "test", created, created);
    run("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `WO-${id}`, id, `GROUP-${id}`, "PRV-BUDGET", "Budget Trainer", "full_time", "grooming", start, end, 1 + (n % 8), "assigned", JSON.stringify({ reservations: [n] }), created, created);
    run("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      `PAY-${id}`, id, customer, 1000 + n, n % 2 ? 0 : 500, "INR", "upi", n % 2 ? "pay_after_service" : "prepaid", n % 3 ? "created" : "captured", "uat_sandbox", `PAY-IDEM-${id}`, JSON.stringify({ n }), created, created);
  }

  for (let j = 0; j < children; j += 1) {
    for (let n = 1; n <= count; n += 1) {
      const id = bookingId(n), at = BASE + n * 1000 + Math.floor(j / 2) * 10, key = `${id}-${String(children - j).padStart(2, "0")}`;
      run("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)", `LC-${key}`, id, `event_${j}`, "booking", id, "system", JSON.stringify({ j }), at);
      run("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)", `OP-${key}`, id, "PRV-BUDGET", "provider_delay", `delay ${j}`, j * 5, "{}", "ops", at);
      run("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)", `NT-${key}`, id, customerId(n), "whatsapp", "update", `message ${j}`, "queued", `EV-${key}`, at);
      run("INSERT INTO booking_rebooking_cases (id,booking_id,source_event_id,status,reason,eligible_at,selected_start,assigned_provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", `RB-${key}`, id, `EV-${key}`, "offered", `reason ${j}`, at, null, null, at, at);
      run("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", `RF-${key}`, id, `PAY-${id}`, 100 + j, `refund ${j}`, "requested", "ops", null, null, at, at);
      run("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,lead_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", `TK-${key}`, customerId(n), id, null, "service", j % 2 ? "high" : "normal", `ticket ${j}`, "detail", "cx", "cx-lead", at + 3_600_000, j % 3 ? "open" : "resolved", 0, "We received your request", "ops", at, at);
      run("INSERT INTO booking_admin_actions (id,booking_id,action,reason,detail_json,actor_email,created_at) VALUES (?,?,?,?,?,?,?)", `AA-${key}`, id, "call_customer", `follow-up ${j}`, "{}", MANAGER_EMAIL, at);
    }
  }
  // Pay-the-difference reschedules (#1111) on every third booking: two per booking sharing a timestamp, with
  // ids against insertion order, so their order is pinned the same way as the child lists'.
  for (let n = 3; n <= count; n += 3) {
    const id = bookingId(n), at = BASE + n * 1000 + 5;
    for (const [suffix, status] of [["b", "applied"], ["a", "expired"]]) {
      run("INSERT INTO grooming_reschedule_requests (id,booking_id,customer_id,payment_id,from_start,from_end,to_start,to_end,current_provider_id,target_provider_id,booked_amount,new_slot_amount,difference_amount,booking_total_before,new_total_amount,consent_revision,status,failure_reason,refund_case_id,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        `RS-${id}-${suffix}`, id, customerId(n), `PAY-${id}`, "2026-10-01T04:30:00.000Z", "2026-10-01T05:30:00.000Z", "2026-10-02T04:30:00.000Z", "2026-10-02T05:30:00.000Z", "PRV-BUDGET", "PRV-BUDGET", 1000, 1200, 200, 1000 + n, 1200 + n, "v1", status, status === "expired" ? "hold_lapsed_before_payment" : null, null, "customer", at, at);
    }
  }
  // A ticket about no booking, and unified complaint cases that merge into `tickets` (plus one that must not).
  run("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,lead_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", "TK-NO-BOOKING", customerId(1), null, "LEAD-1", "sales", "normal", "no booking", "detail", "cx", "cx-lead", BASE, "open", 0, "We received your request", "ops", BASE, BASE);
  for (let n = 7; n <= count; n += 7) {
    for (const [suffix, caseType] of [["a", "customer_complaint"], ["b", "customer_complaint"], ["c", "provider_incident"]]) {
      run("INSERT INTO unified_cases (id,idempotency_key,case_type,severity,status,title,description,customer_id,booking_id,source_type,source_id,owner_team,first_response_due_at,resolution_due_at,manager_escalation_due_at,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        `UC-${n}-${suffix}`, `UC-IDEM-${n}-${suffix}`, caseType, "high", "open", `case ${suffix}`, "detail", customerId(n), bookingId(n), "test", `SRC-${n}`, "cx", BASE, BASE, BASE, "ops", BASE + n, "ops", BASE + n);
    }
  }
}

/** Row by row, so a mismatch names the booking and field instead of diffing 200 bookings at once. */
function assertSameSnapshot(actual, oracle, label) {
  assert.deepEqual(actual.body.bookings.map((booking) => booking.id), oracle.bookings.map((booking) => booking.id), `${label}: the same rows in the same order`);
  for (const [index, booking] of oracle.bookings.entries()) assert.deepEqual(actual.body.bookings[index], booking, `${label}: booking ${booking.id} is field-identical to the per-row reads`);
  assert.deepEqual({ ...actual.body, bookings: [] }, { ...oracle, bookings: [] }, `${label}: envelope`);
  assert.ok(actual.text === JSON.stringify(oracle), `${label}: byte-identical, key order included`);
}

const scopeOf = (body) => (body.organizationalScope === "global" ? null : body.organizationalScope);

test("the snapshot answers exactly what the per-row reads answered, for every row, window and chunk", async () => {
  const w = await productionShapedWorld();
  seed(w.sqlite, { count: 200, children: 4 });
  // The oracle runs first, on today's schema: once the route has run, its new indexes exist.
  const views = ["", "?limit=500", "?limit=37", "?q=basic%20obedience", "?q=bk-budget-01", "?sort=schedule&limit=120"];
  const expected = [];
  for (const view of views) {
    const url = new URL(`${ORIGIN}/api/booking-command-center${view}`);
    expected.push(await legacySnapshot(w.db, { cityId: "blr" }, route.parseBookingListOptions(url)));
  }

  for (const [index, view] of views.entries()) {
    const actual = await get(view);
    assert.equal(scopeOf(actual.body)?.cityId, "blr", "the oracle ran with the scope the route resolved");
    const oracle = JSON.parse(JSON.stringify({ ...expected[index], organizationalScope: actual.body.organizationalScope }));
    assert.equal(expected[index].bookings.length > 0, true, `${view} returns rows`);
    assertSameSnapshot(actual, oracle, `GET ${view || "(default)"}`);
  }
  // Warm: the DDL is memoized and the indexes now exist; the answer does not move.
  const warm = await get("?limit=500");
  assertSameSnapshot(warm, JSON.parse(JSON.stringify({ ...expected[1], organizationalScope: warm.body.organizationalScope })), "warm GET ?limit=500");

  // The data really exercises what equality has to survive, so it is not equal by being empty.
  const all = expected[1].bookings;
  assert.equal(all.length, 200, "?limit=500 spans three chunks of 80 booking ids");
  assert.equal(expected[0].bookings.length, 150, "the default window leaves 50 bookings (and their child rows) out");
  const leaky = all.find((booking) => JSON.parse(booking.pet_ids_json).includes("PET-OTHER-OWNER"));
  assert.deepEqual(leaky.pets.map((pet) => pet.id), [`PET-${leaky.customer_id}-z`, `PET-${leaky.customer_id}-a`], "another customer's pet, a missing id and a duplicate are not shown; equal names keep insertion order");
  assert.deepEqual(Object.keys(leaky.pets[0]), ["id", "name", "species", "breed", "vaccination_status"], "no customer_id or join key leaks into a pet");
  const withTies = all.find((booking) => booking.operations.length === 4);
  assert.equal(withTies.operations[0].created_at, withTies.operations[1].created_at, "timestamps tie");
  assert.ok(String(withTies.operations[0].id) > String(withTies.operations[1].id), "a tie is in insertion order, which here runs against id order");
  assert.ok(String(withTies.lifecycle[0].id) < String(withTies.lifecycle[1].id), "lifecycle ties come back newest insertion first, as its index returned them");
  const rescheduled = all.find((booking) => booking.id === bookingId(3));
  assert.deepEqual(rescheduled.rescheduleRequests.map((request) => request.id), [`RS-${bookingId(3)}-b`, `RS-${bookingId(3)}-a`], "reschedule ties keep insertion order");
  assert.deepEqual(Object.keys(rescheduled.rescheduleRequests[0]), ["id", "status", "from_start", "to_start", "difference_amount", "new_total_amount", "target_provider_id", "refund_case_id", "failure_reason", "created_at", "updated_at"], "the reschedule columns #1111 shows, and no join key");
  assert.deepEqual(all.find((booking) => booking.id === bookingId(4)).rescheduleRequests, []);
  const merged = all.find((booking) => booking.id === bookingId(7));
  assert.deepEqual(merged.tickets.slice(-2).map((ticket) => ticket.source_kind), ["unified_case", "unified_case"], "complaint cases still follow the booking's own tickets");
  assert.ok(!all.some((booking) => booking.tickets.some((ticket) => ticket.id === "TK-NO-BOOKING")));
});

async function warmCalls(w, path) {
  await get(path);
  w.reset();
  await get(path);
  return w.calls();
}

test("D1 calls no longer grow with the window or with each booking's child rows", async () => {
  const small = await productionShapedWorld();
  seed(small.sqlite, { count: 160, children: 1 });
  const smallCalls = await warmCalls(small, "");

  const large = await productionShapedWorld();
  seed(large.sqlite, { count: 400, children: 6 });
  const largeCalls = await warmCalls(large, "");
  assert.equal(largeCalls, smallCalls, "150 rows cost the same whether each booking has 1 or 6 rows per child table and the table holds 160 or 400 bookings");
  assert.ok(largeCalls <= 30, `the default window is a fixed handful of calls, used ${largeCalls}`);

  // Within one chunk of 80 booking ids the window size costs nothing extra.
  assert.equal(await warmCalls(large, "?limit=10"), await warmCalls(large, "?limit=80"), "10 rows and 80 rows cost the same");
  const maxWindow = await warmCalls(large, "?limit=500");
  assert.ok(maxWindow <= 70, `the 500-row cap (400 rows here, five chunks) stays bounded, used ${maxWindow}`);

  // The per-row loop it replaces, on the same data.
  large.reset();
  await legacySnapshot(large.db, { cityId: "blr" });
  assert.ok(large.calls() >= 8 * 150, `the per-row reads cost ${large.calls()} calls for the same window`);
});

test("every child read searches a booking_id index; none scans a table", async () => {
  const w = await productionShapedWorld();
  seed(w.sqlite, { count: 90, children: 2 });
  await get("");
  w.reset();
  await get("");
  const isSnapshotRead = (sql) => CHILD_TABLES.some((table) => sql.includes(`FROM ${table} WHERE booking_id IN (`)) || sql.includes("FROM canonical_bookings b JOIN canonical_pets");
  const reads = [...new Set(w.sql.filter(isSnapshotRead))];
  assert.equal(reads.length, 8 * 2, "the pets and seven child tables, each read once per chunk (90 rows = 2 chunks)");
  for (const table of CHILD_TABLES) assert.ok(reads.some((sql) => sql.includes(`FROM ${table} WHERE booking_id IN (`)), table);
  for (const sql of reads) {
    const binds = (sql.match(/\?/g) || []).map(() => "x");
    const plan = w.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds).map((row) => String(row.detail));
    assert.deepEqual(plan.filter((detail) => /^SCAN (?!json_each)/.test(detail)), [], `no table scan: ${sql.slice(0, 80)}\n${plan.join("\n")}`);
    const table = CHILD_TABLES.find((name) => sql.includes(`FROM ${name} `));
    if (table) assert.ok(plan.some((detail) => detail.startsWith(`SEARCH ${table} USING INDEX idx_${table}_booking (booking_id=?)`)), `${table} is searched by its booking_id index\n${plan.join("\n")}`);
  }
});

test("the route's DDL runs once per D1 binding, and the migration carries the same indexes", async () => {
  const ddl = (w) => w.sql.filter((sql) => /^CREATE (TABLE|INDEX)/.test(sql));
  const w = await productionShapedWorld();
  seed(w.sqlite, { count: 5, children: 1 });
  w.reset();
  await get("");
  const routeDdl = preparedDdl(read("app/api/booking-command-center/route.ts"));
  assert.deepEqual(ddl(w).filter((sql) => routeDdl.includes(sql)), routeDdl, "the first request on a binding sends the route's whole DDL batch");
  const rescheduleSchema = (list) => list.filter((sql) => sql.includes("grooming_reschedule_requests") && /^CREATE /.test(sql));
  assert.equal(rescheduleSchema(w.sql).length, 4, "with the reschedule table's schema in the same batch");
  w.reset();
  await get("");
  await get("?q=bk-budget");
  assert.deepEqual(ddl(w).filter((sql) => routeDdl.includes(sql)), [], "later requests on the same binding send none of it");
  assert.deepEqual(rescheduleSchema(w.sql), [], "nor the reschedule schema, which #1111 had sent on every GET");

  const fresh = await productionShapedWorld();
  seed(fresh.sqlite, { count: 5, children: 1 });
  fresh.reset();
  await get("");
  assert.equal(ddl(fresh).filter((sql) => routeDdl.includes(sql)).length, routeDdl.length, "a new binding is provisioned again");

  const routeIndexes = routeDdl.filter((sql) => sql.startsWith("CREATE INDEX")).map((sql) => sql.replace(/\s+/g, ""));
  const migration = read("drizzle/0042_booking_child_booking_id_indexes.sql").replace(/--[^\n]*/g, "").split(";").map((sql) => sql.replace(/[`\s]/g, "")).filter(Boolean);
  assert.equal(routeIndexes.length, 7);
  assert.deepEqual(migration, routeIndexes, "drizzle/0042 creates exactly the indexes ensureTables creates");
});
