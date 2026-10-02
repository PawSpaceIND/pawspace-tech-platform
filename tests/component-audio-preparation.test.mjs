import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {componentCostBound,startComponentLease,resumeComponentLease,claimComponentRequest,componentNetworkGuard,COMPONENT_LIMITS} from '../scripts/component-audio-control.mjs';
function ledger(){
 const sqlite=new DatabaseSync(':memory:');
 const statement=(sql,args=[])=>({sql,args,bind:(...p)=>statement(sql,p),run:async()=>({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}),first:async()=>sqlite.prepare(sql).get(...args)??null});
 return {sqlite,db:{prepare:statement,batch:async rows=>{sqlite.exec('BEGIN IMMEDIATE');try{const result=rows.map(s=>({success:true,meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}}));sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}}};
}
const SOURCE='a'.repeat(40),NOW=Date.parse('2026-10-02T12:00:00Z');
test('conservative fixed component bound remains below the shared $5 ceiling',()=>{
 const b=componentCostBound();assert.equal(b.modelPerRequest,34284);assert.equal(b.sttPerRequest,8334);assert.equal(b.ttsPerRequest,100000);assert.equal(b.totalMicros,4278540);assert.equal(b.hardReservationMicros,5000000);assert.equal(b.headroomMicros,721460);
});
test('one durable reservation across competing starts; resume and housekeeping never reset counters or refund',async t=>{
 const w=ledger();t.after(()=>w.sqlite.close());const outcomes=await Promise.allSettled(Array.from({length:20},()=>startComponentLease(w.db,SOURCE,NOW)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const lease=outcomes.find(r=>r.status==='fulfilled').value;
 for(const kind of ['model','stt','tts']){
  const results=await Promise.allSettled(Array.from({length:50},()=>claimComponentRequest(w.db,lease,kind,NOW)));assert.equal(results.filter(r=>r.status==='fulfilled').length,30);
 }
 assert.equal(w.sqlite.prepare('SELECT reserved_micros FROM managed_audio_test_budget').get().reserved_micros,5000000);
 const resumed=await resumeComponentLease(w.db,lease.id,SOURCE,NOW);await assert.rejects(()=>claimComponentRequest(w.db,resumed,'model',NOW),/refused/);
 await assert.rejects(()=>resumeComponentLease(w.db,lease.id,'b'.repeat(40),NOW),/wrong_source/);await assert.rejects(()=>resumeComponentLease(w.db,lease.id,SOURCE,NOW+7200001),/expired/);
 await assert.rejects(()=>startComponentLease(w.db,SOURCE,NOW),/already_reserved/);
});
test('any existing native managed reservation blocks component admission',async t=>{
 const w=ledger();t.after(()=>w.sqlite.close());await startComponentLease(w.db,SOURCE,NOW);w.sqlite.prepare('DELETE FROM managed_audio_component_runs').run();await assert.rejects(()=>startComponentLease(w.db,SOURCE,NOW),/already_reserved/);
});
test('network guard rejects customer endpoints, oversized input, wrong model, tool use and retries before dispatch',async()=>{
 let sends=0,claims=0;const guard=componentNetworkGuard({region:'https://api.elevenlabs.io',voiceId:'fixture',fetcher:async()=>{sends++;return Response.json({output_text:'mock'});},claim:async()=>{claims++;}});
 const body={model:'gpt-5.6-luna',instructions:'i',input:'u',max_output_tokens:700,store:false,reasoning:{effort:'none'}};
 const req=b=>({method:'POST',body:JSON.stringify(b)});
 for(const url of ['https://api.razorpay.com/v1/orders','https://pawspace-staging.karthik-fce.workers.dev/api/messages','https://api.openai.com/v1/responses?x=1'])await assert.rejects(()=>guard.fetch(url,req(body)),/route_refused/);
 for(const b of [{...body,model:'other'},{...body,max_output_tokens:701},{...body,input:'x'.repeat(COMPONENT_LIMITS.inputBytes+1)},{...body,tools:[]},{...body,stream:true}])await assert.rejects(()=>guard.fetch('https://api.openai.com/v1/responses',req(b)),/unbounded/);
 assert.equal(sends,0);assert.equal(claims,0);
 await guard.fetch('https://api.openai.com/v1/responses',req(body));assert.equal(sends,1);assert.equal(claims,1);
 const retry=await guard.fetch('https://api.openai.com/v1/responses',req(body));assert.equal(retry.status,403);assert.equal(sends,1);assert.equal(claims,1);
});
test('reviewed application brain runs on synthetic fixture state with actual prompt bounds and no external sends',async()=>{
 const {createComponentBrain}=await import('../scripts/component-audio-brain.mjs');const prior=globalThis.fetch;let calls=0,maximum=0;
 const guard=componentNetworkGuard({region:'https://api.elevenlabs.io',voiceId:'fixture',claim:async()=>{},fetcher:async(url,init)=>{calls++;const b=JSON.parse(init.body);maximum=Math.max(maximum,Buffer.byteLength(b.instructions)+Buffer.byteLength(b.input));return Response.json({output_text:'Grooming options depend on your pets and selected package. Which package would you like to compare?',usage:{total_tokens:100}});}});
 globalThis.fetch=guard.fetch;let brain;
 try{brain=await createComponentBrain({PAWSPACE_OPENAI_API_KEY:'offline-not-a-credential'});guard.beginTurn();const result=await brain.turn('grooming','What grooming packages are available for Milo and Luna? Information only, do not book.');console.log("UNPAID_BRAIN_RESULT="+JSON.stringify(result));assert.ok(result.output);assert.equal(calls,1);assert.ok(maximum<=65536);assert.equal(brain.snapshot().productionPersistenceVerified,false);console.log('UNPAID_BRAIN_PROMPT_BYTES='+maximum);}finally{brain?.close();globalThis.fetch=prior;}
});

test('strict STT duration is verified from actual PCM WAV bytes; TTS character cap precedes billing',async()=>{
 const {componentWav}=await import('../scripts/run-component-audio.mjs');let sends=0;const guard=componentNetworkGuard({region:'https://api.elevenlabs.io',voiceId:'fixture',claim:async()=>{},fetcher:async()=>{sends++;return Response.json({text:'offline fixture'});}});
 const request=audio=>{const f=new FormData();f.set('model_id','scribe_v2');f.set('file',new Blob([audio]),'fixture.wav');f.set('webhook','false');f.set('diarize','false');return {method:'POST',body:f};};
 await assert.rejects(()=>guard.fetch('https://api.elevenlabs.io/v1/speech-to-text',request(Buffer.alloc(3244))),/audio_invalid/);
 await assert.rejects(()=>guard.fetch('https://api.elevenlabs.io/v1/speech-to-text',request(componentWav(Buffer.alloc(32000*61)))),/unbounded/);
 await assert.rejects(()=>guard.fetch('https://api.elevenlabs.io/v1/text-to-speech/fixture/stream?output_format=pcm_16000',{method:'POST',body:JSON.stringify({text:'x'.repeat(1001),model_id:'eleven_multilingual_v2'})}),/unbounded/);assert.equal(sends,0);
 await guard.fetch('https://api.elevenlabs.io/v1/speech-to-text',request(componentWav(Buffer.alloc(3200))));assert.equal(sends,1);
});
test('component route verifies remote staging ledger identity and confines batch SQL to budget tables',async()=>{
 const {remoteComponentLedger}=await import('../scripts/run-component-audio.mjs');const id='a'.repeat(32),env={CLOUDFLARE_ACCOUNT_ID:id,CLOUDFLARE_API_TOKEN:'offline',STAGING_D1_ID:'11111111-1111-1111-1111-111111111111',PRODUCTION_D1_ID:'22222222-2222-2222-2222-222222222222'};let calls=0;
 await assert.rejects(()=>remoteComponentLedger(env,async()=>{calls++;return Response.json({success:true,result:{name:'production',uuid:env.STAGING_D1_ID}});}),/not_verified/);assert.equal(calls,1);
 const db=await remoteComponentLedger(env,async(url,init)=>{calls++;if(init.method==='GET')return Response.json({success:true,result:{name:'pawspace-staging',uuid:env.STAGING_D1_ID}});const x=JSON.parse(init.body);assert.ok(x.batch);return Response.json({success:true,result:x.batch.map(()=>({success:true,meta:{changes:1},results:[]}))});});
 assert.throws(()=>db.prepare('DROP TABLE managed_audio_test_budget'),/scope_refused/);
 await db.batch([db.prepare('SELECT * FROM managed_audio_test_budget')]);
});
test('standard premade voice metadata refuses reward/unknown paid library voices without generation',async()=>{
 const {readComponentVoice}=await import('../scripts/run-component-audio.mjs');const env={ELEVENLABS_API_KEY:'offline'};
 await assert.rejects(()=>readComponentVoice(env,async()=>Response.json({voices:[{voice_id:'private',category:'professional',sharing:{financial_rewards_enabled:true}}]})),/no_fee_bound/);
 const v=await readComponentVoice(env,async()=>Response.json({voices:[{voice_id:'standard',category:'premade',sharing:null,labels:{gender:'female'}}]}));assert.equal(v.voiceId,'standard');assert.equal(v.receipt.nativeAgentVoiceTested,false);
});
