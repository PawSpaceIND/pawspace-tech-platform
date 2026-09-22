import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1,refusal} from './helpers/taxi-harness.mjs';
installWorkersHooks('__RELOCATION_RECOVERY_DB__');
const {createRelocationCase,getRelocationCase,mutateRelocationCase,listRelocationCases}=await import('../lib/relocation-governance.ts');
const client=await import('../lib/relocation-client.ts');
const input=(overrides={})=>({customerId:'QA-RELOCATION-OWNER',petName:'QA dog',breed:'Indie',ageYears:3,sizeClass:'medium',travelMode:'air',originCountry:'India',originCity:'Bengaluru',destinationCountry:'Germany',destinationCity:'Berlin',targetTravelDate:'2099-11-05',crateRequirement:'QA ONLY',idempotencyKey:'qa-recovery-key-1',...overrides});
const world=()=>{const sqlite=freshSqlite();return{sqlite,db:makeD1(sqlite)}};
const count=(sqlite,table)=>Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

test('Relocation creation replay retains case, progress, checklist, CRM linkage and single notification',async()=>{
 const {sqlite,db}=world(),details=input();const a=await createRelocationCase(db,details,'customer:QA');
 await mutateRelocationCase(db,{caseId:a.id,action:'qualify',actorId:'ops:QA'});
 const b=await createRelocationCase(db,details,'customer:QA');assert.equal(b.id,a.id);assert.equal(b.status,'documents_pending');
 for(const [table,n]of [['relocation_cases',1],['relocation_documents',5],['relocation_milestones',9],['relocation_events',2],['lead_work_items',1],['special_service_case_links',1],['communication_messages',1]])assert.equal(count(sqlite,table),n,table);
 assert.equal((await listRelocationCases(db,{customerId:details.customerId}))[0].id,a.id);
 assert.equal((await listRelocationCases(db,{customerId:'other'})).length,0);
});

test('same request key cannot overwrite another payload and is scoped to its customer',async()=>{
 const {db}=world(),a=await createRelocationCase(db,input(),'customer:QA');
 assert.equal((await refusal(createRelocationCase(db,input({destinationCity:'Paris'}),'customer:QA'))).status,409);
 const other=await createRelocationCase(db,input({customerId:'QA-OTHER'}),'customer:OTHER');assert.notEqual(other.id,a.id);
 assert.equal((await getRelocationCase(db,a.id)).destination_city,'Berlin');
});

test('creation transaction rolls back partial checklist and can safely retry',async()=>{
 const {sqlite,db}=world();db.onSql('INSERT OR IGNORE INTO relocation_documents',()=>{throw new Error('Injected checklist write failure')});
 await assert.rejects(createRelocationCase(db,input(),'customer:QA'),/Injected/);
 assert.equal(count(sqlite,'relocation_cases'),0);assert.equal(count(sqlite,'relocation_documents'),0);
 const row=await createRelocationCase(db,input(),'customer:QA');assert.equal(row.documents.length,5);assert.equal(count(sqlite,'relocation_cases'),1);
});

test('interrupted notification write retries the same durable case and repairs linkage without duplication',async()=>{
 const {sqlite,db}=world();db.onSql('INSERT INTO communication_messages',()=>{throw new Error('Injected queue failure')});
 await assert.rejects(createRelocationCase(db,input(),'customer:QA'),/Injected/);assert.equal(count(sqlite,'relocation_cases'),1);
 const first=sqlite.prepare('SELECT id FROM relocation_cases').get().id;
 const row=await createRelocationCase(db,input(),'customer:QA');assert.equal(row.id,first);
 for(const table of ['relocation_cases','relocation_events','lead_work_items','special_service_case_links','communication_messages'])assert.equal(count(sqlite,table),1,table);
});

test('interleaved duplicate creation reuses one case and one CRM/outbox path',async()=>{
 const {sqlite,db}=world();let competitor;
 db.onSql('INSERT OR IGNORE INTO relocation_cases',async()=>{competitor=await createRelocationCase(db,input(),'customer:QA')});
 const row=await createRelocationCase(db,input(),'customer:QA');assert.equal(row.id,competitor.id);
 for(const table of ['relocation_cases','relocation_events','lead_work_items','special_service_case_links','communication_messages'])assert.equal(count(sqlite,table),1,table);
 assert.equal(count(sqlite,'relocation_documents'),5);assert.equal(count(sqlite,'relocation_milestones'),9);
});

test('customer recovery client uses owned scope, encoded identifiers, no-store and abort signals',async()=>{
 const original=globalThis.fetch,calls=[],signal=new AbortController().signal;
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({data:[]})};
 try{await client.loadCustomerRelocationCases('customer&foreign=1',signal);await client.loadRelocationCase('case&scope=staff',signal);
 assert.equal(calls[0].url,'/api/relocation?scope=customer&customerId=customer%26foreign%3D1');assert.equal(calls[1].url,'/api/relocation?scope=customer&caseId=case%26scope%3Dstaff');
 for(const call of calls){assert.equal(call.options.cache,'no-store');assert.equal(call.options.signal,signal)}
 await assert.rejects(client.loadCustomerRelocationCases(''),/Sign in/);assert.equal(calls.length,2);
 }finally{globalThis.fetch=original}
});

test('customer recovery exposes invalid/error responses instead of treating them as an empty history',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response('<html>Upstream unavailable</html>',{status:502});await assert.rejects(client.loadRelocationCase('RLC-1'),/Relocation request failed/);
 globalThis.fetch=async()=>Response.json({error:'Ownership denied'},{status:403});await assert.rejects(client.loadCustomerRelocationCases('other'),/Ownership denied/);
 }finally{globalThis.fetch=original}
});

test('Relocation and V2 Activity expose durable owned-case recovery and read-only retries',()=>{
 const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
 const page=read('app/relocation/page.tsx'),activity=read('app/v2/activity/page.tsx'),list=read('app/relocation/customer-inquiries.tsx');
 assert.match(page,/useQueryParameter\("caseId"\)/);assert.match(page,/loadRelocationCase\(caseId,/);assert.match(page,/url\.searchParams\.set\("caseId",created\.id\)/);
 assert.match(page,/idempotencyKey:createRequest\.current\.key/);assert.match(page,/createInFlight\.current/);assert.match(page,/Retry inquiry/);
 assert.match(activity,/<CustomerRelocationInquiries customerId=\{account.customerId\} routeScope="v2"/);
 assert.match(list,/loadCustomerRelocationCases\(customerId,/);assert.match(list,/encodeURIComponent\(item.id\)/);assert.match(list,/role="alert"/);
 assert.doesNotMatch(list,/createRelocationCase|loadRelocationQueue/);
});

test('invalid explicit request keys fail before creating any case',async()=>{
 const {sqlite,db}=world();for(const key of ['', 'short', 12, {}, 'x'.repeat(201)])assert.equal((await refusal(createRelocationCase(db,input({idempotencyKey:key}),'customer:QA'))).status,400);
 assert.equal(count(sqlite,'relocation_cases'),0);
});

test('real owned recovery routes refuse another customer and refuse staff queue access',async()=>{
 const {db}=world();globalThis.__RELOCATION_RECOVERY_DB__=db;
 const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
 const {issuePlatformSession,PLATFORM_SESSION_COOKIE}=await import('../lib/platform-session.ts');
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 const binding=await upsertIdentityBinding(db,{identitySource:'customer_app',principalType:'phone',principalKey:'+919900000088',subjectType:'customer',subjectId:'QA-RELOCATION-OWNER',verificationState:'verified',actorId:'qa',reason:'Relocation recovery isolation test'});
 const session=await issuePlatformSession(db,{bindingId:String(binding.id),identitySource:'customer_app',principalType:'phone',principalKey:String(binding.principal_key),subjectType:'customer',subjectId:'QA-RELOCATION-OWNER'});
 const cookie=`${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
 const own=await createRelocationCase(db,input(),'customer:QA'),foreign=await createRelocationCase(db,input({customerId:'QA-OTHER'}),'customer:OTHER');
 const route=await import('../app/api/relocation/route.ts');
 const get=path=>route.GET(new Request('https://ops.pawspace.example'+path,{headers:{cookie}}));
 assert.equal((await get('/api/relocation?scope=customer&caseId='+own.id)).status,200);
 assert.equal((await get('/api/relocation?scope=customer&caseId='+foreign.id)).status,403);
 const list=await get('/api/relocation?scope=customer&customerId=QA-RELOCATION-OWNER');assert.equal(list.status,200);assert.deepEqual((await list.json()).data.map(x=>x.id),[own.id]);
 assert.equal((await get('/api/relocation?scope=customer&customerId=QA-OTHER')).status,403);
 assert.equal((await get('/api/relocation')).status,403);
});
