import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {employeeAuditD1} from './helpers/employee-audit-d1.mjs';
installWorkersHooks('__EXIT_DB__','__EXIT_ENV__');
const exit=await import('../lib/employee-offboarding.ts');
const people=await import('../lib/people-foundation.ts');
const payroll=await import('../lib/payroll-engine.ts');
const proration=await import('../lib/payroll-proration.ts');
const salary=await import('../lib/employee-payroll-payout.ts');
const access=await import('../lib/employee-exit-access.ts');
const uat=await import('../lib/uat-staging-auth.ts');
const START=Date.parse('2026-09-01T00:00:00+05:30'),END=Date.parse('2026-10-01T00:00:00+05:30'),CUTOFF=Date.parse('2026-09-16T00:00:00+05:30');
const env={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'isolated-employee-exit-signing-key-not-a-live-secret',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',RAZORPAYX_KEY_ID_SANDBOX:'rzp_test_exit',RAZORPAYX_KEY_SECRET_SANDBOX:'isolated-test-secret',RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:'isolated-test-account',RAZORPAYX_WEBHOOK_SECRET_SANDBOX:'isolated-exit-webhook'};
async function world(t){
 const w=employeeAuditD1(t);globalThis.__EXIT_DB__=w.db;globalThis.__EXIT_ENV__={...env,DB:w.db};await exit.ensureEmployeeExitTables(w.db);
 const employee=await people.upsertEmployee(w.db,{employeeCode:'EXIT-QA',displayName:'Synthetic Exit Employee',workEmail:'employee@exit.test',userEmail:'employee@exit.test',joinedAt:START-31*86400000,actorId:'hr@exit.test'});
 await people.addEmploymentVersion(w.db,{employeeId:employee.id,effectiveFrom:START-31*86400000,employmentType:'direct_employee',teamCode:'sales',reason:'Isolated test employment',actorId:'hr@exit.test'});
 w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('EXIT-USER','employee@exit.test','Synthetic Exit Employee','associate','active',1,1)").run();
 const structure=await payroll.saveSalaryStructure(w.db,{structureCode:'EXIT-BASIC',effectiveFrom:START-31*86400000,components:[{code:'BASIC',label:'Basic',kind:'earning',amount:30000}],actorId:'hr@exit.test'});
 await payroll.assignCompensation(w.db,{employeeId:employee.id,structureId:structure.id,effectiveFrom:START-31*86400000,reason:'Explicit synthetic salary',actorId:'hr@exit.test'});
 await proration.saveSalaryCalculationPolicy(w.db,{structureId:structure.id,mode:'calendar_days',componentCodes:['BASIC'],approvalReference:'TEST-ONLY-POLICY',actorId:'finance@exit.test'});
 return{...w,employeeId:employee.id,structureId:structure.id};
}
const request=(w,extra={})=>exit.requestEmployeeExit(w.db,{employeeId:w.employeeId,accessEndsAt:CUTOFF,reason:'Synthetic employee exit',idempotencyKey:'EXIT-ONE',actorId:'hr@exit.test',...extra});
async function approved(w,extra={}){const r=await request(w,extra);await exit.approveEmployeeExit(w.db,{caseId:r.case.id,actorId:'manager@exit.test'});return r.case.id;}
async function executed(w){const caseId=await approved(w);await exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'});return caseId;}
test('request does not disable anyone; same-key replay cannot name another employee or cutoff',async t=>{const w=await world(t);const a=await request(w),b=await request(w);assert.equal(a.case.id,b.case.id);assert.equal(b.duplicatePrevented,true);assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'active');await assert.rejects(()=>request(w,{accessEndsAt:CUTOFF+1}));});
test('requester and employee cannot approve their own exit',async t=>{const w=await world(t),r=await request(w);for(const actorId of ['HR@EXIT.TEST','employee@exit.test'])await assert.rejects(()=>exit.approveEmployeeExit(w.db,{caseId:r.case.id,actorId}));assert.equal(w.sqlite.prepare('SELECT status FROM employee_exit_cases').get().status,'pending');});
test('future cutoff cannot be executed early and cancellation preserves access',async t=>{const w=await world(t),cutoff=Date.now()+86400000,caseId=await approved(w,{accessEndsAt:cutoff});assert.equal(await access.employeeAccessHasEnded(w.db,'employee@exit.test'),false);await assert.rejects(()=>exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'}));await exit.cancelEmployeeExit(w.db,{caseId,actorId:'manager@exit.test',reason:'Approved exit withdrawn'});assert.equal(await access.employeeAccessHasEnded(w.db,'employee@exit.test',cutoff+1),false);});
test('approved cutoff refuses an existing UAT session even before the scheduled writer runs',async t=>{
 const w=await world(t),token=await uat.issueUatToken(env,'employee@exit.test',3600),req=new Request('https://pawspace.test/api/me',{headers:{cookie:`pawspace_uat=${token}`}});
 assert.equal((await uat.resolveUatStaffActor(w.db,req,env)).email,'employee@exit.test');await approved(w);
 assert.equal(await uat.resolveUatStaffActor(w.db,req,env),null);assert.equal(await uat.uatStaffIdentityAllowed(w.db,'employee@exit.test'),false);
 assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'active','cutoff enforcement itself is read-only');
});
test('executing an exit revokes identity and sessions atomically while retaining employee records',async t=>{
 const w=await world(t),caseId=await approved(w);w.sqlite.prepare("INSERT INTO active_sessions(id,user_id,token_hash,mfa_verified_at,issued_at,expires_at) VALUES ('MFA','EXIT-USER','synthetic-hash',1,1,9999999999999)").run();
 await exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'});assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'disabled');
 const e=w.sqlite.prepare('SELECT * FROM employees WHERE id=?').get(w.employeeId);assert.equal(e.employment_status,'exited');assert.equal(e.ended_at,CUTOFF);assert.ok(w.sqlite.prepare("SELECT revoked_at FROM active_sessions WHERE id='MFA'").get().revoked_at);
 const again=await exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'});assert.equal(again.duplicatePrevented,true);assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_exit_events WHERE action='access_revoked'").get().n,1);
});
test('late audit failure rolls back access removal and keeps the exit retryable',async t=>{
 const w=await world(t),caseId=await approved(w);w.sqlite.exec("CREATE TRIGGER fail_exit BEFORE INSERT ON employee_exit_events WHEN NEW.action='access_revoked' BEGIN SELECT RAISE(ABORT,'exit audit failure'); END");
 await assert.rejects(()=>exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'}),/exit audit failure/);
 assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'active');assert.equal(w.sqlite.prepare('SELECT employment_status FROM employees').get().employment_status,'active');
 assert.equal(w.sqlite.prepare('SELECT status FROM employee_exit_cases').get().status,'approved');w.sqlite.exec('DROP TRIGGER fail_exit');await exit.executeEmployeeExit(w.db,{caseId,actorId:'hr@exit.test'});
});
test('changed identity after request and protected founder identity are refused',async t=>{const w=await world(t),r=await request(w);w.sqlite.prepare("UPDATE app_users SET role_code='founder' WHERE id='EXIT-USER'").run();await assert.rejects(()=>exit.approveEmployeeExit(w.db,{caseId:r.case.id,actorId:'manager@exit.test'}));await assert.rejects(()=>request(w,{idempotencyKey:'another'}));});
test('approved due-exit sweep does not execute unapproved requests',async t=>{const w=await world(t);await request(w);assert.equal((await exit.runApprovedEmployeeExitSweep(w.db)).processed,0);const caseId=await approved(w);assert.equal((await exit.runApprovedEmployeeExitSweep(w.db)).processed,1);assert.equal(w.sqlite.prepare('SELECT status FROM employee_exit_cases WHERE id=?').get(caseId).status,'access_revoked');});
test('verified leaver stays in their earned month but never the following month',async t=>{
 const w=await world(t);await executed(w);const result=await payroll.calculatePayroll(w.db,{periodStart:START,periodEnd:END,idempotencyKey:'FINAL-MONTH',actorId:'maker@exit.test'});
 assert.equal(result.results.length,1);assert.equal(result.results[0].net_pay,15000);assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'disabled');
 await assert.rejects(()=>payroll.calculatePayroll(w.db,{periodStart:END,periodEnd:Date.parse('2026-11-01T00:00:00+05:30'),idempotencyKey:'AFTER-EXIT',actorId:'maker@exit.test'}));
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:w.employeeId,fundAccountId:'fa_ExitFinal',verificationReference:'FINANCE-TEST-REVIEW',expiresAt:Date.now()+86400000,actorId:'finance@exit.test'});
});
async function paidExit(w){
 const caseId=await executed(w),run=await payroll.calculatePayroll(w.db,{periodStart:START,periodEnd:END,idempotencyKey:'FINAL-PAID',actorId:'maker@exit.test'}),runId=run.run.id;
 await payroll.reviewPayroll(w.db,{runId,actorId:'reviewer@exit.test'});await payroll.approvePayroll(w.db,{runId,actorId:'approver@exit.test'});await payroll.prepareSandboxPaymentBatch(w.db,{runId,actorId:'finance@exit.test'});
 await salary.saveEmployeeSalaryBeneficiary(w.db,{employeeId:w.employeeId,fundAccountId:'fa_ExitFinal',verificationReference:'FINANCE-TEST-REVIEW',expiresAt:Date.now()+86400000,actorId:'finance@exit.test'});
 const queued=await salary.queueEmployeeSalary(w.db,{runId,actorId:'finance@exit.test'}),instruction=queued.instructions[0];
 const send=async(status,id)=>{const rawBody=JSON.stringify({event:`payout.${status}`,payload:{payout:{entity:{id:'pout_ExitFinal',reference_id:instruction.id,fund_account_id:'fa_ExitFinal',amount:instruction.amountPaise,currency:'INR',status,utr:'SYNTHETIC-NOT-A-BANK-PAYMENT'}}}});const signature=createHmac('sha256',env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX).update(rawBody).digest('hex');return salary.processEmployeeSalaryWebhook(w.db,env,{rawBody,signature,eventId:id});};
 await send('processed','EXIT-PAID');return{caseId,runId,instruction,send};
}
const settle=(w,review,extra={})=>exit.closeEmployeeExitSandbox(w.db,{caseId:review.caseId,revision:review.revision,clearanceReference:'HR-HANDOVER-ASSETS-TEST',policyReviewReference:'FINANCE-POLICY-TEST',actorId:'finance@exit.test',confirmSandbox:true,...extra});
test('a missing final payroll blocks settlement instead of inventing zero salary',async t=>{const w=await world(t),caseId=await executed(w),review=await exit.employeeExitSettlement(w.db,caseId);assert.equal(review.ready,false);assert.ok(review.blockers.includes('one_canonical_final_period_payroll_required'));await assert.rejects(()=>settle(w,review));});
test('signed sandbox payroll proof permits one explicit settlement review without moving money',async t=>{
 const w=await world(t),{caseId}=await paidExit(w),review=await exit.employeeExitSettlement(w.db,caseId);assert.equal(review.ready,true);assert.equal(review.livePaymentConfirmed,false);
 await assert.rejects(()=>settle(w,review,{revision:'stale'}));await assert.rejects(()=>settle(w,review,{confirmSandbox:false}));
 const result=await settle(w,review);assert.equal(result.review.caseStatus,'settled_sandbox');assert.equal(result.review.settledEvidenceCurrent,true);assert.equal((await settle(w,result.review)).duplicatePrevented,true);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM employee_salary_instructions').get().n,1);
});
test('a later signed salary reversal invalidates settlement evidence without deleting history',async t=>{
 const w=await world(t),proof=await paidExit(w);await settle(w,await exit.employeeExitSettlement(w.db,proof.caseId));await proof.send('reversed','EXIT-REVERSED');
 const review=await exit.employeeExitSettlement(w.db,proof.caseId);assert.equal(review.ready,false);assert.equal(review.settledEvidenceCurrent,false);assert.ok(review.blockers.includes('sandbox_salary_confirmation_required'));await assert.rejects(()=>settle(w,review));
});
test('manager handover must be resolved in the existing People records before final settlement',async t=>{
 const w=await world(t),proof=await paidExit(w);const report=await people.upsertEmployee(w.db,{employeeCode:'REPORT',displayName:'Synthetic Direct Report',workEmail:'report@exit.test',joinedAt:START,actorId:'hr@exit.test'});
 await people.addEmploymentVersion(w.db,{employeeId:report.id,effectiveFrom:START,employmentType:'direct_employee',managerEmployeeId:w.employeeId,reason:'Synthetic existing manager',actorId:'hr@exit.test'});
 let review=await exit.employeeExitSettlement(w.db,proof.caseId);assert.ok(review.blockers.includes('open_work_handover_required'));await assert.rejects(()=>settle(w,review));
 await people.addEmploymentVersion(w.db,{employeeId:report.id,effectiveFrom:CUTOFF,employmentType:'direct_employee',managerEmployeeId:null,reason:'Handover resolved by HR',actorId:'hr@exit.test'});
 review=await exit.employeeExitSettlement(w.db,proof.caseId);assert.equal(review.ready,true);
});
test('ordinary onboarding cannot silently reactivate a completed exit',async t=>{const w=await world(t);await executed(w);const {onboardEmployeeJourney}=await import('../lib/employee-journey-onboarding.ts');await assert.rejects(()=>onboardEmployeeJourney(w.db,{employeeCode:'EXIT-QA',displayName:'Synthetic Exit Employee',workEmail:'employee@exit.test',joinedAt:START,structureId:w.structureId,roleCode:'associate',reason:'Must not bypass rehire',actorId:'hr@exit.test'}),/explicit rehire/);assert.equal(w.sqlite.prepare("SELECT status FROM app_users WHERE id='EXIT-USER'").get().status,'disabled');});

test('automated actor strings cannot approve an exit or sign off settlement',async t=>{
 const w=await world(t),pending=await request(w);
 await assert.rejects(()=>exit.approveEmployeeExit(w.db,{caseId:pending.case.id,actorId:'system:employee-exit'}));
 const proof=await paidExit(w),review=await exit.employeeExitSettlement(w.db,proof.caseId);
 await assert.rejects(()=>settle(w,review,{actorId:'system:settlement'}));
});
function incentiveFixture(w,id='INC-EXIT',amount=0,status='approved'){
 w.sqlite.prepare("INSERT INTO employee_incentive_results (id,period_id,employee_id,employee_email,source_fact_run_id,metric_value,calculated_amount,approved_amount,status,evidence_json,approved_by,approved_at) VALUES (?,'PERIOD-TEST',?,'employee@exit.test','FACT-TEST',0,?,?,?,'{}','finance@exit.test',1)").run(id,w.employeeId,amount,amount,status);
}
test('approved zero-value incentives need no fabricated payroll payment',async t=>{
 const w=await world(t),proof=await paidExit(w);incentiveFixture(w);
 w.sqlite.prepare("INSERT INTO sales_incentive_period_results (id,employee_id,month_start,daily_accrued_total,monthly_achieved_value,monthly_bonus,approved_total,status,generated_by,generated_at,approved_by,approved_at) VALUES ('ZERO-SALES','employee@exit.test','2026-09-01',0,0,0,0,'approved','maker@exit.test',1,'finance@exit.test',2)").run();
 const review=await exit.employeeExitSettlement(w.db,proof.caseId);assert.equal(review.ready,true,JSON.stringify(review.blockers));
});
test('an unconsumed approved incentive reversal blocks final settlement',async t=>{
 const w=await world(t),proof=await paidExit(w);incentiveFixture(w,'INC-REVERSED',100,'reversed');
 w.sqlite.prepare("INSERT INTO incentive_reversals (id,result_id,amount,reason,status,effective_at,actor_id,created_at) VALUES ('REV-EXIT','INC-REVERSED',100,'Synthetic adjustment','approved',?,'finance@exit.test',1)").run(CUTOFF-1);
 const review=await exit.employeeExitSettlement(w.db,proof.caseId);assert.equal(review.ready,false);assert.ok(review.blockers.includes('outstanding_incentive_review'));
 await assert.rejects(()=>settle(w,review));
});
test('renaming a login cannot escape an approved exit bound to the same user id',async t=>{
 const w=await world(t);await approved(w);w.sqlite.prepare("UPDATE app_users SET email='renamed@exit.test' WHERE id='EXIT-USER'").run();
 assert.equal(await access.employeeAccessHasEnded(w.db,'renamed@exit.test'),true);
});

async function leadFixture(w){
 const lead=await import('../lib/lead-assignment-governance.ts');await lead.ensureLeadAssignmentTables(w.db);
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,area TEXT,email TEXT)");
 w.sqlite.prepare("INSERT INTO crm_contacts VALUES ('EXIT-CUSTOMER','Synthetic customer','9000000000','Bengaluru','customer@exit.test')").run();
 w.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_cycle,opt_out,created_at,updated_at,lifecycle_state) VALUES ('EXIT-LEAD','EXIT-CUSTOMER','Website','Grooming','Unassigned','Manager','active','day_1',1,?,?,?,0,0,?,?,'new')").run(CUTOFF,CUTOFF+600000,CUTOFF+1800000,CUTOFF,CUTOFF);
 const policy=await lead.saveLeadAssignmentPolicy(w.db,{name:'Synthetic exit routing',teamCode:'sales',serviceCodes:['grooming'],cityIds:['Bengaluru'],maxActiveWorkload:10,continuityEnabled:true,requireShift:false,fallbackQueue:'exit-review',effectiveFrom:START,reason:'Synthetic assignment test',actorId:'manager@exit.test'});
 await lead.activateLeadAssignmentPolicy(w.db,{policyId:policy.id,approvalReference:'TEST-ONLY',reason:'Synthetic routing approval',actorId:'manager@exit.test'});
 await lead.saveLeadAssignmentMember(w.db,{employeeEmail:'employee@exit.test',teamCode:'sales',serviceCodes:['grooming'],cityIds:['Bengaluru'],active:true,actorId:'manager@exit.test'});
 return()=>lead.assignLead(w.db,{leadId:'EXIT-LEAD',idempotencyKey:'EXIT-ASSIGN',reason:'new_lead',actorId:'system:lead-routing',asOf:CUTOFF});
}
test('lead selection respects approved exit cutoff before the employee row is disabled',async t=>{
 const w=await world(t),assign=await leadFixture(w);await approved(w);const r=await assign();assert.equal(r.assignment.employee_email,null);assert.equal(r.assignment.fallback_queue,'exit-review');
});
test('exit approved during lead selection blocks the assignment write atomically',async t=>{
 const w=await world(t),assign=await leadFixture(w),pending=await request(w),original=w.db.prepare;let injected=0;
 w.db.prepare=sql=>{const statement=original(sql);if(!/^INSERT INTO lead_assignments /.test(sql))return statement;
  const wrap=s=>new Proxy(s,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(key==='run')return async()=>{if(!injected++){await exit.approveEmployeeExit(w.db,{caseId:pending.case.id,actorId:'manager@exit.test'});}return target.run();};return Reflect.get(target,key);}});return wrap(statement);};
 await assert.rejects(assign);assert.equal(injected,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM lead_assignments').get().n,0);assert.equal(w.sqlite.prepare("SELECT owner FROM lead_work_items WHERE id='EXIT-LEAD'").get().owner,'Unassigned');
});

for(const state of ['pending','future','cancelled'])test(`lead assignment remains available for ${state} exit`,async t=>{
 const w=await world(t),assign=await leadFixture(w);
 if(state==='pending')await request(w);
 else {const id=await approved(w,{accessEndsAt:Date.now()+86400000});if(state==='cancelled')await exit.cancelEmployeeExit(w.db,{caseId:id,actorId:'manager@exit.test',reason:'Synthetic cancellation before cutoff'});}
 const result=await assign();assert.equal(result.assignment.employee_email,'employee@exit.test');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM lead_assignments').get().n,1);
});
test('the first exit approved during a cold lead-only assignment cannot bypass the write guard',async t=>{
 const w=await world(t);w.sqlite.exec('DROP TABLE employee_exit_cases');const assign=await leadFixture(w),original=w.db.prepare;let injected=0;
 assert.ok(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='employee_exit_cases'").get(),'lead bootstrap creates only the shared cutoff schema');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM employee_exit_cases').get().n,0);
 w.db.prepare=sql=>{const q=original(sql);if(!/^INSERT INTO lead_assignments /.test(sql))return q;
  const wrap=s=>new Proxy(s,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(key==='run')return async()=>{if(!injected++)await approved(w);return target.run();};return Reflect.get(target,key);}});return wrap(q);};
 await assert.rejects(assign,e=>e instanceof Error&&e.name==='GovernedRefusal'&&e.status===409);
 assert.equal(injected,1);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM lead_assignments').get().n,0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM lead_assignment_events').get().n,0);
 assert.equal(w.sqlite.prepare("SELECT owner FROM lead_work_items WHERE id='EXIT-LEAD'").get().owner,'Unassigned');
});
test('lead fallback uses the cutoff user id after a staff email change',async t=>{
 const w=await world(t),assign=await leadFixture(w);await approved(w);
 w.sqlite.exec("UPDATE app_users SET email='renamed@exit.test' WHERE id='EXIT-USER'; UPDATE lead_assignment_memberships SET employee_email='renamed@exit.test'; UPDATE employees SET work_email='renamed@exit.test',user_email='renamed@exit.test'");
 const result=await assign();assert.equal(result.assignment.employee_email,null);assert.equal(result.assignment.fallback_queue,'exit-review');
});
