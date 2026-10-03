import {reversePayrollShell} from './helpers/payroll-shell-review.mjs';
import {reverseTrainingReadGeneration} from './helpers/training-finance-read-generation-review.mjs';
import {reverseSittingTargetSafety} from './helpers/ui-sitting-target-safety-review.mjs';
import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {staffSemanticContract,parseStaffPage} from './helpers/staff-presentation-contract.mjs';
import ts from 'typescript';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const contract=JSON.parse(read('tests/fixtures/staff-finance-people-contract.json'));
const sittingPath='app/team/finance/sitting/sitting-finance-workspace.tsx';
// Reverse only the reviewed pre-completion disclosure repair. Historical AST hashes stay pinned.
const sittingDisplayImport='import {sittingReconciliationLabel} from "../../../../lib/sitting-reconciliation-display";\n';
const sittingDisplayParagraph='<h2>Reconciliation</h2><p>{sittingReconciliationLabel(booking.status,data?.reconciliation)}</p>';
const historicalSittingParagraph='<h2>Reconciliation</h2><p>{data?.reconciliation?`${label(data.reconciliation.status)} · refund ${label(data.reconciliation.refund_state)} · settlement ${label(data.reconciliation.settlement_state)} · tax ${label(data.reconciliation.tax_state)}`:"Not reconciled yet"}</p>';
function reverseReviewedSittingDisclosure(source,path){
 if(path!==sittingPath)return source;
 for(const exact of [sittingDisplayImport,sittingDisplayParagraph])assert.equal(source.split(exact).length,2,'Exactly one reviewed Sitting disclosure is required');
 assert.equal(source.split('sittingReconciliationLabel').length,3,'Only the import and reviewed display may use the helper');
 return source.replace(sittingDisplayImport,'').replace(sittingDisplayParagraph,historicalSittingParagraph);
}

// Reverse only the reviewed Finance CSS import/classes; the historical semantic digest stays pinned.
function reverseReviewedFinanceContent(source,path){
 if(path!=="app/team/finance/page.tsx")return source;
 const {reversals}=JSON.parse(read('tests/fixtures/ui-finance-next-preservation.json'));
 const cssImport='\nimport styles from "./finance-content.module.css";';
 assert.equal(source.split(cssImport).length,2,'Exactly one reviewed Finance stylesheet import');
 source=source.replace(cssImport,'');
 for(const [before,after] of [...reversals['page.tsx']].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Finance presentation hook');
  source=source.replace(after,before);
 }
 return source;
}

// Reverse only the reviewed Boarding stylesheet and two scoped class hooks.
function reverseReviewedBoardingContent(source,path){
 if(path!=="app/team/finance/boarding/boarding-finance-workspace.tsx")return source;
 const {replacements}=JSON.parse(read('tests/fixtures/ui-boarding-finance-next-preservation.json'));
 for(const [before,after] of [...replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Boarding presentation hook');
  source=source.replace(after,before);
 }
 return source;
}

// Exact Training landmarks/styles reverse to the unchanged historical business contract.
function reverseReviewedTrainingContent(source,path){
 if(path!=="app/team/finance/training/page.tsx")return source;
 const {replacements}=JSON.parse(read('tests/fixtures/ui-training-finance-next-preservation.json'));
 for(const [before,after] of [...replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Training presentation hook');
  source=source.replace(after,before);
 }
 return source;
}

// Reverse only the new Provider Training labels and scoped style hooks.
function reverseProviderTrainingContent(source,path){
 if(path!=="app/team/people/provider-training/page.tsx")return source;
 const {replacements}=JSON.parse(read('tests/fixtures/ui-provider-training-next-preservation.json'));
 for(const [before,after] of [...replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one Provider Training presentation hook');
  source=source.replace(after,before);
 }
 return source;
}

for(const [path,expected] of Object.entries(contract.files)) {
  test('Finance/People presentation preserves every non-style AST node: '+path,()=>{
    const source=reversePayrollShell(read(path),path);
    assert.equal(staffSemanticContract(reverseProviderTrainingContent(reverseReviewedTrainingContent(reverseReviewedBoardingContent(reverseReviewedFinanceContent(reverseReviewedSittingDisclosure(reverseFinancePrecision(reverseSittingTargetSafety(reverseTrainingReadGeneration(source,path),path),path),path),path),path),path),path),path),expected.semantic);
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

test('reviewed Sitting disclosure retains the historical contract and rejects financial mutations',()=>{
 assert.equal(contract.base,'82d4158b339bedebd9485f8bc5324c54475f96de');
 assert.equal(contract.files[sittingPath].semantic,'bfcce787ec049a852c8fc50016ace019caa507c318e2b5ce202c00a4f63a0b86');
 const source=read(sittingPath),expected=contract.files[sittingPath].semantic;
 for(const [before,after] of [['booking.total_amount','booking.captured_amount'],['action:"approve_settlement"','action:"unsafe_settlement"'],['disabled={busy||String(booking.status)!=="completed"}','disabled={busy}'],['approvedRefundAmount:amount','approvedRefundAmount:999']]){
  assert.ok(source.includes(before));
  assert.notEqual(staffSemanticContract(reverseReviewedSittingDisclosure(source.replace(before,after),sittingPath),sittingPath),expected,before+' must remain protected');
 }
 for(const [before,after] of [[sittingDisplayImport,''],['sittingReconciliationLabel(booking.status,data?.reconciliation)','sittingReconciliationLabel("confirmed",data?.reconciliation)'],[sittingDisplayParagraph,sittingDisplayParagraph+sittingDisplayParagraph]]){
  assert.throws(()=>reverseReviewedSittingDisclosure(source.replace(before,after),sittingPath),/reviewed Sitting disclosure/);
 }
});
