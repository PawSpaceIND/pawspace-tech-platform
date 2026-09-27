import test from 'node:test';
import assert from 'node:assert/strict';
import {staffReadJson} from '../lib/staff-read-json.ts';
test('staff reads return data and surface server errors',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({data:[1]}));
 assert.deepEqual(await staffReadJson('/staff'),{data:[1]});
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Access denied'},{status:403}));
 await assert.rejects(staffReadJson('/staff'),/Access denied/);
});
test('timeout bounds body consumption as well as the initial response',async t=>{
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>({ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}));
 await assert.rejects(staffReadJson('/staff',5),/Refresh to retry/);
});
