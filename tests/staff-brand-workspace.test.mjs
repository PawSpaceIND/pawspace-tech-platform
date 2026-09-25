import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import ts from 'typescript';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAFF_UI_DB__','__STAFF_UI_ENV__');
const {STAFF_GROUPS,visibleStaffGroups,activeStaffLink,staffNavigationPath}=await import('../app/components/staff-workspace/navigation.ts');
const {defaultRoles,hasPermission}=await import('../lib/platform-security.ts');
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const expected=JSON.parse(read('tests/fixtures/staff-ui-wiring-contract.json'));
function contract(path){
 const source=read(path),tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.modifiers?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword));
 const prefix=fn.body.statements.slice(0,fn.body.statements.findIndex(s=>ts.isReturnStatement(s))).map(s=>s.getText(tree)).join('\n');
 const bindings=[];
 function visit(n){if(ts.isJsxAttribute(n)){
  const name=n.name.getText(tree),init=n.initializer;
  if(/^(on[A-Z]|disabled$|value$|checked$|name$)/.test(name))bindings.push(n.getText(tree));
  if(name==='href'&&init&&!ts.isStringLiteral(init))bindings.push(n.getText(tree));
 }ts.forEachChild(n,visit);}visit(tree);
 return {logicHash:hash(prefix),bindings:bindings.sort(),source};
}
for(const [path,before] of Object.entries(expected)){
 test(path+': data fetching, state, calculations and action functions are unchanged',()=>assert.equal(contract(path).logicHash,before.logicHash));
 test(path+': original event handlers, controlled values and dynamic links are unchanged',()=>assert.deepEqual(contract(path).bindings,before.bindings));
}
const navigationSource=read('app/components/staff-workspace/navigation.ts')+read('app/components/staff-workspace/StaffWorkspace.tsx');
for(const [path,before] of Object.entries(expected)){
 test(path+': existing destinations remain in the page or shared navigation',()=>{
  const destinations=read(path)+navigationSource;
  for(const href of before.hrefs)assert.ok(destinations.includes('"'+href+'"'),href+' must not be orphaned');
 });
}
for(const role of defaultRoles){
 test('navigation respects existing '+role.code+' permissions',()=>{
  const shown=visibleStaffGroups([...role.permissions]).flatMap(group=>group.links);
  const allowed=STAFF_GROUPS.flatMap(group=>group.links).filter(link=>hasPermission([...role.permissions],link.permission));
  assert.deepEqual(shown,allowed);
 });
}
test('unverified actors see no role workspaces',()=>assert.deepEqual(visibleStaffGroups([]),[]));
test('search cannot reveal forbidden payroll links',()=>assert.deepEqual(visibleStaffGroups(['customers.view'],'payroll'),[]));
test('alias highlighting does not alter the original destination',()=>{
 assert.equal(activeStaffLink('/booking-command-center'),'/team/operations/bookings');
 assert.equal(activeStaffLink('/v2/control-center'),'/team/operations/bookings');
 assert.equal(activeStaffLink('/v2/crm'),'/crm');
 assert.equal(staffNavigationPath('/team/finance/cash-flow'),'/team/finance/cash-flow');
 assert.equal(activeStaffLink('/team/operations/bookings'),'/team/operations/bookings');
 assert.equal(activeStaffLink('/team/operations-other'),null);
});
test('all sidebar destinations still have actual route files',()=>{
 const links=STAFF_GROUPS.flatMap(group=>group.links);assert.equal(new Set(links.map(x=>x.href)).size,links.length);
 for(const link of links)assert.ok(fs.existsSync(new URL('../app'+link.href+'/page.tsx',import.meta.url)),link.href);
});
test('the frame only reads navigation identity and never writes business state',()=>{
 const source=read('app/components/staff-workspace/StaffWorkspace.tsx');
 assert.match(source,/fetch\("\/api\/team-overview"/);
 assert.doesNotMatch(source,/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
 assert.doesNotMatch(source,/localStorage|sessionStorage|document\.cookie|router\.(?:push|replace)|location\.(?:assign|replace)/);
 assert.match(source,/if \(suppliedActor !== undefined\) return/);
 assert.match(source,/\{children\}/);
});
test('brand typography and theme selectors are staff-scoped',()=>{
 const css=read('app/components/staff-workspace/staff-workspace.module.css');
 assert.match(css,/PawSpaceStaffNunito/); assert.match(css,/#01261f/i);assert.match(css,/#e6b34e/i);
 assert.match(css,/#894aed/i);assert.match(css,/#ffaf00/i);
 assert.doesNotMatch(css,/:root|(?:^|\})\s*body\s*\{/);
 for(const selector of css.matchAll(/:global\([^)]*\)[^{]+/g))assert.match(selector[0],/\.frame/);
 assert.match(css,/prefers-reduced-motion/);
});
test('logo and licensed font assets exist locally',()=>{
 for(const path of ['public/brand/pawspace-horizontal.png','public/fonts/nunito/Nunito-Variable.ttf','public/fonts/nunito/OFL.txt'])assert.ok(fs.existsSync(new URL('../'+path,import.meta.url)),path);
});
