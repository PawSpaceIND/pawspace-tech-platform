import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__EXIT_SURFACE_DB__');
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const {requiredPermission}=await import('../lib/api-gateway.ts');
test('V2 employee entries reuse the exact canonical pages rather than fork logic',()=>{
 for(const [file,target] of [['app/v2/people/page.tsx','../../team/people/page'],['app/v2/payroll/page.tsx','../../team/people/payroll/page'],['app/v2/employee/page.tsx','../../me/page'],['app/v2/people/offboarding/page.tsx','../../../team/people/offboarding/page']]){
  assert.equal(read(file),`export {default} from "${target}";\n`);assert.ok(fs.existsSync(new URL('../'+path.posix.normalize(path.posix.dirname(file)+'/'+target)+'.tsx',import.meta.url)));
 }
});
test('exit gateway requires People administration for reads and writes',async()=>{
 for(const method of ['GET','POST'])assert.equal(await requiredPermission(new Request('https://pawspace.test/api/employee-offboarding',{method})), 'people.manage');
});
test('exit route retains independent identity and payroll authorities and trusts no body actor',()=>{
 const source=read('app/api/employee-offboarding/route.ts');assert.match(source,/authorize\(request,"people\.manage"\)/);assert.match(source,/requirePermission\(actor,"users\.manage"\)/);assert.match(source,/requirePermission\(actor,"payroll\.approve"\)/);assert.match(source,/requirePermission\(actor,"payroll\.view"\)/);
 assert.match(source,/actorId=actor\.email/);assert.doesNotMatch(source,/actorId:\s*body\./);assert.match(source,/Cross-origin employee exit write blocked/);assert.match(source,/confirmSandbox:body\.confirmSandbox===true/);
});
test('staff exit screen exposes errors, source blockers, explicit approvals and sandbox limits',()=>{
 const source=read('app/team/people/offboarding/page.tsx');for(const text of ['role="alert"','role="status"','Request exit','Approve exit','Execute due exit','Review handover & settlement','Record sandbox settlement review','No payroll result has been found. Salary is unknown, not zero.','revision:review.revision','lock.current','AbortController'])assert.ok(source.includes(text),text);
 assert.match(read('app/team/people/page.tsx'),/\/team\/people\/offboarding/);assert.match(source,/review\.ready&&testConfirmed/);assert.match(source,/review\.settledEvidenceCurrent/);
});
