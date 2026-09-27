import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
installWorkersHooks("__PAYROLL_D1_DB__", "__PAYROLL_D1_ENV__");
const people=await import("../../lib/people-foundation.ts");
const payroll=await import("../../lib/payroll-engine.ts");
const start=Date.parse("2026-09-01T00:00:00+05:30"),end=Date.parse("2026-10-01T00:00:00+05:30");
async function fixture(t){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('isolated payroll test')}}",compatibilityDate:"2026-09-01",d1Databases:{DB:"payroll-integrity-test"},d1Persist:false}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database("DB");
 globalThis.__PAYROLL_D1_DB__=db;globalThis.__PAYROLL_D1_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true"};
 await people.ensurePeopleTables(db);await payroll.ensurePayrollTables(db);
 const employee=await people.upsertEmployee(db,{employeeCode:"D1-QA",displayName:"Synthetic D1 Employee",workEmail:"employee@d1.test",userEmail:"employee@d1.test",joinedAt:start-86400000,actorId:"hr@d1.test"});
 const structure=await payroll.saveSalaryStructure(db,{structureCode:"D1-QA",effectiveFrom:start-86400000,components:[{code:"BASIC",label:"Basic",kind:"earning",amount:30000}],actorId:"hr@d1.test"});
 await payroll.assignCompensation(db,{employeeId:employee.id,structureId:structure.id,effectiveFrom:start-86400000,reason:"Isolated local D1 payroll verification",actorId:"hr@d1.test"});
 return {db,calculate:key=>payroll.calculatePayroll(db,{periodStart:start,periodEnd:end,idempotencyKey:key,actorId:"maker@d1.test"})};
}
test("local Cloudflare D1 rolls back a late payroll failure and retries completely",{timeout:60000},async t=>{
 const {db,calculate}=await fixture(t);
 await db.prepare("CREATE TRIGGER test_line_failure BEFORE INSERT ON payroll_result_lines BEGIN SELECT RAISE(ABORT,'local D1 line failure'); END").run();
 await assert.rejects(()=>calculate("retry"),/local D1 line failure/);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_runs").first()).n,0);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM employee_payroll_results").first()).n,0);
 await db.prepare("DROP TRIGGER test_line_failure").run();
 const result=await calculate("retry");assert.equal(result.results.length,1);assert.equal(result.results[0].net_pay,30000);
});
test("local Cloudflare D1 concurrent calculation and preparation have one authority",{timeout:60000},async t=>{
 const {db,calculate}=await fixture(t);
 const calculations=await Promise.all(Array.from({length:4},()=>calculate("one-run")));
 assert.equal(new Set(calculations.map(x=>x.run.id)).size,1);
 assert.ok(calculations.every(x=>x.results.length===1));
 const runId=calculations[0].run.id;
 await payroll.reviewPayroll(db,{runId,actorId:"reviewer@d1.test"});
 await payroll.approvePayroll(db,{runId,actorId:"approver@d1.test"});
 const batches=await Promise.all(Array.from({length:6},()=>payroll.prepareSandboxPaymentBatch(db,{runId,actorId:"finance@d1.test"})));
 assert.equal(new Set(batches.map(x=>x.id)).size,1);
 assert.ok(batches.every(x=>x.externalTransmission===false));
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_payment_batches").first()).n,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_approval_events WHERE event_type='payment_prepared'").first()).n,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM payroll_integrity_checks").first()).n,0);
});
