import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const voice=readFileSync(new URL("../lib/voice-ai-self-test.ts",import.meta.url),"utf8");
const route=readFileSync(new URL("../app/api/voice-outbound/route.ts",import.meta.url),"utf8");
const worker=readFileSync(new URL("../worker/index.ts",import.meta.url),"utf8");
test("AI voice self-test is UAT-only, one-recipient, non-recording and audited",()=>{
 assert.match(voice,/mode!=="uat"/);
 assert.match(voice,/allowlistSize!==1/);
 assert.match(voice,/PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED/);
 assert.match(voice,/requestQuietHoursOverride/);
 assert.match(voice,/contactCount:1/);
 assert.match(voice,/reasonCode:"customer_requested_callback"/);
 assert.match(voice,/body\.set\("record","false"\)/);
 assert.match(voice,/MAX_CALL_SECONDS=300/);
 assert.match(voice,/DAILY_CAP_DEFAULT=3/);
 assert.match(voice,/canonicalDialNumber\(env,phoneKey\)/);
});
test("browser cannot choose the destination and staff action requires privileged permissions",()=>{
 assert.match(route,/action==="uat_ai_self_test"/);
 assert.match(route,/requirePermission\(actor,"settings\.manage"\)/);
 assert.match(route,/requirePermission\(actor,"communications\.call"\)/);
 assert.doesNotMatch(route,/requestAiVoiceSelfTest\([^\n]+body\.phone/);
});
test("AgentStream websocket is signed and Q&A is mutation-free",()=>{
 assert.match(voice,/ai-self-test:\$\{callId\}:\$\{exp\}/);
 assert.match(voice,/@cf\/deepgram\/flux/);
 assert.match(voice,/@cf\/deepgram\/aura-1/);
 assert.match(voice,/@cf\/openai\/gpt-oss-20b/);
 assert.match(voice,/do not execute bookings, payments, refunds/);
 assert.match(voice,/event:"clear"/);
 assert.match(worker,/url\.pathname==="\/voice\/ai-self-test"/);
 assert.match(worker,/handleAiVoiceSelfTestStream/);
});
