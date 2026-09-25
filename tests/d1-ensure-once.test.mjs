import test from"node:test";
import assert from"node:assert/strict";
import{ensureD1Once}from"../lib/d1-ensure-once.js";

test("ensureD1Once shares one successful setup per binding and key",async()=>{
 const db={},calls=[];
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const first=ensureD1Once(db,"schema",async()=>{calls.push("run");await gate;});
 const second=ensureD1Once(db,"schema",async()=>{calls.push("duplicate");});
 assert.equal(first,second);assert.deepEqual(calls,["run"]);release();await first;
 await ensureD1Once(db,"schema",async()=>{calls.push("late");});
 assert.deepEqual(calls,["run"]);
});

test("ensureD1Once forgets a failed setup so a later request can retry",async()=>{
 const db={};let calls=0;
 await assert.rejects(ensureD1Once(db,"schema",async()=>{calls++;throw new Error("setup failed");}),/setup failed/);
 await ensureD1Once(db,"schema",async()=>{calls++;});
 assert.equal(calls,2);
});
