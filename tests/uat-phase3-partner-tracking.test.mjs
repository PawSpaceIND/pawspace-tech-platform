import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__PHASE3_DB__");
const {BEFORE_SERVICE,AFTER_SERVICE,checklistComplete,isGroomerOnDuty}=await import("../lib/partner-job-checklists.ts");
const {enqueueStatus,readStatusQueue,deliverStatus,statusAlreadyApplied}=await import("../lib/partner-status-queue.ts");
const {recordPartnerHeartbeat,sweepPartnerHeartbeats,heartbeatIsStale}=await import("../lib/partner-job-heartbeat.ts");
const item={id:"event-1",bookingId:"job-1",providerId:"provider-1",action:"start_service",checklist:BEFORE_SERVICE.map(x=>x.id),createdAt:Date.now()};
test("checklists require every explicit safety acknowledgement",()=>{
 for(const [stage,items] of [["before",BEFORE_SERVICE],["after",AFTER_SERVICE]]){
  const ids=items.map(x=>x.id);assert.equal(checklistComplete(stage,ids),true);
  for(const missing of ids)assert.equal(checklistComplete(stage,ids.filter(x=>x!==missing)),false);
  for(const malformed of [null,{},"yes",[true],["Service checklist completed"]])assert.equal(checklistComplete(stage,malformed),false);
 }
 assert.equal(isGroomerOnDuty({status:"in_service"}),true);assert.equal(isGroomerOnDuty({status:"completed"}),false);assert.equal(isGroomerOnDuty({status:"confirmed"}),false);
});
test("queued status survives reloading storage and stays provider scoped",t=>{
 const disk=new Map();const previous=Object.getOwnPropertyDescriptor(globalThis,"localStorage");t.after(()=>{if(previous)Object.defineProperty(globalThis,"localStorage",previous);else delete globalThis.localStorage;});Object.defineProperty(globalThis,"localStorage",{configurable:true,writable:true,value:undefined});globalThis.localStorage={getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)};
 const saved=enqueueStatus({providerId:item.providerId,bookingId:item.bookingId,action:item.action,checklist:item.checklist});
 assert.equal(readStatusQueue(item.providerId)[0].id,saved.id);assert.equal(readStatusQueue("another-provider").length,0);
 assert.throws(()=>enqueueStatus(item),/pending update/);
 globalThis.localStorage={getItem:()=>null,setItem:()=>{throw new Error("Disk full");}};
 assert.throws(()=>enqueueStatus(item),/Disk full/);
});
test("replay reconciles a lost success response without sending the transition twice",async()=>{
 const calls=[];await deliverStatus(item,async(url)=>{calls.push(url);return Response.json({data:{booking:{provider_id:item.providerId,status:"in_service"}}});});
 assert.equal(calls.length,1);assert.equal(statusAlreadyApplied(item,"cancelled"),false);
});
test("replay refuses changed assignment and retains transport failures for retry",async()=>{
 await assert.rejects(()=>deliverStatus(item,async()=>Response.json({data:{booking:{provider_id:"other",status:"arrived"}}})),/Assignment changed/);
 await assert.rejects(()=>deliverStatus(item,async()=>{throw new Error("Network request timed out");}),e=>e.retry===true);
 let count=0;await assert.rejects(()=>deliverStatus(item,async()=>++count===1?Response.json({data:{booking:{provider_id:item.providerId,status:"arrived"}}}):Response.json({error:"Safety checklist required"},{status:409})),/Safety checklist/);
});
test("replay preserves original checklist and event identity",async()=>{
 let sent;await deliverStatus(item,async(_url,options)=>{if(options.method==="POST"){sent=JSON.parse(options.body);return Response.json({ok:true});}return Response.json({data:{booking:{provider_id:item.providerId,status:"arrived"}}});});
 assert.deepEqual(sent.checklist,item.checklist);assert.equal(sent.clientEventId,item.id);
});
function makeDb(){const sql=new DatabaseSync(":memory:");const statement=(query,args=[])=>({bind:(...values)=>statement(query,values),first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})});return{sql,db:{prepare:query=>statement(query),batch:async list=>{const out=[];for(const q of list)out.push(await q.run());return out;}}};}
test("heartbeat sweep raises a deduplicated Ops case even if the first heartbeat never arrived",async()=>{
 const{sql,db}=makeDb();const now=Date.now();
 sql.exec("CREATE TABLE canonical_bookings(id TEXT,provider_id TEXT,customer_id TEXT,service_code TEXT,status TEXT,scheduled_start TEXT);CREATE TABLE provider_work_orders(booking_id TEXT,provider_id TEXT,status TEXT,updated_at INTEGER)");
 sql.prepare("INSERT INTO canonical_bookings VALUES('job-1','provider-1','customer-1','grooming','arrived',?)").run(new Date(now).toISOString());sql.prepare("INSERT INTO provider_work_orders VALUES('job-1','provider-1','arrived',?)").run(now-300000);
 assert.equal((await sweepPartnerHeartbeats(db,now)).created,1);assert.equal((await sweepPartnerHeartbeats(db,now)).created,0);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM unified_cases WHERE owner_team='operations'").get().n,1);
 assert.equal(await recordPartnerHeartbeat(db,{bookingId:"job-1",providerId:"other",trackingState:"native"},now),false);
 assert.equal(await recordPartnerHeartbeat(db,{bookingId:"job-1",providerId:"provider-1",trackingState:"native"},now),true);
 assert.equal((await sweepPartnerHeartbeats(db,now+1000)).checked,0);
 sql.exec("UPDATE canonical_bookings SET status='completed'");assert.equal(await recordPartnerHeartbeat(db,{bookingId:"job-1",providerId:"provider-1",trackingState:"native"},now+2000),false);
 assert.equal((await sweepPartnerHeartbeats(db,now+600000)).checked,0);sql.close();
 assert.equal(heartbeatIsStale(now-180000,now),true);assert.equal(heartbeatIsStale(now-179999,now),false);
});
