import test from 'node:test';import assert from 'node:assert/strict';
import {diagnoseComponentCredential} from '../scripts/component-audio-credential-diagnostic.mjs';
test('same-origin GET-only diagnostic exports known denial classification without provider messages or credentials',async()=>{
 const canary='SECRET_CANARY_NO_EXPORT',calls=[];
 const r=await diagnoseComponentCredential({ELEVENLABS_API_KEY:canary,ELEVENLABS_API_BASE:'https://api.elevenlabs.io'},async(url,init)=>{calls.push({url,init});return Response.json({detail:{status:'invalid_api_key',message:canary}},{status:401});});
 assert.deepEqual(r.reads.map(x=>x.classification),['invalid_api_key','invalid_api_key']);assert.ok(!JSON.stringify(r).includes(canary));assert.equal(r.providerGenerationRequests,0);assert.equal(r.budgetLedgerWrites,0);
 assert.deepEqual(calls.map(x=>x.url),['https://api.elevenlabs.io/v1/voices','https://api.elevenlabs.io/v1/user']);for(const c of calls){assert.equal(c.init.method,'GET');assert.equal(c.init.redirect,'error');assert.equal(c.init.body,undefined);}
});
test('missing key, unapproved origin and unknown denial never cause fallback or leak arbitrary values',async()=>{
 let calls=0;const fake=async()=>{calls++;return Response.json({detail:{status:'SECRET_BODY_VALUE',message:'SECRET_MESSAGE'}},{status:401});};
 assert.equal((await diagnoseComponentCredential({},fake)).reads.length,0);assert.equal(calls,0);
 await assert.rejects(()=>diagnoseComponentCredential({ELEVENLABS_API_KEY:'offline',ELEVENLABS_API_BASE:'https://other.invalid'},fake),/unapproved/);assert.equal(calls,0);
 const r=await diagnoseComponentCredential({ELEVENLABS_API_KEY:'offline'},fake);assert.equal(calls,2);assert.ok(!JSON.stringify(r).includes('SECRET'));
});
