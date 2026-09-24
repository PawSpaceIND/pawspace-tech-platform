import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {staffContextSemanticContract} from './helpers/staff-presentation-contract.mjs';
import {hasPermission} from '../lib/platform-security.ts';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const contract=JSON.parse(read('tests/fixtures/staff-crm-control-contract.json'));
for(const [file,expected] of Object.entries(contract.files))test('CRM/Control preserves non-presentation code: '+file,()=>assert.equal(staffContextSemanticContract(read(file),file),expected.contextSemantic));
test('CRM consent, lead lock, customer identity, payloads and handlers cannot disappear',()=>{
 const path='app/crm/page.tsx',s=read(path),h=staffContextSemanticContract(s,path);
 for(const [a,b] of [['/api/crm','/api/other'],['leadLock.current)return','false)return'],['primaryPhone:String','wrongPhone:String'],['whatsappConsent:fd.get','wrongConsent:fd.get'],['onClick={()=>setView(n.id)}','onClick={()=>setView("customers")}']]){assert.ok(s.includes(a));assert.notEqual(staffContextSemanticContract(s.replace(a,b),path),h);}
});
test('Control disclosures retain the original permission-filtered buttons',()=>{
 const s=read('app/control/page.tsx');assert.match(s,/data-staff-context="true"/);assert.match(s,/hasPermission\(access.permissions,n.permission\)/);assert.match(s,/aria-current=\{view===n.id/);
 assert.equal(hasPermission(['audit.view'],'users.manage'),false);assert.equal(hasPermission(['*'],'users.manage'),true);assert.equal(hasPermission([],'settings.manage'),false);
});
test('Layouts no longer overlay the scoped frame with a conflicting global theme',()=>{
 for(const p of ['app/crm/layout.tsx','app/control/layout.tsx']){const s=read(p);assert.match(s,/return <>\{children\}<\/>/);assert.doesNotMatch(s,/fetch\(|useEffect|workspace-convergence|control-route-shell/);}
 for(const p of contract.pages)assert.match(read(p),/<StaffModule>/,p);
});
test('Every existing legacy stylesheet byte is preserved above scoped additions',()=>{
 for(const [p,expected] of Object.entries(contract.css)){const original=read(p).split('\n/* STAFF CRM/CONTROL OPT-IN:')[0];assert.equal(hash(original),expected,p);const extra=read(p).slice(original.length);assert.match(extra,/data-staff-module/);}
});
test('All protected API, security, customer, partner and database files remain identical',()=>{
 for(const [p,expected] of Object.entries(contract.protected))assert.equal(hash(fs.readFileSync(new URL('../'+p,import.meta.url))),expected,p);
});

test('V2 entry points keep using the shared CRM and Booking Command Center',()=>{
 const crm=read('app/v2/crm/page.tsx');
 assert.match(crm,/from "\.\.\/\.\.\/crm\/layout"/);
 assert.match(crm,/from "\.\.\/\.\.\/crm\/page"/);
 assert.match(crm,/<CrmLayout><CrmPage\/><\/CrmLayout>/);
 const operations=read('app/v2/control-center/page.tsx');
 assert.match(operations,/export \{default\} from "\.\.\/\.\.\/booking-command-center\/page"/);
 const hub=read('app/v2/workspaces/page.tsx');
 for(const href of ['/v2','/v2/partner','/v2/crm','/v2/control-center'])assert.ok(hub.includes(`href:"${href}"`),href);
 assert.match(hub,/this hub does not grant access/);
});
test('New sandbox-panel styling leaves the customer suppression and original source intact',()=>{
 const css=read('app/components/test-sync-panel.module.css');
 assert.match(css,/\.panel\[data-surface="customer"\]\{display:none!important\}/);
 const marker=css.indexOf('\n/*');
 assert.ok(marker>0,'Staff rules are appended after the original customer rule');
 assert.match(css.slice(marker),/data-staff-module/);
 assert.match(read('app/components/test-sync-panel.tsx'),/if\(surface==="customer"\)return <span hidden/);
});
