/**
 * ensureTrustSafetyTables is cached per D1 binding. Two of its steps depend on tables other modules
 * create: the provider trust columns (provider_capacity_profiles) and the global-blocklist booking
 * trigger (canonical_bookings). If the first call on a binding lands before those tables exist, a plain
 * run-once cache would remember "done" and never install them - leaving blocked customers able to book.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv } from "./helpers/voice-harness.mjs";

installWorkersHooks("__TSDS_DB__", "__TSDS_ENV__");
const trust = await import("../lib/trust-safety-governance.ts");

test("table-dependent trust-safety schema is installed once the dependency appears on the same binding", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__TSDS_DB__ = db;
  globalThis.__TSDS_ENV__ = uatVoiceEnv();
  await trust.ensureTrustSafetyTables(db);
  const trigger = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_global_blocklist_booking_insert'").get();
  assert.equal(trigger(), undefined, "no trigger while canonical_bookings does not exist");

  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,status TEXT)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (provider_id TEXT PRIMARY KEY)");
  await trust.ensureTrustSafetyTables(db);

  assert.ok(trigger(), "the blocklist trigger is installed on the same binding once canonical_bookings exists");
  const columns = sqlite.prepare("PRAGMA table_info(provider_capacity_profiles)").all().map((row) => row.name);
  for (const column of ["trust_score", "trust_strike_count", "suspended_until"]) assert.ok(columns.includes(column), column);

  sqlite.prepare("INSERT INTO global_blocklist (phone_e164,phone_key,customer_id,reason_code,status,flagged_by,flagged_by_type,created_at,updated_at) VALUES ('+919876543210','9876543210','CUST-B','fraud','active','ops','staff',1,1)").run();
  sqlite.prepare("INSERT INTO global_blocklist_customer_links (customer_id,phone_e164,linked_at) VALUES ('CUST-B','+919876543210',1)").run();
  assert.throws(() => sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,status) VALUES ('BKG-B','CUST-B','confirmed')").run(), /global_customer_blocked/);
});
