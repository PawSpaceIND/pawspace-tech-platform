/**
 * WAVE 3C - the IST/UTC day-boundary gap, driven to a consequence. [PTJA-W3C]
 *
 * THE GAP, verbatim (ptja/PTJA-FINDINGS.json, domain 04-scheduling):
 *
 *   "Not probed to a conclusion: the IST-vs-UTC day boundary divergence between
 *    backend/src/scheduling.ts dateKey() (IST, +330m) and lib/universal-replacement-recovery.ts's
 *    `substr(scheduled_start,1,10)` (UTC) - I confirmed the two definitions differ by reading and
 *    executing both, but did not construct a booking that cross[es it]"
 *
 * PROBED, and the divergence is SHARPER than recorded: it is not between two modules, it is inside ONE
 * FUNCTION. selectCapacitySafeReplacement resolves a candidate's AVAILABILITY on the IST day -
 * `localDate(start)`, +330m - and then counts that candidate's existing reservations for the daily
 * capacity cap on the UTC day:
 *
 *   const date  = localDate(start.toISOString());                       // IST
 *   ... "AND substr(scheduled_start,1,10)=?" .bind(..., String(b.scheduled_start).slice(0,10))  // UTC
 *
 * For any booking scheduled between 18:30 and 23:59 UTC - which is 00:00 to 05:29 IST the NEXT day -
 * those are different dates. The maxDailyJobs cap is then measured against a day the booking is not on.
 *
 * CONSEQUENCE: a provider already at their daily cap on the real (IST) service day can be handed a
 * replacement booking, because the count looked at the previous UTC day and saw nothing.
 *
 * The window is narrow - it needs a midnight-to-05:29 IST booking - and that is stated rather than
 * dressed up. But maxDailyJobs is a provider-welfare and capacity control, and a control measured on
 * the wrong day is not measuring anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3C_IST_DB__", "__W3C_IST_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const i of items) out.push(await i.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (e) { if (outer) sqlite.exec("ROLLBACK"); throw e; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3C_IST_DB__ = db;
  globalThis.__W3C_IST_ENV__ = {};
  return { sqlite, db };
}

// 20:00 UTC on the 20th == 01:30 IST on the 21st. The IST service day and the UTC calendar day differ.
const START = "2026-11-20T20:00:00.000Z";
const END   = "2026-11-20T21:00:00.000Z";
const IST_DAY = "2026-11-21";
const UTC_DAY = "2026-11-20";

async function crossingWorld({ loadOn = IST_DAY, jobs = 6 } = {}) {
  const { sqlite, db } = world();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.seedProviderCapacityDefaults(db);
sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  // Every candidate is authored as available across the IST service day, so availability cannot be
  // what decides the outcome - only the daily-cap count can.
  for (const providerId of ["groom_arun", "groom_kiran", "groom_sanjay"]) {
    sqlite.prepare("INSERT OR REPLACE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,'operations',?)")
      .run(`av-${providerId}`, providerId, "blr", "blr-east", IST_DAY, JSON.stringify(["00:00-23:59"]), now);
  }
sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,total_amount,created_by,created_at,updated_at) VALUES ('BK-F31','f31','CUST-F31','[]','[]','blr','blr-east','grooming','dog-basic','Bath','GRP-F31','groom_arun',?,?,1899,'seed',?,?)")
    .run(START, END, now, now);

  // Fill groom_kiran's IST service day to the cap with reservations that do not overlap the window,
  // so only the DAILY COUNT can exclude them - never the overlap check.
  for (let i = 0; i < jobs; i++) {
    const hour = String(6 + i).padStart(2, "0");
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,?,?,?,?,'[]',?,?,'confirmed',?)")
      .run(`RES-${i}`, `GRP-OTHER-${i}`, "groom_kiran", "grooming", "blr", "blr-east", "CUST-X",
           `${loadOn}T${hour}:00:00.000Z`, `${loadOn}T${hour}:30:00.000Z`, now);
  }
  const recovery = await import("../lib/universal-replacement-recovery.ts");
  return { sqlite, db, recovery };
}

test("IST-01: a provider at their daily cap on the IST SERVICE day is not offered the replacement", async () => {
  // groom_kiran holds SIX reservations on 2026-11-21 IST - the day this booking is actually served.
  // maxDailyJobs defaults to 6, so they are full. The cap counts 2026-11-20 (UTC) and sees none.
  const { db, recovery } = await crossingWorld({ loadOn: IST_DAY, jobs: 6 });
  const result = await recovery.selectCapacitySafeReplacement(db, { bookingId: "BK-F31", excludeProviderId: "groom_arun" });
  assert.ok(result, "a replacement is returned");
  assert.notEqual(result.provider.id, "groom_kiran",
    `groom_kiran is at the daily cap on the IST service day ${IST_DAY} and must not be selected - the cap counted the UTC day ${UTC_DAY} instead: ${JSON.stringify(result.checks)}`);
});

test("IST-02: a provider full on the PREVIOUS IST day is still selectable - the bug cut both ways", async () => {
  // The old code counted the UTC calendar day, so it was wrong in BOTH directions. IST-01 covers the
  // dangerous one (a provider full on the real service day admitted anyway). This is the other: the
  // reservations seeded here fall on 2026-11-20 IST - the day BEFORE the service day - and under the
  // old query they occupied the very date it counted, wrongly excluding a provider who is free.
  const { db, recovery } = await crossingWorld({ loadOn: UTC_DAY, jobs: 6 });
  const result = await recovery.selectCapacitySafeReplacement(db, { bookingId: "BK-F31", excludeProviderId: "groom_arun" });
  assert.ok(result, "a replacement is found");
  assert.equal(result.provider.id, "groom_kiran",
    `groom_kiran's load is all on ${UTC_DAY} IST, a different service day from ${IST_DAY}, so they are the first eligible candidate: ${JSON.stringify(result)}`);
});

test("IST-03: with no load at all the same provider IS selectable - so IST-01 is not an artefact", async () => {
  const { db, recovery } = await crossingWorld({ loadOn: IST_DAY, jobs: 0 });
  const result = await recovery.selectCapacitySafeReplacement(db, { bookingId: "BK-F31", excludeProviderId: "groom_arun" });
  assert.ok(result, "an unloaded provider is available");
});
