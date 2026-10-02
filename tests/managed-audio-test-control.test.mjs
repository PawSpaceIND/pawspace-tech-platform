import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__MANAGED_AUDIO_DB__','__MANAGED_AUDIO_ENV__');
const control=await import('../lib/managed-audio-test-control.ts');
const isolation=await import('../lib/managed-audio-isolation.ts');
const NOW=Date.parse('2026-10-02T12:00:00Z');
const ENV={PAWSPACE_MANAGED_AUDIO_ISOLATION:'no-send-v1',PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_AI_VOICE_MODEL:'gpt-5.6-luna',PAWSPACE_OPENAI_API_KEY:'offline-not-a-credential'};
function world(){
 const sqlite=new DatabaseSync(':memory:');
 const statement=(sql,args=[])=>({bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},sql,args});
 const db={prepare:statement,batch:async statements=>{sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>{const r=sqlite.prepare(s.sql).run(...s.args);return {success:true,meta:{changes:Number(r.changes)}};});sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 sqlite.exec("CREATE TABLE ai_voice_calls (id TEXT PRIMARY KEY,thread_id TEXT,customer_id TEXT,status TEXT)");
 return {sqlite,db};
}
async function admitted(w,suffix='ONE',fees=0,duration=600){
 await control.ensureManagedAudioControl(w.db);
 const threadId=control.MANAGED_AUDIO_THREAD_PREFIX+suffix,callId=control.MANAGED_AUDIO_CALL_PREFIX+suffix,customerId='OWNED-OFFLINE-TEST';
 const bound=control.managedAudioCostBound(duration,fees,NOW);
 await control.reserveManagedAudioConversation(w.db,{threadId,callId,customerId,bound,expiresAt:NOW+600000,now:NOW});
 w.sqlite.prepare('INSERT INTO ai_voice_calls VALUES (?,?,?,?)').run(callId,threadId,customerId,'active');
 return {threadId,callId,customerId};
}
const attempt=(identity,extra={})=>({...identity,provider:'openai',modelRef:'gpt-5.6-luna',maxOutputTokens:700,now:NOW,...extra});

test('strict total includes optional fees and native duration; unknown or above $5 refuses',()=>{
 assert.equal(control.managedAudioCostBound(600,0,NOW).totalMicros,4757560);
 assert.equal(control.managedAudioCostBound(600,242440,NOW).totalMicros,5000000);
 for(const fee of [null,undefined,NaN,-1,0.5,'0'])assert.throws(()=>control.managedAudioCostBound(600,fee,NOW),/not_attested/);
 assert.throws(()=>control.managedAudioCostBound(600,242441,NOW),/insufficient/);
 assert.throws(()=>control.managedAudioCostBound(601,0,NOW),/duration_unbounded/);
 assert.throws(()=>control.managedAudioCostBound(600,0,control.MANAGED_AUDIO_RATES_EXPIRE_AT),/expired/);
});
test('one shared durable reservation never refunds or resets on another start',async t=>{
 const w=world();t.after(()=>w.sqlite.close());await admitted(w);
 await assert.rejects(()=>admitted(w,'TWO'),/insufficient/);
 await control.ensureManagedAudioControl(w.db);
 assert.equal(w.sqlite.prepare('SELECT reserved_micros FROM managed_audio_test_budget').get().reserved_micros,4757560);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM managed_audio_test_conversations').get().n,1);
});
test('50 competing callbacks claim exactly six slots, independent of reservation housekeeping',async t=>{
 const w=world();t.after(()=>w.sqlite.close());const identity=await admitted(w);
 const results=await Promise.allSettled(Array.from({length:50},()=>control.claimManagedAudioAttempt(w.db,ENV,attempt(identity))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,6);
 assert.equal(w.sqlite.prepare('SELECT attempts_used FROM managed_audio_test_conversations').get().attempts_used,6);
 await assert.rejects(()=>control.claimManagedAudioAttempt(w.db,ENV,attempt(identity)),/exhausted/);
});
test('missing markers, wrong identity/model, changed isolation, completed call and expired proof refuse',async t=>{
 const w=world();t.after(()=>w.sqlite.close());const identity=await admitted(w);
 for(const extra of [{customerId:'OTHER'},{modelRef:'gpt-5.6-terra'},{provider:'anthropic'},{maxOutputTokens:701},{now:NOW+600001}])await assert.rejects(()=>control.claimManagedAudioAttempt(w.db,ENV,attempt(identity,extra)));
 await assert.rejects(()=>control.claimManagedAudioAttempt(w.db,{...ENV,PAWSPACE_MANAGED_AUDIO_ISOLATION:''},attempt(identity)));
 w.sqlite.prepare("UPDATE ai_voice_calls SET status='completed'").run();await assert.rejects(()=>control.claimManagedAudioAttempt(w.db,ENV,attempt(identity)));
 w.sqlite.prepare('DELETE FROM managed_audio_test_conversations').run();await assert.rejects(()=>control.claimManagedAudioAttempt(w.db,ENV,attempt(identity)));
 assert.equal(w.sqlite.prepare('SELECT reserved_micros FROM managed_audio_test_budget').get().reserved_micros,4757560);
});
test('absent optional-fee receipt refuses metadata admission without any provider fetch',async t=>{
 const w=world();t.after(()=>w.sqlite.close());await control.ensureManagedAudioControl(w.db);
 const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network is forbidden')};t.after(()=>globalThis.fetch=old);
 const receipt=await control.managedAudioReadiness(w.db,ENV,NOW);
 assert.equal(receipt.paidExecutionAllowed,false);assert.ok(receipt.gates.includes('managed_optional_speech_llm_cost_upper_bound_not_attested'));
});
test('direct sends for arbitrary customer/provider/staff recipients refuse before DB or network',async t=>{
 globalThis.__MANAGED_AUDIO_ENV__=ENV;
 const old=globalThis.fetch;let network=0;globalThis.fetch=()=>{network++;throw Error('Network is forbidden')};t.after(()=>{globalThis.fetch=old;delete globalThis.__MANAGED_AUDIO_ENV__});
 const poison={prepare(){throw Error('DB access before suppression')}};
 const cases=[['communication-provider-boundary','dispatchExternalCommunication'],['interakt-whatsapp-base','dispatchInteraktWhatsApp'],['meta-whatsapp-dispatch','dispatchMetaWhatsApp'],['meta-whatsapp-live-dispatch','dispatchMetaWhatsAppLive'],['meta-whatsapp-uat-dispatch','dispatchMetaWhatsAppUat'],['crm-email-sync','dispatchEmailOutbox']];
 for(const [file,name] of cases){const mod=await import(`../lib/${file}.ts`);await assert.rejects(()=>mod[name](poison,ENV,{messageId:'ANY',recipient:'unrelated-provider@example.invalid',adapterName:'push_provider'}),e=>e instanceof Response&&e.status===403);}
 const sms=await import('../lib/production-sms-provider.ts');await assert.rejects(()=>sms.sendProductionSms(ENV,{phone:'9876500089',message:'offline',idempotencyKey:'ONE'}),e=>e instanceof Response&&e.status===403);
 const direct=await import('../lib/sms-test-provider.ts');await assert.rejects(()=>direct.sendFast2SmsMessage({apiKey:'offline',phone:'9876500089',message:'offline'}),e=>e instanceof Response&&e.status===403);
 assert.equal(network,0);
 assert.doesNotThrow(()=>control.assertManagedAudioSendAllowed({}));
 assert.throws(()=>control.assertManagedAudioSendAllowed({PAWSPACE_MANAGED_AUDIO_ISOLATION:'invalid',PAWSPACE_DEPLOYMENT_ENV:'production'}),e=>e instanceof Response&&e.status===403);
});
test('isolation blocks customer sends, payments, phone endpoints, unrelated callbacks and oversized streams',async()=>{
 const request=(path,body)=>new Request('https://isolated.example'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 for(const path of ['/api/sms-test','/api/partner-otp','/api/communications','/api/voice-outbound','/api/razorpay/orders','/api/push','/api/marketing'])assert.equal((await isolation.managedAudioRequestBlock(request(path,{}),ENV)).status,503);
 assert.equal((await isolation.managedAudioRequestBlock(request('/api/elevenlabs/v1/responses',{elevenlabs_extra_body:{pawspace_thread_id:'NORMAL',pawspace_customer_id:'ONE'}}),ENV)).status,503);
 assert.equal((await isolation.managedAudioRequestBlock(request('/api/ai-voice-uat',{action:'start',managedAudioProfile:control.MANAGED_AUDIO_PROFILE,direction:'outbound',transportProvider:'exotel'}),ENV)).status,503);
 assert.equal((await isolation.managedAudioRequestBlock(request('/api/staging-login',{email:'founder@pawspace.in',code:'x'.repeat(66000)}),ENV)).status,503);
 assert.equal(await isolation.managedAudioRequestBlock(request('/api/ai-voice-uat',{action:'start',managedAudioProfile:control.MANAGED_AUDIO_PROFILE,direction:'inbound',transportProvider:'sandbox_simulator'}),ENV),null);
 assert.equal(await isolation.managedAudioRequestBlock(request('/api/communications',{}),{}),null);
});
test('migration matches runtime schema and initializes only an empty evidence gate',async t=>{
 const w=world();t.after(()=>w.sqlite.close());w.sqlite.exec(readFileSync(new URL('../drizzle/0047_managed_audio_test_control.sql',import.meta.url),'utf8'));
 await control.ensureManagedAudioControl(w.db);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM managed_audio_fee_evidence').get().n,0);
 assert.equal(w.sqlite.prepare('SELECT cap_micros FROM managed_audio_test_budget').get().cap_micros,5000000);
});

test('actual adapter recovery consumes two slots and refuses a seventh fetch; output clamp applies to both',async t=>{
 const w=world();t.after(()=>w.sqlite.close());const identity=await admitted(w);
 globalThis.__MANAGED_AUDIO_DB__=w.db;globalThis.__MANAGED_AUDIO_ENV__={...ENV,DB:w.db};
 const old=globalThis.fetch,oldNow=Date.now;Date.now=()=>NOW;let network=0;
 t.after(()=>{globalThis.fetch=old;Date.now=oldNow;delete globalThis.__MANAGED_AUDIO_DB__;delete globalThis.__MANAGED_AUDIO_ENV__});
 globalThis.fetch=async (url,options)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');assert.equal(JSON.parse(options.body).max_output_tokens,700);network++;return network===1?Response.json({error:'offline recovery'},{status:500}):Response.json({status:'completed',output_text:'Offline verified reply',usage:{total_tokens:20}});};
 const {requestAiDraftWithVoiceRecovery,requestAiDraft}=await import('../lib/ai-provider-adapter.ts');
 const input={systemPrompt:'Offline synthetic test',userPrompt:'Quote enquiry',channel:'voice',maxTokens:8000,managedConversation:identity};
 assert.equal((await requestAiDraftWithVoiceRecovery(input)).connected,true);
 assert.equal(network,2);assert.equal(w.sqlite.prepare('SELECT attempts_used FROM managed_audio_test_conversations').get().attempts_used,2);
 for(let n=0;n<4;n++)assert.equal((await requestAiDraft(input)).connected,true);
 assert.equal((await requestAiDraft(input)).connected,false);assert.equal(network,6);
 delete globalThis.__MANAGED_AUDIO_ENV__.DB;
 assert.equal((await requestAiDraft(input)).connected,false);assert.equal(network,6);
});
