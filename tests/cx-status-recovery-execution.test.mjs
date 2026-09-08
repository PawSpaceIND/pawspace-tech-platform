import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl} from './helpers/ai-harness.mjs';
installAiHooks();
const conversation=await import('../lib/conversation-governance.ts');
const route=await import('../app/api/conversations/route.ts');
async function world(){
 const {sqlite,db}=freshAiDb();
 db.batch=async items=>{sqlite.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}};
 const {ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 sqlite.exec("INSERT INTO app_users(id,email,name,role_code,status,created_at,updated_at) VALUES ('CX-STAFF','cx@pawspace.in','CX','founder','active',1,1)");
 seedCustomer(sqlite,'CUS-CX','CX customer','9876500991');
 await inboundMessage(sqlite,db,{threadId:'THREAD-CX',customerId:'CUS-CX',text:'Help with booking',idempotencyKey:'cx-message'});
 await conversation.ensureConversationGovernance(db);
 const request=(method,body,path='')=>new Request(`https://app.pawspace.in/api/conversations${path}`,{method,headers:{'oai-authenticated-user-email':'cx@pawspace.in',origin:'https://app.pawspace.in','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const change=status=>route.POST(request('POST',{action:'status',threadId:'THREAD-CX',status,reason:'CX status test'}));
 const list=async status=>{const response=await route.GET(request('GET',null,`?status=${status}`));assert.equal(response.status,200);return (await response.json()).data.threads;};
 return {sqlite,db,change,list};
}
test('CX await-customer and reopen flow remains discoverable through the status filters',async()=>{
 const w=await world();assert.equal((await w.list('open')).length,1);
 assert.equal((await w.change('pending_customer')).status,200);
 assert.equal((await w.list('open')).length,0);assert.equal((await w.list('pending_customer'))[0].id,'THREAD-CX');
 assert.equal((await w.change('resolved')).status,200);assert.equal((await w.list('resolved')).length,1);
 assert.equal((await w.change('open')).status,200);assert.equal((await w.list('open')).length,1);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM conversation_audit_events').get().n,3);
});
test('invalid and missing conversation status changes create no success audit',async()=>{
 const w=await world();assert.equal((await w.change('invented_status')).status,400);
 await assert.rejects(()=>conversation.setConversationStatus(w.db,{threadId:'MISSING',status:'closed',actorEmail:'cx@pawspace.in'}),error=>error instanceof Response&&error.status===404);
 assert.equal(w.sqlite.prepare('SELECT status FROM communication_threads').get().status,'open');
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM conversation_audit_events').get().n,0);
});
test('status audit failure rolls back the thread change and permits retry',async()=>{
 const w=await world();
 w.sqlite.exec("CREATE TRIGGER fail_status_audit BEFORE INSERT ON conversation_audit_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 assert.equal((await w.change('resolved')).status,500);
 assert.equal(w.sqlite.prepare('SELECT status FROM communication_threads').get().status,'open');
 w.sqlite.exec('DROP TRIGGER fail_status_audit');assert.equal((await w.change('resolved')).status,200);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM conversation_audit_events').get().n,1);
});

test('CX detail and queue attach canonical customer, booking and unified-case context without cross-customer links',async()=>{
 const w=await world();
 applyOwnedDdl(w.sqlite,'lib/unified-case-center.ts');
 w.sqlite.exec("INSERT INTO canonical_bookings(id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount) VALUES ('BOOK-CX','CUS-CX','grooming','Basic grooming','completed','2026-09-08T10:00:00Z','2026-09-08T11:00:00Z',0)");
 w.sqlite.exec("INSERT INTO unified_cases(id,idempotency_key,case_type,severity,title,description,customer_id,booking_id,source_type,source_id,owner_team,created_by,updated_by,created_at,updated_at,first_response_due_at) VALUES ('CASE-CX','cx-key','customer_complaint','high','Delayed','Needs follow-up','CUS-CX','BOOK-CX','test','test','cx','qa','qa',1,1,1000)");
 w.sqlite.exec("UPDATE communication_threads SET booking_id='BOOK-CX',ticket_id='CASE-CX'");
 const get=async()=>{const response=await route.GET(new Request('https://app.pawspace.in/api/conversations?threadId=THREAD-CX',{headers:{'oai-authenticated-user-email':'cx@pawspace.in'}}));assert.equal(response.status,200);return (await response.json()).data.thread;};
 const detail=await get();assert.ok(detail.customer_name);assert.notEqual(detail.customer_name,'CUS-CX');assert.equal(detail.booking.package_name,'Basic grooming');assert.equal(detail.ticket.subject,'Delayed');assert.equal(detail.ticket.sla_due_at,1000);
 assert.equal((await w.list('open'))[0].ticket.source_kind,'unified_case');
 const customerView=await conversation.getConversation(w.db,'THREAD-CX','customer');assert.equal(customerView.thread.primary_phone,undefined);assert.equal(customerView.thread.ticket,undefined);
 w.sqlite.exec("UPDATE canonical_bookings SET customer_id='OTHER'; UPDATE unified_cases SET customer_id='OTHER'");
 const refused=await get();assert.equal(refused.booking,null);assert.equal(refused.ticket,null);assert.equal((await w.list('open'))[0].ticket,null);
});
