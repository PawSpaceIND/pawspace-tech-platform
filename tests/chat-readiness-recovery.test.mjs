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

test('failed knowledge read propagates rather than masquerading as no matches',async t=>{const {db}=await world(t);const broken={...db,prepare(sql){if(sql.startsWith('SELECT id,title,content_text'))return{all:async()=>{throw new Error('injected knowledge read failure');}};return db.prepare(sql);}};await assert.rejects(adapter.publicAiWebKnowledge(broken,{query:'grooming'}),/injected knowledge read failure/);});

test('invalid chat mode is rejected without creating an inbound message',async t=>{const {sqlite}=await world(t);const response=await route.POST(post({mode:'typo',message:'hello'}));assert.equal(response.status,400);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='communication_messages'").get().n,0);});

test('signed customer session supplies chat identity; explicit foreign identity is still denied',async t=>{
 const {db,sqlite}=await world(t);const now=Date.now();sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES('A','blr','Chat customer','9000800901',?,?)").run(now,now);
 const token=await cookie(db);
 const foreign=await route.POST(post({mode:'authenticated',customerId:'B',message:'What is my next booking?',idempotencyKey:'foreign'},token));assert.equal(foreign.status,403);
 const own=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},token));const result=await own.json();assert.equal(own.status,201,JSON.stringify(result));assert.ok(result.data.threadId);
 const row=sqlite.prepare('SELECT customer_id FROM communication_threads WHERE id=?').get(result.data.threadId);assert.equal(row.customer_id,'A');
 sqlite.prepare("INSERT INTO canonical_customers(id,city_id,name,primary_phone,created_at,updated_at) VALUES('B','blr','Other customer','9000800902',?,?)").run(now,now);
 const otherToken=await cookie(db,'B');
 const stolenReplay=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},otherToken));
 assert.equal(stolenReplay.status,403);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_threads WHERE customer_id='B'").get().n,0);
 const ownReplay=await route.POST(post({mode:'authenticated',message:'What grooming services do you offer?',idempotencyKey:'own'},token));assert.equal(ownReplay.status,200);assert.equal((await ownReplay.json()).data.threadId,result.data.threadId);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key='foreign'").get().n,0);
});
