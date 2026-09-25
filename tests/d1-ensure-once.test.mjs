import test from"node:test";
import assert from"node:assert/strict";
import{ensureD1Once,ensureD1OnceApplied}from"../lib/d1-ensure-once.js";

test("ensureD1Once shares one successful setup per binding and key",async()=>{
 const db={},calls=[];
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const first=ensureD1Once(db,"schema",async()=>{calls.push("run");await gate;});
 const second=ensureD1Once(db,"schema",async()=>{calls.push("duplicate");});
 assert.deepEqual(calls,["run"]);release();await Promise.all([first,second]);
 await ensureD1Once(db,"schema",async()=>{calls.push("late");});
 assert.deepEqual(calls,["run"]);
});

test("ensureD1Once forgets a failed setup so a later request can retry",async()=>{
 const db={};let calls=0;
 await assert.rejects(ensureD1Once(db,"schema",async()=>{calls++;throw new Error("setup failed");}),/setup failed/);
 await ensureD1Once(db,"schema",async()=>{calls++;});
 assert.equal(calls,2);
});

test("a caller that joined a failed setup retries once instead of inheriting the failure",async()=>{
 const db={};let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
 const owner=ensureD1Once(db,"schema",async()=>{calls++;await gate;throw new Error("transient");});
 const joiner=ensureD1Once(db,"schema",async()=>{calls++;});
 release();
 await assert.rejects(owner,/transient/);
 await joiner;
 assert.equal(calls,2,"the joiner ran its own retry after the shared attempt failed");
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
