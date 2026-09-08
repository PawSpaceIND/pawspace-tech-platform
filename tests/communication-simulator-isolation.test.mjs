import test from 'node:test';
import assert from 'node:assert/strict';
import {d1} from './helpers/execution-harness.mjs';
import {setupJourney} from './helpers/grooming-journey-harness.mjs';
const route=await import('../app/api/communications/route.ts');
const engine=await import('../lib/communication-engine.ts');
const origin='https://uat.pawspace.in';
async function call(body){return route.POST(new Request(`${origin}/api/communications`,{method:'POST',headers:{origin,'content-type':'application/json','oai-authenticated-user-email':'closure-admin@pawspace.test'},body:JSON.stringify(body)}));}
async function world(t){const ctx=await setupJourney();ctx.db.batch=d1(ctx.sqlite).batch;t.after(ctx.close);globalThis.__GROOM_GOLDEN_ENV__.FORBID_PRODUCTION='true';await engine.seedCommunicationPolicy(ctx.db);const message=await engine.enqueueCommunication(ctx.db,{customerId:'C-SIM',cityId:'blr',channel:'chat',purpose:'transactional',bookingId:'BK-SIM',idempotencyKey:'SIM-ISOLATION',templateKey:'transactional',payload:{},createdBy:'fixture'});return{...ctx,messageId:message.messageId};}

test('staff simulation cannot forge a real provider delivery receipt',async t=>{
 const ctx=await world(t);
 const res=await call({action:'delivery_event',messageId:ctx.messageId,provider:'limechat',eventId:'forged',eventType:'delivered'});
 assert.equal(res.status,403,await res.clone().text());
 const audit=ctx.sqlite.prepare("SELECT actor_email,outcome FROM security_audit_events WHERE action='communication.delivery_event'").get();
 assert.equal(audit.actor_email,'closure-admin@pawspace.test');assert.equal(audit.outcome,'denied');
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) count FROM communication_message_delivery_events').get().count,0);
 assert.equal(ctx.sqlite.prepare('SELECT status FROM communication_messages WHERE id=?').get(ctx.messageId).status,'queued');
});

test('simulation requires all sandbox locks and cannot overwrite a provider-bound message',async t=>{
 const ctx=await world(t);
 for(const change of [{PAWSPACE_PAYMENT_ENV:'live'},{PAWSPACE_PAYMENT_ENV:undefined},{PAWSPACE_PAYMENT_LIVE_APPROVED:'true'},{FORBID_PRODUCTION:'false'}]){
  const saved={...globalThis.__GROOM_GOLDEN_ENV__};Object.assign(globalThis.__GROOM_GOLDEN_ENV__,change);
  const res=await call({action:'dispatch_sandbox',messageId:ctx.messageId});assert.equal(res.status,403,await res.clone().text());
  globalThis.__GROOM_GOLDEN_ENV__=saved;
 }
 ctx.sqlite.prepare("UPDATE communication_messages SET provider='limechat',provider_reference='real-reference' WHERE id=?").run(ctx.messageId);
 for(const action of ['dispatch_sandbox','delivery_event']){
  const res=await call({action,messageId:ctx.messageId,provider:'sandbox_simulator',eventId:'forged-sim',eventType:'delivered'});
  assert.equal(res.status,409,await res.clone().text());
 }
 assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) count FROM communication_message_delivery_events').get().count,0);
});

test('explicit sandbox simulation stays labelled synthetic and its callback replay is idempotent',async t=>{
 const ctx=await world(t);
 const sent=await call({action:'dispatch_sandbox',messageId:ctx.messageId});assert.equal(sent.status,200,await sent.clone().text());
 const input={action:'delivery_event',messageId:ctx.messageId,eventId:'sim-delivered',eventType:'delivered',detail:{externalDelivery:true}};
 const res=await call(input);assert.equal(res.status,200,await res.clone().text());
 const duplicate=await (await call(input)).json();assert.equal(duplicate.data.duplicatePrevented,true);
 const row=ctx.sqlite.prepare("SELECT provider,detail_json FROM communication_message_delivery_events WHERE event_id='sim-delivered'").get();
 assert.equal(row.provider,'sandbox_simulator');assert.equal(JSON.parse(row.detail_json).externalDelivery,false);
});

test('concurrent simulator dispatch claims once and failed simulations never escape to an external dispatcher',async t=>{
 const ctx=await world(t);
 const replies=await Promise.all([call({action:'dispatch_sandbox',messageId:ctx.messageId}),call({action:'dispatch_sandbox',messageId:ctx.messageId})]);
 for(const reply of replies)assert.equal(reply.status,200,await reply.clone().text());
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_message_delivery_events WHERE event_type='accepted'").get().count,1);
 const failed=await call({action:'delivery_event',messageId:ctx.messageId,eventId:'sim-failed',eventType:'failed'});
 assert.equal(failed.status,200,await failed.clone().text());
 ctx.sqlite.prepare('UPDATE communication_outbox SET next_attempt_at=0 WHERE message_id=?').run(ctx.messageId);
 const generic=await import('../lib/communication-provider-boundary.ts');
 assert.equal((await generic.dispatchExternalCommunication(ctx.db,{}, {messageId:ctx.messageId,adapterName:'limechat',recipient:'+919999900001'})).status,'simulation_only');
 const dispatch=await import('../lib/communication-outbox-dispatcher.ts');
 assert.equal((await dispatch.runCommunicationOutboxDispatcher(ctx.db,{})).processed,0);
 ctx.sqlite.prepare("UPDATE communication_messages SET channel='whatsapp' WHERE id=?").run(ctx.messageId);
 const interakt=await import('../lib/interakt-whatsapp.ts'),meta=await import('../lib/meta-whatsapp-uat-dispatch.ts');
 assert.equal((await interakt.dispatchInteraktWhatsApp(ctx.db,{}, {messageId:ctx.messageId})).status,'simulation_only');
 assert.equal((await meta.dispatchMetaWhatsAppUat(ctx.db,{}, {messageId:ctx.messageId,recipient:'+919999900001'})).status,'simulation_only');
 const whatsapp=await import('../lib/whatsapp-production-runtime.ts');
 const sweep=await whatsapp.runWhatsAppOutboxDispatcher(ctx.db,{});
 assert.equal(sweep.dispatched,0);assert.equal(sweep.results.length,0);
});
