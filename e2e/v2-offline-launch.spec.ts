import {test, expect, type Page} from "@playwright/test";
import ts from "typescript";
import {readFileSync} from "node:fs";

// Execute the actual queue modules in real browser storage, without writing a real booking or payment.
const modules = new Set(["provider-proof-offline-queue", "partner-status-queue", "bounded-fetch"]);
async function fixture(page: Page) {
  await page.route("**/__launch/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/__launch/harness") return route.fulfill({contentType:"text/html",body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>V2 offline fault harness</title><h1>Offline queue verification</h1>'});
    const name = path.split("/").pop()?.replace(/\.js$/, "") ?? "";
    if (!modules.has(name)) return route.fulfill({status:404,body:"Unknown harness module"});
    const code = ts.transpileModule(readFileSync(`lib/${name}.ts`,"utf8"), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace('"./bounded-fetch"','"./bounded-fetch.js"');
    return route.fulfill({contentType:"text/javascript",body:code});
  });
  await page.goto("/__launch/harness");
}
async function queuePhoto(page: Page) {
  return page.evaluate(async () => {
    // @ts-expect-error The harness serves the repository TypeScript as browser ESM.
    const q = await import("/__launch/provider-proof-offline-queue.js");
    const file = new Blob(["offline-photo"], {type:"image/jpeg"});
    const row = await q.queueProviderProof({bookingId:"launch-test-only",purpose:"before_service",file,fileName:"proof.jpg",mimeType:file.type,sizeBytes:file.size,sha256:"a".repeat(64)});
    return row.id as string;
  });
}

test("real IndexedDB: offline photo survives reload and syncs once when connectivity returns",async({page,context})=>{
 await fixture(page);const id=await queuePhoto(page);await page.reload();
 // Load ESM before disconnecting. Browser storage remains real, not an in-memory fake.
 await page.evaluate(async()=>{ // @ts-expect-error harness ESM
  window.__pawspaceLaunchTestQueue=await import("/__launch/provider-proof-offline-queue.js");
 });
 await context.setOffline(true);
 const waiting=await page.evaluate(async()=>{ // @ts-expect-error harness ESM
  return window.__pawspaceLaunchTestQueue.flushProviderProofQueue(async()=>{throw new Error("must not send while offline");});
 });
 expect(waiting.pending).toBe(1);expect(waiting.uploaded).toBe(0);
 await context.setOffline(false);
 const result=await page.evaluate(async()=>{
  const received:Array<{id:string;bytes:string}>=[];
  // @ts-expect-error harness ESM
  const q=window.__pawspaceLaunchTestQueue;
  const sent=await q.flushProviderProofQueue(async(row:{id:string;file:Blob})=>received.push({id:row.id,bytes:await row.file.text()}));
  const again=await q.flushProviderProofQueue(async()=>{throw new Error("duplicate dispatch");});
  return {received,sent,again};
 });
 expect(result.received).toEqual([{id,bytes:"offline-photo"}]);expect(result.sent.uploaded).toBe(1);expect(result.again.pending).toBe(0);
});

test("real IndexedDB: transaction abort after put success is never acknowledged as saved",async({page})=>{
 await fixture(page);
 const result=await page.evaluate(async()=>{
  // @ts-expect-error harness ESM
  const q=await import("/__launch/provider-proof-offline-queue.js");
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){const operation=original.apply(this,args);const transaction=this.transaction;operation.addEventListener("success",()=>transaction.abort(),{once:true});return operation;};
  let rejected=false;
  try {await q.queueProviderProof({bookingId:"abort-test",purpose:"before_service",file:new Blob(["x"]),fileName:"proof.jpg",mimeType:"image/jpeg",sizeBytes:1,sha256:"b".repeat(64)});}catch{rejected=true;}finally{IDBObjectStore.prototype.put=original;}
  const remaining=await q.flushProviderProofQueue(async()=>{throw new Error("aborted bytes must not be uploaded");});
  return {rejected,remaining};
 });
 expect(result.rejected).toBe(true);expect(result.remaining.pending).toBe(0);expect(result.remaining.uploaded).toBe(0);
});

test("real browser: status queue survives reload and is isolated by partner identity",async({page})=>{
 await fixture(page);
 const id=await page.evaluate(async()=>{
  // @ts-expect-error harness ESM
  const q=await import("/__launch/partner-status-queue.js");
  return q.withStatusQueueLock("partner-a","storage",()=>q.enqueueStatus({providerId:"partner-a",bookingId:"launch-test-only",action:"arrived",checklist:[]})).then((row:{id:string})=>row.id);
 });
 await page.reload();
 const saved=await page.evaluate(async()=>{ // @ts-expect-error harness ESM
  const q=await import("/__launch/partner-status-queue.js");return {mine:q.readStatusQueue("partner-a"),other:q.readStatusQueue("partner-b")};
 });
 expect(saved.mine).toHaveLength(1);expect(saved.mine[0].id).toBe(id);expect(saved.other).toEqual([]);
});

test("real browser: HTML gateway failure retains the event and safe retry uses its original identity",async({page})=>{
 await fixture(page);let failed=true;const mutations:unknown[]=[];
 await page.route("**/api/grooming-lifecycle**",route=>{
  if(route.request().method()==="POST"){mutations.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
  if(failed)return route.fulfill({status:502,contentType:"text/html",body:"<html>gateway unavailable</html>"});
  return route.fulfill({json:{data:{booking:{provider_id:"partner-a",status:"arrived"}}}});
 });
 const first=await page.evaluate(async()=>{
  // @ts-expect-error harness ESM
  const q=await import("/__launch/partner-status-queue.js");
  const row=q.enqueueStatus({providerId:"partner-a",bookingId:"launch-test-only",action:"start_service",checklist:["safety"]});
  try{await q.deliverStatus(row);return {id:row.id,retry:false};}catch(error){return {id:row.id,retry:(error as {retry?:boolean}).retry};}
 });
 expect(first.retry).toBe(true);expect(mutations).toHaveLength(0);failed=false;
 await page.evaluate(async()=>{ // @ts-expect-error harness ESM
  const q=await import("/__launch/partner-status-queue.js");await q.deliverStatus(q.readStatusQueue("partner-a")[0]);
 });
 expect(mutations).toHaveLength(1);expect(mutations[0]).toMatchObject({clientEventId:first.id,checklist:["safety"]});
});

test("real browser: overlapping proof flushes register the bytes once",async({page})=>{
 await fixture(page);await queuePhoto(page);
 const result=await page.evaluate(async()=>{
  // @ts-expect-error harness ESM
  const q=await import("/__launch/provider-proof-offline-queue.js");let calls=0;
  const send=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));};
  const [a,b]=await Promise.all([q.flushProviderProofQueue(send),q.flushProviderProofQueue(send)]);
  return {calls,a,b};
 });
 expect(result.calls).toBe(1);expect(result.a.uploaded).toBe(1);expect(result.b.uploaded).toBe(1);
});
