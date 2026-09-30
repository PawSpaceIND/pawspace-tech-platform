import test from 'node:test';
import assert from 'node:assert/strict';
import {freshSqlite,makeD1} from './helpers/voice-harness.mjs';
import {voiceSalesOperations} from '../lib/voice-sales-operations.ts';

test('missing sources are unknown and never certify a launch',async()=>{
 const sqlite=freshSqlite();try{const result=await voiceSalesOperations(makeD1(sqlite));assert.equal(result.pendingWebhooks,null);assert.equal(result.pendingCrmWrites,null);assert.equal(result.offers,null);assert.equal(result.funnel,null);assert.equal(result.productionCertified,false);assert.ok(result.sources.every(s=>!s.available));}finally{sqlite.close();}
});
test('journey reads canonical payment and provider records, not AI claims',async()=>{
 const sqlite=freshSqlite();try{
 sqlite.exec(`CREATE TABLE voice_sales_offers(id TEXT,service_code TEXT,status TEXT,created_at INTEGER,completed_at INTEGER,result_json TEXT,customer_id TEXT,thread_id TEXT,turn_key TEXT);
 CREATE TABLE ai_turn_reservations(idempotency_key TEXT,thread_id TEXT,customer_id TEXT,channel TEXT);
 CREATE TABLE canonical_bookings(id TEXT,status TEXT,provider_id TEXT,customer_id TEXT);
 CREATE TABLE booking_payments(booking_id TEXT,customer_id TEXT,status TEXT);
 CREATE TABLE communication_messages(id TEXT,status TEXT,customer_id TEXT,booking_id TEXT);
 INSERT INTO voice_sales_offers VALUES('offer','grooming','completed',${Date.now()},2,'{"bookingId":"b","orderId":"order","paymentMessageId":"m","paymentVerified":true}','c','shared-thread','voice-turn');
 INSERT INTO voice_sales_offers VALUES('chat-offer','grooming','pending',${Date.now()},NULL,'{}','c','shared-thread','chat-turn');
 INSERT INTO ai_turn_reservations VALUES('voice-turn','shared-thread','c','voice');
 INSERT INTO ai_turn_reservations VALUES('chat-turn','shared-thread','c','chat');
 INSERT INTO canonical_bookings VALUES('b','payment_pending','provider','c');
 INSERT INTO booking_payments VALUES('b','c','created');
 INSERT INTO communication_messages VALUES('m','queued','c','b');`);
 const result=await voiceSalesOperations(makeD1(sqlite));assert.equal(result.offers.length,1);assert.equal(result.offers[0].payment_status,'created');assert.equal(result.offers[0].payment_link_status,'queued');assert.equal(result.offers[0].provider_id,'provider');assert.deepEqual(result.funnel,{offered:1,booked:1,linkQueued:1,linkDelivered:0,paid:0,providerAssigned:1});assert.equal(result.productionCertified,false);
 sqlite.exec("UPDATE canonical_bookings SET customer_id='another'");
 const mismatch=await voiceSalesOperations(makeD1(sqlite));assert.equal(mismatch.offers[0].booking_id,null);assert.equal(mismatch.offers[0].payment_status,null);assert.equal(mismatch.offers[0].payment_link_status,null);assert.equal(mismatch.funnel.booked,0);assert.equal(mismatch.funnel.paid,0);
 sqlite.exec("UPDATE canonical_bookings SET customer_id='c'; UPDATE booking_payments SET status='captured'; UPDATE communication_messages SET status='delivered'");
 const delivered=await voiceSalesOperations(makeD1(sqlite));assert.equal(delivered.funnel.paid,1);assert.equal(delivered.funnel.linkDelivered,1);
 }finally{sqlite.close();}
});
test('processing percentiles exclude missing measurements and never become audio certification',async()=>{
 const sqlite=freshSqlite();try{
 sqlite.exec('CREATE TABLE ai_conversation_turns(latency_ms INTEGER,outcome TEXT,cost_minor INTEGER,channel TEXT,created_at INTEGER)');
 const insert=sqlite.prepare('INSERT INTO ai_conversation_turns VALUES(?,?,?,?,?)');
 for(const latency of [0,null,500,1500,3000])insert.run(latency,'replied',null,'voice',Date.now());
 insert.run(100,'handoff',1,'voice',Date.now());insert.run(99999,'replied',1,'chat',Date.now());
 const {quality,productionCertified}=await voiceSalesOperations(makeD1(sqlite));
 assert.equal(quality.sampledTurns,6);assert.equal(quality.measuredTurns,4);assert.equal(quality.processingP50Ms,500);assert.equal(quality.processingP95Ms,3000);assert.equal(quality.handoffs,1);assert.equal(quality.turnsWithCost,1);assert.equal(productionCertified,false);
 }finally{sqlite.close();}
});
