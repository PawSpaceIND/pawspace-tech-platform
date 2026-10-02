import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__NEXT_AUDIO_DB__','__NEXT_AUDIO_ENV__');
const budget=await import('../lib/next-audio-budget.ts');
const nativeDemo=await import('../lib/native-attended-demo.ts');
test('next audio namespace retains immutable booking/payment denial without a grant',async()=>{
 await assert.rejects(()=>nativeDemo.assertNativeDemoBusinessAllowed(undefined,budget.NEXT_AUDIO_THREAD_PREFIX+'synthetic'),e=>e instanceof Response&&e.status===403);
});
const now=Date.parse('2026-10-02T18:10:00Z');
const receipt=()=>({currency:'USD',inclusiveOfFeesAndTaxes:true,sourceSha:'a'.repeat(40),agentConfigSha256:'b'.repeat(64),provider:'openai',model:'gpt-5.6-luna',validUntil:now+600000,nativeMicrosPerMinute:160000,optionalBatchMicros:500000,inputMicrosPerToken:1,outputMicrosPerToken:8,framingTokenUpper:4096,evidenceReference:'UNIT TEST ONLY: invented rates; cannot be used for live admission'});
const lease=i=>({threadId:budget.NEXT_AUDIO_THREAD_PREFIX+i,customerId:'SYNTHETIC',sourceSha:'a'.repeat(40),agentConfigSha256:'b'.repeat(64),providerHardDurationSeconds:120,now});
const attempt=i=>({threadId:lease(i).threadId,customerId:'SYNTHETIC',provider:'openai',model:'gpt-5.6-luna',sourceSha:'a'.repeat(40),systemPrompt:'system',userPrompt:'हिंदी Kannada ಕನ್ನಡ',outputTokens:700,now:now+1});
async function world(t,r=receipt()){
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('no providers')}}",compatibilityDate:'2026-09-01',d1Databases:{DB:crypto.randomUUID()},d1Persist:false,cf:false,outboundService:async()=>{throw Error('External requests forbidden')}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await budget.provisionNextAudioBudget(db,r,now);return db;
}
test('missing optional/tax/currency/config/rate proof fails closed',()=>{
 for(const patch of [{optionalBatchMicros:null},{inclusiveOfFeesAndTaxes:false},{currency:'credits'},{agentConfigSha256:''},{validUntil:now},{inputMicrosPerToken:0},{framingTokenUpper:0}])assert.throws(()=>budget.validateAudioRateReceipt({...receipt(),...patch},now));
});
test('multilingual prompt bound counts UTF-8 bytes rather than chars',()=>{
 const r=receipt(),s='ಕನ್ನಡ',u='हिंदी';assert.equal(budget.modelAttemptBound(r,s,u,700,now),(Buffer.byteLength(s)+Buffer.byteLength(u)+4096)+5600);
});
test('native local D1: 25 parallel conversations reserve at most10',{timeout:60000},async t=>{
 const db=await world(t);const results=await Promise.allSettled(Array.from({length:25},(_,i)=>budget.reserveNextAudioLease(db,lease(i))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10);
 const row=await db.prepare('SELECT * FROM next_audio_budget').first();assert.equal(row.conversations,10);assert.equal(row.reserved_micros,3700000);
});
test('native local D1: retries concurrently use at most6 attempt slots; expiry and customer mismatch denied',{timeout:60000},async t=>{
 const db=await world(t);await budget.reserveNextAudioLease(db,lease(1));
 const results=await Promise.allSettled(Array.from({length:30},()=>budget.reserveNextAudioAttempt(db,attempt(1))));assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
 assert.equal((await db.prepare('SELECT attempts FROM next_audio_leases').first()).attempts,6);
 await budget.reserveNextAudioLease(db,lease(2));
 for(const patch of [{customerId:'other'},{now:now+120000},{provider:'anthropic'},{model:'other'},{sourceSha:'c'.repeat(40)},{outputTokens:701}])await assert.rejects(()=>budget.reserveNextAudioAttempt(db,{...attempt(2),...patch}));
});
test('native local D1: aggregate model and native reservations never exceed extra$5; failed attempts remain reserved',{timeout:60000},async t=>{
 const r={...receipt(),optionalBatchMicros:4600000};const db=await world(t,r);await budget.reserveNextAudioLease(db,lease(1));
 const input={...attempt(1),systemPrompt:'x'.repeat(65000)};
 const results=await Promise.allSettled(Array.from({length:20},()=>budget.reserveNextAudioAttempt(db,input)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const row=await db.prepare('SELECT reserved_micros FROM next_audio_budget').first();assert.ok(row.reserved_micros<=5000000);assert.ok(row.reserved_micros>4920000);
});
test('native local D1: pinned evidence cannot be reset or changed; duplicate lease does not charge twice',{timeout:60000},async t=>{
 const db=await world(t);await budget.reserveNextAudioLease(db,lease(1));await assert.rejects(()=>budget.reserveNextAudioLease(db,lease(1)));
 await assert.rejects(()=>budget.provisionNextAudioBudget(db,{...receipt(),optionalBatchMicros:0},now));
 await budget.provisionNextAudioBudget(db,receipt(),now);assert.equal((await db.prepare('SELECT reserved_micros FROM next_audio_budget').first()).reserved_micros,820000);
});
