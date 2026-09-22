import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { freshSqlite, makeD1 } from './helpers/taxi-harness.mjs';
installWorkersHooks('__PAYROLL_REPEAT_DB__');
// EMP-L-D01: preparing payment for a run that was already prepared answered a plain Error, which the
// route redacted to a 500 "Payroll update failed" — indistinguishable from a lost payment instruction.

const world = async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__PAYROLL_REPEAT_DB__ = db;
  const engine = await import('../lib/payroll-engine.ts');
  await engine.ensurePayrollTables(db);
  await db.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at,reviewed_by,reviewed_at,approved_by,approved_at) VALUES ('RUN-1','k1',1,2,'approved','{}','maker@pawspace.in',1,'checker@pawspace.in',2,'founder@pawspace.in',3)").run();
  await db.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json) VALUES ('R1','RUN-1','EMP1','S1',1000,100,0,1100,900,'{}')").run();
  return { sqlite, db, engine };
};

test('preparing payment twice returns the batch that exists instead of failing', async () => {
  const { sqlite, engine, db } = await world();
  const first = await engine.prepareSandboxPaymentBatch(db, { runId: 'RUN-1', actorId: 'founder@pawspace.in' });
  assert.equal(first.status, 'sandbox_prepared');
  assert.equal(first.externalTransmission, false);
  const second = await engine.prepareSandboxPaymentBatch(db, { runId: 'RUN-1', actorId: 'founder@pawspace.in' });
  assert.equal(second.id, first.id, 'the repeat must return the same batch');
  assert.equal(second.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM payroll_payment_batches WHERE run_id='RUN-1'").get().n, 1, 'no second batch may be created');
});

test('a run that is not approved is refused in plain words, not as a server error', async () => {
  const { engine, db } = await world();
  await db.prepare("UPDATE payroll_runs SET status='calculated' WHERE id='RUN-1'").run();
  let refusal = null;
  try { await engine.prepareSandboxPaymentBatch(db, { runId: 'RUN-1', actorId: 'founder@pawspace.in' }); }
  catch (error) { refusal = error; }
  assert.ok(refusal instanceof Response, 'the refusal must be a governed response, not a bare Error');
  assert.equal(refusal.status, 409);
  const body = await refusal.json();
  assert.match(body.error, /calculated/, 'the refusal must name the state the run is actually in');
  assert.match(body.error, /approved/);
  let missing = null;
  try { await engine.prepareSandboxPaymentBatch(db, { runId: 'RUN-NOPE', actorId: 'founder@pawspace.in' }); }
  catch (error) { missing = error; }
  assert.ok(missing instanceof Response);
  assert.equal(missing.status, 404);
});
