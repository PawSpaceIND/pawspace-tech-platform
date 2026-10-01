import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAFF_NEXT_DB__','__STAFF_NEXT_ENV__');
const {visibleStaffGroups,activeStaffLink}=await import('../app/components/staff-workspace/navigation.ts');
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const css=read('app/components/staff-workspace/staff-workspace.module.css');
const split=css.split('\n/* STAFF SHELL NEXT:');
test('Existing shell CSS and component requests, permissions, navigation and state remain byte-identical',()=>{
 assert.equal(hash(split[0]),'b78ede82f6fdd6d7b9cce7e3f60372bec588e36b98630acff16cb98dccfee06e');
 assert.equal(hash(read('app/components/staff-workspace/StaffWorkspace.tsx')),'17a8fb4cc17eae8d5424566b962584a9193f0021fa4e0df2043ab8a707f1f432');
});
test('New shell styles retain every control and theme while increasing touch access',()=>{
 const added=split[1]; assert.ok(added);
 assert.doesNotMatch(added,/display\s*:\s*none|visibility\s*:\s*hidden|pointer-events|position\s*:\s*(?:fixed|absolute)|#[0-9a-f]{3,8}\b|!important/);
 for(const selector of ['.finder input','.home,.group a','.group summary','.navRecovery button,.navRecovery a','.sidebarFooter summary','.sidebarFooter a','.mobileBar button']) {
  const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  assert.match(added,new RegExp(escaped+String.raw` \{[^}]*min-height:48px`));
 }
 assert.match(added,/flex-wrap:wrap/); assert.match(added,/@media\(max-width:360px\)/);
 assert.match(css,/:focus-visible/); assert.match(css,/var\(--paw-font\)/);
});

test('Restyled navigation still executes permission filtering and current-route selection',()=>{
 assert.deepEqual(visibleStaffGroups([]),[]);
 assert.deepEqual(visibleStaffGroups(['customers.view'],'payroll'),[]);
 assert.ok(visibleStaffGroups(['customers.view']).flatMap(g=>g.links).some(l=>l.href==='/team/sales'));
 assert.equal(activeStaffLink('/team/operations/bookings'),'/team/operations/bookings');
});
