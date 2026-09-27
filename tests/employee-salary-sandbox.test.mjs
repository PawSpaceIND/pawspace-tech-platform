import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {createHmac} from "node:crypto";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {employeeAuditD1} from "./helpers/employee-audit-d1.mjs";
installWorkersHooks("__SALARY_DB__","__SALARY_ENV__");
const people=await import("../lib/people-foundation.ts");
const payroll=await import("../lib/payroll-engine.ts");
const salary=await import("../lib/employee-payroll-payout.ts");
const START=Date.parse("2026-09-01T00:00:00+05:30"),END=Date.parse("2026-10-01T00:00:00+05:30");
async function world(t){
 const w=employeeAuditD1(t);globalThis.__SALARY_DB__=w.db;globalThis.__SALARY_ENV__={DB:w.db};
 await people.ensurePeopleTables(w.db);
 const employee=await people.upsertEmployee(w.db,{employeeCode:"SAL-QA",displayName:"Synthetic salary employee",workEmail:"salary@qa.test",joinedAt:START-86400000,actorId:"hr@qa.test"});
 const structure=await payroll.saveSalaryStructure(w.db,{structureCode:"SAL-QA",effectiveFrom:START-86400000,components:[{code:"BASIC",label:"Basic",kind:"earning",amount:30000}],actorId:"hr@qa.test"});
 await payroll.assignCompensation(w.db,{employeeId:employee.id,structureId:structure.id,effectiveFrom:START-86400000,reason:"Synthetic salary transport test",actorId:"hr@qa.test"});
 const run=await payroll.calculatePayroll(w.db,{periodStart:START,periodEnd:END,idempotencyKey:"salary-qa",actorId:"maker@qa.test"});
 await payroll.reviewPayroll(w.db,{runId:run.run.id,actorId:"reviewer@qa.test"});
 await payroll.approvePayroll(w.db,{runId:run.run.id,actorId:"approver@qa.test"});
 await payroll.prepareSandboxPaymentBatch(w.db,{runId:run.run.id,actorId:"finance@qa.test"});
 return{...w,employeeId:employee.id,runId:run.run.id};
}
async function instructions(w){
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:w.employeeId,fundAccountId:"fa_SALARYQA",verificationReference:"LOCAL-TEST-EVIDENCE",expiresAt:Date.now()+86400000,actorId:"finance@qa.test"});
 return salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"approver@qa.test"});
}
async function transport(t){
 const calls=[];let last=null;
 const server=http.createServer((req,res)=>{let raw="";req.on("data",x=>raw+=x);req.on("end",()=>{
  calls.push({method:req.method,path:req.url,body:raw?JSON.parse(raw):null,idem:req.headers["x-payout-idempotency"]});
  if(req.method==="POST"){const p=JSON.parse(raw);last={...p,id:"pout_SALARYQA",status:"processing",utr:null};}
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(last));
 });});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise(r=>server.close(r)));
 const env={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_RAZORPAYX_ENV:"sandbox",PAWSPACE_RAZORPAYX_LIVE_APPROVED:"false",
  RAZORPAYX_KEY_ID_SANDBOX:"rzp_test_local",RAZORPAYX_KEY_SECRET_SANDBOX:"local-test-secret",RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:"local-test-account",RAZORPAYX_WEBHOOK_SECRET_SANDBOX:"local-test-webhook",
  PAWSPACE_RAZORPAYX_CONTRACT_TEST:"true",PAWSPACE_RAZORPAYX_API_BASE_URL:`http://127.0.0.1:${server.address().port}`};
 return{calls,env,payout:()=>last};
}
function webhook(env,payout,event="payout.processed",id="salary-event"){
 const rawBody=JSON.stringify({event,payload:{payout:{entity:{...payout,status:event.slice(7),utr:"QA-NOT-A-BANK-UTR"}}}});
 return{rawBody,signature:createHmac("sha256",env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX).update(rawBody).digest("hex"),eventId:id};
}
test("salary instructions require reviewed beneficiary and non-maker authorization",async t=>{
 const w=await world(t);await assert.rejects(()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"approver@qa.test"}));
 await instructions(w);await assert.rejects(()=>salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"maker@qa.test"}));
});
test("repeat authorization creates one instruction per payroll result",async t=>{
 const w=await world(t),first=await instructions(w);
 const repeat=await salary.queueEmployeeSalary(w.db,{runId:w.runId,actorId:"approver@qa.test"});
 assert.equal(first.instructions[0].id,repeat.instructions[0].id);assert.equal(repeat.duplicatePrevented,true);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_salary_instructions").get().n,1);
});
test("salary uses the existing transport and signed confirmation settles only its payroll",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 await salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"});
 assert.equal(provider.calls.length,1);assert.equal(provider.calls[0].body.purpose,"salary");
 assert.equal(provider.calls[0].body.notes.employee_id,w.employeeId);assert.equal(provider.calls[0].body.notes.provider_id,undefined);
 assert.equal(provider.calls[0].body.amount,3000000);
 const event=webhook(provider.env,provider.payout());await salary.processEmployeeSalaryWebhook(w.db,provider.env,event);
 assert.equal(w.sqlite.prepare("SELECT status FROM payroll_runs").get().status,"paid_sandbox");
 assert.equal(w.sqlite.prepare("SELECT status FROM payslips").get().status,"paid_sandbox");
 assert.equal((await salary.processEmployeeSalaryWebhook(w.db,provider.env,event)).duplicatePrevented,true);
 await salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"});assert.equal(provider.calls.length,1);
});
test("wrong signatures and wrong amounts cannot settle an employee salary",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 await salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"});
 const event=webhook(provider.env,provider.payout());
 await assert.rejects(()=>salary.processEmployeeSalaryWebhook(w.db,provider.env,{...event,signature:"00"}),e=>e instanceof Response&&e.status===401);
 await assert.rejects(()=>salary.processEmployeeSalaryWebhook(w.db,provider.env,webhook(provider.env,{...provider.payout(),amount:1},"payout.processed","wrong-amount")));
 assert.equal(w.sqlite.prepare("SELECT status FROM payroll_runs").get().status,"payment_prepared");
});
test("salary reversal restores a review state and old queued events never erase it",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 await salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"});
 for(const[event,id]of[["payout.processed","paid"],["payout.reversed","reverse"],["payout.queued","old"]])await salary.processEmployeeSalaryWebhook(w.db,provider.env,webhook(provider.env,provider.payout(),event,id));
 assert.equal(w.sqlite.prepare("SELECT status FROM employee_salary_instructions").get().status,"reversed_sandbox");
 assert.equal(w.sqlite.prepare("SELECT status FROM payroll_runs").get().status,"payment_prepared");
});
test("live or incomplete payout configuration is refused before any transport call",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 await assert.rejects(()=>salary.dispatchEmployeeSalarySandbox(w.db,{...provider.env,PAWSPACE_PAYMENT_ENV:"live"},{instructionId,actorId:"finance@qa.test"}),e=>e instanceof Response&&e.status===503);
 await assert.rejects(()=>salary.dispatchEmployeeSalarySandbox(w.db,{...provider.env,RAZORPAYX_WEBHOOK_SECRET_SANDBOX:""},{instructionId,actorId:"finance@qa.test"}));
 assert.equal(provider.calls.length,0);
});
test("concurrent dispatch cannot duplicate the provider request",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 const outcomes=await Promise.allSettled(Array.from({length:4},()=>salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"})));
 assert.ok(outcomes.some(r=>r.status==="fulfilled"));assert.equal(provider.calls.filter(r=>r.method==="POST").length,1);
});
test("a transport timeout never marks salary paid and keeps its original request key",async t=>{
 const w=await world(t),provider=await transport(t),queued=await instructions(w),instructionId=queued.instructions[0].id;
 const before=w.sqlite.prepare("SELECT idempotency_key FROM employee_salary_instructions").get().idempotency_key;
 const result=await salary.dispatchEmployeeSalarySandbox(w.db,{...provider.env,PAWSPACE_RAZORPAYX_API_BASE_URL:"http://127.0.0.1:1",PAWSPACE_RAZORPAYX_TIMEOUT_MS:"250"},{instructionId,actorId:"finance@qa.test"});
 assert.equal(result.reconciliationRequired,true);assert.equal(w.sqlite.prepare("SELECT status FROM employee_salary_instructions").get().status,"reconciliation_required");
 await salary.dispatchEmployeeSalarySandbox(w.db,provider.env,{instructionId,actorId:"finance@qa.test"});
 assert.equal(w.sqlite.prepare("SELECT idempotency_key FROM employee_salary_instructions").get().idempotency_key,before);
 assert.equal(w.sqlite.prepare("SELECT status FROM payroll_runs").get().status,"payment_prepared");
});
test("automatic salary sweep is disabled unless explicitly enabled",async()=>{
 const db={prepare(){throw new Error("Disabled automation must not touch the database");}};
 const result=await salary.runEmployeeSalarySandboxSweep(db,{});assert.equal(result.enabled,false);assert.equal(result.liveSalaryEnabled,false);
});
test("enabled TEST sweep processes only already-authorized instructions",async t=>{
 const w=await world(t),provider=await transport(t);await instructions(w);
 const result=await salary.runEmployeeSalarySandboxSweep(w.db,{...provider.env,PAWSPACE_EMPLOYEE_SALARY_SANDBOX_AUTODISPATCH:"on"});
 assert.equal(result.enabled,true);assert.equal(result.processed,1);assert.equal(provider.calls.filter(r=>r.method==="POST").length,1);
 await salary.runEmployeeSalarySandboxSweep(w.db,{...provider.env,PAWSPACE_EMPLOYEE_SALARY_SANDBOX_AUTODISPATCH:"on"});
 assert.equal(provider.calls.filter(r=>r.method==="POST").length,1,"later sweeps reconcile instead of creating another payout");
});
