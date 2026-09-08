import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1,seedSittingBooking,customerSessionCookie} from './helpers/stay-harness.mjs';
import {sittingCustomerIncidents,loadCustomerSittingIncidents,acknowledgeCustomerSittingIncident} from '../lib/sitting-customer-view.ts';
installWorkersHooks('__INCIDENT_CUSTOMER_DB__','__INCIDENT_CUSTOMER_ENV__');
test('incident payloads require the owned booking and a complete incident collection',()=>{
 assert.deepEqual(sittingCustomerIncidents({bookingId:'B',incidents:[]},'B'),[]);
 for(const value of [{bookingId:'B'},{bookingId:'OTHER',incidents:[]},{bookingId:'B',incidents:[{}]}])assert.throws(()=>sittingCustomerIncidents(value,'B'),/incomplete|another booking/);
 const incident={id:'I',summary:'Owner update',severity:'urgent',status:'open',customer_acknowledged_at:123};const rows=sittingCustomerIncidents({bookingId:'B',incidents:[incident]},'B');assert.equal(rows[0].acknowledged,true);assert.equal(rows[0].notificationStatus,'unavailable');assert.throws(()=>sittingCustomerIncidents({bookingId:'B',incidents:[incident,incident]},'B'),/incomplete/);
});
test('failed reads and unconfirmed acknowledgements never become success',async t=>{const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>Response.json({error:'Unavailable'},{status:503});await assert.rejects(loadCustomerSittingIncidents('B'),/Unavailable/);globalThis.fetch=async()=>Response.json({data:{bookingId:'B',incidentId:'I'}});await assert.rejects(acknowledgeCustomerSittingIncident('B','I'),/not confirmed/);globalThis.fetch=async()=>Response.json({data:{bookingId:'B',incidentId:'OTHER',customerAcknowledged:true}});await assert.rejects(acknowledgeCustomerSittingIncident('B','I'),/not confirmed/);});
test('unloaded incident screen shows loading rather than a false empty collection',async()=>{const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{default:Panel}=await import('../app/sitting/manage/sitting-customer-incidents.tsx');const html=renderToStaticMarkup(React.createElement(Panel,{bookingId:'B'}));assert.match(html,/Loading recorded incidents/);assert.doesNotMatch(html,/No Sitting incidents/);assert.match(html,/<button disabled/);});
test('real customer incident route persists one acknowledgement without resolving the case or changing money',async t=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());globalThis.__INCIDENT_CUSTOMER_DB__=db;globalThis.__INCIDENT_CUSTOMER_ENV__={PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'};
 const seed=await seedSittingBooking(db,sqlite);sqlite.prepare("UPDATE canonical_bookings SET status='in_progress' WHERE id=?").run(seed.bookingId);
 const {mutateSittingProof}=await import('../lib/sitting-proof-governance.ts');const reported=await mutateSittingProof(db,{bookingId:seed.bookingId,action:'report_incident',actorId:'fixture-sitter',idempotencyKey:'FIXTURE-INCIDENT',severity:'attention',summary:'Disposable incident for customer acknowledgement',actionTaken:'Recorded for sandbox review'});
 const route=await import('../app/api/sitting-proof/route.ts');let cookie=(await customerSessionCookie(db,{principalKey:'customer:incident-owner',customerId:seed.customerId})).cookie;
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async(path,init={})=>route[init.method||'GET'](new Request(new URL(path,'https://uat.pawspace.test'),{...init,headers:{...init.headers,cookie}}));
 const before=sqlite.prepare('SELECT status,total_amount FROM canonical_bookings WHERE id=?').get(seed.bookingId);assert.equal((await loadCustomerSittingIncidents(seed.bookingId))[0].acknowledged,false);
 await acknowledgeCustomerSittingIncident(seed.bookingId,reported.incidentId);await acknowledgeCustomerSittingIncident(seed.bookingId,reported.incidentId);
 const rows=await loadCustomerSittingIncidents(seed.bookingId);assert.equal(rows[0].acknowledged,true);assert.equal(rows[0].status,'open');assert.deepEqual(sqlite.prepare('SELECT status,total_amount FROM canonical_bookings WHERE id=?').get(seed.bookingId),before);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sitting_incident_events WHERE incident_id=? AND event_type='customer_acknowledged'").get(reported.incidentId).n,1);
 cookie=(await customerSessionCookie(db,{principalKey:'customer:incident-foreign',customerId:'FOREIGN'})).cookie;await assert.rejects(loadCustomerSittingIncidents(seed.bookingId),/ownership/i);await assert.rejects(acknowledgeCustomerSittingIncident(seed.bookingId,reported.incidentId),/ownership/i);
});
