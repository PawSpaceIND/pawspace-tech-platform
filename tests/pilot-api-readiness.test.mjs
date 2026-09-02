import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("/api/inquiries is bound and exposes exactly ten governed inquiry categories",async()=>{
 const route=await import("../app/api/inquiries/route.ts");
 const response=await route.GET(new Request("https://pawspace.test/api/inquiries"));
 assert.equal(response.status,200);
 const payload=await response.json();
 assert.equal(payload.ok,true);
 assert.equal(payload.data.serviceCategories.length,10);
 assert.deepEqual(payload.data.serviceCategories.map(item=>item.code),[
  "grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking","food","relocation","funeral_memorial","veterinary",
 ]);
});

test("/api/inquiries rejects invalid payloads before touching CRM or external providers",async()=>{
 const route=await import("../app/api/inquiries/route.ts");
 const response=await route.POST(new Request("https://pawspace.test/api/inquiries",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({service:"not-a-service"})}));
 assert.equal(response.status,400);
 const payload=await response.json();
 assert.equal(payload.code,"INQUIRY_SERVICE_INVALID");
 assert.equal(payload.serviceCategories.length,10);
});

test("API gateway explicitly maps inquiries public and Haptik outbound marketing scopes",async()=>{
 const source=await read("lib/api-gateway.ts");
 assert.match(source,/url\.pathname==="\/api\/inquiries"/);
 assert.match(source,/url\.pathname==="\/api\/haptik-outbound"\)return method==="GET"\?"marketing\.view":"marketing\.manage"/);
});

test("bot-call-outcomes preserves authorization before controlled binding readiness",async()=>{
 const source=await read("app/api/bot-call-outcomes/route.ts");
 assert.match(source,/BOT_CALL_BINDINGS_MISSING/);
 assert.match(source,/missingRequired:runtime\.DB\?\[\]:\["DB"\]/);
 assert.match(source,/IDEMPOTENCY_KV:Boolean\(runtime\.IDEMPOTENCY_KV\)/);
 assert.match(source,/CALL_ARTIFACTS:Boolean\(runtime\.CALL_ARTIFACTS\)/);
 const getBody=source.slice(source.indexOf("export async function GET"),source.indexOf("export async function POST"));
 assert.ok(getBody.indexOf("authorize(request,\"customers.view\")")<getBody.indexOf("requireBotCallBindings()"),"GET must authenticate before exposing binding readiness");
 const postBody=source.slice(source.indexOf("export async function POST"));
 assert.ok(postBody.indexOf("authorize(request,\"customers.manage\")")<postBody.indexOf("requireBotCallBindings()"),"POST must authenticate before exposing binding readiness");
});

test("test voice transport is pinned to the explicit non-production simulator",async()=>{
 const packageJson=JSON.parse(await read("package.json"));
 assert.match(packageJson.scripts.test,/PAWSPACE_VOICE_TRANSPORT=local_simulator_non_production/);
 const harness=await read("tests/helpers/voice-harness.mjs");
 assert.match(harness,/PAWSPACE_VOICE_TRANSPORT:\s*"local_simulator_non_production"/);
 const telephony=await read("lib/voice-telephony-provider.ts");
 assert.match(telephony,/voiceMode\(env\) !== "live"/);
});

test("Haptik and WhatsApp UAT fallbacks are network-safe when real providers are not selected",async()=>{
 const haptik=await read("lib/haptik-outbound-client.ts");
 assert.match(haptik,/if \(!key \|\| !url\) return \{ connected: false/);
 const whatsapp=await read("lib/whatsapp-uat-adapter.ts");
 assert.match(whatsapp,/"sandbox_simulator"/);
 assert.match(whatsapp,/externalDelivery:false/);
});
