import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D2 (P2): walking/food/taxi `approve_cancel` are the un-patched
// twins of the sitting/boarding double-refund hardening. The approve UPDATE has no status
// predicate/changes-check and the refund ledger has NO UNIQUE(cancellation_request_id) floor,
// so one approved cancellation can yield two refund rows.
//
// CONFIRMED (deterministic, this file): the missing UNIQUE floor is proven by a real-schema
// differential — two refund rows with the same cancellation_request_id both land on
// walking/food/taxi but are rejected on sitting/boarding.
// PLAUSIBLE (not provable here): the genuine concurrent double-approve requires two requests to
// interleave; node:sqlite serialises writes, so a true race cannot be executed in this harness.
// Run against the PRE-FIX SHA ca09d06.
// =============================================================================
installWorkersHooks("__D2_DB__", "__D2_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const VERTICALS = [
  { name: "walking", ensure: "ensureWalkingFinanceTables", lib: "lib/walking-finance-governance.ts", table: "walking_refund_ledger", idCol: "booking_id", requestTable: "walking_cancellation_requests" },
  { name: "food", ensure: "ensureFoodFinanceTables", lib: "lib/food-finance-governance.ts", table: "food_refund_ledger", idCol: "order_id", requestTable: "food_cancellation_requests" },
  { name: "taxi", ensure: "ensureTaxiFinanceTables", lib: "lib/taxi-finance-governance.ts", table: "taxi_refund_ledger", idCol: "booking_id", requestTable: "taxi_cancellation_requests" },
];
const HARDENED = [
  { name: "sitting", ensure: "ensureSittingFinanceTables", lib: "lib/sitting-finance-governance.ts", table: "sitting_refund_ledger", idCol: "booking_id" },
  { name: "boarding", ensure: "ensureBoardingFinanceTables", lib: "lib/boarding-finance-governance.ts", table: "boarding_refund_ledger", idCol: "booking_id" },
];

async function ensureFor(spec) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__D2_DB__ = makeD1(sqlite);
  globalThis.__D2_ENV__ = {};
  const mod = await import(`../${spec.lib}`);
  await mod[spec.ensure](globalThis.__D2_DB__);
  return sqlite;
}
// Insert a refund-ledger row for a given cancellation_request_id. Returns true on success, false if the
// DB rejected it (e.g. UNIQUE violation).
function insertRefund(sqlite, spec, refundId, requestId) {
  try {
    sqlite.prepare(`INSERT INTO ${spec.table} (id,${spec.idCol},cancellation_request_id,amount,currency,status,policy_source,created_by,created_at,updated_at) VALUES (?,?,?,?,'INR','sandbox_pending','explicit_finance_approval','tester',?,?)`)
      .run(refundId, "BOOK-1", requestId, 4000, Date.now(), Date.now());
    return true;
  } catch { return false; }
}

// ---- CONFIRMED (real schema): two refunds for one cancellation request BOTH land on walking/food/taxi ----
for (const spec of VERTICALS) {
  test(`D2 REPRODUCED — ${spec.name}: two refund rows for one cancellation_request_id BOTH persist (no UNIQUE floor)`, async () => {
    const sqlite = await ensureFor(spec);
    const first = insertRefund(sqlite, spec, "RF-1", "REQ-1");
    const second = insertRefund(sqlite, spec, "RF-2", "REQ-1"); // same request id
    const count = sqlite.prepare(`SELECT COUNT(*) c FROM ${spec.table} WHERE cancellation_request_id=?`).get("REQ-1").c;
    assert.ok(first && second, `${spec.name}: both inserts should currently succeed (vulnerable)`);
    assert.equal(count, 2, `${spec.name}: one approved cancellation can hold TWO refund obligations`);
    // Source corroboration: no per-request unique floor exists in this vertical.
    assert.doesNotMatch(read(spec.lib), /one_refund_per_request/, `${spec.name}: source has no UNIQUE(cancellation_request_id) refund index`);
  });
}

// ---- Contrast: the hardened verticals REJECT the duplicate (the fix template) ----
for (const spec of HARDENED) {
  test(`D2 contrast — ${spec.name}: the duplicate refund is REJECTED (UNIQUE floor present)`, async () => {
    const sqlite = await ensureFor(spec);
    const first = insertRefund(sqlite, spec, "RF-1", "REQ-1");
    const second = insertRefund(sqlite, spec, "RF-2", "REQ-1");
    const count = sqlite.prepare(`SELECT COUNT(*) c FROM ${spec.table} WHERE cancellation_request_id=?`).get("REQ-1").c;
    assert.ok(first, `${spec.name}: first refund lands`);
    assert.ok(!second, `${spec.name}: the second refund for the same request is rejected`);
    assert.equal(count, 1, `${spec.name}: exactly one refund per cancellation request`);
    assert.match(read(spec.lib), /one_refund_per_request/, `${spec.name}: source creates the UNIQUE(cancellation_request_id) index`);
  });
}

// ---- SECURE INVARIANT (post-fix gate): walking/food/taxi must reject the duplicate too ----
test("D2 SECURE INVARIANT (post-fix gate) — walking/food/taxi must reject a second refund per cancellation request", async () => {
  const violations = [];
  for (const spec of VERTICALS) {
    const sqlite = await ensureFor(spec);
    insertRefund(sqlite, spec, "RF-1", "REQ-1");
    insertRefund(sqlite, spec, "RF-2", "REQ-1");
    const count = sqlite.prepare(`SELECT COUNT(*) c FROM ${spec.table} WHERE cancellation_request_id=?`).get("REQ-1").c;
    if (count !== 1) violations.push(`${spec.name}=${count}`);
  }
  // Expected after remediation: each vertical enforces one-refund-per-request. FAILS on ca09d06.
  assert.deepEqual(violations, [], `SECURE INVARIANT VIOLATED on ca09d06 — verticals accept duplicate refunds: ${violations.join(", ")}`);
});

// ---- Source: the approve UPDATE lacks the atomic status-claim the hardened verticals use ----
test("D2 REPRODUCED (source) — walking/food/taxi approve UPDATE has no atomic status predicate; sitting/boarding do", () => {
  for (const spec of VERTICALS) {
    const src = read(spec.lib);
    assert.match(src, new RegExp(`UPDATE ${spec.requestTable} SET status='approved'`), `${spec.name}: approve UPDATE present`);
    // The approve UPDATE targets WHERE id=? with no `status='policy_review_required'` guard on the write.
    assert.doesNotMatch(src, new RegExp(`UPDATE ${spec.requestTable} SET status='approved'[^;]*status='policy_review_required'`), `${spec.name}: no atomic status-claim on the approve write`);
  }
  for (const spec of HARDENED) {
    assert.match(read(spec.lib), /status='policy_review_required'/, `${spec.name}: uses the atomic status-claim pattern`);
  }
});

// ---- PLAUSIBLE note: a genuine concurrent double-approve cannot be executed in node:sqlite ----
test("D2 PLAUSIBLE — the concurrent double-approve is not locally reproducible (node:sqlite serialises writes)", () => {
  // The CONFIRMED evidence above (missing UNIQUE floor + missing atomic status-claim) is the structural
  // proof. On real Cloudflare D1 two concurrent approve_cancel requests can interleave the stale-read /
  // write / refund-insert and both land, because neither the status-claim nor the unique floor stops
  // them. This harness cannot exercise that interleave (writes are serialised), so the double-EFFECT is
  // labelled PLAUSIBLE while the missing-guard CODE GAP is CONFIRMED.
  assert.ok(true);
});
