/**
 * WAVE 3C - the last two gaps the Wave 2 hunt recorded and did not conclude. [PTJA-W3C]
 *
 * GAP A, verbatim (domain 01-leadgen):
 *   "lib/referral-booking-governance.ts was read only. Its read-decide-write in prepareReferralBooking
 *    looked race-prone but the UNIQUE index referral_first_booking_customer_programme_idx appears to
 *    cover it; I did not build a concurrency harness to confirm either way, so nothing is reported."
 *
 * GAP B, verbatim (domain 01-leadgen):
 *   "runAppFunnelSweep's `Math.max(1, Number(input.abandonMinutes) || 60)` collapses -5 to a 1-minute
 *    abandonment window (premature Rs.300 recovery issuance). I could not find a caller that passes
 *    abandonMinutes at all... so there is no consequence path and I have not filed it."
 *
 * BOTH ARE LATENT TRAPS: correct today by a property nobody wrote down, and wrong the moment somebody
 * changes a caller. GAP A is refuted and guarded. GAP B is fixed, because the fix is smaller than the
 * argument for leaving it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3C_TRAP_DB__", "__W3C_TRAP_ENV__");

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
  globalThis.__W3C_TRAP_DB__ = db;
  globalThis.__W3C_TRAP_ENV__ = {};
  return { sqlite, db };
}

// =====================================================================================================
// GAP A - the referral first-booking race
// =====================================================================================================

test("TRAP-A1: one referred customer cannot bind two first bookings on the same programme", async () => {
  // prepareReferralBooking only READS; the write is a statement its caller batches. So the window
  // between the decision and the commit is closed by the UNIQUE index alone - which is exactly what
  // the hunt suspected and did not test. Two callers that BOTH passed the read are modelled by issuing
  // both link statements against one database: the second must be refused by the index.
  const { sqlite, db } = world();
  const referral = await import("../lib/referral-booking-governance.ts");
  await referral.ensureReferralBookingTables(db);

  const now = Date.now();
  const link = (claimId, bookingId) => db.prepare(
    "INSERT INTO referral_claim_booking_links (claim_id,booking_id,programme_id,referred_customer_id,applied_discount,status,created_at,updated_at) VALUES (?,?,?,?,?,'bound',?,?)"
  ).bind(claimId, bookingId, "PROG-1", "CUST-REFERRED", 200, now, now);

  await link("CLAIM-A", "BKG-A").run();
  const second = await link("CLAIM-B", "BKG-B").run().then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) }));

  assert.equal(second.ok, false,
    "a second first-booking for the same programme and customer must be refused - the discount is once per referral");
  assert.match(second.message, /UNIQUE|constraint/i, "and refused by the index, not by chance");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM referral_claim_booking_links WHERE programme_id='PROG-1' AND referred_customer_id='CUST-REFERRED'").get().c), 1,
    "exactly one binding survives");
});

test("TRAP-A2: the index is what enforces it - a different customer on the same programme still binds", async () => {
  // Non-vacuity. If the table refused every second row the case above would prove nothing about the
  // (programme, customer) pair specifically.
  const { sqlite, db } = world();
  const referral = await import("../lib/referral-booking-governance.ts");
  await referral.ensureReferralBookingTables(db);
  const now = Date.now();
  const link = (claimId, bookingId, customerId) => db.prepare(
    "INSERT INTO referral_claim_booking_links (claim_id,booking_id,programme_id,referred_customer_id,applied_discount,status,created_at,updated_at) VALUES (?,?,?,?,?,'bound',?,?)"
  ).bind(claimId, bookingId, "PROG-1", customerId, 200, now, now);

  await link("CLAIM-A", "BKG-A", "CUST-ONE").run();
  const other = await link("CLAIM-B", "BKG-B", "CUST-TWO").run().then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) }));
  assert.equal(other.ok, true, `a different referred customer must still be able to bind: ${JSON.stringify(other)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM referral_claim_booking_links").get().c), 2);
});

// =====================================================================================================
// GAP B - runAppFunnelSweep's abandonment window
// =====================================================================================================

test("TRAP-B1: a non-positive or malformed abandonMinutes falls back to the default, not to 1 minute", async () => {
  // MEASURED BEFORE THE FIX: `Math.max(1, Number(input.abandonMinutes) || 60)` collapses -5 to ONE
  // MINUTE, because -5 is truthy so the `|| 60` never fires and Math.max floors it at 1. A one-minute
  // abandonment window issues recovery incentives to customers who simply paused. No caller passes the
  // field today, which is why the hunt filed nothing - but "no caller today" is not a control.
  const { db } = world();
  const funnel = await import("../lib/app-to-revenue-funnel.ts");
  const at = Date.UTC(2026, 8, 1, 12, 0, 0);

  for (const bad of [-5, 0, -1, Number.NaN, "abc", "", null, undefined, [], {}, -1e12]) {
    const result = await funnel.runAppFunnelSweep(db, { asOf: at, abandonMinutes: bad });
    assert.equal(Number(result.abandonMinutes), 60,
      `abandonMinutes=${JSON.stringify(bad)} must fall back to the 60-minute default, not collapse the window: ${JSON.stringify(result)}`);
  }
});

test("TRAP-B2 (non-vacuity): a legitimate abandonMinutes is still honoured", async () => {
  const { db } = world();
  const funnel = await import("../lib/app-to-revenue-funnel.ts");
  const at = Date.UTC(2026, 8, 1, 12, 0, 0);
  for (const good of [15, 90, 1440]) {
    const result = await funnel.runAppFunnelSweep(db, { asOf: at, abandonMinutes: good });
    assert.equal(Number(result.abandonMinutes), good,
      `a sane window must be used as given: ${JSON.stringify(result)}`);
  }
});
