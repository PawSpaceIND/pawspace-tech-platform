/**
 * lib/trust-safety-governance.ts carries its own copy of the global-blocklist flow, alongside the
 * corrected copy in lib/trust-safety-blocklist.ts. The two diverged: the governance copy suppresses
 * a blocked customer by writing communication_preferences columns (sms,email,whatsapp,push,
 * quiet_start,quiet_end,updated_by) that the table - created by lib/communication-engine.ts - has
 * never had, and omits `source`, which is NOT NULL.
 *
 * Nothing in the build, the type checker or the existing suites can see inside that SQL string, so
 * the entry point stays green until it is actually called with a customer attached to the phone.
 * Then it throws `no such column: sms`, AFTER the global_blocklist row is already written and
 * BEFORE voice_call_opt_outs is - a half-applied block on a trust-and-safety path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv, DAYTIME } from "./helpers/voice-harness.mjs";

installWorkersHooks("__TSB_DB__", "__TSB_ENV__");
const trust = await import("../lib/trust-safety-governance.ts");

const PHONE = "+919876543210";

async function blocklistDb() {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__TSB_DB__ = db;
  globalThis.__TSB_ENV__ = uatVoiceEnv();
  sqlite.exec(`CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT,secondary_phone TEXT,updated_at INTEGER);`);
  await trust.ensureTrustSafetyTables(db);
  sqlite.prepare("INSERT INTO canonical_customers (id,primary_phone,secondary_phone,updated_at) VALUES (?,?,NULL,?)")
    .run("CUST-BLK-1", PHONE, DAYTIME);
  return { sqlite, db };
}

test("blocking a phone that belongs to a real customer completes instead of failing on schema", async () => {
  const { sqlite, db } = await blocklistDb();

  const result = await trust.flagCustomerOnGlobalBlocklist(db, {
    phone: PHONE, reasonCode: "circumvention", actorId: "ops@pawspace.in", actorType: "staff", asOf: DAYTIME,
  });

  assert.deepEqual(result.linkedCustomerIds, ["CUST-BLK-1"], "the customer on that phone must be linked to the block");

  // The suppression the block exists to apply.
  const preference = sqlite.prepare("SELECT service_updates,marketing,source FROM communication_preferences WHERE customer_id='CUST-BLK-1'").get();
  assert.ok(preference, "a blocked customer must have a communication preference row");
  assert.equal(Number(preference.service_updates), 0, "service updates must be off for a blocked customer");
  assert.equal(Number(preference.marketing), 0, "marketing must be off for a blocked customer");
  assert.equal(preference.source, "global_blocklist", "the suppression must record why it happened");

  // Written after the suppression loop: proves the flow ran to the end, not that it threw midway.
  const optOut = sqlite.prepare("SELECT reason FROM voice_call_opt_outs WHERE phone_key='9876543210'").get();
  assert.equal(optOut?.reason, "circumvention", "the block must also stop outbound voice");
});

test("an existing preference row is overridden rather than left consenting", async () => {
  const { sqlite, db } = await blocklistDb();
  sqlite.prepare("INSERT INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,1,1,'whatsapp','Asia/Kolkata','signup',?)")
    .run("CUST-BLK-1", DAYTIME - 1000);

  await trust.flagCustomerOnGlobalBlocklist(db, {
    phone: PHONE, reasonCode: "circumvention", actorId: "ops@pawspace.in", actorType: "staff", asOf: DAYTIME,
  });

  const preference = sqlite.prepare("SELECT service_updates,marketing,source FROM communication_preferences WHERE customer_id='CUST-BLK-1'").get();
  assert.equal(Number(preference.service_updates), 0, "a prior consent must not survive a block");
  assert.equal(Number(preference.marketing), 0, "a prior marketing consent must not survive a block");
  assert.equal(preference.source, "global_blocklist", "the block must claim the row");
});
