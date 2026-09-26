import test from"node:test";
import assert from"node:assert/strict";
import{ensureD1Once,ensureD1OnceApplied}from"../lib/d1-ensure-once.js";

const never=()=>new Promise(()=>{});
/** Resolves "timeout" if `promise` has not settled within `ms`: a hang, as the Workers runtime would see it. */
const within=(promise,ms=200)=>Promise.race([promise.then(()=>"settled",()=>"settled"),new Promise(resolve=>setTimeout(()=>resolve("timeout"),ms))]);

test("ensureD1Once remembers a completed setup per binding and key",async()=>{
 const db={},calls=[];
 await ensureD1Once(db,"schema",async()=>{calls.push("run");});
 await ensureD1Once(db,"schema",async()=>{calls.push("late");});
 assert.deepEqual(calls,["run"]);
 await ensureD1Once({},"schema",async()=>{calls.push("other binding");});
 assert.deepEqual(calls,["run","other binding"],"each binding is set up on its own");
});

test("ensureD1Once forgets a failed setup so a later request can retry",async()=>{
 const db={};let calls=0;
 await assert.rejects(ensureD1Once(db,"schema",async()=>{calls++;throw new Error("setup failed");}),/setup failed/);
 await ensureD1Once(db,"schema",async()=>{calls++;});
 assert.equal(calls,2);
});

// The staging "Worker threw exception" on GET /api/provider-chat: a request cancelled mid-setup leaves its
// in-flight promise unsettled for ever. The old helper handed that promise to every later caller on the
// isolate, so they hung too. A later caller must run the idempotent setup itself and finish.
test("a setup that never settles (a cancelled request) does not block a later request",async()=>{
 const db={};let calls=0;
 void ensureD1Once(db,"trust_safety_tables",async()=>{calls++;await never();});
 assert.equal(await within(ensureD1Once(db,"trust_safety_tables",async()=>{calls++;})),"settled","the second request must not wait on the cancelled one");
 assert.equal(calls,2,"the later request ran the idempotent setup itself");
 await ensureD1Once(db,"trust_safety_tables",async()=>{calls++;});
 assert.equal(calls,2,"and once it completed, the key is remembered");
});

test("ensureD1OnceApplied never joins another request's unfinished setup either",async()=>{
 const db={};let calls=0;
 void ensureD1OnceApplied(db,"trigger",async()=>{calls++;await never();return true;});
 assert.equal(await within(ensureD1OnceApplied(db,"trigger",async()=>{calls++;return true;})),"settled");
 assert.equal(calls,2);
});

test("ensureD1OnceApplied keeps re-checking until the dependent setup is actually applied",async()=>{
 const db={};let tableExists=false,applied=0,checks=0;
 const setup=async()=>{checks++;if(!tableExists)return false;applied++;return true;};
 await ensureD1OnceApplied(db,"trigger",setup);
 await ensureD1OnceApplied(db,"trigger",setup);
 assert.equal(applied,0);assert.equal(checks,2,"not cached while the dependency is missing");
 tableExists=true;
 await ensureD1OnceApplied(db,"trigger",setup);
 await ensureD1OnceApplied(db,"trigger",setup);
 assert.equal(applied,1,"applied once the dependency exists, then cached");assert.equal(checks,3);
});
