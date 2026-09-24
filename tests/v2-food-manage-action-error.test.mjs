import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manage = await readFile(new URL('../app/food/manage/food-customer-management.tsx', import.meta.url),'utf8');
const client = await readFile(new URL('../lib/food-finance-client.ts', import.meta.url),'utf8');

test('Food manage keeps action errors separate from resource load errors',()=>{
  assert.match(manage,/\[loadError,setLoadError\]/);
  assert.match(manage,/\[actionError,setActionError\]/);
  assert.match(manage,/resourceScreenState\(\{id:orderId,loaded:loadedId===orderId,resource:order,error:loadError\}\)/);
  assert.match(manage,/actionError&&<p role="alert">\{actionError\}<\/p>/);
  assert.doesNotMatch(manage,/setError\(problem instanceof Error\?problem\.message:"Unable to request Food cancellation"\)/);
});

test('Food cancellation duplicate conflict has a safe specific customer message',()=>{
  assert.match(client,/response\.status===409&&input\.action==="request_cancel"/);
  assert.match(client,/A cancellation request is already pending or approved for this Food order\./);
});
