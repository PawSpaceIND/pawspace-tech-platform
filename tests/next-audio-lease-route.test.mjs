import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {installAiHooks,freshAiDb,seedCustomer} from './helpers/ai-harness.mjs';
installAiHooks();
const route=await import('../app/api/ai-voice-uat/audio-lease/route.ts');
const {issueUatToken}=await import('../lib/uat-staging-auth.ts');
const {ensureAiVoiceUatTables}=await import('../lib/ai-voice-uat.ts');
const budget=await import('../lib/next-audio-budget.ts');
const origin='https://pawspace-staging.karthik-fce.workers.dev';
async function world(t,patch={}){
 const env={PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'synthetic-only-signing-key'.repeat(3),PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_STAGING_BUILD_SHA:'a'.repeat(40),PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_AI_VOICE_MODEL:'gpt-5.6-luna',ELEVENLABS_API_BASE:'https://api.elevenlabs.io',ELEVENLABS_API_KEY:'unit-test-only-not-real',ELEVENLABS_GROOMING_AGENT_ID:'synthetic',PAWSPACE_VOICE_UAT_ALLOWLIST:'9876500088',...patch};
 const w=freshAiDb(env);t.after(()=>w.sqlite.close());
 w.sqlite.prepare("INSERT INTO app_users(id,email,name,role_code,status,created_at,updated_at) VALUES('F','founder@pawspace.in','Founder','founder','active',0,0)").run();
 seedCustomer(w.sqlite,'SYNTHETIC','Synthetic tester','9876500088');await ensureAiVoiceUatTables(w.db);
 w.sqlite.prepare("INSERT INTO ai_voice_calls(id,thread_id,customer_id,transport_provider,direction,status,consent_status,started_at,created_by) VALUES('CALL','INITIAL','SYNTHETIC','sandbox_simulator','inbound','active','verified',0,'founder@pawspace.in')").run();
 await budget.ensureNextAudioBudget(w.db);w.sqlite.exec('CREATE TABLE next_audio_rate_evidence(id TEXT PRIMARY KEY,region TEXT NOT NULL,receipt_json TEXT NOT NULL)');
 const agent={conversation_config:{agent:{prompt:{custom_llm:{url:origin+'/api/elevenlabs/v1'}}},conversation:{max_duration_seconds:120}}};
 // All monetary values are test fixtures. A fake metadata origin is the only outbound fetch here.
 const receipt={currency:'USD',inclusiveOfFeesAndTaxes:true,sourceSha:'a'.repeat(40),agentConfigSha256:createHash('sha256').update(JSON.stringify(agent)).digest('hex'),provider:'openai',model:'gpt-5.6-luna',validUntil:Date.now()+600000,nativeMicrosPerMinute:160000,optionalBatchMicros:500000,inputMicrosPerToken:1,outputMicrosPerToken:8,framingTokenUpper:4096,evidenceReference:'synthetic test reference'};
 const token=await issueUatToken(env,'founder@pawspace.in',3600),cookie='pawspace_uat='+encodeURIComponent(token);
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let reads=0;
 globalThis.fetch=async(url,init)=>{reads++;assert.equal(String(url),'https://api.elevenlabs.io/v1/convai/agents/synthetic');assert.equal(init.method??'GET','GET');return Response.json(agent);};
 return {...w,env,agent,receipt,cookie,reads:()=>reads,seedEvidence(r=receipt){w.sqlite.prepare('INSERT OR REPLACE INTO next_audio_rate_evidence VALUES(?,?,?)').run(budget.NEXT_AUDIO_BUDGET_ID,env.ELEVENLABS_API_BASE,JSON.stringify(r));},request(body,headers={}){return new Request(origin+'/api/ai-voice-uat/audio-lease',{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});}};
}
test('lease HTTP cannot provide invented rates; missing trusted evidence blocks without provider fetch',async t=>{
 const w=await world(t);const r=await route.POST(w.request({customerId:'SYNTHETIC',callId:'CALL',receipt:w.receipt}));assert.equal(r.status,403);assert.equal((await r.json()).error,'next_audio_account_charge_ceiling_not_attested');assert.equal(w.reads(),0);
});
test('same origin and authentication required before metadata or paid work',async t=>{
 const w=await world(t);w.seedEvidence();for(const h of [{origin:'https://other.test'},{cookie:''}]){const r=await route.GET(w.request(undefined,h));assert.ok([401,403].includes(r.status));}assert.equal(w.reads(),0);
});
test('valid synthetic admission creates immutable deny namespace and completing call revokes attempt deadline',async t=>{
 const w=await world(t);w.seedEvidence();const claim=await route.POST(w.request({action:'claim_batch',runId:'123'}));const batchToken=(await claim.json()).data.batchToken;const r=await route.POST(w.request({customerId:'SYNTHETIC',callId:'CALL',batchToken}));assert.equal(r.status,201,JSON.stringify(await r.clone().json()));const {data}=await r.json();assert.ok(data.threadId.startsWith(budget.NEXT_AUDIO_THREAD_PREFIX));assert.equal(data.nativeBound,320000);
 assert.equal(w.sqlite.prepare('SELECT thread_id FROM ai_voice_calls').get().thread_id,data.threadId);
 w.sqlite.prepare("UPDATE ai_voice_calls SET status='completed' WHERE id='CALL'").run();assert.ok(w.sqlite.prepare('SELECT expires_at FROM next_audio_leases').get().expires_at<=Date.now());
 const again=await route.POST(w.request({customerId:'SYNTHETIC',callId:'CALL'}));assert.equal(again.status,403);
});
test('provider native duration must be configured, not merely a socket timer',async t=>{
 const w=await world(t);w.agent.conversation_config.conversation.max_duration_seconds=600;w.receipt.agentConfigSha256=createHash('sha256').update(JSON.stringify(w.agent)).digest('hex');w.seedEvidence();const r=await route.GET(w.request());assert.equal(r.status,403);assert.equal((await r.json()).error,'next_audio_native_hard_duration_or_config_unproven');assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM next_audio_leases').get().n,0);
});
test('source, config, unit-test pricing and caller allowlist mismatches fail closed',async t=>{
 const w=await world(t);for(const p of [{sourceSha:'c'.repeat(40)},{agentConfigSha256:'d'.repeat(64)},{evidenceReference:'UNIT TEST ONLY: invented'}]){w.seedEvidence({...w.receipt,...p});assert.equal((await route.GET(w.request())).status,403);}
 w.seedEvidence();w.sqlite.prepare("UPDATE canonical_customers SET primary_phone='9876500099'").run();assert.equal((await route.POST(w.request({customerId:'SYNTHETIC',callId:'CALL'}))).status,403);
});

import {prepareNextAudioDuration} from '../scripts/prepare-next-audio-duration.mjs';
const durationEnv={ELEVENLABS_API_BASE:'https://api.elevenlabs.io',ELEVENLABS_API_KEY:'unit-test-only',GROOMING_AGENT_ID:'synthetic',EXPECTED_SHA:'a'.repeat(40),GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ATTEMPT:'1'};
const config=n=>({conversation_config:{agent:{prompt:{custom_llm:{url:'https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1'}}},conversation:{max_duration_seconds:n}}});
test('only native max duration is patched; verification reads back provider enforcement',async()=>{
 let current=config(600);const methods=[];const r=await prepareNextAudioDuration(durationEnv,async(url,init)=>{assert.equal(url,'https://api.elevenlabs.io/v1/convai/agents/synthetic');methods.push(init.method);if(init.method==='PATCH'){assert.deepEqual(JSON.parse(init.body),{conversation_config:{conversation:{max_duration_seconds:120}}});current=config(120);}return Response.json(current);});
 assert.deepEqual(methods,['GET','PATCH','GET']);assert.equal(r.providerHardDurationSeconds,120);assert.equal(r.paidGenerationRequests,0);assert.equal(r.paidExecutionAllowed,false);
});
test('production brain or replay cannot receive a configuration write',async()=>{
 let writes=0;const bad=config(600);bad.conversation_config.agent.prompt.custom_llm.url='https://production.example/api/elevenlabs/v1';await assert.rejects(()=>prepareNextAudioDuration(durationEnv,async(_,i)=>{if(i.method==='PATCH')writes++;return Response.json(bad);}));assert.equal(writes,0);
 await assert.rejects(()=>prepareNextAudioDuration({...durationEnv,GITHUB_RUN_ATTEMPT:'2'},()=>assert.fail('no HTTP')));
});
test('ignored duration mutation fails rather than substituting a local socket timeout',async()=>{
 await assert.rejects(()=>prepareNextAudioDuration(durationEnv,async()=>Response.json(config(600))),/readback failed/);
});

test('fresh dispatches and replay cannot claim the approved allocation twice',async t=>{
 const w=await world(t);w.seedEvidence();
 const first=await route.POST(w.request({action:'claim_batch',runId:'123'}));assert.equal(first.status,201);
 for(const runId of ['123','124'])assert.notEqual((await route.POST(w.request({action:'claim_batch',runId}))).status,201);
 assert.notEqual((await route.POST(w.request({customerId:'SYNTHETIC',callId:'CALL',batchToken:'other'}))).status,201);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM next_audio_batch_claims').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM next_audio_leases').get().n,0);
});
import {finalizeAudioScenario} from '../scripts/next-audio-evidence.mjs';
test('format/export failures retain packet metadata and final JSON and still complete call',async()=>{
 for(const failure of ['unknown format','ffmpeg failed']){
 const result={errors:[],providerConversationId:'actual-id'};let completed=0,persisted;
 await finalizeAudioScenario({result,recordings:[['caller',[{atMs:1,pcm:Buffer.from([1,2]),format:'unknown'}]],['agent',[{atMs:2,pcm:Buffer.from([3]),format:'pcm_16000'}]]],exportRecording:async()=>{throw Error(failure)},completeCall:async()=>{completed++;result.syntheticCallCompleted=true},persist:async()=>{persisted=JSON.parse(JSON.stringify(result))}});
 assert.equal(completed,1);assert.equal(persisted.providerConversationId,'actual-id');assert.equal(persisted.callerPacketTimeline[0].bytes,2);assert.equal(persisted.agentPacketTimeline.length,1);assert.equal(persisted.errors.length,2);assert.ok(persisted.completedAt);
 }
});
test('completion failure is independently recorded after export failure',async()=>{
 const result={errors:[]};let persisted=false;
 await finalizeAudioScenario({result,recordings:[['agent',[{atMs:1,pcm:Buffer.from([1]),format:'bad'}]]],exportRecording:async()=>{throw Error('export')},completeCall:async()=>{throw Error('complete')},persist:async()=>{persisted=true}});
 assert.equal(persisted,true);assert.equal(result.syntheticCallCompleted,false);assert.equal(result.errors.length,2);
});

import {readFileSync} from 'node:fs';
import {preservedNextAudioBytes} from './helpers/next-audio-reviewed-delta.mjs';
test('exact reviewed workflow suffix can be reversed but any guard mutation fails',()=>{
 const path='.github/workflows/elevenlabs-provider-preflight.yml',bytes=readFileSync(path),before=preservedNextAudioBytes(path,bytes);
 assert.ok(!before.toString().includes('next-bounded-audio:'));
 for(const [a,b] of [["test \"$GITHUB_RUN_ATTEMPT\" = \"1\"","true"],["group: pawspace-staging-sweep","group: other"],["node --experimental-strip-types scripts/next-ten-audio-runner.mjs","node old-runner.mjs"]])assert.throws(()=>preservedNextAudioBytes(path,Buffer.from(before.toString()+bytes.toString().slice(before.length).replace(a,b))));
});

test('provider lookalike, credential and embedded-host URLs are refused before metadata HTTP',async t=>{
 const w=await world(t);w.seedEvidence();
 for(const base of ['https://api.elevenlabs.io.evil.invalid','https://evil.invalid/https://api.elevenlabs.io','https://user@api.elevenlabs.io','https://api.elevenlabs.io?host=evil.invalid']){
 globalThis.__PAWSPACE_TEST_ENV__.ELEVENLABS_API_BASE=base;assert.equal((await route.GET(w.request())).status,403);
 }
 assert.equal(w.reads(),0);
});
import {inspectManagedAudioFees} from '../scripts/inspect-next-audio-fees.mjs';
test('metadata inspector rejects embedded provider host without any HTTP',async()=>{
 for(const base of ['https://api.elevenlabs.io.evil.invalid','https://evil.invalid/https://api.in.residency.elevenlabs.io','https://user@api.elevenlabs.io'])await assert.rejects(()=>inspectManagedAudioFees({ELEVENLABS_API_KEY:'synthetic',GROOMING_AGENT_ID:'synthetic',ELEVENLABS_API_BASE:base},()=>assert.fail('no network')));
});
import {provisionNextAudioCeiling} from '../scripts/prepare-next-audio-duration.mjs';
test('trusted hosted provisioning pins runtime/config and cannot overwrite evidence or reset ledger',async()=>{
 const agent=config(120),receipt={currency:'USD',inclusiveOfFeesAndTaxes:true,sourceSha:'a'.repeat(40),agentConfigSha256:createHash('sha256').update(JSON.stringify(agent)).digest('hex'),provider:'openai',model:'gpt-5.6-luna',validUntil:Date.now()+600000,nativeMicrosPerMinute:320000,optionalBatchMicros:1000000,inputMicrosPerToken:1,outputMicrosPerToken:2,framingTokenUpper:4096,evidenceReference:'synthetic test reference'};
 const e={...durationEnv,CLOUDFLARE_API_TOKEN:'synthetic',CLOUDFLARE_ACCOUNT_ID:'synthetic',STAGING_D1_ID:'staging-only',PRODUCTION_D1_ID:'production-only',NEXT_AUDIO_RATE_RECEIPT_JSON:JSON.stringify(receipt)};
 let stored;const sql=[];
 const vars={PAWSPACE_STAGING_BUILD_SHA:'a'.repeat(40),PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_AI_VOICE_MODEL:'gpt-5.6-luna'};
 const fetcher=async(url,init)=>{
 if(url.startsWith('https://api.elevenlabs.io/')){assert.equal(init.method,'GET');return Response.json(agent);}
 if(url.endsWith('/settings'))return Response.json({success:true,result:{annotations:{'workers/message':'staging '+'a'.repeat(40)},bindings:[...Object.entries(vars).map(([name,text])=>({type:'plain_text',name,text})),{type:'d1',name:'DB',id:'staging-only'}]}});
 if(url.endsWith('/query')){const body=JSON.parse(init.body);sql.push(body.sql);if(body.sql.startsWith('INSERT')&&!stored)stored={region:body.params[1],receipt_json:body.params[2]};return Response.json({success:true,result:[{results:body.sql.startsWith('SELECT')?[stored]:[]}]});}
 return Response.json({success:true,result:{name:'pawspace-staging'}});
 };
 const r=await provisionNextAudioCeiling({...e,GITHUB_SHA:'b'.repeat(40),EXPECTED_SHA:'b'.repeat(40)},fetcher);assert.equal(r.inspectorCheckoutSha,'b'.repeat(40));assert.equal(r.sourceSha,'a'.repeat(40));assert.equal(r.paidGenerationRequests,0);assert.equal(r.trustedCeilingStored,true);assert.ok(sql.every(x=>!x.includes('next_audio_budget')&&!x.includes('UPDATE')&&!x.includes('DELETE')));
 await assert.rejects(()=>provisionNextAudioCeiling({...e,NEXT_AUDIO_RATE_RECEIPT_JSON:JSON.stringify({...receipt,optionalBatchMicros:0})},fetcher),/already pinned/);
 const writes=sql.length;vars.PAWSPACE_VOICE_PHONE_TESTS_PAUSED='false';await assert.rejects(()=>provisionNextAudioCeiling(e,fetcher),/isolation/);assert.equal(sql.length,writes);
 await assert.rejects(()=>provisionNextAudioCeiling({...e,STAGING_D1_ID:'production-only'},()=>assert.fail('no HTTP')));
});
