import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Same test-only resolve hook as tests/customer-offers.test.mjs: lets Node's native ESM loader
// (under --experimental-strip-types) import the real, unmodified .ts sources directly.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const libSource = fs.readFileSync("lib/partner-job-feed.ts", "utf8");
const routeSource = fs.readFileSync("app/api/partner-job-feed/route.ts", "utf8");
const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const pageSource = fs.readFileSync("app/partner/jobs/page.tsx", "utf8");

// --- Contract tests (source text) -----------------------------------------------------------

test("the route gets the DB from cloudflare:workers and NEVER references globalThis", () => {
  assert.match(routeSource, /await import\("cloudflare:workers"\)/);
  assert.match(routeSource, /return env\.DB;/);
  assert.doesNotMatch(routeSource, /globalThis/);
});

test("the route is authenticated: resolveActor + bookings.view + requireProviderOwnership", () => {
  assert.match(routeSource, /resolveActor\(request\)/);
  assert.match(routeSource, /requirePermission\(actor,"bookings\.view"\)/);
  assert.match(routeSource, /await requireProviderOwnership\(db,actor,providerId\)/);
  assert.doesNotMatch(routeSource, /export async function POST/); // read-only surface
});

test("/api/partner-job-feed requires bookings.view in the API gateway (never public)", () => {
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/partner-job-feed"\)return "bookings\.view";/);
  // and it must NOT sit in the public return-null allowlist
  const publicBlock = gatewaySource.match(/if\(url\.pathname==="\/api\/pricing-quote"[\s\S]*?\)return null;/);
  assert.ok(publicBlock, "public allowlist block not found");
  assert.doesNotMatch(publicBlock[0], /partner-job-feed/);
});

test("the feed is read-only and never selects customer contact columns", () => {
  assert.doesNotMatch(libSource, /CREATE TABLE/i);
  assert.doesNotMatch(libSource, /primary_phone|secondary_phone/);
  assert.doesNotMatch(libSource, /\bemail\b/);
  assert.doesNotMatch(libSource, /line1|postal_code|customer_addresses/);
  // the only canonical_customers read is id + name
  assert.match(libSource, /SELECT id,name FROM canonical_customers/);
});

test("the partner jobs page reuses POST /api/boarding-stays for accept/decline (no new mutation path)", () => {
  assert.match(pageSource, /fetch\("\/api\/boarding-stays",\{method:"POST"/);
  assert.match(pageSource, /"accept"/);
  assert.match(pageSource, /"decline"/);
  assert.match(pageSource, /idempotencyKey:crypto\.randomUUID\(\)/);
  assert.doesNotMatch(pageSource, /api\/partner-job-feed",\{method:"POST"/);
});

test("the partner jobs page is a standalone client page that never touches flow/checkout files", () => {
  assert.match(pageSource, /^"use client";/m);
  assert.match(pageSource, /fetch\("\/api\/partner-job-feed"/);
  assert.doesNotMatch(pageSource, /stay-flow|grooming-flow|training-flow|checkout/);
});

// --- Real-execution tests: grouping over a real SQLite engine -------------------------------

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const DAY = 86400000;
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, service_code TEXT NOT NULL, package_code TEXT NOT NULL, package_name TEXT NOT NULL, schedule_group_id TEXT NOT NULL, provider_id TEXT NOT NULL, scheduled_start TEXT NOT NULL, scheduled_end TEXT NOT NULL, status TEXT NOT NULL, pet_ids_json TEXT NOT NULL DEFAULT '[]')");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL DEFAULT '9999999999', email TEXT)");
  sqlite.exec("CREATE TABLE boarding_stays (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, host_provider_id TEXT NOT NULL, status TEXT NOT NULL, check_in_at TEXT NOT NULL DEFAULT '', check_out_at TEXT NOT NULL DEFAULT '', care_plan_status TEXT NOT NULL DEFAULT 'required', pet_count INTEGER NOT NULL DEFAULT 1)");
  // walking_sessions / taxi_trips / scheduling_reservations deliberately NOT created:
  // the feed must degrade gracefully when optional service tables are missing.
  return { sqlite, db: makeD1(sqlite) };
}

function seedBooking(sqlite, { id, provider = "prov_1", customer = "cus_1", service = "boarding", start, end, status }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,pet_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, customer, service, "pkg", `Package ${id}`, `grp_${id}`, provider, start, end, status, JSON.stringify(["pet_1", "pet_2"]));
}

async function seededFeed() {
  const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
  const { sqlite, db } = freshDb();
  sqlite.prepare("INSERT INTO canonical_customers (id,name,primary_phone,email) VALUES (?,?,?,?)").run("cus_1", "Anita Rao", "9876543210", "anita@example.com");

  // 1) boarding awaiting host acceptance (starts tomorrow) -> needs_action
  seedBooking(sqlite, { id: "B_await", start: iso(1 * DAY), end: iso(3 * DAY), status: "confirmed" });
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,host_provider_id,status,care_plan_status,pet_count) VALUES (?,?,?,?,?,?)")
    .run("stay_await", "B_await", "prov_1", "awaiting_host_acceptance", "required", 2);
  // 2) one today (already running: started an hour ago)
  seedBooking(sqlite, { id: "B_today", service: "pet_walking", start: iso(-1 * 3600000), end: iso(2 * 3600000), status: "assigned" });
  // 3) one future
  seedBooking(sqlite, { id: "B_future", service: "pet_taxi", start: iso(5 * DAY), end: iso(5 * DAY + 3600000), status: "assigned" });
  // 4) one completed 3 days ago -> completed
  seedBooking(sqlite, { id: "B_done3", start: iso(-4 * DAY), end: iso(-3 * DAY), status: "completed" });
  // 5) one completed 20 days ago -> EXCLUDED from the feed
  seedBooking(sqlite, { id: "B_done20", start: iso(-21 * DAY), end: iso(-20 * DAY), status: "completed" });
  // another provider's booking must never leak into prov_1's feed
  seedBooking(sqlite, { id: "B_other", provider: "prov_2", start: iso(1 * DAY), end: iso(2 * DAY), status: "assigned" });

  return { feed: await listProviderJobs(db, "prov_1", NOW), db };
}

test("real execution: jobs group into needs_action / today / upcoming / completed(14d)", async () => {
  const { feed } = await seededFeed();
  assert.deepEqual(feed.needsAction.map((job) => job.bookingId), ["B_await"]);
  assert.equal(feed.needsAction[0].needsActionReason, "awaiting_host_acceptance");
  assert.equal(feed.needsAction[0].stayId, "stay_await");
  assert.equal(feed.needsAction[0].status, "awaiting_host_acceptance");
  assert.deepEqual(feed.today.map((job) => job.bookingId), ["B_today"]);
  assert.deepEqual(feed.upcoming.map((job) => job.bookingId), ["B_future"]);
  assert.deepEqual(feed.completed.map((job) => job.bookingId), ["B_done3"], "a job completed 20 days ago must be excluded");
  const everyId = [...feed.needsAction, ...feed.today, ...feed.upcoming, ...feed.completed].map((job) => job.bookingId);
  assert.ok(!everyId.includes("B_other"), "another provider's booking must never appear");
  assert.ok(!everyId.includes("B_done20"));
});

test("real execution: the feed exposes the customer FIRST NAME only, never contact data", async () => {
  const { feed } = await seededFeed();
  const serialized = JSON.stringify(feed);
  for (const job of [...feed.needsAction, ...feed.today, ...feed.upcoming, ...feed.completed]) {
    assert.equal(job.customerFirstName, "Anita", "first name only, taken from canonical_customers.name");
  }
  assert.ok(!serialized.includes("Rao"), "surname must not be exposed");
  assert.ok(!serialized.includes("9876543210"), "phone must never be in the feed");
  assert.ok(!serialized.includes("anita@example.com"), "email must never be in the feed");
});

test("real execution: job rows carry service, package, window, pet count and status", async () => {
  const { feed } = await seededFeed();
  const job = feed.needsAction[0];
  assert.equal(job.serviceCode, "boarding");
  assert.equal(job.packageName, "Package B_await");
  assert.equal(job.petCount, 2); // from the boarding stay
  assert.ok(job.scheduledStart && job.scheduledEnd);
  const walk = feed.today[0];
  assert.equal(walk.petCount, 2); // from pet_ids_json when no stay row exists
});

test("real execution: jobCounts matches the grouped feed", async () => {
  const { jobCounts } = await import("../lib/partner-job-feed.ts");
  const { db } = await seededFeed();
  const counts = await jobCounts(db, "prov_1", NOW);
  assert.deepEqual(counts, { needsAction: 1, today: 1, upcoming: 1, completed: 1, total: 4 });
});

test("real execution: missing optional tables (walking/taxi/reservations) never break the feed", async () => {
  // seededFeed() already runs without those tables; assert an empty provider also works.
  const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
  const { db } = freshDb();
  const feed = await listProviderJobs(db, "prov_empty", NOW);
  assert.deepEqual(feed, { providerId: "prov_empty", needsAction: [], today: [], upcoming: [], completed: [] });
});

test("real execution: a care-plan-required confirmed stay is needs_action; cancelled bookings are excluded", async () => {
  const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
  const { sqlite, db } = freshDb();
  seedBooking(sqlite, { id: "B_care", start: iso(2 * DAY), end: iso(4 * DAY), status: "assigned" });
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,host_provider_id,status,care_plan_status,pet_count) VALUES (?,?,?,?,?,?)")
    .run("stay_care", "B_care", "prov_1", "confirmed", "required", 1);
  seedBooking(sqlite, { id: "B_cancel", start: iso(2 * DAY), end: iso(3 * DAY), status: "cancelled" });
  const feed = await listProviderJobs(db, "prov_1", NOW);
  assert.deepEqual(feed.needsAction.map((job) => job.bookingId), ["B_care"]);
  assert.equal(feed.needsAction[0].needsActionReason, "care_plan_required");
  assert.equal([...feed.today, ...feed.upcoming, ...feed.completed].length, 0, "cancelled bookings never appear");
});
