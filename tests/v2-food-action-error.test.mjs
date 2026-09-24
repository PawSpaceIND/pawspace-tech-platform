import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importLibModule } from './helpers/ts-module-loader.mjs';

const management=fs.readFileSync(new URL('../app/food/manage/food-customer-management.tsx',import.meta.url),'utf8');

test('Food manage keeps resource-load errors separate from action errors',()=>{
  assert.match(management,/loadError,setLoadError/);
  assert.match(management,/actionError,setActionError/);
  assert.match(management,/resource:order,error:loadError/);
  assert.match(management,/actionError&&<p role="alert">/);
  assert.doesNotMatch(management,/resource:order,error\}/);
});

test('Food cancellation 409 executes the real client and returns the safe pending-review message',async()=>{
  const { requestFoodCancellation }=await importLibModule('food-finance-client');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Unable to update Food finance'}),{status:409,headers:{'content-type':'application/json'}});
  try{
    await assert.rejects(
      requestFoodCancellation({orderId:'PS-UAT-FOOD-1',reason:'Duplicate request'}),
      /A Food cancellation request is already pending or approved\./,
    );
  }finally{globalThis.fetch=originalFetch}
});
