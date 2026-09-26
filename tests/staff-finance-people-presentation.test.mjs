import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {staffSemanticContract,parseStaffPage} from './helpers/staff-presentation-contract.mjs';
import ts from 'typescript';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const contract=JSON.parse(read('tests/fixtures/staff-finance-people-contract.json'));
for(const [path,expected] of Object.entries(contract.files)) {
  test('Finance/People presentation preserves every non-style AST node: '+path,()=>{
    const source=read(path);
    assert.equal(staffSemanticContract(source,path),expected.semantic);
    const file=parseStaffPage(source,path);let roots=0;
    function walk(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='StaffModule')roots++;ts.forEachChild(node,walk);}
    walk(file);assert.equal(roots,expected.mainRoots,'Every original main, including loading/error returns, stays framed.');
  });
}
test('presentation contract catches request, amount, authorization and handler mutations',()=>{
  const path='app/team/finance/training/page.tsx',source=read(path),base=staffSemanticContract(source,path);
  for(const [before,after] of [['/api/training-finance','/api/wrong-endpoint'],['gross_earning','wrong_amount'],['disabled={busy','disabled={false'],['action:"approve_payout"','action:"unsafe_payout"']]){
    assert.ok(source.includes(before),before);assert.notEqual(staffSemanticContract(source.replace(before,after),path),base,before+' must be protected');
  }
});
test('StaffModule is a presentation-only wrapper around the existing staff frame',()=>{
  const source=read('app/components/staff-workspace/StaffModule.tsx');
  assert.match(source,/<StaffWorkspace>/);assert.match(source,/\{children\}/);
  assert.doesNotMatch(source,/fetch\(|localStorage|sessionStorage|useEffect|router\.|window\./);
});
test('standalone styles are scoped, responsive, and do not hide operational controls',()=>{
  const css=read('app/components/staff-workspace/staff-module.module.css').replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(css,/:global|:root|display\s*:\s*none|visibility\s*:\s*hidden/);
  assert.match(css,/overflow-x:auto/);assert.match(css,/@media\(max-width:600px\)/);
  assert.match(css,/font-variant-numeric:tabular-nums/);
  assert.match(css,/--staff-surface/);assert.match(css,/--staff-primary/);
});
test('existing async query-param forwarding routes were not replaced by client shortcuts',()=>{
  for(const [service,key] of [['boarding','bookingId'],['sitting','bookingId'],['taxi','bookingId'],['walking','bookingId'],['food','orderId']]){
    const source=read(`app/team/finance/${service}/page.tsx`);
    assert.match(source,/await searchParams/);assert.ok(source.includes('params.'+key));assert.doesNotMatch(source,/StaffModule|useRouter/);
  }
});
