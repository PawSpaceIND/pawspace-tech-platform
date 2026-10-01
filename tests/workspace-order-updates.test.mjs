import test from 'node:test';import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';installWorkersHooks('__WORKSPACE_ORDER_UPDATES__');
const {workspaceOrderUpdate,uniqueWorkspaceUpdates}=await import('../lib/workspace-order-updates.ts');
test('notification gateway maps only exact GET and POST to booking visibility',async()=>{
 const {requiredPermission}=await import('../lib/api-gateway.ts');
 for(const method of ['GET','POST'])assert.equal(await requiredPermission(new Request('https://pawspace.test/api/workspace-order-updates',{method})),'bookings.view');
 for(const method of ['PUT','DELETE'])assert.equal(await requiredPermission(new Request('https://pawspace.test/api/workspace-order-updates',{method})),'dashboard.view');
 assert.equal(await requiredPermission(new Request('https://pawspace.test/api/workspace-order-updates-extra')),'dashboard.view');
});
test('pending is not confirmation or payment capture; confirmation is not payment capture',()=>{for(const status of ['payment_pending','awaiting_payment','pending_payment']){const row=workspaceOrderUpdate({id:'A',status,service_code:'grooming',updated_at:5});assert.match(row.title,/payment pending/);assert.doesNotMatch(row.title,/confirmed|paid|captured/);}const confirmed=workspaceOrderUpdate({id:'A',status:'confirmed',service_code:'grooming',updated_at:6});assert.equal(confirmed.title,'Booking confirmed');assert.doesNotMatch(confirmed.title,/paid|captured/);});
test('replayed snapshots deduplicate while pending-to-confirmed is a distinct update',()=>{const a=workspaceOrderUpdate({id:'A',status:'payment_pending',service_code:'grooming',updated_at:5}),b=workspaceOrderUpdate({id:'A',status:'confirmed',service_code:'grooming',updated_at:6});assert.deepEqual(uniqueWorkspaceUpdates([a,b,a,b]),[b,a]);});
test('food record is distinct and cannot claim a confirmed booking',()=>{const food=workspaceOrderUpdate({id:'A',status:'uat_reserved',updated_at:8},'food');assert.match(food.title,/Food order recorded/);assert.equal(food.kind,'food');assert.doesNotMatch(food.title,/confirmed|paid|captured/);});

import {DatabaseSync} from 'node:sqlite';
const {readStaffWorkspaceOrderUpdates,ensureWorkspaceOrderTables}=await import('../lib/workspace-order-updates.ts');
function fixture(){const sqlite=new DatabaseSync(':memory:');sqlite.exec("CREATE TABLE canonical_bookings(id TEXT,service_code TEXT,status TEXT,updated_at INTEGER,created_at INTEGER,city_id TEXT);CREATE TABLE food_orders(id TEXT,status TEXT,updated_at INTEGER,created_at INTEGER,city_id TEXT);CREATE TABLE workspace_order_reads(recipient_key TEXT,event_id TEXT,read_at INTEGER,PRIMARY KEY(recipient_key,event_id));");const stmt=(sql,args=[])=>({bind:(...next)=>stmt(sql,next),run:async()=>sqlite.prepare(sql).run(...args),all:async()=>({results:sqlite.prepare(sql).all(...args)}),first:async()=>sqlite.prepare(sql).get(...args)});return{sqlite,db:{prepare:sql=>stmt(sql)}};}
test('actual read query scopes city and actor-specific unread; replay does not duplicate a read',async()=>{
 const w=fixture();w.sqlite.exec("INSERT INTO canonical_bookings VALUES('A','grooming','payment_pending',2,1,'blr'),('H','grooming','confirmed',3,1,'hyd');INSERT INTO food_orders VALUES('F','uat_reserved',4,1,'blr');");
 let feed=await readStaffWorkspaceOrderUpdates(w.db,'blr','actor-one');assert.equal(feed.unread,2);assert.deepEqual(feed.items.map(i=>i.recordId),['F','A']);
 w.sqlite.exec("INSERT OR IGNORE INTO workspace_order_reads VALUES('actor-one','booking:A:payment_pending',8);INSERT OR IGNORE INTO workspace_order_reads VALUES('actor-one','booking:A:payment_pending',9);");
 feed=await readStaffWorkspaceOrderUpdates(w.db,'blr','actor-one');assert.equal(feed.unread,1);assert.equal(feed.items.find(i=>i.recordId==='A').readAt,8);assert.equal((await readStaffWorkspaceOrderUpdates(w.db,'blr','actor-two')).unread,2);
 w.sqlite.exec("UPDATE canonical_bookings SET status='confirmed',updated_at=10 WHERE id='A'");assert.equal((await readStaffWorkspaceOrderUpdates(w.db,'blr','actor-one')).unread,2);
 w.sqlite.exec("UPDATE canonical_bookings SET city_id='hyd' WHERE id='A'");feed=await readStaffWorkspaceOrderUpdates(w.db,'blr','actor-one');assert.equal(feed.unread,1);assert.ok(!feed.items.some(i=>i.recordId==='A'));
});
test('pagination retains more than one hundred unread records without treating missing Food source as zero',async()=>{
 const w=fixture();for(let n=0;n<105;n++)w.sqlite.prepare("INSERT INTO canonical_bookings VALUES(?,'grooming','confirmed',?,1,'blr')").run('B'+String(n).padStart(3,'0'),n+1);
 w.sqlite.exec('DROP TABLE food_orders');const first=await readStaffWorkspaceOrderUpdates(w.db,'blr','owner');assert.equal(first.items.length,100);assert.equal(first.unread,105);assert.equal(first.sourceStatus.food,'unavailable');const last=await readStaffWorkspaceOrderUpdates(w.db,'blr','owner',first.nextCursor);assert.equal(last.items.length,5);assert.equal(new Set([...first.items,...last.items].map(i=>i.id)).size,105);
});

test('cold acknowledgement schema is created before reads and initialization preserves existing read records',async()=>{
 const w=fixture();try{
  w.sqlite.exec('DROP TABLE workspace_order_reads');
  assert.equal((await readStaffWorkspaceOrderUpdates(w.db,null,'cold-owner')).unread,0);
  w.sqlite.exec("INSERT INTO workspace_order_reads VALUES('cold-owner','booking:A:confirmed',42)");
  await ensureWorkspaceOrderTables(w.db);
  assert.equal(w.sqlite.prepare('SELECT read_at FROM workspace_order_reads').get().read_at,42);
 }finally{w.sqlite.close();}
});
