import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installWorkersHooks,enterWorkersDbScope} from './helpers/module-hooks.mjs';
import {world} from './helpers/execution-harness.mjs';
import {prepareCrmSchedulingReadiness,schedulingReadinessKey} from '../lib/crm-scheduling-readiness.ts';

installWorkersHooks('__CRM_SCHED_INTEGRATION_DB__','__CRM_SCHED_INTEGRATION_ENV__');
process.env.NODE_ENV='test';
process.env.PAWSPACE_LOCAL_PREVIEW='on';
const {ensureCustomerAccountTables}=await import('../lib/customer-account.ts');
const {resolveStaffLeadCustomer}=await import('../lib/lead-customer-identity.ts');
const {ensureLeadWorkItemsTable,validateBookingOrigin}=await import('../lib/lead-conversion-attribution.ts');
const {ensureInboundLead}=await import('../lib/lead-lifecycle-governance.ts');
const {resolveGovernedServiceAddress}=await import('../lib/service-discovery-address.ts');
const {POST}=await import('../app/api/uat-scheduling/route.ts');
const {resolveActor,requirePermission}=await import('../lib/server-auth.ts');
const {resolveTrustedWorkspaceIdentity}=await import('../lib/trusted-workspace-identity.ts');
const env={PAWSPACE_SCHEDULING_ENV:'uat',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:'on',PAWSPACE_TEST_AUTHORED_ROSTER_FIXTURE:'on'};
const crmSource=readFileSync(new URL('../app/api/crm/route.ts',import.meta.url),'utf8');
const crmDdl=crmSource.match(/CREATE TABLE IF NOT EXISTS crm_contacts [^"]+/)[0];
const post=async body=>{const response=await POST(new Request('http://localhost/api/uat-scheduling',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
function futureSlot(){const offset=330*60_000,d=new Date(Date.now()+offset);const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+8,10)-offset);return {scheduledStart:start.toISOString(),scheduledEnd:new Date(start.getTime()+120*60_000).toISOString()};}

test('real canonical lead helpers → governed address → readiness → real preview → atomic conflict/replay, entirely in memory',async()=>{
 const {sqlite,db}=world('__CRM_SCHED_INTEGRATION_DB__','__CRM_SCHED_INTEGRATION_ENV__',env);
 const originalFetch=globalThis.fetch;let providerCalls=0;
 globalThis.fetch=async()=>{providerCalls++;throw Error('External requests forbidden in synthetic integration');};
 try{
  await ensureCustomerAccountTables(db);sqlite.exec(crmDdl);await ensureLeadWorkItemsTable(db);
  const customer=await resolveStaffLeadCustomer(db,{proposedCustomerId:'SYNTHETIC-C1',name:'Synthetic Lead',phone:'9000000812',cityId:'blr',now:Date.now()});
  assert.equal(customer.identityReview,false);assert.equal(customer.newCanonicalCustomer,true);
  const again=await resolveStaffLeadCustomer(db,{proposedCustomerId:'SYNTHETIC-OTHER',name:'Same Synthetic Lead',phone:'+91 90000 00812',cityId:'blr',now:Date.now()});assert.equal(again.customerId,customer.customerId);
  const lead=await ensureInboundLead(db,{customerId:customer.customerId,source:'synthetic_enquiry',service:'Grooming',owner:'Synthetic Review Queue'});
  const origin=await validateBookingOrigin(db,{customerId:customer.customerId,leadId:lead.leadId,serviceCode:'grooming'});assert.equal(origin.leadId,lead.leadId);
  await assert.rejects(()=>validateBookingOrigin(db,{customerId:'OTHER-CUSTOMER',leadId:lead.leadId,serviceCode:'grooming'}),e=>e instanceof Response&&e.status===403);
  await assert.rejects(()=>validateBookingOrigin(db,{customerId:customer.customerId,leadId:lead.leadId,serviceCode:'dog_walking'}),e=>e instanceof Response&&e.status===409);
  sqlite.prepare("INSERT INTO canonical_pets(id,customer_id,name,species,breed,vaccination_status,created_at,updated_at) VALUES (?,?,'Synthetic Dog','dog','Mixed','verified',?,?)").run('SYNTHETIC-P1',customer.customerId,Date.now(),Date.now());
  const governed=await resolveGovernedServiceAddress(db,{customerId:customer.customerId,serviceCode:'grooming',serviceAddress:'42 Indiranagar Double Road, Bengaluru',servicePincode:'560038',saveToAccount:false});
  const request={clientRequestId:'synthetic-event-a',customerId:customer.customerId,petIds:['SYNTHETIC-P1'],serviceCode:'grooming',providerSelection:'specific',preferredProviderId:'groom_arun',serviceAddress:governed.address,servicePincode:governed.pincode,...futureSlot()};
  const actor= requirePermission(await resolveActor(new Request('http://localhost/api/uat-scheduling')),'scheduling.book');assert.equal(actor.developmentPreview,true,'local synthetic authority; not unattended auth proof');
  const draft={event:{key:'synthetic-event-a',fingerprint:'synthetic-immutable-a'},binding:{eventKey:'synthetic-event-a',fingerprint:'synthetic-immutable-a',customerId:customer.customerId,leadId:origin.leadId,serviceCode:'grooming',verified:true},auth:{customerId:customer.customerId,leadId:origin.leadId,platformAuthorized:true,permission:'scheduling.book',expiresAt:Date.now()+60_000},request,pets:[{id:'SYNTHETIC-P1',customerId:customer.customerId}],address:{id:governed.addressId,customerId:customer.customerId,serviceCode:'grooming',text:governed.address,pincode:governed.pincode,cityId:governed.cityId,zoneId:governed.zoneId,latitude:governed.latitude,longitude:governed.longitude,serviceable:true}};
  const missing=prepareCrmSchedulingReadiness(draft,Date.now());assert.equal(missing.status,'held');assert.ok(missing.holds.includes('fresh_bound_availability_required'));
  // Trusted evidence acquisition executes existing preview. No duplicate scheduling engine is built.
  const preview=await post({...request,action:'preview'});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(preview.body.data.providers.some(p=>p.id==='groom_arun'));
  const now=Date.now(),revision='synthetic-calendar-revision-1',requestKey=schedulingReadinessKey(draft);
  draft.availability={requestKey,revision,checkedAt:now,expiresAt:now+30_000,providerIds:preview.body.data.providers.map(p=>p.id),engineEligible:true};
  // Road results are deliberately synthetic input; adapter wiring does not prove the maps transport.
  draft.travel={requestKey,availabilityRevision:revision,providerId:'groom_arun',checkedAt:now,expiresAt:now+30_000,complete:true,legs:[{status:'configured',durationSeconds:900,availableSeconds:3600}]};
  const rows=sqlite.prepare("SELECT provider_id,scheduled_start,scheduled_end FROM scheduling_reservations WHERE status!='cancelled'").all();
  draft.reservations={availabilityRevision:revision,complete:true,windows:rows.map(r=>({providerId:r.provider_id,start:r.scheduled_start,end:r.scheduled_end}))};
  const ready=prepareCrmSchedulingReadiness(draft,now);assert.equal(ready.status,'ready',JSON.stringify(ready));assert.equal(ready.reservationAllowed,false);
  const payloadPreview=await post(ready.payload);assert.equal(payloadPreview.status,200);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM scheduling_reservations').get().n,0);
  // Test-only override invokes the REAL atomic commit, exclusively against this in-memory D1.
  // No production handler/flag is changed or wired to the adapter.
  const winning=await post({...ready.payload,action:'reserve'});assert.equal(winning.status,200,JSON.stringify(winning.body));
  const repeat=await post({...ready.payload,action:'reserve'});assert.equal(repeat.status,200);assert.equal(repeat.body.data.duplicatePrevented,true);
  // Reuse the existing transactional D1 harness. Hide ONLY engine conflict reads to force TOCTOU;
  // SQL INSERT guards still see the actual committed winner and must reject the second request.
  const staleDb={...db,prepare(sql){const wrap=stmt=>({...stmt,bind(...args){return wrap(stmt.bind(...args));},async all(){return /FROM scheduling_reservations WHERE city_id=/.test(sql)?{results:[],success:true}:stmt.all();}});return wrap(db.prepare(sql));}};
  enterWorkersDbScope(staleDb);
  const loser=await post({...ready.payload,clientRequestId:'synthetic-event-b',action:'reserve'});assert.equal(loser.status,409,JSON.stringify(loser.body));assert.equal(loser.body.error,'SLOT_TAKEN');
  enterWorkersDbScope(db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE status!='cancelled'").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_assignment_decisions WHERE status='assigned'").get().n,1,'failed atomic batch leaves no second assigned decision');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM canonical_customers').get().n,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM lead_work_items').get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").get().n,0,'booking confirmation is never invoked');
  assert.equal(providerCalls,0,'no maps, provider or messaging HTTP requests');
 }finally{globalThis.fetch=originalFetch;sqlite.close();}
});

test('actual auth resolver rejects direct-Worker workspace spoof and operator/Bearer token',async()=>{
 const {sqlite}=world('__CRM_SCHED_INTEGRATION_DB__','__CRM_SCHED_INTEGRATION_ENV__',{PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_WORKSPACE_IDENTITY_TRUST:'openai-dispatch'});
 try{const request=new Request('https://synthetic-platform.workers.dev/api/uat-scheduling',{headers:{'oai-authenticated-user-email':'synthetic@pawspace.test',Authorization:'Bearer synthetic-operator-token'}});assert.equal(resolveTrustedWorkspaceIdentity(request,{PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_WORKSPACE_IDENTITY_TRUST:'openai-dispatch'}),null);await assert.rejects(()=>resolveActor(request),e=>e instanceof Response&&e.status===401);}finally{sqlite.close();}
});
