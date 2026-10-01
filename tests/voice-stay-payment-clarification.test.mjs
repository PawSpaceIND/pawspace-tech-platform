import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks} from './helpers/ai-harness.mjs';
installAiHooks();
const {prepareStaySalesQuote}=await import('../lib/voice-stay-sales.ts');
test('missing or unsupported stay payment explains available terms without asserting eligibility',async()=>{
 for(const paymentMode of [undefined,'pay_after_service']){
  let refusal;try{await prepareStaySalesQuote(null,{service:'boarding',booking:{paymentMode},schedule:{},petCount:1});}catch(error){assert.equal(error.status,400);refusal=await error.text();}
  assert.match(refusal,/full payment upfront/);assert.match(refusal,/longer than four nights/);assert.match(refusal,/24 hours before check-in/);
 }
});
test('valid payment cannot bypass unresolved stay dates',async()=>{
 for(const paymentMode of ['prepaid','split_50_50']){
  try{await prepareStaySalesQuote(null,{service:'boarding',booking:{paymentMode},schedule:{},petCount:1});assert.fail('must refuse');}catch(error){assert.equal(error.status,400);assert.match(await error.text(),/Exact start and end times/);}
 }
});
