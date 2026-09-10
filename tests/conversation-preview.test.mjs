import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage} from './helpers/ai-harness.mjs';
installAiHooks();process.env.PAWSPACE_LOCAL_PREVIEW='off';
const {ensureSecurityTables}=await import('../lib/server-auth.ts');
const {ensureCustomer360Tables}=await import('../lib/customer-360.ts');
const {ensureWhatsAppUatTables}=await import('../lib/whatsapp-uat-adapter.ts');
const crm=await import('../app/api/crm/chat/route.ts');
const cx=await import('../app/api/conversations/route.ts');
async function world(t){
 const {sqlite,db}=freshAiDb();t.after(()=>sqlite.close());
 await ensureSecurityTables(db);await ensureCustomer360Tables(db);await ensureWhatsAppUatTables(db);
 const now=Date.now();sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('preview-staff','preview-staff@pawspace.test','Staff','admin','active',?,?)").run(now,now);
 seedCustomer(sqlite,'CUS-PREVIEW','Preview Customer','9876500044');
 await inboundMessage(sqlite,db,{threadId:'THREAD-PREVIEW',customerId:'CUS-PREVIEW',text:'Please arrange grooming tomorrow',channel:'whatsapp',idempotencyKey:'preview-one'});
 return sqlite;
}
const request=path=>new Request('https://app.pawspace.in'+path,{headers:{'oai-authenticated-user-email':'preview-staff@pawspace.test'}});
for(const [name,route,path] of [['CRM',crm,'/api/crm/chat'],['CX',cx,'/api/conversations']]){
 test(`${name} conversation list includes bounded message text without copying private payload fields`,async t=>{
  const sqlite=await world(t);
  sqlite.prepare("UPDATE communication_messages SET payload_json=? WHERE thread_id='THREAD-PREVIEW'").run(JSON.stringify({text:'Please arrange grooming tomorrow',internalNote:'Private complaint',customerPhone:'9876500044',attachmentToken:'private-token'}));
  const response=await route.GET(request(path));assert.equal(response.status,200);
  const row=(await response.json()).data.threads[0];
  assert.equal(row.lastMessage.text,'Please arrange grooming tomorrow');
  const preview=JSON.stringify(row.lastMessage);
  for(const secret of ['Private complaint','9876500044','private-token','payload_json'])assert.ok(!preview.includes(secret));
  sqlite.prepare("UPDATE communication_messages SET payload_json=? WHERE thread_id='THREAD-PREVIEW'").run(JSON.stringify({text:'x'.repeat(4000)}));
  const long=(await(await route.GET(request(path))).json()).data.threads[0];assert.equal(long.lastMessage.text.length,240);
  for(const value of ['{invalid','null',JSON.stringify({text:{secret:'must not serialize'}})]){
   sqlite.prepare("UPDATE communication_messages SET payload_json=? WHERE thread_id='THREAD-PREVIEW'").run(value);
   const bad=await route.GET(request(path));assert.equal(bad.status,200);
   const message=(await bad.json()).data.threads[0].lastMessage;assert.equal(message.text,'');assert.ok(message.id);
  }
 });
}
