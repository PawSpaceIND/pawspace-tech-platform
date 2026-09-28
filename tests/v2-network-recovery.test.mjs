import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_NETWORK_TEST_DB__");
const {boundedFetch,boundedJsonFetch} = await import("../lib/bounded-fetch.ts");
const {deliverStatus,retryAfterMs,deferStatusRetry} = await import("../lib/partner-status-queue.ts");
const item = {id:"offline-event",providerId:"partner-a",bookingId:"booking-a",action:"start_service",checklist:["safety"],createdAt:Date.now()};
const current = () => Response.json({data:{booking:{provider_id:item.providerId,status:"arrived"}}});
const restoreFetch = t => {const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});};

test("V2: a request cancelled before dispatch never reaches the network", async t => {
 restoreFetch(t);let sent=0;globalThis.fetch=async()=>{sent++;return Response.json({});};
 const controller=new AbortController();controller.abort();
 await assert.rejects(boundedFetch("/api/test",{signal:controller.signal},30),e=>e.name==="AbortError");
 assert.equal(sent,0);
});
test("V2: caller cancellation is forwarded, not relabelled as a timeout", async t => {
 restoreFetch(t);globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener("abort",()=>reject(new DOMException("Cancelled","AbortError")),{once:true});});
 const controller=new AbortController();const pending=boundedFetch("/api/test",{signal:controller.signal},30);controller.abort();
 await assert.rejects(pending,e=>e.name==="AbortError");
});
for(const status of [408,425,429,502,503]) test(`V2: HTTP ${status} keeps an offline status update retryable`,async()=>{
 await assert.rejects(deliverStatus(item,async()=>Response.json({error:"Temporary gateway failure"},{status})),e=>e.retry===true);
});
test("V2: a gateway HTML body is a retryable outage, not a permanent partner error",async()=>{
 await assert.rejects(deliverStatus(item,async()=>new Response("<html>Bad gateway</html>",{status:502})),e=>e.retry===true);
});
test("V2: interrupted/malformed success JSON remains queued for reconciliation",async()=>{
 await assert.rejects(deliverStatus(item,async()=>new Response('{"data":', {status:200})),e=>e.retry===true);
});
test("V2: rate limiting preserves the server Retry-After deadline",async()=>{
 await assert.rejects(deliverStatus(item,async()=>Response.json({error:"Slow down"},{status:429,headers:{"Retry-After":"120"}})),e=>e.retry===true&&e.retryAfterMs>=120000);
});
test("V2: 408 during a mutation retains the original event for safe retry",async()=>{
 let calls=0;await assert.rejects(deliverStatus(item,async()=>++calls===1?current():Response.json({error:"Timed out"},{status:408})),e=>e.retry===true);
});
test("V2: business-rule refusal is not automatically retried",async()=>{
 let calls=0;await assert.rejects(deliverStatus(item,async()=>++calls===1?current():Response.json({error:"Safety checklist required"},{status:409})),e=>e.retry!==true&&/Safety checklist/.test(e.message));
});

for (const status of [200, 503]) test(`V2: the JSON deadline covers a stalled HTTP ${status} response body`, async t => {
 restoreFetch(t);
 globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});}}),{status});
 await assert.rejects(boundedJsonFetch("/api/test",{},20),e=>e.retry===true&&/timed out/.test(e.message));
});
test("V2: cancelling an error response body remains cancellation", async t => {
 restoreFetch(t);const caller=new AbortController();
 globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});}}),{status:503});
 const pending=boundedJsonFetch("/api/test",{signal:caller.signal},50);caller.abort();
 await assert.rejects(pending,e=>e.name==="AbortError");
});
test("V2: Retry-After dates and invalid values are interpreted safely",()=>{
 const now=Date.parse("2026-09-27T12:00:00Z");
 assert.equal(retryAfterMs("Sun, 27 Sep 2026 12:02:00 GMT",now),120000);
 for(const value of [null,"","invalid","Infinity"])assert.equal(retryAfterMs(value,now),0);
 assert.equal(retryAfterMs("Sun, 27 Sep 2026 11:00:00 GMT",now),0);
});
test("V2: retry delay is persisted without changing the original event or checklist",()=>{
 const retried=deferStatusRetry(item,{retryAfterMs:120000},1000,()=>0);
 assert.equal(retried.id,item.id);assert.equal(retried.createdAt,item.createdAt);
 assert.deepEqual(retried.checklist,item.checklist);assert.equal(retried.nextAttemptAt,121000);
 const capped=deferStatusRetry({...item,attempts:29},{},1000,()=>1);
 assert.equal(capped.attempts,30);assert.equal(capped.nextAttemptAt,61000);
 assert.ok(deferStatusRetry(item,{},1000,()=>0).nextAttemptAt>1000);
});
