import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";
import { makePlatformScaleD1 } from "./helpers/platform-scale-d1.mjs";
const reconciliation = await import("../lib/grooming-completion-reconciliation.ts");
const lifecycle = await import("../lib/provider-lifecycle.ts");
const TYPE = reconciliation.GROOMING_COMPLETION_RECONCILIATION;
globalThis.fetch = async () => { throw new Error("Hermetic completion reconciliation test forbids network"); };
const marker = (ctx,id) => ctx.sqlite.prepare("SELECT * FROM payment_reconciliation_exceptions WHERE id=?").get(reconciliation.groomingCompletionReconciliationId(id));
const detail = (ctx,id) => JSON.parse(marker(ctx,id).detail_json);
const hasTable = (ctx,name) => Boolean(ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
const completionJournals = (ctx,id) => hasTable(ctx,'finance_journal_entries') ? journal(ctx,id) : [];
function config(label) {
 const start=new Date(Date.now()+3*86400000); start.setUTCHours(4,30,0,0);
 return {customerId:`PROBE-${label}`,customerName:'Synthetic recovery probe',phone:'+919900000101',petSourceId:`PROBE-PET-${label}`,petName:'Synthetic dog',cityId:'blr',zoneId:'blr-east',pincode:'560038',latitude:12.9716,longitude:77.5946,preferredProviderId:'groom_kiran',groupId:`PROBE-GROUP-${label}`,start:start.toISOString()};
}
function atFinalize(ctx, action) {
 ctx.db.beforeBatch=async items=>{
  if(!items.some(item=>String(item._sql).includes("UPDATE canonical_bookings SET status='completed'")))return;
  ctx.db.beforeBatch=null;
  const b=ctx.sqlite.prepare("SELECT * FROM canonical_bookings WHERE status='in_service'").get();
  assert.ok(b); assert.ok(journal(ctx,b.id).length>0,'real finance has posted before fault');
  await action(b);
 };
}
const journal=(ctx,id)=>ctx.sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=? ORDER BY id").all(id);
const row=(ctx,table,id)=>ctx.sqlite.prepare(`SELECT * FROM ${table} WHERE ${table==='canonical_bookings'?'id':'booking_id'}=?`).get(id);
const count=(ctx,sql,id)=>ctx.sqlite.prepare(sql).get(id).n;
async function retry(ctx,result,providerId=result.provider.id){const cookie=await sessionCookie(ctx.db,'provider',providerId,`provider:${providerId}`);return routeCall('../../app/api/grooming-lifecycle/route.ts','POST','/api/grooming-lifecycle',{bookingId:result.bookingId,action:'complete',checklist:fixtureChecklist('complete')},cookie);}
async function seedSyntheticInvoiceSeller(ctx){
 const {ensureGstAccountingTables}=await import('../lib/gst-accounting.ts');
 const {ensureGstReturnTables}=await import('../lib/gst-returns.ts');
 await ensureGstAccountingTables(ctx.db);await ensureGstReturnTables(ctx.db);
 const {saveGstSetting}=await import("../lib/gst-setting.ts");
 await saveGstSetting(ctx.db,{cityId:"*",ratePercent:18,method:"extract_inclusive",effectiveFrom:"2024-01-01",reason:"Synthetic inclusive recovery invoice fixture",actorId:"finance.fixture@pawspace.test"});
 const seller={legalName:'Synthetic Probe Seller',gstin:'29AAICT7352F1Z0',stateCode:'29',state:'Karnataka',address:'Synthetic local fixture address'};
 ctx.sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES ('PROBE-ENTITY',?,'IN','active','fixture-checker',1,1,1)").run(seller.legalName);
 ctx.sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('PROBE-REG','PROBE-ENTITY','IN-KA','gstin',?,'active','2024-01-01',NULL,'fixture-checker',1,1,1)").run(seller.gstin);
 ctx.sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,effective_to,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES ('PROBE-POLICY','PROBE-ENTITY',1,'active','2024-01-01',NULL,?,'SYNTHETIC-APPROVAL','fixture-checker',1,1,1)").run(JSON.stringify({seller,defaultComponents:[{code:'CGST',rate:9},{code:'SGST',rate:9}]}));
 ctx.sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('PROBE-SERIES','PROBE-ENTITY','invoice','PR/{FY}/',1,5,'PROBE-POLICY','active',1)").run();
}


test('ordinary completion closes its durable marker only with one committed completion', async t => {
 const ctx=await setupJourney();t.after(ctx.close);
 const result=await runCompletedJourney(ctx,config('SUCCESS'));
 assert.equal(result.completed.status,200,JSON.stringify(result.completed));
 const saved=marker(ctx,result.bookingId);assert.equal(saved.status,'resolved');assert.equal(detail(ctx,result.bookingId).phase,'completed');
 assert.ok(saved.resolved_at);assert.ok(saved.resolved_by);assert.equal(detail(ctx,result.bookingId).postingConfirmed,true);
 const before=journal(ctx,result.bookingId);
 assert.equal((await retry(ctx,result)).status,200);
 assert.deepEqual(marker(ctx,result.bookingId),saved);assert.deepEqual(journal(ctx,result.bookingId),before);
 assert.equal(count(ctx,"SELECT COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? AND to_status='completed'",result.bookingId),1);
});

test('post-finance interruption is visible to Finance; concurrent retries close one marker without repeating money',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);let oldLease;
 atFinalize(ctx,b=>{
  const record=row(ctx,'provider_lifecycle_records',b.id);
  oldLease={bookingId:b.id,lifecycleKey:record.lifecycle_key,token:record.lease_token,from:'in_progress',actorId:'fixture-old-attempt'};
  assert.equal(marker(ctx,b.id).status,'open','marker already committed before finalization');
  assert.equal(detail(ctx,b.id).phase,'awaiting_finance','a crash need not execute catch to leave evidence');
  throw new Error('Synthetic interruption after posted finance');
 });
 const result=await runCompletedJourney(ctx,config('RETRY'));assert.equal(result.completed.status,500);
 assert.equal(marker(ctx,result.bookingId).status,'open');assert.equal(detail(ctx,result.bookingId).phase,'review_required');assert.equal(detail(ctx,result.bookingId).postingConfirmed,true);
 const shown=await routeCall('../../app/api/payment-reconciliation/route.ts','GET','/api/payment-reconciliation?view=overview');
 assert.equal(shown.status,200,JSON.stringify(shown));assert.ok(shown.body.data.exceptions.some(x=>x.id===marker(ctx,result.bookingId).id&&x.type===TYPE));
 const providerCookie=await sessionCookie(ctx.db,'provider',result.provider.id,`provider:${result.provider.id}`);
 const denied=await routeCall('../../app/api/payment-reconciliation/route.ts','POST','/api/payment-reconciliation',{exceptionId:marker(ctx,result.bookingId).id,action:'dismiss',note:'Unauthorized fixture acknowledgement'},providerCookie);
 assert.equal(denied.status,403);assert.equal(marker(ctx,result.bookingId).status,'open');
 const before=journal(ctx,result.bookingId);
 const responses=await Promise.all(Array.from({length:8},()=>routeCall('../../app/api/grooming-lifecycle/route.ts','POST','/api/grooming-lifecycle',{bookingId:result.bookingId,action:'complete',checklist:fixtureChecklist('complete')},providerCookie)));
 assert.ok(responses.some(x=>x.status===200));assert.ok(responses.every(x=>[200,409].includes(x.status)),JSON.stringify(responses));
 assert.deepEqual(journal(ctx,result.bookingId),before);assert.equal(marker(ctx,result.bookingId).status,'resolved');
 assert.equal(count(ctx,"SELECT COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? AND to_status='completed'",result.bookingId),1);
 assert.equal(count(ctx,"SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_completed'",result.bookingId),1);
 const resolved=marker(ctx,result.bookingId);
 await reconciliation.recordGroomingCompletionFailure(ctx.db,oldLease,'finalize');
 assert.deepEqual(marker(ctx,result.bookingId),resolved,'stale catch cannot reopen or alter later success');
});

for(const behavior of ['throw','ignore'])test(`non-durable marker (${behavior}) fails closed before financial posting`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const prepare=ctx.db.prepare;let injected=false;
 ctx.db.prepare=sql=>{
  const stmt=prepare(sql);if(!sql.includes('INSERT INTO payment_reconciliation_exceptions'))return stmt;
  const bind=stmt.bind;stmt.bind=(...args)=>{const bound=bind(...args);if(!args.includes(TYPE))return bound;
   bound.run=async()=>{injected=true;if(behavior==='throw')throw new Error('Synthetic marker storage failure');return{success:true,meta:{changes:0}};};return bound;};return stmt;
 };
 const result=await runCompletedJourney(ctx,config(`MARKER-${behavior}`));assert.ok(injected);assert.ok(result.completed.status>=400);
 assert.equal(completionJournals(ctx,result.bookingId).length,0);assert.equal(marker(ctx,result.bookingId),undefined);
 assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'in_service');
 assert.equal(row(ctx,'provider_lifecycle_records',result.bookingId).lease_token,null);
 ctx.db.prepare=prepare;assert.equal((await retry(ctx,result)).status,200);
});

test('known finance refusal before posting is closed as not_posted, then safely reused on retry',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const prior=process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE;process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE='on';t.after(()=>{if(prior==null)delete process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE;else process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE=prior;});
 const result=await runCompletedJourney(ctx,config('EARLY'));
 assert.equal(result.completed.status,409);assert.equal(completionJournals(ctx,result.bookingId).length,0);
 const saved=marker(ctx,result.bookingId);assert.equal(saved.status,'resolved');assert.equal(detail(ctx,result.bookingId).phase,'not_posted');assert.equal(detail(ctx,result.bookingId).postingConfirmed,false);
 delete process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE;
 assert.equal((await retry(ctx,result)).status,200);assert.equal(marker(ctx,result.bookingId).id,saved.id);assert.equal(detail(ctx,result.bookingId).phase,'completed');
});

test('marker resolution failure rolls back lifecycle success and remains recoverable',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);
 atFinalize(ctx,()=>{ctx.sqlite.exec(`CREATE TEMP TRIGGER ignore_completion_marker_resolution BEFORE UPDATE ON payment_reconciliation_exceptions
   WHEN NEW.exception_type='${TYPE}' AND json_extract(NEW.detail_json,'$.phase')='completed' BEGIN SELECT RAISE(IGNORE); END`);});
 const result=await runCompletedJourney(ctx,config('RESOLVE'));
 assert.equal(result.completed.status,500);assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'in_service');
 assert.equal(marker(ctx,result.bookingId).status,'open');assert.equal(detail(ctx,result.bookingId).phase,'review_required');
 assert.equal(count(ctx,"SELECT COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? AND to_status='completed'",result.bookingId),0);
 const before=journal(ctx,result.bookingId);ctx.sqlite.exec('DROP TRIGGER ignore_completion_marker_resolution');
 assert.equal((await retry(ctx,result)).status,200);assert.deepEqual(journal(ctx,result.bookingId),before);assert.equal(marker(ctx,result.bookingId).status,'resolved');
});

test('public Operations stop leaves dedicated Finance evidence while preserving invoice, journal, and payout block',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);await seedSyntheticInvoiceSeller(ctx);
 let originalJournal,invoice;
 atFinalize(ctx,async b=>{
  originalJournal=journal(ctx,b.id);invoice=ctx.sqlite.prepare("SELECT * FROM finance_invoices WHERE source_type='booking' AND source_id=?").get(b.id);assert.ok(invoice);
  const cookie=await sessionCookie(ctx.db,'customer',b.customer_id,`customer:${b.customer_id}`);
  const opened=await routeCall('../../app/api/grooming-booking-change/route.ts','POST','/api/grooming-booking-change',{bookingId:b.id,customerId:b.customer_id,action:'cancel',reasonCategory:'medical_or_safety_incident',reason:'Synthetic local-only incident during service'},cookie);
  assert.equal(opened.status,409);assert.equal(opened.body.code,'cancellation_requires_approval');
  const stopped=await routeCall('../../app/api/booking-cancellation-case/route.ts','POST','/api/booking-cancellation-case',{caseId:opened.body.caseId,action:'ops_decision',decision:'stop',reason:'Synthetic authorized Operations stop',evidence:{synthetic:true},communication:{customer:'Synthetic recorded notice',provider:'Synthetic recorded notice'}});
  assert.equal(stopped.status,200,JSON.stringify(stopped));
 });
 const result=await runCompletedJourney(ctx,config('STOP'));assert.equal(result.completed.status,409);assert.equal(result.completed.body.code,'completion_financial_inputs_changed');
 assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'stopped_after_start');assert.equal(row(ctx,'provider_work_orders',result.bookingId).status,'stopped_after_start');
 assert.equal((await retry(ctx,result)).status,409);assert.deepEqual(journal(ctx,result.bookingId),originalJournal);
 assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM finance_invoices WHERE source_type='booking' AND source_id=?").get(result.bookingId),invoice);
 const item=marker(ctx,result.bookingId);assert.equal(item.status,'open');assert.equal(item.exception_type,TYPE);assert.equal(detail(ctx,result.bookingId).bookingStatus,'stopped_after_start');assert.equal(detail(ctx,result.bookingId).postingConfirmed,true);
 const {runProviderPayoutQueueSweep}=await import('../lib/provider-payout-queue.ts');
 const sweep=await runProviderPayoutQueueSweep(ctx.db,{asOf:Date.now()+86400000*10,actorId:'synthetic-review',force:true,limit:10});
 assert.equal(sweep.queued,0);assert.equal(row(ctx,'provider_payout_candidates',result.bookingId).reason,'booking_not_completed');
 const listed=await routeCall('../../app/api/payment-reconciliation/route.ts','GET','/api/payment-reconciliation');
 assert.equal(listed.status,200);assert.ok(listed.body.data.exceptions.some(x=>x.id===item.id));
 const reviewed=await routeCall('../../app/api/payment-reconciliation/route.ts','POST','/api/payment-reconciliation',{exceptionId:item.id,action:'investigate',note:'Synthetic Finance investigation, no money action approved'});
 assert.equal(reviewed.status,200,JSON.stringify(reviewed));assert.equal(marker(ctx,result.bookingId).status,'investigating');
 assert.deepEqual(journal(ctx,result.bookingId),originalJournal);assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'stopped_after_start');
});

async function minimal(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=makePlatformScaleD1(sqlite);
 sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,status TEXT,provider_id TEXT); CREATE TABLE provider_work_orders(booking_id TEXT PRIMARY KEY,status TEXT,provider_id TEXT); INSERT INTO canonical_bookings VALUES('BK','grooming','in_service','PR'); INSERT INTO provider_work_orders VALUES('BK','in_service','PR')");
 const lease=await lifecycle.acquireProviderLifecycleLease(db,{bookingId:'BK',serviceCode:'grooming',providerId:'PR',from:'in_progress',path:['completed'],actorId:'fixture'});
 return{sqlite,db,lease};
}

test('crash immediately after reservation leaves an honest posting-unconfirmed marker without catch execution',async t=>{
 const ctx=await minimal(t);await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,ctx.lease,{paymentId:null,expectedAmount:100});
 assert.equal(marker(ctx,'BK').status,'open');assert.equal(detail(ctx,'BK').phase,'awaiting_finance');assert.equal(detail(ctx,'BK').postingConfirmed,false);
 assert.equal(hasTable(ctx,'finance_journal_entries'),false,'reservation cannot provision/post money');
});

test('old attempt cannot clear or reopen a newer pending marker; human dismissal cannot be overwritten',async t=>{
 const ctx=await minimal(t);const old=ctx.lease;
 await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,old,{paymentId:null,expectedAmount:100});
 await lifecycle.releaseProviderLifecycleLease(ctx.db,old);
 const next=await lifecycle.acquireProviderLifecycleLease(ctx.db,{bookingId:'BK',serviceCode:'grooming',providerId:'PR',from:'in_progress',path:['completed'],actorId:'new-fixture'});
 await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,next,{paymentId:null,expectedAmount:100});
 const pending=marker(ctx,'BK');await reconciliation.recordGroomingCompletionFailure(ctx.db,old,'finance');assert.deepEqual(marker(ctx,'BK'),pending);
 await assert.rejects(()=>reconciliation.prepareGroomingCompletionReconciliation(ctx.db,old,{paymentId:null,expectedAmount:100}));assert.deepEqual(marker(ctx,'BK'),pending);
 const {resolvePaymentException}=await import('../lib/grooming-payment-reconciliation.ts');
 await resolvePaymentException(ctx.db,{exceptionId:pending.id,action:'dismiss',actorId:'fixture-finance',note:'Synthetic deliberate acknowledgement only'});
 const dismissed=marker(ctx,'BK');await reconciliation.recordGroomingCompletionFailure(ctx.db,next,'finalize');assert.deepEqual(marker(ctx,'BK'),dismissed);
 await assert.rejects(()=>reconciliation.prepareGroomingCompletionReconciliation(ctx.db,next,{paymentId:null,expectedAmount:100}));assert.deepEqual(marker(ctx,'BK'),dismissed);
});

test('takeover retains unresolved prior-attempt evidence even when a newer finance call refuses before posting',async t=>{
 const ctx=await minimal(t);const old=ctx.lease;
 await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,old,{paymentId:null,expectedAmount:100});
 ctx.sqlite.prepare('UPDATE provider_lifecycle_records SET lease_expires_at=0 WHERE booking_id=?').run('BK');
 const next=await lifecycle.acquireProviderLifecycleLease(ctx.db,{bookingId:'BK',serviceCode:'grooming',providerId:'PR',from:'in_progress',path:['completed'],actorId:'new-fixture'});
 await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,next,{paymentId:null,expectedAmount:100});
 assert.equal(detail(ctx,'BK').priorAttemptUncertain,true);
 await reconciliation.recordGroomingCompletionFailure(ctx.db,next,'finance');
 assert.equal(marker(ctx,'BK').status,'open','absence now does not prove old in-flight work can no longer post');
 assert.equal(detail(ctx,'BK').postingConfirmed,false);assert.equal(detail(ctx,'BK').phase,'review_required');
 await reconciliation.recordGroomingCompletionFailure(ctx.db,old,'finance');assert.equal(marker(ctx,'BK').status,'open');
});

test('concurrent empty financial schema creation keeps posting unconfirmed rather than inventing posted money',async t=>{
 const ctx=await minimal(t);await reconciliation.prepareGroomingCompletionReconciliation(ctx.db,ctx.lease,{paymentId:null,expectedAmount:100});
 const prepare=ctx.db.prepare;let injected=false;
 ctx.db.prepare=sql=>{const stmt=prepare(sql);if(sql!=="SELECT name FROM sqlite_master WHERE type='table'")return stmt;
  const all=stmt.all;stmt.all=async()=>{const result=await all();injected=true;ctx.sqlite.exec('CREATE TABLE finance_journal_entries(source_type TEXT,source_id TEXT)');return result;};return stmt;};
 await reconciliation.recordGroomingCompletionFailure(ctx.db,ctx.lease,'finance');
 assert.ok(injected);assert.equal(marker(ctx,'BK').status,'open');assert.equal(detail(ctx,'BK').postingConfirmed,false);
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM finance_journal_entries').get().n,0);
});

test('real-route expired-lease takeover cannot hide an older finance call that posts after the newer refusal',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);let release,hit,intercepted=false;
 const paused=new Promise(resolve=>{hit=resolve;});const gate=new Promise(resolve=>{release=resolve;});
 const prepare=ctx.db.prepare;
 ctx.db.prepare=sql=>{const stmt=prepare(sql);if(!sql.startsWith('SELECT entry_date,period_code,vertical,cost_centre'))return stmt;
  const bind=stmt.bind;stmt.bind=(...args)=>{const bound=bind(...args),first=bound.first;
   bound.first=async()=>{if(!intercepted){intercepted=true;hit();await gate;}return first();};return bound;};return stmt;};
 const journey=runCompletedJourney(ctx,config('EXPIRED-LEASE'));
 await Promise.race([paused,journey.then(()=>{throw new Error('Expected real finance boundary was not reached');})]);
 const booking=ctx.sqlite.prepare("SELECT * FROM canonical_bookings WHERE status='in_service'").get();
 ctx.sqlite.prepare('UPDATE provider_lifecycle_records SET lease_expires_at=0 WHERE booking_id=?').run(booking.id);
 const prior=process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE;
 try{
  process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE='on';
  const newer=await retry(ctx,{bookingId:booking.id,provider:{id:booking.provider_id}});
  assert.equal(newer.status,409);assert.equal(marker(ctx,booking.id).status,'open');assert.equal(detail(ctx,booking.id).priorAttemptUncertain,true);
 }finally{if(prior==null)delete process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE;else process.env.PAWSPACE_VISUAL_COMPLETION_ENFORCE=prior;release();}
 const older=await journey;assert.ok(older.completed.status>=400);
 const posted=journal(ctx,booking.id);assert.ok(posted.length>0,'older call really posts after newer call returned');
 assert.equal(row(ctx,'canonical_bookings',booking.id).status,'in_service');assert.equal(marker(ctx,booking.id).status,'open');assert.notEqual(detail(ctx,booking.id).phase,'not_posted');
 assert.equal((await retry(ctx,older)).status,200);assert.deepEqual(journal(ctx,booking.id),posted);assert.equal(marker(ctx,booking.id).status,'resolved');
});

for(const action of ['dismiss','mark_refund'])test(`Finance ${action} acknowledgement during finalization is preserved without moving money`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);let acknowledged,posted;
 atFinalize(ctx,async b=>{
  posted=journal(ctx,b.id);
  const review=await routeCall('../../app/api/payment-reconciliation/route.ts','POST','/api/payment-reconciliation',{exceptionId:marker(ctx,b.id).id,action,note:'Synthetic Finance acknowledgement, no gateway operation'});
  assert.equal(review.status,200,JSON.stringify(review));acknowledged=marker(ctx,b.id);
 });
 const result=await runCompletedJourney(ctx,config(`MANUAL-${action}`));assert.ok(result.completed.status>=400);
 assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'in_service');assert.deepEqual(marker(ctx,result.bookingId),acknowledged);assert.deepEqual(journal(ctx,result.bookingId),posted);
 const retried=await retry(ctx,result);assert.equal(retried.status,409);assert.deepEqual(marker(ctx,result.bookingId),acknowledged);assert.deepEqual(journal(ctx,result.bookingId),posted);
});

test('lost finalization response after commit retains completed marker and existing receipt retry',async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const batch=ctx.db.batch;let lost=false;
 ctx.db.batch=async items=>{const output=await batch(items);
  if(!lost&&items.some(item=>String(item._sql).includes("UPDATE canonical_bookings SET status='completed'"))){lost=true;throw new Error('Synthetic lost response after actual finalization commit');}return output;};
 const result=await runCompletedJourney(ctx,config('LOST-RESPONSE'));assert.ok(lost);assert.equal(result.completed.status,500);
 assert.equal(row(ctx,'canonical_bookings',result.bookingId).status,'completed');const saved=marker(ctx,result.bookingId);assert.equal(saved.status,'resolved');assert.equal(detail(ctx,result.bookingId).phase,'completed');
 const posted=journal(ctx,result.bookingId);assert.equal((await retry(ctx,result)).status,200);assert.deepEqual(marker(ctx,result.bookingId),saved);assert.deepEqual(journal(ctx,result.bookingId),posted);
});
