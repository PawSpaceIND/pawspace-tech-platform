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
test('native local D1: aggregate model and native reservations never exceed total$10; failed attempts remain reserved',{timeout:60000},async t=>{
 const r={...receipt(),optionalBatchMicros:9600000};const db=await world(t,r);await budget.reserveNextAudioLease(db,lease(1));
 const input={...attempt(1),systemPrompt:'x'.repeat(65000)};
 const results=await Promise.allSettled(Array.from({length:20},()=>budget.reserveNextAudioAttempt(db,input)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const row=await db.prepare('SELECT reserved_micros FROM next_audio_budget').first();assert.ok(row.reserved_micros<=10000000);assert.ok(row.reserved_micros>9920000);
});
test('native local D1: pinned evidence cannot be reset or changed; duplicate lease does not charge twice',{timeout:60000},async t=>{
 const db=await world(t);await budget.reserveNextAudioLease(db,lease(1));await assert.rejects(()=>budget.reserveNextAudioLease(db,lease(1)));
 await assert.rejects(()=>budget.provisionNextAudioBudget(db,{...receipt(),optionalBatchMicros:0},now));
 await budget.provisionNextAudioBudget(db,receipt(),now);assert.equal((await db.prepare('SELECT reserved_micros FROM next_audio_budget').first()).reserved_micros,820000);
});

import {createAudioEventReceipt} from '../scripts/next-audio-evidence.mjs';
test('audio before transcript is retained; a late ASR event cannot overwrite latency',()=>{
 let now=100;const r=createAudioEventReceipt(()=>now);r.callerSpeechEnded();now=850;
 r.receive({type:'audio',audio_event:{event_id:1,audio_base_64:Buffer.from([1,2,3,4]).toString('base64')}});
 now=900;r.receive({type:'user_transcript'});now=950;r.receive({type:'agent_response'});
 const s=r.snapshot();assert.equal(s.firstAudioAfterCallerEndMs,750);assert.equal(s.audioChunks[0].pcm.length,4);assert.equal(s.listened,false);
});
test('missing audio stays unknown; interruption and native conversation ID are retained',()=>{
 const r=createAudioEventReceipt(()=>20);r.receive({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{conversation_id:'synthetic-provider-id'}});r.receive({type:'interruption'});
 assert.equal(r.snapshot().firstAudioAfterCallerEndMs,null);assert.equal(r.snapshot().conversationId,'synthetic-provider-id');assert.ok(r.snapshot().events.some(e=>e.type==='interruption'));
});

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedNextAudioBytes} from './helpers/next-audio-reviewed-delta.mjs';
test('historical runtime bytes reconcile only the exact reviewed budget additions',()=>{
 const path='lib/ai-grounded-runtime-provider.ts',source=readFileSync(new URL('../'+path,import.meta.url));
 const hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(hash(preservedNextAudioBytes(path,source)),'a61691f2cee7230cb315ede9ebd5722f78c3fc6a0500531fbc1fc694774c1740');
 for(const [a,b] of [['nextAudioConversation:{threadId:input.threadId,customerId:input.customerId}','nextAudioConversation:{threadId:input.threadId,customerId:"OTHER"}'],['isNextAudioThread(input.threadId)','true'],['./next-audio-budget','./unknown-budget']])assert.throws(()=>preservedNextAudioBytes(path,Buffer.from(source.toString().replace(a,b))));
 const mutation=source.toString().replace('maxTokens:channel===','maxTokens:false&&channel===');
 assert.notEqual(hash(preservedNextAudioBytes(path,Buffer.from(mutation))),'a61691f2cee7230cb315ede9ebd5722f78c3fc6a0500531fbc1fc694774c1740');
});

test('adapter historical normalization catches guard deletion, price bypass and ordinary-provider changes',()=>{
 const p='lib/ai-provider-adapter.ts',source=readFileSync(new URL('../'+p,import.meta.url));
 const hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(hash(preservedNextAudioBytes(p,source)),'fc0b63ae2bdcdffee9a515ce20a3d3a5d7ebd60961be756c4d15a92dee135f2e');
 for(const [a,b]of [['await reserveNextAudioAttempt','void reserveNextAudioAttempt'],['sourceSha:str(env,','sourceSha:"forged",ignored:str(env,'],['str(env,"PAWSPACE_PAYMENT_LIVE_APPROVED")!=="false"','false']])assert.throws(()=>preservedNextAudioBytes(p,Buffer.from(source.toString().replace(a,b))));
 const changed=source.toString().replace('const MAX_TIMEOUT_MS = 120_000','const MAX_TIMEOUT_MS = 999_000');
 assert.notEqual(hash(preservedNextAudioBytes(p,Buffer.from(changed))),'fc0b63ae2bdcdffee9a515ce20a3d3a5d7ebd60961be756c4d15a92dee135f2e');
});

test('native D1 concurrent fresh dispatches claim allocation exactly once',{timeout:60000},async t=>{
 const db=await world(t);
 const outcomes=await Promise.allSettled(Array.from({length:12},(_,i)=>budget.claimNextAudioBatch(db,String(100+i),'a'.repeat(40),now)));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const token=outcomes.find(x=>x.status==='fulfilled').value;
 await budget.requireNextAudioBatch(db,token,'a'.repeat(40));
 await assert.rejects(()=>budget.requireNextAudioBatch(db,token,'b'.repeat(40)));
 await assert.rejects(()=>budget.claimNextAudioBatch(db,'999','a'.repeat(40),now+1));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM next_audio_batch_claims').first()).n,1);
 assert.equal((await db.prepare('SELECT conversations FROM next_audio_budget').first()).conversations,0);
});

test('cap increase preserves incurred reservations and consumed batch claim',{timeout:60000},async t=>{
 const db=await world(t),token=await budget.claimNextAudioBatch(db,'123','a'.repeat(40),now);
 await budget.reserveNextAudioLease(db,lease(1));await budget.reserveNextAudioAttempt(db,attempt(1));
 await db.prepare('UPDATE next_audio_budget SET cap_micros=5000000').run();
 const before=await db.prepare('SELECT * FROM next_audio_budget').first();
 await budget.provisionNextAudioBudget(db,receipt(),now);
 const after=await db.prepare('SELECT * FROM next_audio_budget').first();
 assert.equal(after.cap_micros,10000000);for(const key of ['reserved_micros','conversations','receipt_json','expires_at'])assert.equal(after[key],before[key]);
 await budget.requireNextAudioBatch(db,token,'a'.repeat(40));await assert.rejects(()=>budget.claimNextAudioBatch(db,'124','a'.repeat(40),now));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM next_audio_attempts').first()).n,1);
 await assert.rejects(()=>budget.provisionNextAudioBudget(db,{...receipt(),optionalBatchMicros:0},now));
});

import {NEXT_FIVE_AUDIO_SCENARIOS} from '../scripts/next-ten-audio-scenarios.mjs';
test('first five cover each requested service with complex prompts and actual taxi interruption',()=>{
 assert.equal(NEXT_FIVE_AUDIO_SCENARIOS.length,5);assert.deepEqual(NEXT_FIVE_AUDIO_SCENARIOS.map(s=>s.service),['grooming','dog_training','pet_boarding','pet_sitting','pet_taxi']);
 assert.ok(NEXT_FIVE_AUDIO_SCENARIOS.every(s=>s.prompts.length===4&&s.maxProviderDurationSeconds===120));assert.ok(NEXT_FIVE_AUDIO_SCENARIOS[4].plannedBargeIn);
});
test('aggregate brain reservations have an independent one-dollar hard ceiling across five conversations',{timeout:60000},async t=>{
 const db=await world(t);for(let i=1;i<=5;i++)await budget.reserveNextAudioLease(db,lease(i));
 const outcomes=await Promise.allSettled(Array.from({length:30},(_,i)=>budget.reserveNextAudioAttempt(db,{...attempt(i%5+1),systemPrompt:'x'.repeat(50000)})));
 assert.ok(outcomes.some(x=>x.status==='rejected'));assert.ok(outcomes.some(x=>x.status==='fulfilled'));
 const row=await db.prepare('SELECT SUM(reserved_micros) n FROM next_audio_attempts').first();assert.ok(row.n<=budget.NEXT_AUDIO_MODEL_BATCH_CAP_MICROS);assert.ok(row.n>900000);
 await budget.provisionNextAudioBudget(db,receipt(),now);assert.equal((await db.prepare('SELECT SUM(reserved_micros) n FROM next_audio_attempts').first()).n,row.n);
});
test('speech attempt slots are atomic, never refunded and bound all failed/duplicate requests',{timeout:60000},async t=>{
 const db=await world(t);await budget.reserveNextAudioLease(db,lease(1));
 const base={threadId:lease(1).threadId,customerId:'SYNTHETIC',kind:'tts',units:2500,now};
 const attempts=await Promise.allSettled(Array.from({length:20},()=>budget.reserveNextAudioSpeech(db,base)));assert.equal(attempts.filter(x=>x.status==='fulfilled').length,4);
 await assert.rejects(()=>budget.reserveNextAudioSpeech(db,{...base,kind:'stt',units:960001}));await assert.rejects(()=>budget.reserveNextAudioSpeech(db,{...base,kind:'stt',units:960000,now:now+120000}));await assert.rejects(()=>budget.reserveNextAudioSpeech(db,{...base,kind:'stt',units:960000,customerId:'other'}));
 await budget.provisionNextAudioBudget(db,receipt(),now);await assert.rejects(()=>budget.reserveNextAudioSpeech(db,base));assert.equal((await db.prepare('SELECT COUNT(*) n FROM next_audio_speech_attempts').first()).n,4);
});

import {preservedAtlasTextBytes} from './helpers/atlas-text-reviewed-delta.mjs';
const atlasRead=p=>readFileSync(new URL('../'+p,import.meta.url)),atlasHash=b=>createHash('sha256').update(b).digest('hex');
test('Atlas normalizer rejects guard removal, ownership drift, price bypass and changed cancellation/audio',()=>{
 const p='lib/ai-provider-adapter.ts',s=atlasRead(p).toString();
 for(const[a,b]of [['directPayload(modelRef','void directPayload(modelRef'],['await reserveTextTest','void reserveTextTest'],['assertTextTestDispatch(textTestClaim)','void textTestClaim'],['service_tier:"default"','service_tier:"priority"'],['nextAudioConversation?:','removedAudioContext?:'],['signal?: AbortSignal','signal?: unknown']]){assert.ok(s.includes(a),a);assert.throws(()=>preservedNextAudioBytes(p,Buffer.from(s.replace(a,b))))}
 const g='lib/ai-grounded-runtime-provider.ts',gs=atlasRead(g).toString();assert.throws(()=>preservedNextAudioBytes(g,Buffer.from(gs.replace('textTestScope:{customerId:input.customerId','textTestScope:{customerId:"OTHER"'))));
 const changedAdmission=atlasRead('lib/atlas-text-test-admission.ts').toString().replace('if(!db||','if(false||');assert.throws(()=>preservedAtlasTextBytes(p,atlasRead(p),()=>Buffer.from(changedAdmission)));
 const cancelled=s.replace('input.signal?.removeEventListener("abort",abortFromCaller);','void input.signal;');assert.notEqual(atlasHash(preservedNextAudioBytes(p,Buffer.from(cancelled))),'fc0b63ae2bdcdffee9a515ce20a3d3a5d7ebd60961be756c4d15a92dee135f2e');
 const ordinary=s.replace('const maxTokens = Math.min(8_000','const maxTokens = Math.min(8');assert.notEqual(atlasHash(preservedNextAudioBytes(p,Buffer.from(ordinary))),'fc0b63ae2bdcdffee9a515ce20a3d3a5d7ebd60961be756c4d15a92dee135f2e');
});
