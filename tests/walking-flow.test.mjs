import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createD1 } from "./helpers/d1.mjs";

const flowSource = fs.readFileSync("app/mobile-app/walking-flow.tsx", "utf8");
const cssSource = fs.readFileSync("app/mobile-app/walking-flow.module.css", "utf8");
const bookingClientSource = fs.readFileSync("lib/walking-booking-client.ts", "utf8");
const commercialClientSource = fs.readFileSync("lib/walking-commercial-client.ts", "utf8");

// --- Contract tests (source text) -----------------------------------------------------------

test("the walking flow prices everything from /api/walking-commercial and never hardcodes prices", () => {
  assert.match(flowSource, /import\s*\{[^}]*loadWalkingCatalogue[^}]*createWalkingQuote[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/walking-commercial-client"/);
  // the import chain is what fetches the catalogue/quote endpoint
  assert.match(commercialClientSource, /\/api\/walking-commercial/);
  // canonical seed prices (349/549) must never be baked into the UI
  assert.doesNotMatch(flowSource, /349|549/);
  // amounts rendered come off the server quote / catalogue rows
  assert.match(flowSource, /quote\.perWalkAmount/);
  assert.match(flowSource, /quote\.totalAmount/);
  assert.match(flowSource, /item\.amount_per_walk/);
});

test("booking creation goes through lib/walking-booking-client.ts — the component makes no direct API calls", () => {
  assert.match(flowSource, /import\s*\{[^}]*createCanonicalWalkingBooking[^}]*reserveWalkingSchedule[^}]*\}\s*from\s*"\.\.\/\.\.\/lib\/walking-booking-client"/);
  // every network interaction is a client-lib call: the component itself never fetches
  assert.doesNotMatch(flowSource, /fetch\(/);
  assert.doesNotMatch(flowSource, /\/api\/walking-bookings/);
  assert.doesNotMatch(flowSource, /\/api\/uat-scheduling/);
});

test("the dogs-only guard is present and cats can never be selected", () => {
  assert.match(flowSource, /species !== "dog"/);
  assert.match(flowSource, /dogs-only service/);
  assert.match(flowSource, /species: "cat"/); // the roster shows the cat so the friendly note can trigger
  assert.match(flowSource, /DOGS ONLY/);
});

test("the flow is a standalone client component: no imports from other flow/checkout files, no globalThis", () => {
  assert.match(flowSource, /^"use client";/m);
  // Finding #188: the flow now also receives the resolved location {cityId,zoneId} from the shell.
  assert.match(flowSource, /export default function WalkingFlow\(\{ customer, location \}: \{ customer: LoggedInCustomer; location: ResolvedLocation \}\)/);
  assert.doesNotMatch(flowSource, /from\s*["'][^"']*(grooming-flow|stay-flow|training-flow|checkout)/, "must not import from any other flow/checkout file");
  assert.doesNotMatch(flowSource, /globalThis/);
  assert.doesNotMatch(bookingClientSource, /globalThis/);
  // standalone styling, not another flow's module css
  assert.match(flowSource, /from "\.\/walking-flow\.module\.css"/);
  assert.match(cssSource, /#01261F/i);
  assert.match(cssSource, /#E6B34E/i);
});

test("the flow respects the scheduler's dog_walking roster hours (06:00-21:00 IST)", () => {
  assert.match(flowSource, /WALK_START_HOURS = \[6, 7, 8, 9, 10, 16, 17, 18, 19, 20\]/);
  assert.match(flowSource, /6:00 AM and 9:00 PM/);
});

test("walking-booking-client was extended additively — existing signatures unchanged", () => {
  assert.match(bookingClientSource, /export async function createCanonicalWalkingBooking\(input:WalkingBookingInput\)\{const response=await fetch\("\/api\/walking-bookings"/);
  assert.match(bookingClientSource, /export async function reserveWalkingSchedule\(/);
  assert.match(bookingClientSource, /serviceCode:"dog_walking"/);
  assert.match(bookingClientSource, /\/api\/uat-scheduling/);
});

test("confirmation screen shows walker name + rating and the session list", () => {
  assert.match(flowSource, /walker\.name/);
  assert.match(flowSource, /walker\.rating/);
  assert.match(flowSource, /booking\.sessions\.map/);
  assert.match(flowSource, /session\.occurrenceNumber/);
});

// --- Real-execution tests: the exact server contract the flow depends on --------------------
// Minimal D1 shim over node:sqlite (a real SQLite engine), running the real, unmodified
// lib/walking-governance.ts against the real walking tables its own DDL creates.

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const DAY = 86400000;
const tomorrow7am = () => { const d = new Date(Date.now() + DAY); d.setHours(7, 0, 0, 0); return d; };

test("real execution: the catalogue the flow renders comes from the real walking package table", async () => {
  const { listWalkingPackages } = await import("../lib/walking-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const packages = await listWalkingPackages(db, tomorrow7am().toISOString());
  assert.equal(packages.length, 2);
  for (const pkg of packages) {
    // real column names the flow reads: package_code, name, duration_minutes, amount_per_walk, max_pets
    assert.ok(pkg.package_code && pkg.name);
    assert.ok([30, 60].includes(Number(pkg.duration_minutes)));
    assert.ok(Number(pkg.amount_per_walk) > 0);
    assert.equal(Number(pkg.max_pets), 1);
  }
});

test("real execution: a recurring quote shaped exactly like the flow's confirm() is accepted and server-priced", async () => {
  const { createWalkingQuote, listWalkingPackages } = await import("../lib/walking-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const packages = await listWalkingPackages(db, tomorrow7am().toISOString());
  const pkg = packages.find(item => String(item.package_code) === "walking-30");
  const start = tomorrow7am();
  const end = new Date(start.getTime() + Number(pkg.duration_minutes) * 60_000);
  const quote = await createWalkingQuote(db, { packageCode: "walking-30", mode: "recurring", petCount: 1, walkCount: 6, weekdays: [1, 3, 5], scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), paymentMode: "pay_after_service" });
  assert.equal(quote.walkCount, 6);
  assert.equal(quote.perWalkAmount, Number(pkg.amount_per_walk));
  assert.equal(quote.totalAmount, Number(pkg.amount_per_walk) * 6, "total is per-walk price × walks, computed server-side");
  assert.equal(quote.amountDueNow, 0, "pay-after-service quotes owe nothing today");
  assert.deepEqual(quote.weekdays, [1, 3, 5]);
});

async function expectRejection(promise, statusCode, description) {
  try {
    await promise;
    assert.fail(`${description}: expected a rejection`);
  } catch (error) {
    assert.ok(error instanceof Response, `${description}: server governance throws Response`);
    assert.equal(error.status, statusCode, description);
  }
}

test("real execution: the server enforces the constraints the flow UI encodes (one dog, walk counts, exact duration)", async () => {
  const { createWalkingQuote } = await import("../lib/walking-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  const start = tomorrow7am();
  const base = { packageCode: "walking-30", scheduledStart: start.toISOString(), paymentMode: "pay_after_service" };
  const end30 = new Date(start.getTime() + 30 * 60_000).toISOString();
  await expectRejection(createWalkingQuote(db, { ...base, mode: "once", petCount: 2, walkCount: 1, scheduledEnd: end30 }), 409, "two pets rejected — walking is one dog per booking");
  await expectRejection(createWalkingQuote(db, { ...base, mode: "once", petCount: 1, walkCount: 2, scheduledEnd: end30 }), 409, "once-mode must be exactly one walk");
  await expectRejection(createWalkingQuote(db, { ...base, mode: "recurring", petCount: 1, walkCount: 13, weekdays: [1], scheduledEnd: end30 }), 409, "recurring caps at 12 walks");
  await expectRejection(createWalkingQuote(db, { ...base, mode: "recurring", petCount: 1, walkCount: 4, weekdays: [], scheduledEnd: end30 }), 409, "recurring requires weekdays");
  const end31 = new Date(start.getTime() + 31 * 60_000).toISOString();
  await expectRejection(createWalkingQuote(db, { ...base, mode: "once", petCount: 1, walkCount: 1, scheduledEnd: end31 }), 409, "window must exactly match the package duration");
});

test("real execution: walking_sessions real schema (copied from lib/walking-ops-governance.ts) stores the session list the confirmation screen renders", () => {
  const sqlite = new DatabaseSync(":memory:");
  // Exact DDL from lib/walking-ops-governance.ts — real column names, no guessing.
  sqlite.exec("CREATE TABLE IF NOT EXISTS walking_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,occurrence_number INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',handover_status TEXT NOT NULL DEFAULT 'pending',completion_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const opsSource = fs.readFileSync("lib/walking-ops-governance.ts", "utf8");
  for (const column of ["booking_id", "schedule_group_id", "reservation_id", "provider_id", "occurrence_number", "scheduled_start", "scheduled_end", "handover_status", "completion_status"]) {
    assert.ok(opsSource.includes(column), `walking_sessions column ${column} exists in the ops governance DDL`);
  }
  const now = Date.now();
  const insert = sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,handover_status,completion_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'scheduled','pending','pending',?,?)");
  insert.run("WALK-B1-2", "B1", "grp1", "res2", "walk_nisha", 2, "2026-08-15T07:00:00Z", "2026-08-15T07:30:00Z", now, now);
  insert.run("WALK-B1-1", "B1", "grp1", "res1", "walk_nisha", 1, "2026-08-13T07:00:00Z", "2026-08-13T07:30:00Z", now, now);
  const rows = sqlite.prepare("SELECT id,occurrence_number,scheduled_start,scheduled_end,status FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number").all("B1");
  assert.deepEqual(rows.map(row => row.occurrence_number), [1, 2]);
  assert.equal(rows[0].status, "scheduled");
});

// --- Real execution of the additive client helper (the actual exported function) -------------

test("real execution: reserveWalkingSchedule sends the dog_walking scheduling contract and maps the walker rating", async () => {
  const { reserveWalkingSchedule } = await import("../lib/walking-booking-client.ts");
  const captured = {};
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: { groupId: "grp-77", provider: { id: "walk_nisha", name: "Nisha P.", model: "commission", rating: 4.9 }, occurrences: [{ start: "2026-08-13T07:00:00Z", end: "2026-08-13T07:30:00Z", occurrenceNumber: 1 }], explanation: ["auto-assigned"] } }) };
  };
  try {
    const reservation = await reserveWalkingSchedule({ clientRequestId: "walking-req-1", customerId: "cus_1", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "2026-08-13T07:00:00Z", scheduledEnd: "2026-08-13T07:30:00Z", walkCount: 6, weekdays: [1, 3, 5] });
    assert.equal(captured.url, "/api/uat-scheduling");
    assert.equal(captured.body.serviceCode, "dog_walking");
    assert.equal(captured.body.occurrences, 6, "walkCount maps to scheduler occurrences");
    assert.deepEqual(captured.body.weekdays, [1, 3, 5]);
    assert.equal(reservation.groupId, "grp-77");
    assert.equal(reservation.walker.name, "Nisha P.");
    assert.equal(reservation.walker.rating, 4.9, "the assigned walker's rating is surfaced for the confirmation screen");
  } finally {
    global.fetch = originalFetch;
  }
});

test("real execution: reserveWalkingSchedule fails loudly when no walker is assigned, and hides an absent rating", async () => {
  const { reserveWalkingSchedule } = await import("../lib/walking-booking-client.ts");
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, json: async () => ({ error: "NO_SCHEDULE_AVAILABLE" }) });
    await assert.rejects(
      () => reserveWalkingSchedule({ clientRequestId: "r", customerId: "c", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e", walkCount: 1 }),
      /NO_SCHEDULE_AVAILABLE/,
    );
    global.fetch = async () => ({ ok: true, json: async () => ({ data: { groupId: "g", provider: { id: "w1", name: "New Walker", model: "commission" }, occurrences: [] } }) });
    const reservation = await reserveWalkingSchedule({ clientRequestId: "r2", customerId: "c", petIds: ["Bruno"], zoneId: "blr-east", scheduledStart: "s", scheduledEnd: "e", walkCount: 1 });
    assert.equal(reservation.walker.rating, null, "a walker without a rating shows as rating-pending, never a fabricated number");
  } finally {
    global.fetch = originalFetch;
  }
});
