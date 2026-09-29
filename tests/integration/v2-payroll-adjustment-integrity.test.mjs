import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
import { v2PayrollFixture } from "../helpers/v2-payroll-governance-fixture.mjs";
installWorkersHooks("__V2PG_NATIVE_DB__", "__V2PG_NATIVE_ENV__");
async function world(t){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,
  script:"export default {fetch(){return new Response('isolated V2 payroll test')}}",
  compatibilityDate:"2026-09-01",d1Databases:{DB:"v2-payroll-adjustment-test"},d1Persist:false,cf:false,
  outboundService:async()=>{throw new Error("This local test forbids outbound requests");}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
 globalThis.__V2PG_NATIVE_DB__=db;globalThis.__V2PG_NATIVE_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true"};
 return v2PayrollFixture(db);
}
async function noChecks(db){assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_integrity_checks").first()).n,0);}
test("native V2 payroll: approved deduction remains valid for canonical payment preparation",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();assert.equal((await w.apply()).applied,1);
 assert.equal((await w.apply()).applied,0);await w.approve();
 const batch=await w.payroll.prepareSandboxPaymentBatch(w.db,{runId:w.runId,actorId:"finance@v2-payroll.test"});
 assert.equal(batch.externalTransmission,false);assert.equal((await w.result()).net_pay,29000);
 assert.equal((await w.lines()).length,1);await noChecks(w.db);
});
test("native V2 payroll: six concurrent applications cannot deduct twice",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();const outcomes=await Promise.allSettled(Array.from({length:6},()=>w.apply()));
 assert.equal(outcomes.filter(x=>x.status==="fulfilled").reduce((n,x)=>n+x.value.applied,0),1);
 assert.equal((await w.result()).net_pay,29000);assert.equal((await w.result()).total_deductions,1000);
 assert.equal((await w.lines()).length,1);await noChecks(w.db);
});
for(const fault of ["line","snapshot"])test(`native V2 payroll: suppressed ${fault} rolls back all adjustment effects`,{timeout:60000},async t=>{
 const w=await world(t);const id=await w.adjustment();
 const before=await w.db.prepare("SELECT input_snapshot_json FROM payroll_runs WHERE id=?").bind(w.runId).first();
 const sql=fault==="line"
  ? "CREATE TRIGGER v2qa_fail BEFORE INSERT ON payroll_result_lines WHEN NEW.source_type='v2_hr_payroll_adjustment' BEGIN SELECT RAISE(IGNORE); END"
  : "CREATE TRIGGER v2qa_fail BEFORE UPDATE OF input_snapshot_json ON payroll_runs BEGIN SELECT RAISE(IGNORE); END";
 await w.db.prepare(sql).run();await assert.rejects(w.apply);
 assert.equal((await w.result()).net_pay,30000);assert.equal((await w.lines()).length,0);
 assert.equal((await w.db.prepare("SELECT status FROM v2_payroll_adjustments WHERE id=?").bind(id).first()).status,"approved");
 assert.deepEqual(await w.db.prepare("SELECT input_snapshot_json FROM payroll_runs WHERE id=?").bind(w.runId).first(),before);
 assert.equal((await w.db.prepare("SELECT COUNT(*) n FROM v2_payroll_governance_events WHERE action='adjustments_applied'").first()).n,0);
 await noChecks(w.db);await w.db.prepare("DROP TRIGGER v2qa_fail").run();assert.equal((await w.apply()).applied,1);
 assert.equal((await w.result()).net_pay,29000);await noChecks(w.db);
});
test("native V2 payroll: review racing with application preserves the reviewed salary",{timeout:60000},async t=>{
 const w=await world(t);await w.adjustment();let readAdjustments=false,changed=false;
 // D1's proxy does not accept monkey-patching methods. Pass an explicit wrapper instead.
 const observed={prepare(sql){if(sql.includes("status='approved' AND applied_at IS NULL"))readAdjustments=true;return w.db.prepare(sql);},
  async batch(statements){if(readAdjustments&&!changed){changed=true;await w.db.prepare("UPDATE payroll_runs SET status='reviewed' WHERE id=?").bind(w.runId).run();}return w.db.batch(statements);}};
 await assert.rejects(()=>w.governance.applyApprovedV2Adjustments(observed,{runId:w.runId,actorId:"operator@v2-payroll.test"}),error=>error instanceof Response&&error.status===409);
 assert.equal(changed,true);assert.equal((await w.result()).net_pay,30000);assert.equal((await w.lines()).length,0);await noChecks(w.db);
});
