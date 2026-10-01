import {reverseSittingTargetSafety} from './helpers/ui-sitting-target-safety-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-finance-precision-next-preservation.json',import.meta.url),'utf8'));
for(const item of receipt.files){
 test('exact display-only formatter reversal preserves every source byte: '+item.file,()=>{
  const source=readFileSync(new URL('../'+item.file,import.meta.url),'utf8');
  assert.equal(createHash('sha256').update(reverseFinancePrecision(reverseSittingTargetSafety(source,item.file),item.file)).digest('hex'),item.beforeHash);
  assert.throws(()=>reverseFinancePrecision(source.replace(item.after,'maximumFractionDigits:1'),item.file),/Exactly one reviewed/);
 });
 test('actual INR formatter retains fractional refunds, tax and whole amounts: '+item.file,()=>{
  const source=readFileSync(new URL('../'+item.file,import.meta.url),'utf8');
  const definition=source.match(/^const money=.*;$/m)?.[0];assert.ok(definition);
  const compiled=ts.transpile(definition, {target:ts.ScriptTarget.ESNext});
  const money=Function(compiled+';return money;')();
  for(const [amount,text] of [[279.60,'₹279.60'],[15.10,'₹15.10'],[379.80,'₹379.80'],[20.51,'₹20.51'],[1899,'₹1,899.00'],[0,'₹0.00'],[-279.60,'-₹279.60']]){
   const input={amount};assert.equal(money(input.amount),text);assert.equal(input.amount,amount);
  }
 });
}
