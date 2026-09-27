import test from 'node:test';
import assert from 'node:assert/strict';
import {triggerHaptikCall} from '../lib/haptik-outbound-client.ts';
const env={HAPTIK_OUTBOUND_API_KEY:'test-only',HAPTIK_OUTBOUND_URL:'https://test.haptikapi.com/calls'};
test('Haptik HTTP success without a usable call identifier is not a placed call',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({}));
 const result=await triggerHaptikCall(env,{phone:'sandbox',campaign:'test'});
 assert.equal(result.connected,false);
});
test('Haptik accepted call retains the provider identifier',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({callId:'test-call'}));
 assert.deepEqual(await triggerHaptikCall(env,{phone:'sandbox',campaign:'test'}),{connected:true,callRef:'test-call'});
});
