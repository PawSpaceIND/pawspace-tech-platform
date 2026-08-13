import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// /admin used to render hard-coded numbers (Rs.32,482 "expected revenue", "8/10
// groomers active", an invented groomer calendar) with no database access at
// all. These tests execute the real overview builder over a real database and
// pin the two properties that matter: every number is derivable from the seeds,
// and anything without a source says so instead of showing a plausible figure.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}

const { buildOperationsOverview } = await import("../lib/operations-overview.ts");

// Monday 3 August 2026, 12:00 UTC — the day the prototype screen claimed to show.
const ASOF = Date.UTC(2026, 7, 3, 12, 0, 0);
const DAY = "2026-08-03";
// Hours are IST, because that is the clock the business runs on and the one every other module
// (scheduling roster, staff day board, pricing bands) reads.
const at = (hour) => new Date(`${DAY}T${String(hour).padStart(2, "0")}:00:00+05:30`).toISOString();

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT,category TEXT NOT NULL,priority TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,sla_due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',escalation_level INTEGER NOT NULL DEFAULT 0,customer_status TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}

function booking(sqlite, id, { service = "grooming", status = "confirmed", amount = 1000, hour = 9, provider = "PRV-1", zone = "blr-east" } = {}) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr',?,?,'pkg','Full Groom',?,?,?,?,?,'customer_app',?,'INR','{}','uat',?,?)")
    .run(id, `ik-${id}`, `CUS-${id}`, zone, service, `grp-${id}`, provider, at(hour), at(hour + 1), status, amount, ASOF, ASOF);
}
function provider(sqlite, id, name, zone = "blr-east", { status = "active", live = 1 } = {}) {
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,status,effective_from,updated_by,updated_at) VALUES (?,?,?,?,'[]',?,?,?,?,?,?)")
    .run(id, "blr", name, "grooming_partner", JSON.stringify([zone]), live, status, "2026-01-01", "uat", ASOF);
}

test("every headline number is computed from the seeds, with the P&L's revenue rule", async () => {
  const { sqlite, db } = fresh();
  booking(sqlite, "B1", { status: "completed", amount: 1200, hour: 9 });
  booking(sqlite, "B2", { status: "confirmed", amount: 4000, hour: 11, service: "boarding" });
  booking(sqlite, "B3", { status: "cancelled", amount: 900, hour: 13 });
  booking(sqlite, "B4", { status: "draft", amount: 5000, hour: 15 });
  booking(sqlite, "B5", { status: "confirmed", amount: 800, hour: 17, provider: "" }); // unassigned
  // A booking on another day must never leak into today.
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id='B1'").run(new Date("2026-08-04T09:00:00+05:30").toISOString());
  booking(sqlite, "B6", { status: "completed", amount: 1200, hour: 9 });

  provider(sqlite, "PRV-1", "Arun Rao");
  provider(sqlite, "PRV-2", "Priya Suresh");
  provider(sqlite, "PRV-3", "Naveen Jain", "blr-east", { status: "pending_verification", live: 0 });

  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-1", "CUS-B2", "quality", "high", "Late groomer", "d", "CX", "M", ASOF - 3600_000, "open", "open", "uat", ASOF, ASOF);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-2", "CUS-B2", "billing", "low", "Question", "d", "CX", "M", ASOF + 3600_000, "open", "open", "uat", ASOF, ASOF);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-3", "CUS-B2", "billing", "low", "Done", "d", "CX", "M", ASOF, "resolved", "closed", "uat", ASOF, ASOF);

  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.equal(overview.date, DAY);
  // Recognized: 4000 (confirmed) + 800 (confirmed, unassigned) + 1200 (completed today) = 6000.
  // NOT the cancelled 900, NOT the draft 5000, NOT the 1200 moved to the 4th.
  assert.equal(overview.metrics.recognizedRevenue, 6000);
  assert.equal(overview.metrics.bookingsToday, 3);
  assert.equal(overview.metrics.completed, 1);
  assert.equal(overview.metrics.cancelled, 1);
  assert.equal(overview.metrics.confirmed, 2);
  assert.equal(overview.metrics.unassigned, 1, "a booking with no provider is counted as unassigned");
  assert.equal(overview.metrics.providersActive, 2, "only live+active capacity profiles are active");
  assert.equal(overview.metrics.providersTotal, 3);
  assert.equal(overview.metrics.openTickets, 2, "resolved tickets are not open");
  assert.equal(overview.metrics.ticketsNeedingAttention, 1, "one ticket is past its SLA");

  // The same rule the P&L applies, checked against the P&L's own recognition query. Every seed here
  // sits between 09:00 and 18:00 IST, where the IST and UTC calendar dates agree, so the P&L's
  // date-prefix filter and the IST window select the same rows and the amounts are comparable.
  const recognized = sqlite.prepare("SELECT COALESCE(SUM(total_amount),0) t FROM canonical_bookings WHERE status!='cancelled' AND status!='draft' AND substr(scheduled_start,1,10)=?").get(DAY).t;
  assert.equal(overview.metrics.recognizedRevenue, recognized);
  // The counts must account for the whole day, not just its two named ends.
  assert.equal(overview.metrics.confirmed + overview.metrics.completed + overview.metrics.inProgress, overview.metrics.bookingsToday);
});

test("today is the IST day, not the UTC day", async () => {
  const { sqlite, db } = fresh();
  provider(sqlite, "PRV-1", "Arun Rao");
  // 20:00 IST on the 3rd is 14:30Z on the 3rd — both agree it is today.
  booking(sqlite, "LATE", { hour: 20, amount: 500 });
  // 00:30 IST on the 4th is 19:00Z on the *3rd*. Slicing the ISO string would file this under today.
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id='LATE'").run(new Date("2026-08-03T20:00:00+05:30").toISOString());
  booking(sqlite, "TOMORROW", { hour: 9, amount: 9000 });
  const tomorrowStart = new Date("2026-08-04T00:30:00+05:30").toISOString();
  sqlite.prepare("UPDATE canonical_bookings SET scheduled_start=? WHERE id='TOMORROW'").run(tomorrowStart);
  assert.equal(tomorrowStart.slice(0, 10), DAY, "the fixture only proves anything if its UTC prefix still reads as today");

  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.equal(overview.date, DAY);
  assert.equal(overview.dayWindow.timezone, "Asia/Kolkata");
  assert.equal(overview.dayWindow.startUtc, new Date(`${DAY}T00:00:00+05:30`).toISOString());
  assert.equal(overview.metrics.bookingsToday, 1, "the 00:30 IST booking belongs to tomorrow");
  assert.equal(overview.metrics.recognizedRevenue, 500, "tomorrow's ₹9,000 must not be recognized today");
  assert.deepEqual(overview.activity.map(row => row.bookingId), ["LATE"]);
});

test("slots are placed by IST wall-clock time", async () => {
  const { sqlite, db } = fresh();
  provider(sqlite, "PRV-1", "Arun Rao");
  booking(sqlite, "S1", { hour: 10, provider: "PRV-1" }); // 10:00 IST -> 04:30Z
  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  const arun = overview.capacity[0];
  assert.equal(arun.slots[0].bookingId, "S1", "10:00 IST belongs in the 9–11 slot, not nowhere");
  assert.equal(overview.activity[0].scheduledTimeIst, "10:00");
  assert.equal(overview.activity[0].slot, "9–11");
  assert.ok(overview.activity[0].scheduledStart.endsWith("04:30:00.000Z"), "the stored instant is still UTC");
});

test("a truncated capacity board says so instead of reading as the whole roster", async () => {
  const { sqlite, db } = fresh();
  for (let index = 0; index < 30; index++) provider(sqlite, `PRV-${index}`, `Provider ${String(index).padStart(2, "0")}`);
  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.equal(overview.metrics.providersActive, 30);
  assert.equal(overview.capacityShown, overview.capacity.length);
  assert.ok(overview.capacityShown < overview.capacityTotal, "this fixture is only meaningful if the board truncates");
  assert.equal(overview.capacityTotal, 30, "the board reports the full roster size it is truncating from");
});

test("the zone filter offers the zones that actually exist", async () => {
  const { sqlite, db } = fresh();
  provider(sqlite, "PRV-1", "Arun Rao", "blr-east");
  provider(sqlite, "PRV-2", "West Provider", "blr-west");
  provider(sqlite, "PRV-3", "Offline", "blr-north", { status: "active", live: 0 });
  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.deepEqual(overview.zones, ["blr-east", "blr-west"], "a zone with no live provider is not offered as a filter");
});

test("the capacity board shows real providers and real bookings in the right slot", async () => {
  const { sqlite, db } = fresh();
  provider(sqlite, "PRV-1", "Arun Rao");
  provider(sqlite, "PRV-2", "Priya Suresh");
  booking(sqlite, "C1", { hour: 9, provider: "PRV-1", status: "confirmed" });
  booking(sqlite, "C2", { hour: 13, provider: "PRV-1", status: "completed" });
  booking(sqlite, "C3", { hour: 13, provider: "PRV-2", status: "cancelled" });

  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.deepEqual(overview.slots, ["9–11", "11–1", "1–3", "3–5", "5–7"]);
  assert.equal(overview.capacity.length, 2, "only live, active providers appear on the board");
  const arun = overview.capacity.find(row => row.name === "Arun Rao");
  assert.equal(arun.slots[0].state, "booked");
  assert.equal(arun.slots[0].bookingId, "C1");
  assert.equal(arun.slots[1].state, "available", "an empty slot is genuinely open, not filled with a sample booking");
  assert.equal(arun.slots[2].state, "completed", "a completed booking reads as completed");
  const priya = overview.capacity.find(row => row.name === "Priya Suresh");
  assert.ok(priya.slots.every(slot => slot.state === "available"), "a cancelled booking never occupies a slot");
});

test("an empty database renders zeros and 'not connected', never a plausible number", async () => {
  const { db } = fresh();
  const overview = await buildOperationsOverview(db, { asOf: ASOF });
  assert.equal(overview.metrics.bookingsToday, 0);
  assert.equal(overview.metrics.recognizedRevenue, 0);
  assert.deepEqual(overview.capacity, []);
  assert.deepEqual(overview.activity, []);
  // There is no comparison series, so the screen must never claim a trend.
  assert.equal(overview.sourceStatus.revenueTrend, "not_connected");
  assert.equal(overview.sourceStatus.revenueRecognition, "excludes_cancelled_and_draft");
});

test("the zone filter bounds every number to that zone", async () => {
  const { sqlite, db } = fresh();
  provider(sqlite, "PRV-1", "Arun Rao", "blr-east");
  provider(sqlite, "PRV-9", "West Provider", "blr-west");
  booking(sqlite, "Z1", { hour: 9, zone: "blr-east", amount: 1000 });
  booking(sqlite, "Z2", { hour: 9, zone: "blr-west", amount: 7000 });

  const east = await buildOperationsOverview(db, { asOf: ASOF, zoneId: "blr-east" });
  assert.equal(east.metrics.recognizedRevenue, 1000, "a west-zone booking must not appear in the east total");
  assert.equal(east.metrics.bookingsToday, 1);
  assert.equal(east.capacity.length, 1);
  assert.equal(east.capacity[0].name, "Arun Rao");
});

test("the /admin screen renders live data and labels anything that is still sample data", () => {
  const page = read("app/admin/page.tsx");
  // The fabricated headline figures are gone from the overview.
  assert.ok(!/32,482/.test(page.slice(0, page.indexOf('view === "payments"'))), "the invented revenue figure is gone from the overview");
  assert.doesNotMatch(page, /8 \/ 10/, "the invented provider count is gone");
  assert.doesNotMatch(page, /vs last Monday/, "no trend is claimed without a comparison series");
  // It now actually fetches, and the zone selector drives that fetch instead of filtering a fixture.
  assert.match(page, /fetch\(`\/api\/operations-overview\$\{zoneId\?/);
  assert.match(page, /useOperationsOverview\(zone\)/);
  assert.match(page, /overview\?\.metrics\.recognizedRevenue/);
  assert.match(page, /\(overview\?\.zones\?\?\[\]\)\.map/, "the zone options come from the API, not a hard-coded neighbourhood list");
  // Today's booking list and the detail panel read the live day, not the sample array.
  assert.match(page, /liveActivity\.map/);
  assert.match(page, /const liveActivity = overview\?\.activity/);
  assert.doesNotMatch(page.slice(0, page.indexOf('view === "crm"')), /selectedBooking\./, "the overview detail panel no longer reads the sample booking");
  assert.doesNotMatch(page, /Monday · 3 August 2026/, "the header date is read from the data, not frozen");
  // Nav badges are queue lengths. Hard-coding them is the quietest lie on the screen.
  const navBlock = page.slice(page.indexOf("const nav:"), page.indexOf("const money ="));
  assert.doesNotMatch(navBlock, /count:\s*\d+/, "no nav badge carries an invented count");
  assert.match(page, /item\.id==="bookings"\?overview\?\.metrics\.bookingsToday/, "the badges that remain come from live metrics");
  // Unsourced fields render as "Not connected" rather than a number.
  assert.match(page, /Not connected/);
  // Tabs still on sample rows say so.
  assert.match(page, /PROTOTYPE_VIEWS/);
  assert.match(page, /still shows built-in example rows/);
  // Gateway + route contract.
  assert.match(read("lib/api-gateway.ts"), /url\.pathname==="\/api\/operations-overview"\)return "dashboard\.view"/);
  assert.match(read("app/api/operations-overview/route.ts"), /authorize\(request,"dashboard\.view"\)/);
});

test("readability: the operations screen has no sub-12px text left", () => {
  const css = read("app/admin/admin.module.css");
  const sizes = [...css.matchAll(/font-size: ([0-9.]+)px/g)].map(match => Number(match[1]));
  const tooSmall = sizes.filter(size => size < 12);
  assert.deepEqual(tooSmall, [], `these font sizes are below the 12px floor: ${tooSmall.join(", ")}`);
  assert.match(css, /\.metrics strong \{ margin: 4px 0; font-size: 30px;/, "the four headline numbers carry the screen");
});
