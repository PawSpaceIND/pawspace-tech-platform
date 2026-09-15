/*
 * /api/training-ops answered 500 on every cold database.
 *
 * Its GET joins canonical_bookings, booking_payments and canonical_customers, and ensured only the
 * training tables — the "whoever wrote the rows created the table" assumption that holds on a warm
 * database and fails on a fresh preview branch, a rebuilt D1, a restored backup or a rollback. The
 * Training Ops console then rendered "Unable to load Training operations" with all four metric tiles
 * at "—", which reads as "there is no training work" rather than "this screen is broken".
 *
 * tests/schema-read-coverage.test.mjs is the ratchet that lists routes with this shape; this test is
 * the executable proof for the one being removed from its baseline. It runs the REAL route handler
 * against a database that has never seen a write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAINING_OPS_COLD_DB__");

const staffRequest = (url) => new Request(url, { headers: { "oai-authenticated-user-email": "founder@pawspace.in" } });

/**
 * A database on which no booking, payment or customer has ever been written.
 *
 * Authentication provisioning is a precondition of ANY authenticated request - resolveActor calls
 * ensureSecurityTables itself - so seeding a staff identity is not warming the tables under test.
 * What stays cold is exactly what /api/training-ops reads and never created.
 */
async function coldWorld() {
  const harness = freshCountingD1();
  globalThis.__TRAINING_OPS_COLD_DB__ = harness.db;
  enterWorkersDbScope(harness.db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind("USR-W2-COLD", "founder@pawspace.in", "founder", "founder", now, now).run();
  return harness;
}

const READ_TABLES = ["canonical_bookings", "booking_payments", "canonical_customers"];
const tableNames = async (harness) => new Set((await harness.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((row) => row.name));

test("TRAINING-OPS-COLD-1: the console loads against a database that has never been written to", async () => {
  const harness = await coldWorld();
  const before = await tableNames(harness);
  for (const table of READ_TABLES) {
    assert.ok(!before.has(table), `the premise of this test is that ${table} does not exist yet`);
  }

  const { GET } = await import("../app/api/training-ops/route.ts");
  const response = await GET(staffRequest("https://app.pawspace.test/api/training-ops"));

  const body = await response.clone().json();
  assert.equal(response.status, 200, `cold load must not fault: ${JSON.stringify(body).slice(0, 200)}`);
  // The screen renders four metric tiles off body.data.metrics; a cold load must hand it a real
  // (empty) shape rather than the "Unable to load Training operations" error it used to return.
  assert.ok(body.data, "a cold load must still carry a payload");
  assert.ok(Array.isArray(body.data.programmes), "the console needs a programmes array, even an empty one");
  assert.ok(Array.isArray(body.data.trainers), "the console needs a trainers array, even an empty one");
  assert.ok(body.data.metrics && typeof body.data.metrics === "object", "the four metric tiles read from body.data.metrics");
  assert.equal(body.data.source, "canonical_training_ops");

  // The three tables the GET joins and used to fault on, in the order it hit them.
  const after = await tableNames(harness);
  for (const table of READ_TABLES) {
    assert.ok(after.has(table), `${table} must be provisioned by the route that reads it`);
  }
});

test("TRAINING-OPS-COLD-2: the shared canonical_customers DDL matches the writer byte for byte", async () => {
  // CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a reader that created this
  // table first with a different shape would silently win and the mismatch would surface later as a
  // column error. SCHEMA-READ-4 pins the same property; this asserts it through the real module.
  const shared = await import("../lib/canonical-booking-core-schema.ts");
  const writer = await import("node:fs").then((fs) => fs.readFileSync("app/api/canonical-bookings/route.ts", "utf8"));
  assert.ok(writer.includes(shared.CANONICAL_CUSTOMER_DDL),
    "lib/canonical-booking-core-schema.ts has drifted from app/api/canonical-bookings/route.ts");
  assert.match(shared.CANONICAL_CUSTOMER_DDL, /^CREATE TABLE IF NOT EXISTS canonical_customers \(/);
});

test("TRAINING-OPS-COLD-3: the provisioning is paid once, not on every poll", async () => {
  // The ensure functions memoise per database handle. A console that re-issued the DDL on every poll
  // would spend D1 round trips per request for nothing, so the cold load must cost strictly more
  // than a warm one, and two warm loads must cost the same.
  const harness = await coldWorld();
  const { GET } = await import("../app/api/training-ops/route.ts");

  const cost = async () => {
    const before = harness.calls();
    const response = await GET(staffRequest("https://app.pawspace.test/api/training-ops"));
    assert.equal(response.status, 200);
    return harness.calls() - before;
  };

  const cold = await cost();
  const warm = await cost();
  const warmAgain = await cost();
  assert.ok(cold > warm, `the cold load pays for the DDL (cold ${cold}, warm ${warm})`);
  assert.equal(warm, warmAgain, "a warm load must cost the same every time - nothing re-provisions");
});
