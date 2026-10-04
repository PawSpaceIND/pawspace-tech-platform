import test from 'node:test';
import assert from 'node:assert/strict';
import{freshWorld}from './helpers/training-lifecycle-harness.mjs';
import{ensureTrainingBroadcastTables,claimTrainingBroadcastOffer}from '../lib/training-broadcast-claim.ts';
async function world(){const w=freshWorld();await ensureTrainingBroadcastTables(w.db);w.sqlite.exec("CREATE TABLE owner_test(booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL)");w.sqlite.prepare("INSERT INTO owner_test VALUES('B','provisional')").run();return w;}
function offer(w,id,expiresAt=Date.now()+60_000){w.sqlite.prepare("INSERT INTO training_broadcast_offers(booking_id,provider_id,session_id,status,offered_at,expires_at) VALUES('B',?,'S','pending',?,?)").run(id,Date.now(),expiresAt);}
function claim(w,providerId,key,extra={}){return claimTrainingBroadcastOffer(w.db,{bookingId:'B',providerId,sessionId:'S',idempotencyKey:key,effectStatements:(guard,binds)=>[w.db.prepare(`UPDATE owner_test SET provider_id=? WHERE booking_id='B' AND ${guard}`).bind(providerId,...binds)],effectPredicate:()=>({sql:"EXISTS(SELECT 1 FROM owner_test WHERE booking_id='B' AND provider_id=?)",binds:[providerId]}),...extra});}
test('first valid contractor wins with one owner; loser closes and replay is stable',async()=>{
 const w=await world();offer(w,'ct1');offer(w,'ct2');
 const results=await Promise.allSettled([claim(w,'ct1','k1'),claim(w,'ct2','k2')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=w.sqlite.prepare("SELECT provider_id,idempotency_key FROM training_broadcast_claims WHERE booking_id='B'").get();
 assert.equal(w.sqlite.prepare("SELECT provider_id FROM owner_test WHERE booking_id='B'").get().provider_id,winner.provider_id);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE booking_id='B' AND status='accepted'").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_offers WHERE booking_id='B' AND status='withdrawn'").get().n,1);
 assert.equal((await claim(w,winner.provider_id,winner.idempotency_key)).duplicatePrevented,true);
 await assert.rejects(claimTrainingBroadcastOffer(w.db,{bookingId:'B',providerId:winner.provider_id,sessionId:'OTHER',idempotencyKey:winner.idempotency_key,effectStatements:()=>[],effectPredicate:()=>({sql:'1',binds:[]})}),e=>e instanceof Response&&e.status===409);
 await assert.rejects(claim(w,winner.provider_id,'new-key'),e=>e instanceof Response&&e.status===409);
});
test('expired or absent offer cannot claim or change owner',async()=>{
 const w=await world();offer(w,'expired',Date.now()-1);
 await assert.rejects(claim(w,'expired','late'),e=>e instanceof Response&&e.status===409);
 await assert.rejects(claim(w,'absent','none'),e=>e instanceof Response&&e.status===409);
 assert.equal(w.sqlite.prepare("SELECT provider_id FROM owner_test WHERE booking_id='B'").get().provider_id,'provisional');
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_claims").get().n,0);
});
test('failed canonical effect rolls back winner claim and offers',async()=>{
 const w=await world();offer(w,'ct1');
 await assert.rejects(claimTrainingBroadcastOffer(w.db,{bookingId:'B',providerId:'ct1',sessionId:'S',idempotencyKey:'failed',effectStatements:()=>[w.db.prepare("INSERT INTO owner_test VALUES('B','duplicate')")],effectPredicate:()=>({sql:"EXISTS(SELECT 1 FROM owner_test WHERE booking_id='B' AND provider_id='ct1')",binds:[]})}));
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_claims").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT status FROM training_broadcast_offers WHERE booking_id='B'").get().status,'pending');
 assert.equal((await claim(w,'ct1','retry')).providerId,'ct1');
});
test('zero-row canonical ownership move fails final assertion and rolls claim back',async()=>{
 const w=await world();offer(w,'ct1');
 await assert.rejects(claimTrainingBroadcastOffer(w.db,{bookingId:'B',providerId:'ct1',sessionId:'S',idempotencyKey:'no-effect',effectStatements:()=>[w.db.prepare("UPDATE owner_test SET provider_id='ct1' WHERE booking_id='missing'")],effectPredicate:()=>({sql:"EXISTS(SELECT 1 FROM owner_test WHERE booking_id='B' AND provider_id='ct1')",binds:[]})}));
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_broadcast_claims").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT status FROM training_broadcast_offers WHERE booking_id='B'").get().status,'pending');
});
test('claim statements can be composed into a caller-owned transaction',async()=>{
 const w=await world();offer(w,'ct1');let commits=0;
 const result=await claimTrainingBroadcastOffer(w.db,{bookingId:'B',providerId:'ct1',sessionId:'S',idempotencyKey:'compose',effectStatements:(guard,binds)=>[w.db.prepare(`UPDATE owner_test SET provider_id='ct1' WHERE booking_id='B' AND ${guard}`).bind(...binds)],effectPredicate:()=>({sql:"EXISTS(SELECT 1 FROM owner_test WHERE booking_id='B' AND provider_id='ct1')",binds:[]}),commitStatements:async statements=>{commits++;return w.db.batch(statements);}});
 assert.equal(commits,1);assert.equal(result.duplicatePrevented,false);
 assert.equal(w.sqlite.prepare("SELECT provider_id FROM owner_test WHERE booking_id='B'").get().provider_id,'ct1');
});
