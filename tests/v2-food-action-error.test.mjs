import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const management=fs.readFileSync(new URL('../app/food/manage/food-customer-management.tsx',import.meta.url),'utf8');
const financeClient=fs.readFileSync(new URL('../lib/food-finance-client.ts',import.meta.url),'utf8');

test('Food manage keeps resource-load errors separate from action errors',()=>{
  assert.match(management,/loadError,setLoadError/);
  assert.match(management,/actionError,setActionError/);
  assert.match(management,/resource:order,error:loadError/);
  assert.match(management,/actionError&&<p role="alert">/);
  assert.doesNotMatch(management,/resource:order,error\}/);
});

test('Food cancellation 409 gets a safe customer-facing pending-review message',()=>{
  assert.match(financeClient,/response\.status===409&&input\.action==="request_cancel"/);
  assert.match(financeClient,/A Food cancellation request is already pending or approved\./);
});
