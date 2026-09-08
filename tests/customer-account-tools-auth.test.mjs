import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {d1} from './helpers/execution-harness.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__ACCOUNT_TOOLS_DB__','__ACCOUNT_TOOLS_ENV__');
const {upsertIdentityBinding}=await import('../lib/identity-binding.ts');
const {issuePlatformSession,PLATFORM_SESSION_COOKIE}=await import('../lib/platform-session.ts');
const {authorizeApiRequest}=await import('../lib/api-gateway.ts');
const {ensureSecurityTables}=await import('../lib/server-auth.ts');
const notifications=await import('../app/api/order-notifications/route.ts');
const billing=await import('../app/api/customer-billing/route.ts');
const {ensureOrderNotificationTables}=await import('../lib/order-notification-governance.ts');
async function cookie(db,id){const identitySource='customer_otp',subjectType='customer',principalType='identity_subject',principalKey=`customer:${id}`;
 const binding=await upsertIdentityBinding(db,{identitySource,principalType,principalKey,subjectType,subjectId:id,verificationState:'verified',actorId:'test',reason:'isolated account access regression'});
 const issued=await issuePlatformSession(db,{bindingId:String(binding.id),identitySource,principalType,principalKey,subjectType,subjectId:id});return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}
test('customer API gateway allows owned account tools; anonymous and foreign inbox reads remain denied',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);globalThis.__ACCOUNT_TOOLS_DB__=db;globalThis.__ACCOUNT_TOOLS_ENV__={};await ensureSecurityTables(db);await ensureOrderNotificationTables(db);
 const own=await cookie(db,'A'),other=await cookie(db,'B');
 for(const path of ['/api/customer-billing','/api/order-notifications?customerId=A']){
  const allowed=await authorizeApiRequest(new Request(`https://uat.pawspace.in${path}`,{headers:{cookie:own}}),{DB:db});assert.ok(!(allowed instanceof Response));assert.equal(allowed.actor.roleCode,'customer');
  const denied=await authorizeApiRequest(new Request(`https://uat.pawspace.in${path}`),{DB:db});assert.ok(denied instanceof Response);assert.ok([401,403].includes(denied.status));
 }
 const before=sqlite.prepare('SELECT COUNT(*) n FROM order_notifications').get().n;
 const ownResponse=await notifications.GET(new Request('https://uat.pawspace.in/api/order-notifications?customerId=A',{headers:{cookie:own}}));assert.equal(ownResponse.status,200);assert.deepEqual((await ownResponse.json()).data.items,[]);
 const foreign=await notifications.GET(new Request('https://uat.pawspace.in/api/order-notifications?customerId=A',{headers:{cookie:other}}));assert.equal(foreign.status,403);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM order_notifications').get().n,before);
 const bill=await billing.GET(new Request('https://uat.pawspace.in/api/customer-billing?customerId=B',{headers:{cookie:own}}));assert.equal(bill.status,200);assert.equal((await bill.json()).data.paymentsAvailable,false);
 sqlite.exec("CREATE TABLE canonical_bookings(id TEXT,customer_id TEXT,package_name TEXT,service_code TEXT); CREATE TABLE booking_payments(id TEXT,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,status TEXT,gateway TEXT,created_at INTEGER); INSERT INTO canonical_bookings VALUES('BA','A','Own package','grooming'),('BB','B','Private package','grooming'); INSERT INTO booking_payments VALUES('PA','BA','A',100,0,'INR','card','captured','sandbox',1),('PB','BB','B',900,0,'INR','card','captured','sandbox',1)");
 const scoped=await billing.GET(new Request('https://uat.pawspace.in/api/customer-billing?customerId=B',{headers:{cookie:own}}));assert.equal(scoped.status,200);assert.deepEqual((await scoped.json()).data.payments.map(p=>p.id),['PA']);
 sqlite.exec("INSERT INTO order_notifications(id,idempotency_key,customer_id,service_code,event_type,severity,title,body,source_type,source_id,created_at) VALUES('N','N','A','grooming','confirmed','info','Own update','Body','booking','BA',1)");
 const payload={customerId:'A',notificationId:'N',action:'mark_read'};
 const write=token=>new Request('https://uat.pawspace.in/api/order-notifications',{method:'POST',headers:{cookie:token,'content-type':'application/json'},body:JSON.stringify(payload)});
 assert.equal((await notifications.POST(write(other))).status,403);assert.equal(sqlite.prepare("SELECT status FROM order_notifications WHERE id='N'").get().status,'unread');
 assert.equal((await notifications.POST(write(own))).status,200);assert.equal(sqlite.prepare("SELECT status FROM order_notifications WHERE id='N'").get().status,'read');

});
