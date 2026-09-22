import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {makeCountingD1} from './helpers/d1-harness.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__V2_GATE_DB__','__V2_GATE_ENV__');
const {ensureSecurityTables}=await import('../lib/server-auth.ts');
const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
const {issuePlatformSession,platformSessionCookie}=await import('../lib/platform-session.ts');
const {authorizeApiRequest}=await import('../lib/api-gateway.ts');
const {authorizePlatformSessionRequest}=await import('../lib/session-api-gateway.ts');
const route=await import('../app/api/grooming-payment-sandbox/route.ts');
const {ensurePaymentReconciliationTables}=await import('../lib/grooming-payment-reconciliation.ts');
const origin='https://uat.pawspace.test';
async function world(){
 const sqlite=new DatabaseSync(':memory:'),{db}=makeCountingD1(sqlite);
 globalThis.__V2_GATE_DB__=db;globalThis.__V2_GATE_ENV__={PAWSPACE_PAYMENT_ENV:'sandbox',RAZORPAY_KEY_ID_SANDBOX:'rzp_test_fixture',RAZORPAY_KEY_SECRET_SANDBOX:'fixture-secret'};
 await ensureSecurityTables(db);await ensurePaymentReconciliationTables(db);
 sqlite.exec("CREATE TABLE provider_work_orders(booking_id TEXT,provider_id TEXT); INSERT INTO provider_work_orders VALUES('B1','P1'); CREATE TABLE canonical_bookings(id TEXT,status TEXT,provider_id TEXT,customer_id TEXT); INSERT INTO canonical_bookings VALUES('B1','completed','P1','C1'); CREATE TABLE booking_payments(id TEXT,booking_id TEXT,amount REAL,currency TEXT,status TEXT,mode TEXT); INSERT INTO booking_payments VALUES('PAY1','B1',1349,'INR','created','pay_after_service');");
 return{sqlite,db};
}
async function cookie(db,subjectType='provider',subjectId='P1'){
 const binding=await upsertIdentityBinding(db,{identitySource:subjectType==='provider'?'partner_otp':'customer_otp',principalType:'identity_subject',principalKey:subjectId,subjectType,subjectId,verificationState:'verified',actorId:'test',reason:'V2 launch regression'});
 const issued=await issuePlatformSession(db,{bindingId:binding.id,identitySource:binding.identity_source,principalType:binding.principal_type,principalKey:subjectId,subjectType,subjectId});
 return platformSessionCookie(issued.token,issued.ttlSeconds).split(';')[0];
}
async function call(db,cookie,action,method='POST',originHeader=origin){
 const req=new Request(origin+'/api/grooming-payment-sandbox'+(method==='GET'?'?bookingId=B1':''),{method,headers:{cookie,origin:originHeader,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({bookingId:'B1',action})}:{})});
 const first=await authorizePlatformSessionRequest(req,db),gate=first??await authorizeApiRequest(req,{DB:db,PAWSPACE_PAYMENT_ENV:'sandbox'});
 return gate instanceof Response?gate:route[method](req);
}
test('assigned provider reads and creates post-service payment through Worker gateway; replay reuses request',async(t)=>{
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.match(String(url),/\/v1\/payment_links$/);const body=JSON.parse(init.body);assert.equal(body.amount,134900);return Response.json({id:'plink_fixture',short_url:'https://rzp.io/test-fixture',expire_by:body.expire_by});});
 const w=await world(),c=await cookie(w.db);
 assert.equal((await call(w.db,c,null,'GET')).status,200);
 const created=await call(w.db,c,'request_after_service');assert.equal(created.status,201,await created.clone().text());
 const id=(await created.json()).data.id;
 assert.equal((await (await call(w.db,c,'request_after_service')).json()).data.id,id);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM post_service_payment_requests').get().n,1);
 assert.equal(w.sqlite.prepare('SELECT status FROM booking_payments').get().status,'created');w.sqlite.close();
});
for(const action of ['create_order','simulate_event','initiate_refund','link_order'])test('provider cannot perform Finance action '+action,async()=>{const w=await world();assert.equal((await call(w.db,await cookie(w.db),action)).status,403);w.sqlite.close();});
test('other provider, customer, anonymous and cross-origin requests remain refused',async()=>{
 const w=await world();
 for(const c of [await cookie(w.db,'provider','P2'),await cookie(w.db,'customer','C1'),''])assert.ok([401,403].includes((await call(w.db,c,'request_after_service')).status));
 assert.equal((await call(w.db,await cookie(w.db),'request_after_service','POST','https://elsewhere.test')).status,403);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM post_service_payment_requests').get().n,0);w.sqlite.close();
});
