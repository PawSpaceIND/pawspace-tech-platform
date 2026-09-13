import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
await import("../lib/provider-proof-offline-queue.ts");

test("provider lifecycle uses synchronous ref locks and durable offline proof retry",async()=>{
  const [app,canonical,queue]=await Promise.all([read("app/partner-app/page.tsx"),read("app/partner-app/canonical-grooming-jobs.tsx"),read("lib/provider-proof-offline-queue.ts")]);
  assert.match(app,/lifecycleLock\.current/);
  assert.match(canonical,/actionLock\.current/);
  assert.match(app,/setInterval\(flush, 15_000\)/);
  assert.match(queue,/indexedDB\.open/);
  assert.match(queue,/2 \*\* Math\.min\(attempts, 6\)/);
});

test("admin finance mutations require optimistic row versions",async()=>{
  const [route,panel]=await Promise.all([read("app/api/finance-control/route.ts"),read("app/control/finance-control-panel.tsx")]);
  assert.match(route,/Finance mutations require an If-Match row version/);
  assert.match(route,/Finance record changed since it was loaded/);
  assert.match(panel,/"if-match":`"\$\{row\.updated_at\}"`/);
});

test("CRM data surfaces are isolated by React error boundaries",async()=>{
  const crm=await read("app/crm/page.tsx");
  assert.match(crm,/CRM customer table/);
  assert.match(crm,/CRM revenue table/);
  assert.match(crm,/CRM live chat table/);
});

test("Razorpay, Meta WhatsApp and Exotel reject duplicate provider events",async()=>{
  const [razorpay,meta,voice]=await Promise.all([read("app/api/razorpay-webhook/route.ts"),read("app/api/whatsapp/meta-webhook/route.ts"),read("lib/voice-bridge-governance.ts")]);
  assert.match(razorpay,/x-razorpay-event-id/);
  assert.match(razorpay,/Razorpay event ID payload mismatch/);
  assert.match(meta,/captureInboundWebhook/);
  assert.match(meta,/eventId/);
  assert.match(voice,/const bridgeEventId = event\.providerEventId/);
  assert.match(voice,/replayed with a different payload/);
});
