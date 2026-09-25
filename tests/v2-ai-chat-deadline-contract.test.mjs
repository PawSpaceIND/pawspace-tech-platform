import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, UAT_AI_ENV } from "./helpers/ai-harness.mjs";

installAiHooks();
const grounded = await import("../lib/ai-grounded-runtime-provider.ts");

const actor={userId:"UAT-CUSTOMER",email:"uat@example.test",roleCode:"customer",permissions:[]};

test("grounded web chat finishes inside the V2 20-second client budget",async()=>{
  globalThis.__PAWSPACE_TEST_ENV__={...UAT_AI_ENV,PAWSPACE_AI_PROVIDER_TIMEOUT_MS:"30000"};
  const provider=await grounded.createGroundedAiRuntimeProvider({},actor,"chat");
  assert.equal(provider.deadlineMs,15000);
});

test("non-chat grounded channels retain their configured provider deadline",async()=>{
  globalThis.__PAWSPACE_TEST_ENV__={...UAT_AI_ENV,PAWSPACE_AI_PROVIDER_TIMEOUT_MS:"30000"};
  const voice=await grounded.createGroundedAiRuntimeProvider({},actor,"voice");
  const whatsapp=await grounded.createGroundedAiRuntimeProvider({},actor,"whatsapp");
  assert.equal(voice.deadlineMs,30000);
  assert.equal(whatsapp.deadlineMs,30000);
});
