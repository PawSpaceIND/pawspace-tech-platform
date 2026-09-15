/**
 * The Booking Command Center list window. [Bengaluru sweep run 8, 2026-09-13]
 *
 * MEASURED: the founder persona created booking PS-UAT-MTZYTV6F-E2CB for four days out; the list API
 * answered 200 with 150 rows and the booking was not among them, so the search box (client-side over
 * the loaded rows) could not find it either. The window was the 150 bookings scheduled FURTHEST in the
 * future, and a seeded UAT database has more than 150 fixtures months ahead.
 *
 * The window is now newest-created first, `sort=schedule` keeps the old order, `q` searches the whole
 * table, and `limit` is capped. Each case here seeds 160 far-future fixtures plus one booking made
 * today and checks exactly which of them the operator gets back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOOKING_WINDOW_DB__", "__BOOKING_WINDOW_ENV__");

const ORIGIN = "https://app.pawspace.in";
const MANAGER_EMAIL = "manager.window@pawspace.in";
const NEW_BOOKING = "BK-NEW-TODAY";
const FIXTURES = 160;

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function get(path) {
  const route = await import("../app/api/booking-command-center/route.ts");
  const response = await route.GET(new Request(`${ORIGIN}/api/booking-command-center${path}`, { headers: { "oai-authenticated-user-email": MANAGER_EMAIL } }));
  return { status: response.status, body: await response.json() };
}

function seedBooking(sqlite, { id, customerId, scheduledStart, createdAt, providerName, packageName = "Essential Bath" }) {
  const end = new Date(new Date(scheduledStart).getTime() + 2 * 3_600_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `IDEM-${id}`, customerId, "[]", "[]", "blr", "blr-central", "grooming", "grooming-bath", packageName, `GROUP-${id}`, "PRV-WINDOW-1", scheduledStart, end, "confirmed", "customer_app", 1349, "INR", "{}", "test", createdAt, createdAt);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`WO-${id}`, id, `GROUP-${id}`, "PRV-WINDOW-1", providerName, "full_time", "grooming", scheduledStart, end, 1, "assigned", "{}", createdAt, createdAt);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`PAY-${id}`, id, customerId, 1349, 0, "INR", "pay_after_service", "pay_after_service", "created", "uat_sandbox", `PAY-IDEM-${id}`, "{}", createdAt, createdAt);
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BOOKING_WINDOW_DB__ = db;
  globalThis.__BOOKING_WINDOW_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensurePeopleTables } = await import("../lib/people-foundation.ts");
  await ensureSecurityTables(db);
  await ensurePeopleTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").run("USR-WINDOW-MANAGER", MANAGER_EMAIL, "Ops Manager", "manager", now, now);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)")
    .run("EMP-WINDOW-MANAGER", MANAGER_EMAIL, "EMP-OPS-WIN", "Ops Manager", MANAGER_EMAIL, "9999999999", now - 86_400_000, now, now);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time','confirmed','Operations Manager','operations',NULL,'CC-OPERATIONS','BLR','Scoped operations manager','test',?)")
    .run("EEV-WINDOW-MANAGER", "EMP-WINDOW-MANAGER", now - 86_400_000, now);

  const initialized = await get("");
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body).slice(0, 200));

  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-FIXTURE", "blr", "Fixture Customer", "9000000111", null, "fixture@example.test", "test", "{}", now - 30 * 86_400_000, now);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-TODAY", "blr", "Sweep Customer", "9000000777", null, "sweep@example.test", "test", "{}", now, now);
  const day = 86_400_000;
  for (let i = 1; i <= FIXTURES; i += 1) {
    seedBooking(sqlite, { id: `BK-FIXTURE-${String(i).padStart(3, "0")}`, customerId: "CUS-FIXTURE", scheduledStart: new Date(now + (30 + i) * day).toISOString(), createdAt: now - 10 * day + i, providerName: "Fixture Groomer" });
  }
  seedBooking(sqlite, { id: NEW_BOOKING, customerId: "CUS-TODAY", scheduledStart: new Date(now + 4 * day).toISOString(), createdAt: now, providerName: "PawSpace Grooming Team (UAT)" });
  return { sqlite, db };
}

const ids = (body) => (body.bookings || []).map(booking => String(booking.id));

test("a booking made today is in the default window even when 160 fixtures are scheduled later", async () => {
  await world();
  const { status, body } = await get("");
  assert.equal(status, 200);
  assert.equal(ids(body).length, 150, "the default window is still 150 rows");
  assert.equal(ids(body)[0], NEW_BOOKING, "newest-created first, so the operator sees today's booking at the top");
});

test("sort=schedule reproduces the old window, and q reaches beyond it", async () => {
  await world();
  const bySchedule = await get("?sort=schedule");
  assert.equal(bySchedule.status, 200);
  assert.equal(ids(bySchedule.body).length, 150);
  assert.ok(!ids(bySchedule.body).includes(NEW_BOOKING), "furthest-scheduled-first pushes a booking four days out below 150 fixtures months ahead (the sweep run 8 gap)");
  const searched = await get(`?sort=schedule&q=${NEW_BOOKING}`);
  assert.deepEqual(ids(searched.body), [NEW_BOOKING], "the search box reaches the whole table, not only the loaded window");
});

test("q matches booking id, customer name, phone and provider, case-insensitively, and LIKE wildcards are literal", async () => {
  await world();
  assert.deepEqual(ids((await get("?q=bk-new")).body), [NEW_BOOKING]);
  assert.deepEqual(ids((await get("?q=9000000777")).body), [NEW_BOOKING], "customer phone");
  assert.deepEqual(ids((await get("?q=sweep%20customer")).body), [NEW_BOOKING], "customer name");
  assert.deepEqual(ids((await get("?q=grooming%20team")).body), [NEW_BOOKING], "provider name");
  assert.deepEqual(ids((await get("?q=%25")).body), [], "a literal percent sign is not a wildcard");
  assert.deepEqual(ids((await get("?q=_")).body), [], "a literal underscore is not a wildcard");
  assert.equal(ids((await get("?q=fixture")).body).length, 150, "a broad search is still bounded by the window");
});

test("limit is honoured and capped", async () => {
  await world();
  assert.equal(ids((await get("?limit=10")).body).length, 10);
  assert.equal(ids((await get("?limit=1000")).body).length, FIXTURES + 1, "a large limit returns everything up to the 500 cap");
  assert.equal(ids((await get("?limit=0")).body).length, 150, "a nonsense limit falls back to the default window");
  assert.equal(ids((await get("?limit=abc")).body).length, 150);
});


test("bookingId deep links seed the command center server-search path", () => {
  const page = readFileSync(new URL("../app/booking-command-center/page.tsx", import.meta.url), "utf8");
  assert.match(page, /useSearchParams\(\)/);
  assert.match(page, /searchParams\.get\("bookingId"\)/);
  assert.match(page, /useState\(deepLinkedBookingId\)/);
  assert.match(page, /useRef\(deepLinkedBookingId\)/);
});
