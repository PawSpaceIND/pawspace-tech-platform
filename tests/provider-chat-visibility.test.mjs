import test from 'node:test';
import assert from 'node:assert/strict';
import { installAiHooks, freshAiDb, seedCustomer } from './helpers/ai-harness.mjs';
installAiHooks();
const { ensureCommunicationTables } = await import('../lib/communication-engine.ts');
const { upsertIdentityBinding } = await import('../lib/identity-binding.ts');
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import('../lib/platform-session.ts');
const { GET } = await import('../app/api/provider-chat/route.ts');

test('assigned provider reads booking chat without staff notes or direct contact fields', async t => {
  const { sqlite, db } = freshAiDb({ PAWSPACE_DEPLOYMENT_ENV: 'e2e' });
  t.after(()=>sqlite.close());
  seedCustomer(sqlite,'CUS-CHAT','Test Customer','9876500001');
  await ensureCommunicationTables(db);
  const now=Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,provider_id) VALUES ('BK-CHAT','CUS-CHAT','grooming','Test','confirmed','2026-09-10','2026-09-10',1000,'PRV-CHAT')").run();
  sqlite.exec("CREATE TABLE provider_work_orders (booking_id TEXT,provider_id TEXT)");
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('BK-CHAT','PRV-CHAT')").run();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,status,created_at,updated_at) VALUES ('TH-CHAT','CUS-CHAT','BK-CHAT','open',?,?)").run(now,now);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-CHAT','TH-CHAT','CUS-CHAT','inbound','chat','transactional','test',?,'received','chat-note-test','{}','staff',?,?)").run(JSON.stringify({text:'Please arrive at 10',internalNote:'Staff-only complaint investigation',customerPhone:'9876500001',providerPhone:'9876500002',providerIdentity:'private-provider-contact'}),now,now);
  async function cookie(id){
    const identitySource='provider_otp',principalType='identity_subject',principalKey=`provider:${id}`,subjectType='provider';
    const binding=await upsertIdentityBinding(db,{identitySource,principalType,principalKey,subjectType,subjectId:id,verificationState:'verified',actorId:'test',reason:'Provider chat regression'});
    const session=await issuePlatformSession(db,{bindingId:String(binding.id),identitySource,principalType,principalKey,subjectType,subjectId:id});
    return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  }
  const request=token=>new Request('https://pawspace.test/api/provider-chat?providerId=PRV-CHAT&threadId=TH-CHAT',{headers:{cookie:token}});
  const response=await GET(request(await cookie('PRV-CHAT'))),body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(body.data.bookingId,'BK-CHAT');
  assert.equal(body.data.messages[0].payload.text,'Please arrive at 10');
  assert.equal(body.data.messages[0].payload.internalNote,undefined,'provider must not receive the staff-only note');
  for(const key of ['customerPhone','providerPhone','providerIdentity'])assert.equal(body.data.messages[0].payload[key],undefined);
  assert.equal((await GET(request(await cookie('PRV-OTHER')))).status,403);
});
