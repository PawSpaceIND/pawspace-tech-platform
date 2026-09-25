import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import postcss from 'postcss';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const contract=JSON.parse(read('tests/fixtures/staff-console-page-contract.json'));
for(const [file,hash] of Object.entries(contract.pages)){
 test(file+': page requests, actions, fields and business copy are byte-for-byte unchanged',()=>{
  assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex'),hash);
 });
}
test('both existing shared shells delegate navigation without guarding their child workflows',()=>{
 for(const file of ['app/components/ops-shell/OpsShell.tsx','app/components/ui/TeamShell.tsx']){
  const source=read(file);assert.match(source,/<StaffWorkspace>/);assert.match(source,/\{children\}/);
  assert.match(source,/consoleStyles\.console/);assert.doesNotMatch(source,/fetch\(|localStorage|router\.(?:push|replace)/);
 }
 const ops=read('app/components/ops-shell/OpsShell.tsx');
 assert.match(ops,/Related workspace links/);assert.match(ops,/nav\.map/);assert.match(ops,/FOOTER\.map/);
 assert.match(ops,/item\.badge \? <b>/);assert.match(ops,/aria-current/);
});
test('console token bridge is scoped and does not restyle customer pages',()=>{
 const css=read('app/components/staff-workspace/staff-console.module.css');
 assert.doesNotMatch(css,/:root|:global|(?:^|\})\s*(?:html|body)\b/);
 for(const key of ['primary','surface','text','success','warning','danger'])assert.ok(css.includes('--staff-'+key));
 assert.match(css,/--ds-text-sm:\.875rem/);assert.match(css,/--ds-text-xs:\.8125rem/);
 assert.doesNotMatch(css,/pointer-events:\s*none|display:\s*none/);
});
const sheets=['app/team/team-console.module.css','app/team/customer-experience/whatsapp-inbox.module.css','app/team/performance/performance.module.css','app/components/ui/team-shell.module.css'];
for(const file of sheets){
 test(file+': original selectors and accessible font floors are retained',()=>{
  const ast=postcss.parse(read(file));const selectors=[];
  ast.walkRules(rule=>{selectors.push(rule.selector);assert.doesNotMatch(rule.selector,/:\s+(?:hover|focus|disabled|first-child|last-child)/);});
  assert.ok(contract.selectors?.[file], 'Original selector contract is required');assert.deepEqual(selectors.slice(0,contract.selectors[file].length),contract.selectors[file]);
  ast.walkDecls('font-size',decl=>{const px=decl.value.match(/^([\d.]+)px$/);if(px)assert.ok(Number(px[1])>=13,decl.toString());});
 });
}
test('primary shared button preserves the previous white text outside a staff frame',()=>{
 const css=read('app/components/ui/ui.module.css');
 assert.match(css,/color: var\(--staff-on-primary, #fff\)/);
});
test('related-navigation controls retain visible focus and the shared mobile navigation',()=>{
 const css=read('app/components/ops-shell/ops-shell.module.css');
 assert.match(css,/\.sidebar nav a:focus-visible/);assert.match(css,/min-height:44px/);
 const frame=read('app/components/staff-workspace/StaffWorkspace.tsx');
 assert.match(frame,/aria-controls="staff-workspace-navigation"/);assert.match(frame,/aria-expanded=\{mobileOpen\}/);
});
