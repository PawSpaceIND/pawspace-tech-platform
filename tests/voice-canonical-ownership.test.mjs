import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, uatVoiceEnv } from "./helpers/voice-harness.mjs";

installWorkersHooks("__VOC_DB__", "__VOC_ENV__");
const voice = await import("../lib/voice-outbound-canonical.ts");

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const env = uatVoiceEnv();
  globalThis.__VOC_DB__ = db;
  globalThis.__VOC_ENV__ = env;
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, primary_phone TEXT NOT NULL, secondary_phone TEXT);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL);
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT, opt_out INTEGER DEFAULT 0);
    INSERT INTO canonical_customers VALUES ('CUST-A','+919111111111','+919876543210');
    INSERT INTO canonical_customers VALUES ('CUST-B','+919222222222',NULL);
    INSERT INTO canonical_bookings VALUES ('BKG-A','CUST-A');
    INSERT INTO canonical_bookings VALUES ('BKG-B','CUST-B');
    INSERT INTO lead_work_items VALUES ('LEAD-A','CUST-A',0);
    INSERT INTO lead_work_items VALUES ('LEAD-B','CUST-B',0);
  `);
  return { sqlite, db, env };
}

const request = (overrides = {}) => ({
  idempotencyKey: `ownership-${Math.random()}`,
  useCase: "booking_confirmation",
  phone: "+919876543210",
  cityId: "blr",
  customerId: "CUST-A",
  leadId: "LEAD-A",
  bookingId: "BKG-A",
  actorId: "ops@pawspace.in",
  actorPermissions: ["*"],
  ...overrides,
});

test("generic outbound voice rejects a phone belonging to another canonical customer before policy or dial", async () => {
  const { db, env } = world();
  await assert.rejects(
    () => voice.requestOutboundVoiceCall(db, env, request({ phone: "+919222222222" })),
    /does not belong to the canonical customer/,
  );
});

test("generic outbound voice rejects a booking whose customer_id differs from the claimed customer", async () => {
  const { db, env } = world();
  await assert.rejects(
    () => voice.requestOutboundVoiceCall(db, env, request({ bookingId: "BKG-B" })),
    /Booking\/customer ownership mismatch/,
  );
});

test("generic outbound voice rejects lead/customer cross-linking", async () => {
  const { db, env } = world();
  await assert.rejects(
    () => voice.requestOutboundVoiceCall(db, env, request({ leadId: "LEAD-B" })),
    /Lead\/customer ownership mismatch/,
  );
});

test("secondary-phone normalization collisions fail closed instead of choosing an owner", async () => {
  const { sqlite, db, env } = world();
  sqlite.prepare("UPDATE canonical_customers SET primary_phone=? WHERE id='CUST-B'").run("09876543210");
  await assert.rejects(
    () => voice.requestOutboundVoiceCall(db, env, request({ phone: "98765 43210" })),
    /not uniquely owned/,
  );
});

test("the production voice route is wired to the canonical boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(new URL("../app/api/voice-outbound/route.ts", import.meta.url), "utf8");
  assert.match(route, /voice-outbound-canonical/);
  assert.doesNotMatch(route, /from["']\.\.\/\.\.\/\.\.\/lib\/voice-outbound-governance["']/);
});
