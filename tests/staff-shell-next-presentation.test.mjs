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
test('Existing shell CSS and all three shells remain byte-identical outside the explicit order-inbox mounts',()=>{
 assert.equal(hash(split[0]),'b78ede82f6fdd6d7b9cce7e3f60372bec588e36b98630acff16cb98dccfee06e');
 for(const [path,importPath,mount,before] of [
  ['app/components/staff-workspace/StaffWorkspace.tsx','../workspace-order-inbox','<WorkspaceOrderInbox/>','17a8fb4cc17eae8d5424566b962584a9193f0021fa4e0df2043ab8a707f1f432'],
  ['app/components/partner-presentation/PartnerModule.tsx','../workspace-order-inbox','<WorkspaceOrderInbox/>','89e595716ad28b5baee90eef57a7b2d6d16881c41db4bf150a0af5aa5c96dfd6'],
  ['app/partner-app/layout.tsx','../components/workspace-order-inbox','    <WorkspaceOrderInbox/>\n','6f461b09c547aa6b1215f63182c6ee349d83bc32b754243a28623575f8c44de0']
 ]) {
  const source=read(path),inboxImport=`import WorkspaceOrderInbox from "${importPath}";\n`;
  assert.equal(source.split(inboxImport).length,2,path+': one explicit inbox import');
  assert.equal(source.split(mount).length,2,path+': one explicit inbox mount');
  assert.equal(hash(source.replace(inboxImport,'').replace(mount,'')),before,path+': all other bytes preserved');
 }
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
