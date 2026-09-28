import assert from 'node:assert/strict';
import test from 'node:test';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {installWorkersHooks} from '../helpers/module-hooks.mjs';
installWorkersHooks('__EXIT_LOCAL_D1__','__EXIT_LOCAL_ENV__');
const exit=await import('../../lib/employee-offboarding.ts');
const people=await import('../../lib/people-foundation.ts');
const payroll=await import('../../lib/payroll-engine.ts');
const proration=await import('../../lib/payroll-proration.ts');
const START=Date.parse('2026-09-01T00:00:00+05:30'),END=Date.parse('2026-10-01T00:00:00+05:30'),CUT=Date.parse('2026-09-16T00:00:00+05:30');
async function fixture(t,approve=true){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('isolated exit test')}}",compatibilityDate:'2026-09-01',d1Databases:{DB:'employee-exit-test'},d1Persist:false}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');globalThis.__EXIT_LOCAL_D1__=db;globalThis.__EXIT_LOCAL_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true'};
 await exit.ensureEmployeeExitTables(db);const e=await people.upsertEmployee(db,{employeeCode:'EXIT-D1',displayName:'Synthetic Exit',workEmail:'employee@exit-d1.test',userEmail:'employee@exit-d1.test',joinedAt:START-86400000,actorId:'hr@exit-d1.test'});
 await people.addEmploymentVersion(db,{employeeId:e.id,effectiveFrom:START-86400000,employmentType:'direct_employee',reason:'Synthetic direct employee',actorId:'hr@exit-d1.test'});
 await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('EXIT-U','employee@exit-d1.test','Synthetic Exit','associate','active',1,1)").run();
 const s=await payroll.saveSalaryStructure(db,{structureCode:'EXIT-D1',effectiveFrom:START-86400000,components:[{code:'BASIC',label:'Basic',kind:'earning',amount:30000}],actorId:'hr@exit-d1.test'});
 await payroll.assignCompensation(db,{employeeId:e.id,structureId:s.id,effectiveFrom:START-86400000,reason:'Synthetic compensation',actorId:'hr@exit-d1.test'});
 await proration.saveSalaryCalculationPolicy(db,{structureId:s.id,mode:'calendar_days',componentCodes:['BASIC'],approvalReference:'TEST-ONLY',actorId:'finance@exit-d1.test'});
 const request=await exit.requestEmployeeExit(db,{employeeId:e.id,accessEndsAt:CUT,reason:'Synthetic employee exit',idempotencyKey:'EXIT-ONE',actorId:'hr@exit-d1.test'});
 if(approve)await exit.approveEmployeeExit(db,{caseId:request.case.id,actorId:'manager@exit-d1.test'});return{db,caseId:request.case.id,employeeId:e.id};
}
test('local D1 employee exit rolls back a late audit failure and then retries completely',{timeout:60000},async t=>{
 const {db,caseId,employeeId}=await fixture(t);await db.prepare("CREATE TRIGGER exit_audit_fail BEFORE INSERT ON employee_exit_events WHEN NEW.action='access_revoked' BEGIN SELECT RAISE(ABORT,'exit audit failure'); END").run();
 await assert.rejects(()=>exit.executeEmployeeExit(db,{caseId,actorId:'hr@exit-d1.test'}),/exit audit failure/);
 assert.equal((await db.prepare('SELECT employment_status FROM employees WHERE id=?').bind(employeeId).first()).employment_status,'active');assert.equal((await db.prepare("SELECT status FROM app_users WHERE id='EXIT-U'").first()).status,'active');
 await db.prepare('DROP TRIGGER exit_audit_fail').run();await exit.executeEmployeeExit(db,{caseId,actorId:'hr@exit-d1.test'});assert.equal((await db.prepare("SELECT status FROM app_users WHERE id='EXIT-U'").first()).status,'disabled');
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM employee_exit_events WHERE action='access_revoked'").first()).n,1);
});
test('local D1 retains final earned salary for a verified leaver without restoring access',{timeout:60000},async t=>{
 const {db,caseId,employeeId}=await fixture(t);await exit.executeEmployeeExit(db,{caseId,actorId:'hr@exit-d1.test'});
 const result=await payroll.calculatePayroll(db,{periodStart:START,periodEnd:END,idempotencyKey:'FINAL-EXIT',actorId:'maker@exit-d1.test'});
 assert.equal(result.results.length,1);assert.equal(result.results[0].employee_id,employeeId);assert.equal(result.results[0].net_pay,15000);
 assert.equal((await db.prepare("SELECT status FROM app_users WHERE id='EXIT-U'").first()).status,'disabled');
 const review=await exit.employeeExitSettlement(db,caseId);assert.equal(review.ready,false);assert.ok(review.blockers.includes('payroll_approval_required'));assert.ok(review.blockers.includes('sandbox_salary_confirmation_required'));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM payroll_payment_batches').first()).n,0);
});

async function leadFixture(db){
 const lead=await import('../../lib/lead-assignment-governance.ts');await lead.ensureLeadAssignmentTables(db);
 await db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,area TEXT,email TEXT)").run();
 await db.prepare("INSERT INTO crm_contacts VALUES ('EXIT-C','Synthetic','9000000000','Bengaluru','customer@exit-d1.test')").run();
 await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_cycle,opt_out,created_at,updated_at,lifecycle_state) VALUES ('EXIT-L','EXIT-C','Website','Grooming','Unassigned','Manager','active','day_1',1,?,?,?,0,0,?,?,'new')").bind(CUT,CUT+600000,CUT+1800000,CUT,CUT).run();
 const p=await lead.saveLeadAssignmentPolicy(db,{name:'D1 exit routing',teamCode:'sales',serviceCodes:['grooming'],cityIds:['Bengaluru'],maxActiveWorkload:10,continuityEnabled:true,requireShift:false,fallbackQueue:'exit-review',effectiveFrom:START,reason:'Synthetic assignment test',actorId:'manager@exit-d1.test'});
 await lead.activateLeadAssignmentPolicy(db,{policyId:p.id,approvalReference:'TEST-ONLY',reason:'Synthetic routing approval',actorId:'manager@exit-d1.test'});
 await lead.saveLeadAssignmentMember(db,{employeeEmail:'employee@exit-d1.test',teamCode:'sales',serviceCodes:['grooming'],cityIds:['Bengaluru'],active:true,actorId:'manager@exit-d1.test'});
 return()=>lead.assignLead(db,{leadId:'EXIT-L',idempotencyKey:'EXIT-ASSIGN',reason:'new_lead',actorId:'system:lead-routing',asOf:CUT});
}
test('local D1 sends an approved-cutoff employee lead to the configured fallback',{timeout:60000},async t=>{
 const {db}=await fixture(t),assign=await leadFixture(db),result=await assign();
 assert.equal(result.assignment.employee_email,null);assert.equal(result.assignment.fallback_queue,'exit-review');
 assert.equal((await db.prepare("SELECT status FROM app_users WHERE id='EXIT-U'").first()).status,'active','no scheduler execution is needed for the cutoff');
});
test('local D1 refuses exit approval racing the lead INSERT and safely retries to fallback',{timeout:60000},async t=>{
 const {db,caseId}=await fixture(t,false),original=db.prepare.bind(db);let injected=0;
 // Miniflare returns an RPC proxy: use a transparent transport wrapper rather than overwriting it.
 const transport={prepare:original,batch:items=>db.batch(items)};
 const assign=await leadFixture(transport);
 transport.prepare=sql=>{const q=original(sql);if(!/^INSERT INTO lead_assignments /.test(sql))return q;
  const wrap=s=>new Proxy(s,{get(target,key){if(key==='bind')return(...args)=>wrap(target.bind(...args));if(key==='run')return async()=>{if(!injected++)await exit.approveEmployeeExit(db,{caseId,actorId:'manager@exit-d1.test'});return target.run();};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return wrap(q);};
 await assert.rejects(assign,e=>e instanceof Error&&e.name==='GovernedRefusal'&&e.status===409);
 assert.equal(injected,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM lead_assignments').first()).n,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM lead_assignment_events').first()).n,0);
 assert.equal((await db.prepare("SELECT owner FROM lead_work_items WHERE id='EXIT-L'").first()).owner,'Unassigned');
 transport.prepare=original;const retry=await assign();assert.equal(retry.assignment.employee_email,null);assert.equal(retry.assignment.fallback_queue,'exit-review');
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM lead_assignments').first()).n,1);
});
