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
async function fixture(t){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('isolated exit test')}}",compatibilityDate:'2026-09-01',d1Databases:{DB:'employee-exit-test'},d1Persist:false}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');globalThis.__EXIT_LOCAL_D1__=db;globalThis.__EXIT_LOCAL_ENV__={DB:db,PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true'};
 await exit.ensureEmployeeExitTables(db);const e=await people.upsertEmployee(db,{employeeCode:'EXIT-D1',displayName:'Synthetic Exit',workEmail:'employee@exit-d1.test',userEmail:'employee@exit-d1.test',joinedAt:START-86400000,actorId:'hr@exit-d1.test'});
 await people.addEmploymentVersion(db,{employeeId:e.id,effectiveFrom:START-86400000,employmentType:'direct_employee',reason:'Synthetic direct employee',actorId:'hr@exit-d1.test'});
 await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('EXIT-U','employee@exit-d1.test','Synthetic Exit','associate','active',1,1)").run();
 const s=await payroll.saveSalaryStructure(db,{structureCode:'EXIT-D1',effectiveFrom:START-86400000,components:[{code:'BASIC',label:'Basic',kind:'earning',amount:30000}],actorId:'hr@exit-d1.test'});
 await payroll.assignCompensation(db,{employeeId:e.id,structureId:s.id,effectiveFrom:START-86400000,reason:'Synthetic compensation',actorId:'hr@exit-d1.test'});
 await proration.saveSalaryCalculationPolicy(db,{structureId:s.id,mode:'calendar_days',componentCodes:['BASIC'],approvalReference:'TEST-ONLY',actorId:'finance@exit-d1.test'});
 const request=await exit.requestEmployeeExit(db,{employeeId:e.id,accessEndsAt:CUT,reason:'Synthetic employee exit',idempotencyKey:'EXIT-ONE',actorId:'hr@exit-d1.test'});
 await exit.approveEmployeeExit(db,{caseId:request.case.id,actorId:'manager@exit-d1.test'});return{db,caseId:request.case.id,employeeId:e.id};
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
