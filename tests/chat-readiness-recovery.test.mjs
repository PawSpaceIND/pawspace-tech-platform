import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {d1} from './helpers/execution-harness.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__CHAT_RECOVERY_DB__','__CHAT_RECOVERY_ENV__');
const adapter=await import('../lib/ai-web-chat-adapter.ts');
const route=await import('../app/api/ai-web-chat/route.ts');
const {ensureSecurityTables}=await import('../lib/server-auth.ts');
const {ensureCustomerAccountTables}=await import('../lib/customer-account.ts');
const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
const {issuePlatformSession,PLATFORM_SESSION_COOKIE}=await import('../lib/platform-session.ts');
async function world(t){const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);globalThis.__CHAT_RECOVERY_DB__=db;globalThis.__CHAT_RECOVERY_ENV__={PAWSPACE_DEPLOYMENT_ENV:'e2e'};await ensureSecurityTables(db);await ensureCustomerAccountTables(db);return{db,sqlite};}
async function cookie(db,id='A'){const identitySource='customer_otp',principalType='identity_subject',principalKey='customer:'+id,subjectType='customer',subjectId=id;const binding=await upsertIdentityBinding(db,{identitySource,principalType,principalKey,subjectType,subjectId,verificationState:'verified',actorId:'test',reason:'chat recovery test'});const issued=await issuePlatformSession(db,{bindingId:String(binding.id),identitySource,principalType,principalKey,subjectType,subjectId});return PLATFORM_SESSION_COOKIE+'='+encodeURIComponent(issued.token);}
const post=(body,token)=>new Request('https://uat.pawspace.test/api/ai-web-chat',{method:'POST',headers:{'content-type':'application/json',origin:'https://uat.pawspace.test',...(token?{cookie:token}:{})},body:JSON.stringify(body)});

test('cold public knowledge storage returns a real empty collection',async t=>{const {db,sqlite}=await world(t);const result=await adapter.publicAiWebKnowledge(db,{query:'grooming'});assert.deepEqual(result.knowledge,[]);assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='ai_knowledge_source_versions'").get());});

test('public knowledge outside its effective window is never used',async t=>{const {db,sqlite}=await world(t);await adapter.publicAiWebKnowledge(db,{query:'grooming'});const now=Date.now(),insert=sqlite.prepare("INSERT INTO ai_knowledge_source_versions (id,source_key,version,status,title,source_type,content_text,visibility_scope_json,effective_from,effective_to,immutable_hash,created_by,created_at,updated_at) VALUES (?,?,1,'active',?,'faq','Grooming packages include bath and brush.','[\"public\"]',?,?,?,'test',?,?)");insert.run('K-LIVE','live','Grooming live',now-1000,null,'h-live',now,now);insert.run('K-EXPIRED','expired','Grooming expired',now-5000,now-1000,'h-expired',now,now);insert.run('K-SCHEDULED','scheduled','Grooming scheduled',now+60000,null,'h-scheduled',now,now);const result=await adapter.publicAiWebKnowledge(db,{query:'grooming'});const titles=result.knowledge.map(item=>item.title);assert.ok(titles.includes('Grooming live'),JSON.stringify(titles));assert.ok(!titles.includes('Grooming expired'),'expired knowledge is excluded');assert.ok(!titles.includes('Grooming scheduled'),'not-yet-effective knowledge is excluded');});

test('failed knowledge read propagates rather than masquerading as no matches',async t=>{const {db}=await world(t);const broken={...db,prepare(sql){if(sql.startsWith('SELECT id,title,content_text')){const failing={bind:()=>failing,all:async()=>{throw new Error('injected knowledge read failure');}};return failing;}return db.prepare(sql);}};await assert.rejects(adapter.publicAiWebKnowledge(broken,{query:'grooming'}),/injected knowledge read failure/);});

test('invalid chat mode is rejected without creating an inbound message',async t=>{const {sqlite}=await world(t);const response=await route.POST(post({mode:'typo',message:'hello'}));assert.equal(response.status,400);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='communication_messages'").get().n,0);});

test('signed customer session supplies chat identity; explicit foreign identity is still denied',async t=>{
 const {db,sqlite}=await world(t);const now=Date.now();sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES('A','blr','Chat customer','9000800901',?,?)").run(now,now);
 const token=await cookie(db);
 const foreign=await route.POST(post({mode:'authenticated',customerId:'B',message:'What is my next booking?',idempotencyKey:'foreign'},token));assert.equal(foreign.status,403);
 const own=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},token));const result=await own.json();assert.equal(own.status,200,JSON.stringify(result));assert.ok(result.data.threadId);
 const row=sqlite.prepare('SELECT customer_id FROM communication_threads WHERE id=?').get(result.data.threadId);assert.equal(row.customer_id,'A');
 sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES('B','blr','Other customer','9000800902',?,?)").run(now,now);
 const otherToken=await cookie(db,'B');
 const stolenReplay=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},otherToken));
 assert.equal(stolenReplay.status,403);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads WHERE customer_id='B'").get().n,0);
 const ownReplay=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},token));assert.equal(ownReplay.status,200);assert.equal((await ownReplay.json()).data.threadId,result.data.threadId);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key='foreign'").get().n,0);
});


test('public AI answers Pet Relocation from the canonical service directory',async t=>{
 const {db}=await world(t);
 const result=await adapter.runPublicAiWebChat(db,{query:'Does PawSpace offer pet relocation?',sessionKey:'relocation-service-check'});
 assert.equal(result.ai.turn.provider,'canonical_service_directory');
 assert.equal(result.ai.turn.outcome,'reply_ready');
 assert.match(result.ai.turn.output,/Yes\. PawSpace offers Pet Relocation\./);
 assert.equal(result.serviceDirectory.find(service=>service.code==='relocation')?.enabled,true);
});

test('public AI chat still answers when the service-control read fails',async t=>{
 const {db}=await world(t);
 const fail=async()=>{throw new Error('injected service control failure');};
 const broken={...db,prepare(sql){if(sql.includes('service_control')){const failing={bind:()=>failing,run:fail,all:fail,first:fail};return failing;}return db.prepare(sql);},batch:async statements=>{for(const statement of statements)await statement.run();return[];}};
 const result=await adapter.runPublicAiWebChat(broken,{query:'Does PawSpace offer pet relocation?',sessionKey:'service-control-failure'});
 assert.equal(result.ai.turn.outcome,'knowledge_missing');
 assert.match(result.ai.turn.output,/I can help with Grooming/);
 const recorded=await db.prepare("SELECT detail_json FROM ai_web_chat_events WHERE event_type='service_directory_degraded' AND actor_ref='public:service-control-failure'").first();
 assert.ok(recorded,'the lost service-directory read is recorded, not silently treated as an empty catalogue');
 assert.equal(JSON.parse(recorded.detail_json).degraded[0].source,'service_controls');
 assert.equal(JSON.stringify(result).includes('injected service control failure'),false,'the failure reason stays internal');
});

test('public AI does not answer deterministically about one service when several are named',async t=>{
 const {db}=await world(t);
 const result=await adapter.runPublicAiWebChat(db,{query:'Do you offer pet taxi and boarding?',sessionKey:'multi-service-check'});
 assert.notEqual(result.ai.turn.provider,'canonical_service_directory');
 const single=await adapter.runPublicAiWebChat(db,{query:'Do you offer boarding?',sessionKey:'single-service-check'});
 assert.equal(single.ai.turn.provider,'canonical_service_directory');
 assert.match(single.ai.turn.output,/PawSpace offers Boarding\./);
});

test('public AI never exposes the operator-entered disabled reason',async t=>{
 const {db}=await world(t);
 const {setServiceEnabled}=await import('../lib/service-control.ts');
 await setServiceEnabled(db,{serviceCode:'relocation',enabled:false,reason:'INTERNAL vendor contract dispute ticket OPS-991',actorEmail:'ops@pawspace.test'});
 const result=await adapter.runPublicAiWebChat(db,{query:'Does PawSpace offer pet relocation?',sessionKey:'disabled-reason-check'});
 assert.equal(result.ai.turn.provider,'canonical_service_directory');
 assert.equal(result.ai.turn.output,'Pet Relocation is temporarily unavailable on PawSpace.');
 const serialized=JSON.stringify(result);
 assert.ok(!serialized.includes('OPS-991'),serialized);
 assert.ok(!serialized.includes('disabledReason'),serialized);
 assert.equal(result.serviceDirectory.find(service=>service.code==='relocation')?.enabled,false);
});
