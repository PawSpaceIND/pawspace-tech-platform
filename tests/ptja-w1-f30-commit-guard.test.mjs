/**
 * PawSpace Total Journey Audit, Wave 1 F30 — travel buffer and max-daily-jobs were enforced only in
 * application code; the atomic reservation guard checked raw overlap alone.
 *
 * Every rule the engine uses to declare a provider ELIGIBLE must also be a condition of the write that
 * COMMITS the reservation. It was not, and the two disagreed under ordinary concurrency.
 *
 * MEASURED, letting a second request complete its whole read-decide-write while the first request's
 * reservation batch was in flight - the ordinary interleaving of two concurrent D1 requests:
 *
 *   BUFFER      sequential A 04:00-06:00Z -> 200 groom_arun
 *               sequential B 06:15-08:15Z -> 409 NO_SCHEDULE_AVAILABLE
 *                            ["Existing booking conflicts with travel/service buffer"]
 *               CONCURRENT   B -> 200 AND A -> 200. Two durable rows 15 minutes apart for a groomer
 *                            whose configured travel buffer is 30 minutes.
 *
 *   DAILY CAP   groom_arun capped at 2 jobs/day. Three reserves, the third interleaved -> all three
 *               200, three durable rows against a cap of 2.
 *
 * The committing guard was `WHERE NOT EXISTS (... scheduled_start<? AND scheduled_end>?)` on the RAW
 * occurrence bounds, while backend/src/scheduling.ts declares the buffer and the daily limit as
 * eligibility rules. Neither wrong state surfaced an error to the customer or to Ops: two customers
 * booking at the same moment produced a groomer with jobs 15 minutes apart in different parts of
 * Bangalore, and a provider committed to more jobs than their own profile allows. The only difference
 * between the refused case and the accepted one was request timing.
 *
 * No product decision is involved. The overnight branch beside this one already committed its rule
 * atomically, with SUM(capacity_units)+units<=capacity inside the same INSERT ... SELECT; this is the
 * same treatment for the appointment branch, using the provider's own travel_buffer_minutes and
 * max_daily_jobs and the same city-local day key the engine uses.
 *
 * The interleave here is not a simulation of a race: it drives the REAL route twice through a D1 shim
 * that runs the second request at the moment the first request's reservation batch begins, which is
 * exactly the window two concurrent Workers requests share.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F30_DB__", "__PTJA_F30_ENV__");

/** Set to a thunk to have it run once, immediately before the batch that commits reservations. */
let interleave = null;

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      if (interleave && items.some(item => /INSERT INTO scheduling_reservations/.test(item.sql))) {
        const pending = interleave; interleave = null; await pending();
      }
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** Thirty days out, so the future-window rule on reserve is never what answers. */
const DAY = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
/** Pins the decision to one provider, so the assertions are about that provider's own limits. */
const ONLY_ARUN = [{ code: "ONLY-ARUN", field: "providerId", operator: "eq", value: "groom_arun" }];

async function world() {
  interleave = null;
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F30_DB__ = db;
  globalThis.__PTJA_F30_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedProviderCapacityDefaults(db);
  const route = await import("../app/api/uat-scheduling/route.ts");
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

  const reserve = async (group, customerId, startZ, endZ) => {
    const binding = await upsertIdentityBinding(db, {
      identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
      subjectType: "customer", subjectId: customerId, verificationState: "verified",
      actorId: "ptja-f30", reason: "PTJA W1-F30 executable regression",
    });
    const issued = await issuePlatformSession(db, {
      bindingId: String(binding.id), identitySource: String(binding.identity_source),
      principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
      subjectType: "customer", subjectId: customerId,
    });
    const response = await route.POST(new Request("https://uat.pawspace.in/api/uat-scheduling", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` },
      body: JSON.stringify({
        clientRequestId: group, customerId, petIds: [`PET-${customerId}`], serviceCode: "grooming",
        cityId: "blr", zoneId: "blr-east", scheduledStart: `${DAY}T${startZ}`, scheduledEnd: `${DAY}T${endZ}`,
        customRules: ONLY_ARUN,
      }),
    }));
    let parsed = null;
    try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
    return { status: response.status, provider: parsed?.data?.provider?.id, error: parsed?.error };
  };

  const committed = () => sqlite.prepare("SELECT group_id,scheduled_start,scheduled_end FROM scheduling_reservations WHERE provider_id='groom_arun' AND status!='cancelled' ORDER BY scheduled_start").all();
  const bufferMinutes = () => Number(sqlite.prepare("SELECT travel_buffer_minutes FROM provider_capacity_profiles WHERE id='groom_arun'").get().travel_buffer_minutes);
  const capDailyJobsAt = (n) => sqlite.prepare("UPDATE provider_capacity_profiles SET max_daily_jobs=? WHERE id='groom_arun'").run(n);

  return { sqlite, reserve, committed, bufferMinutes, capDailyJobsAt };
}

test("W1-F30: the travel buffer is refused sequentially - the eligibility rule exists", async () => {
  // The baseline the concurrent case is measured against. If this ever stops refusing, the rule itself
  // has gone and the case below would pass for the wrong reason.
  const w = await world();
  assert.equal(w.bufferMinutes(), 30, "this case assumes groom_arun's configured travel buffer");

  assert.equal((await w.reserve("SEQ-A", "CA", "04:00:00.000Z", "06:00:00.000Z")).status, 200);
  const second = await w.reserve("SEQ-B", "CB", "06:15:00.000Z", "08:15:00.000Z");

  assert.equal(second.status, 409, `a 15-minute gap against a 30-minute buffer must be refused: ${JSON.stringify(second)}`);
});

test("W1-F30: the travel buffer survives two concurrent requests", async () => {
  const w = await world();
  let concurrent = null;
  // B runs its whole read-decide-write while A's reservation batch is in flight.
  interleave = async () => { concurrent = await w.reserve("CON-B", "CB", "06:15:00.000Z", "08:15:00.000Z"); };
  const first = await w.reserve("CON-A", "CA", "04:00:00.000Z", "06:00:00.000Z");

  const accepted = [concurrent, first].filter(result => result?.status === 200);
  assert.equal(accepted.length, 1,
    `exactly one of two buffer-conflicting concurrent reserves may commit, got ${JSON.stringify([concurrent, first])}`);
  const rows = w.committed();
  assert.equal(rows.length, 1, `only one reservation may be durable: ${JSON.stringify(rows)}`);
});

test("W1-F30: the daily job cap survives two concurrent requests", async () => {
  const w = await world();
  w.capDailyJobsAt(2);
  assert.equal((await w.reserve("D-S0", "D0", "03:30:00.000Z", "05:30:00.000Z")).status, 200);

  let concurrent = null;
  interleave = async () => { concurrent = await w.reserve("D-S2", "D2", "08:30:00.000Z", "10:30:00.000Z"); };
  const second = await w.reserve("D-S1", "D1", "06:00:00.000Z", "08:00:00.000Z");

  const rows = w.committed();
  assert.equal(rows.length, 2,
    `groom_arun is capped at 2 jobs that day; ${rows.length} were committed: ${JSON.stringify(rows)} (${JSON.stringify([concurrent, second])})`);
});

test("W1-F30: the loser of a race is told, and told cleanly", async () => {
  // A durable-state assertion alone would be satisfied by silently dropping the second reservation.
  // The route must answer the customer, and answer with its own SLOT_TAKEN contract rather than a 500.
  const w = await world();
  let concurrent = null;
  interleave = async () => { concurrent = await w.reserve("MSG-B", "CB", "06:15:00.000Z", "08:15:00.000Z"); };
  const first = await w.reserve("MSG-A", "CA", "04:00:00.000Z", "06:00:00.000Z");

  const loser = [concurrent, first].find(result => result?.status !== 200);
  assert.ok(loser, "one of the two must lose");
  assert.equal(loser.status, 409, `the loser must be answered 409, not 500: ${JSON.stringify(loser)}`);
  assert.equal(loser.error, "SLOT_TAKEN");
});

test("W1-F30: a booking that breaks neither rule still reserves", async () => {
  // Non-vacuity. Refusing every second reservation would satisfy all three cases above and would mean a
  // provider could only ever hold one job. Gap here is 45 minutes against a 30-minute buffer.
  const w = await world();
  assert.equal((await w.reserve("OK-A", "CA", "04:00:00.000Z", "06:00:00.000Z")).status, 200);
  const second = await w.reserve("OK-B", "CB", "06:45:00.000Z", "08:45:00.000Z");

  assert.equal(second.status, 200, `a 45-minute gap clears the 30-minute buffer and must reserve: ${JSON.stringify(second)}`);
  assert.equal(w.committed().length, 2, "both must be durable");
});

test("W1-F30: the same non-conflicting booking still commits when it races", async () => {
  // The second non-vacuity control, and the sharper one: the widened guard must reject only genuine
  // conflicts, not every concurrent write. Same 45-minute gap, but interleaved.
  const w = await world();
  let concurrent = null;
  interleave = async () => { concurrent = await w.reserve("RACE-B", "CB", "06:45:00.000Z", "08:45:00.000Z"); };
  const first = await w.reserve("RACE-A", "CA", "04:00:00.000Z", "06:00:00.000Z");

  assert.equal(concurrent?.status, 200, `the interleaved non-conflicting reserve must commit: ${JSON.stringify(concurrent)}`);
  assert.equal(first.status, 200, `and so must the one it interleaved with: ${JSON.stringify(first)}`);
  assert.equal(w.committed().length, 2);
});
