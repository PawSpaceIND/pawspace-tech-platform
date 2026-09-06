import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// s52 GST TCS engine (lib/tcs-governance.ts) and the read-only TDS/TCS reconciliation utility
// (lib/tds-tcs-reconciliation.ts). The reconciler cross-checks recorded ledgers against statutory
// rates/arithmetic, PAN readiness and deposits, and never mutates.

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (e) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw e; }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (e) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context); throw e; }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...b) => statement(sql, b),
      first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
      run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, exec: async (sql) => { sqlite.exec(sql); } };
}

const PERIOD = "2026-07", ACTOR = "maker@pawspace.in";
const IST = 330 * 60_000, istMs = (y, m, d) => Date.UTC(y, m - 1, d) - IST;

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec(`
    CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY, engagement_model TEXT);
    CREATE TABLE provider_payout_computations (booking_id TEXT PRIMARY KEY, provider_id TEXT, service_code TEXT, order_value REAL, provider_net_payout REAL, provider_gst_deducted REAL, term_id TEXT, computed_at INTEGER);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL);
  `);
  return { sqlite, db };
}
function term(sqlite, id, model) { sqlite.prepare("INSERT INTO provider_commercial_terms (id,engagement_model) VALUES (?,?)").run(id, model); }
function payout(sqlite, { booking, provider, order, gst, term, at, net = 0 }) {
  sqlite.prepare("INSERT OR IGNORE INTO canonical_bookings (id,customer_id,city_id) VALUES (?,?,'blr')").run(booking, `CUS-${booking}`);
  sqlite.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,provider_gst_deducted,term_id,computed_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(booking, provider, "boarding", order, net, gst, term, at);
}

test("s52 TCS engine collects 1% of net value on marketplace supplies only, split CGST+SGST", async () => {
  const { sqlite, db } = await world();
  const tcs = await import("../lib/tcs-governance.ts");
  term(sqlite, "T_mkt", "commission_standard");
  term(sqlite, "T_emp", "direct_employee");
  payout(sqlite, { booking: "bk1", provider: "P1", order: 1180, gst: 180, term: "T_mkt", at: istMs(2026, 7, 10) });
  payout(sqlite, { booking: "bk2", provider: "P1", order: 590, gst: 90, term: "T_mkt", at: istMs(2026, 7, 20) });
  payout(sqlite, { booking: "bk3", provider: "E9", order: 2000, gst: 0, term: "T_emp", at: istMs(2026, 7, 11) });
  payout(sqlite, { booking: "bk4", provider: "P2", order: 1180, gst: 180, term: "T_mkt", at: istMs(2026, 6, 28) });

  const res = await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: ACTOR });
  assert.equal(res.supplierCount, 1);
  assert.equal(res.totalNetValue, 1500);
  assert.equal(res.totalTcs, 15, "1% of 1500");
  assert.equal(res.cgstTcs, 7.5); assert.equal(res.sgstTcs, 7.5);
  const rows = sqlite.prepare("SELECT COUNT(*) n FROM tcs_collections WHERE period=?").get(PERIOD);
  assert.equal(rows.n, 2, "only the two marketplace bookings in-period are recorded");

  const gstr8 = await tcs.prepareGstr8(db, { period: PERIOD, actorId: ACTOR });
  assert.equal(gstr8.totalTcs, 15);
  assert.equal(gstr8.suppliers[0].supplierId, "P1");
  assert.equal(gstr8.liveFilingEnabled, false);

  await tcs.recordTcsDeposit(db, { period: PERIOD, challanReference: "CH-1", amount: 15, actorId: ACTOR });
  await assert.rejects(() => tcs.recordTcsDeposit(db, { period: "2026-08", challanReference: "CH-2", amount: 99, actorId: ACTOR }), (e) => e instanceof Response && e.status === 409);
});

test("computeMonthlyTcs is idempotent (re-run replaces the period, no duplicate rows)", async () => {
  const { sqlite, db } = await world();
  const tcs = await import("../lib/tcs-governance.ts");
  term(sqlite, "T_mkt", "commission_standard");
  payout(sqlite, { booking: "bk1", provider: "P1", order: 1180, gst: 180, term: "T_mkt", at: istMs(2026, 7, 10) });
  await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: ACTOR });
  await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: ACTOR });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tcs_collections WHERE period=?").get(PERIOD).n, 1);
});

test("TDS reconciliation flags rate/amount mismatch, PAN-pending, and deposit gaps", async () => {
  const { sqlite, db } = await world();
  const tds = await import("../lib/tds-governance.ts");
  const recon = await import("../lib/tds-tcs-reconciliation.ts");
  await tds.ensureTdsTables(db);
  const insert = (section, id, base, rate, amount, pan) => sqlite.prepare("INSERT INTO tds_deductions (id,period,section,deductee_type,deductee_id,deductee_name,pan_status,base_amount,rate_pct,tds_amount,source_type,source_ref,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`d_${id}`, PERIOD, section, "provider", id, id, pan, base, rate, amount, "provider_payouts", id, Date.now());
  insert("194J", "P_ok", 1000, 10, 100, "verified");
  insert("194H", "P_bad", 1000, 2, 50, "verified");
  insert("194H", "P_pan", 1000, 2, 20, "pending_verification");

  const res = await recon.reconcileTds(db, { period: PERIOD });
  assert.equal(res.summary.recordedTds, 170);
  assert.ok(res.findings.some((f) => f.code === "amount_mismatch" && f.deducteeId === "P_bad"), "flags the wrong TDS amount");
  assert.ok(res.findings.some((f) => f.code === "pan_pending" && f.deducteeId === "P_pan"), "flags PAN pending");
  assert.equal(res.summary.depositStatus, "missing");
  assert.equal(res.summary.reconciled, false);
  assert.equal(res.summary.payoutWithholdingNote.withheldAtPayout, 0);

  await tds.recordTdsDeposit(db, { period: PERIOD, challanReference: "ITNS-1", amount: 170, actorId: ACTOR }).catch(() => {});
  const after = await recon.reconcileTds(db, { period: PERIOD });
  assert.equal(after.summary.depositStatus, "matched");
});

test("TCS reconciliation verifies recorded collections and catches a tampered row", async () => {
  const { sqlite, db } = await world();
  const tcs = await import("../lib/tcs-governance.ts");
  const recon = await import("../lib/tds-tcs-reconciliation.ts");
  term(sqlite, "T_mkt", "commission_standard");
  payout(sqlite, { booking: "bk1", provider: "P1", order: 1180, gst: 180, term: "T_mkt", at: istMs(2026, 7, 10) });
  await tcs.computeMonthlyTcs(db, { period: PERIOD, actorId: ACTOR });
  await tcs.recordTcsDeposit(db, { period: PERIOD, challanReference: "CH-1", amount: 10, actorId: ACTOR });
  const clean = await recon.reconcileTcs(db, { period: PERIOD });
  assert.equal(clean.summary.reconciled, true);
  assert.equal(clean.summary.recordedTcs, 10);

  sqlite.prepare("UPDATE tcs_collections SET tcs_total=99 WHERE period=?").run(PERIOD);
  const tampered = await recon.reconcileTcs(db, { period: PERIOD });
  assert.equal(tampered.summary.reconciled, false);
  assert.ok(tampered.findings.some((f) => f.code === "amount_mismatch"), "detects the tampered TCS total");
});