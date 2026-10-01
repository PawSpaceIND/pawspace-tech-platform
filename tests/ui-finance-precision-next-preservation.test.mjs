import {reverseTrainingReadGeneration} from './helpers/training-finance-read-generation-review.mjs';
import {reverseSittingTargetSafety} from './helpers/ui-sitting-target-safety-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';
import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-finance-precision-next-preservation.json',import.meta.url),'utf8'));
const componentFiles=[
 '../app/team/finance/boarding/boarding-finance-workspace.tsx',
 '../app/team/finance/sitting/sitting-finance-workspace.tsx',
 '../app/team/finance/training/page.tsx',
];
assert.deepEqual(receipt.files.map(item=>'../'+item.file),componentFiles);
for(const item of receipt.files){
 test('exact display-only formatter reversal preserves every source byte: '+item.file,()=>{
  const source=readFileSync(new URL(componentFiles[receipt.files.indexOf(item)],import.meta.url),'utf8');
  assert.equal(createHash('sha256').update(reverseFinancePrecision(reverseSittingTargetSafety(reverseTrainingReadGeneration(source,item.file),item.file),item.file)).digest('hex'),item.beforeHash);
  assert.throws(()=>reverseFinancePrecision(source.replace(item.after,'maximumFractionDigits:1'),item.file),/Exactly one reviewed/);
 });
 test('actual INR formatter retains fractional refunds, tax and whole amounts: '+item.file,()=>{
  const source=readFileSync(new URL(componentFiles[receipt.files.indexOf(item)],import.meta.url),'utf8');
  // Execute the complete component module, including its actual lexical formatter.
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
  const componentModule={exports:{}};
  const context=vm.createContext({module:componentModule,exports:componentModule.exports,require:()=>({}),Intl,Number,String});
  vm.runInContext(compiled+'\nmodule.exports.testMoney=money;',context,{filename:item.file});
  const money=componentModule.exports.testMoney;
  for(const [amount,text] of [[279.60,'₹279.60'],[15.10,'₹15.10'],[379.80,'₹379.80'],[20.51,'₹20.51'],[1899,'₹1,899.00'],[0,'₹0.00'],[-279.60,'-₹279.60']]){
   const input={amount};assert.equal(money(input.amount),text);assert.equal(input.amount,amount);
  }
 });
}
