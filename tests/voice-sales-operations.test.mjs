import test from 'node:test';
import assert from 'node:assert/strict';
import {freshSqlite,makeD1} from './helpers/voice-harness.mjs';
import {voiceSalesOperations} from '../lib/voice-sales-operations.ts';

test('missing sources are unknown and never certify a launch',async()=>{
 const sqlite=freshSqlite();try{const result=await voiceSalesOperations(makeD1(sqlite));assert.equal(result.pendingWebhooks,null);assert.equal(result.pendingCrmWrites,null);assert.equal(result.offers,null);assert.equal(result.productionCertified,false);assert.ok(result.sources.every(s=>!s.available));}finally{sqlite.close();}
});
test('journey reads canonical payment and provider records, not AI claims',async()=>{
 const sqlite=freshSqlite();try{
 sqlite.exec(`CREATE TABLE voice_sales_offers(id TEXT,service_code TEXT,status TEXT,created_at INTEGER,completed_at INTEGER,result_json TEXT,customer_id TEXT);
 CREATE TABLE canonical_bookings(id TEXT,status TEXT,provider_id TEXT,customer_id TEXT);
 CREATE TABLE booking_payments(booking_id TEXT,customer_id TEXT,status TEXT);
 CREATE TABLE communication_messages(id TEXT,status TEXT,customer_id TEXT,booking_id TEXT);
 INSERT INTO voice_sales_offers VALUES('offer','grooming','completed',1,2,'{"bookingId":"b","orderId":"order","paymentMessageId":"m","paymentVerified":true}','c');
 INSERT INTO canonical_bookings VALUES('b','payment_pending','provider','c');
 INSERT INTO booking_payments VALUES('b','c','created');
 INSERT INTO communication_messages VALUES('m','queued','c','b');`);
 const result=await voiceSalesOperations(makeD1(sqlite));assert.equal(result.offers[0].payment_status,'created');assert.equal(result.offers[0].payment_link_status,'queued');assert.equal(result.offers[0].provider_id,'provider');assert.equal(result.productionCertified,false);
 sqlite.exec("UPDATE canonical_bookings SET customer_id='another'");
 const mismatch=await voiceSalesOperations(makeD1(sqlite));assert.equal(mismatch.offers[0].booking_id,null);assert.equal(mismatch.offers[0].payment_status,null);assert.equal(mismatch.offers[0].payment_link_status,null);
 }finally{sqlite.close();}
});
