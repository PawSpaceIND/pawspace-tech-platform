import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__LIFECYCLE_LOCK_DB__", "__LIFECYCLE_LOCK_ENV__");

const { withLifecycleMutationLock } = await import("../lib/lifecycle-mutation-lock.ts");

const refusal = async (promise) => {
 try { await promise; return null; }
 catch (error) { return error; }
};

test("same-booking lifecycle mutations serialize and the loser enters no mutation body", async () => {
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 globalThis.__LIFECYCLE_LOCK_DB__=db;
 globalThis.__LIFECYCLE_LOCK_ENV__={};
 let releaseFirst;
 const firstMayFinish=new Promise(resolve=>{releaseFirst=resolve});
 let firstEntered=false,loserEntered=false;
 const first=withLifecycleMutationLock(db,{bookingId:"BKG-LOCK-1",actorId:"provider-a",action:"complete"},async()=>{
  firstEntered=true;
  await firstMayFinish;
  return "winner";
 });
 while(!firstEntered)await new Promise(resolve=>setTimeout(resolve,0));
 const loser=await refusal(withLifecycleMutationLock(db,{bookingId:"BKG-LOCK-1",actorId:"provider-b",action:"cancel"},async()=>{
  loserEntered=true;
  return "loser";
 }));
 assert.ok(loser instanceof Response,"the competing request is refused with an HTTP response");
 assert.equal(loser.status,409);
 assert.equal(loserEntered,false,"a lock loser must not enter the lifecycle mutation body or write side effects");
 releaseFirst();
 assert.equal(await first,"winner");
 assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM lifecycle_mutation_locks WHERE booking_id='BKG-LOCK-1'").get().c),0,"successful completion releases the lock");
 const next=await withLifecycleMutationLock(db,{bookingId:"BKG-LOCK-1",actorId:"provider-c",action:"next"},async()=>"next-winner");
 assert.equal(next,"next-winner","the next legitimate lifecycle request can proceed after release");
});

test("different bookings remain concurrent", async () => {
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 let releaseA,releaseB;
 const gateA=new Promise(resolve=>{releaseA=resolve}),gateB=new Promise(resolve=>{releaseB=resolve});
 let aEntered=false,bEntered=false;
 const a=withLifecycleMutationLock(db,{bookingId:"BKG-A",actorId:"provider-a",action:"start"},async()=>{aEntered=true;await gateA;return"A"});
 const b=withLifecycleMutationLock(db,{bookingId:"BKG-B",actorId:"provider-b",action:"start"},async()=>{bEntered=true;await gateB;return"B"});
 while(!aEntered||!bEntered)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(aEntered&&bEntered,true,"booking-scoped serialization must not globally serialize unrelated customers");
 releaseA();releaseB();
 assert.deepEqual(await Promise.all([a,b]),["A","B"]);
});
