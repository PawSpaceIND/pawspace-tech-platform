import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
import {hasPermission} from '../lib/platform-security.ts';
import {staffContextSemanticContract} from './helpers/staff-presentation-contract.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const c=JSON.parse(read('tests/fixtures/staff-admin-self-service-contract.json'));
for(const[p,x]of Object.entries(c.files))test('Admin/employee presentation retains all non-style code: '+p,()=>assert.equal(staffContextSemanticContract(read(p),p),x.contextSemantic));
test('Employee requests, identity boundary and contract-earnings conditions remain protected',()=>{
 const p='app/me/page.tsx',s=read(p),h=staffContextSemanticContract(s,p);
 for(const[a,b]of [['/api/me','/api/other-user'],['action:"apply_leave"','action:"approve_leave"'],['data.engagement!=="contract"','true'],['reason:leave.reason.trim()','reason:"invented"'],['disabled={busy}','disabled={false}']]){assert.ok(s.includes(a));assert.notEqual(staffContextSemanticContract(s.replace(a,b),p),h);}
});
test('Admin zone requests, booking-ID handoff and existing local switches remain protected',()=>{
 const p='app/admin/page.tsx',s=read(p),h=staffContextSemanticContract(s,p);
 for(const[a,b]of [['/api/operations-overview','/api/wrong'],['encodeURIComponent(selectedActivity.bookingId)','"different-booking"'],['onClick={() => setView(item.id)}','onClick={() => setView("overview")}']]){assert.ok(s.includes(a));assert.notEqual(staffContextSemanticContract(s.replace(a,b),p),h);}
 assert.match(s,/<details data-staff-context="true"><summary>Operations views and links/);assert.equal((s.match(/<StaffModule>/g)||[]).length,2);
});
test('All protected APIs, customer and partner routes, Team pages and Admin child panels match baseline',()=>{
 for(const[p,h]of Object.entries(c.protected))assert.equal(hash(fs.readFileSync(new URL('../'+p,import.meta.url))),h,p);
});
test('Admin stylesheet additions are scoped and retain original declarations',()=>{
 for(const[p,h]of Object.entries(c.css)){const css=read(p),old=css.split('\n/* STAFF ADMIN/SELF-SERVICE OPT-IN:')[0];assert.equal(hash(old),h,p);const added=css.slice(old.length);postcss.parse(added).walkRules(r=>assert.ok(r.selector.includes(':global([data-staff-module])'),r.selector));assert.doesNotMatch(added,/display\s*:\s*none|visibility\s*:\s*hidden/);}
 assert.match(read('app/admin/admin.module.css'),/\.metrics article:nth-child\(n\) \{ display:flex/);
});
test('Admin layout delegates presentation without altering authentication or mounting a second frame',()=>{
 const s=read('app/admin/layout.tsx');assert.match(s,/return <>\{children\}<\/>/);assert.doesNotMatch(s,/fetch\(|useEffect|workspace-convergence|StaffModule/);
});
test('Executed permissions keep employee self-service separate from payroll administration',()=>{
 assert.equal(hasPermission(['self_service.view'],'self_service.view'),true);
 assert.equal(hasPermission(['self_service.view'],'payroll.manage'),false);
 assert.equal(hasPermission(['self_service.view'],'users.manage'),false);
 assert.equal(hasPermission([],'self_service.view'),false);
 assert.equal(hasPermission(['*'],'payroll.view'),true);
});
