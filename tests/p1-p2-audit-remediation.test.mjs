import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";
import { calculateGroomingHouseholdQuote } from "./helpers/grooming-harness.mjs";
import { listChurnRisk } from "../lib/growth-intelligence-governance.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("mixed dog + cat grooming quote applies each package multi-pet rate and exact inclusive GST", () => {
  const quote = calculateGroomingHouseholdQuote({
    lines: [{ petType: "dog", packageCode: "dog-bath" }, { petType: "cat", packageCode: "cat-routine" }],
    taxRate: 18,
    taxMode: "inclusive",
  });
  assert.deepEqual({ base: quote.baseAmount, discount: quote.multiPetDiscount, subtotal: quote.subtotal, gst: quote.gstAmount, total: quote.totalAmount },
    { base: 2498, discount: 350, subtotal: 2148, gst: 327.66, total: 2148 });
  assert.equal(quote.lines[0].chargedPrice, 1149);
  assert.equal(quote.lines[1].chargedPrice, 999);
  assert.throws(() => calculateGroomingHouseholdQuote({ lines: [{ petType: "cat", packageCode: "dog-basic" }] }), /not eligible for cat/);
});

test("churn telemetry uses completed-service recency, low ratings and cancellation frequency with null-safe values", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite), at = Date.UTC(2026, 8, 11, 5, 0, 0);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,scheduled_start TEXT,total_amount REAL)");
  sqlite.exec("CREATE TABLE booking_ratings (id TEXT PRIMARY KEY,customer_id TEXT,stars INTEGER,created_at INTEGER)");
  const old = new Date(at - 80 * 86400000).toISOString(), recent = new Date(at - 10 * 86400000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('B1','C1','completed',?,NULL)").run(old);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('B2','C1','cancelled',?,NULL)").run(recent);
  sqlite.prepare("INSERT INTO booking_ratings VALUES ('R1','C1',2,?)").run(at - 5 * 86400000);
  const result = await listChurnRisk(db, { at });
  assert.equal(result.method, "service_quality_cancellation_v2");
  assert.equal(result.atRisk.length, 1);
  assert.equal(result.atRisk[0].daysSinceLastCompletedService, 80);
  assert.equal(result.atRisk[0].recentLowRatings, 1);
  assert.equal(result.atRisk[0].cancellationFrequency, 0.5);
  assert.ok(Number.isFinite(result.atRisk[0].score));
  sqlite.close();
});

test("Ops Command Center has scoped SSE feed and client live refresh wiring", async () => {
  const route = await read("../app/api/booking-command-center/stream/route.ts");
  const page = await read("../app/booking-command-center/page.tsx");
  assert.match(route, /authorize\(request, "bookings\.manage"\)/);
  assert.match(route, /resolveManagerOrganizationalScope/);
  assert.match(route, /text\/event-stream/);
  assert.match(route, /provider_work_orders/);
  assert.match(route, /booking_payments/);
  assert.match(page, /new EventSource\("\/api\/booking-command-center\/stream"\)/);
  assert.match(page, /events\.addEventListener\("booking", refresh\)/);
});
