import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SERVICE_CLOCK_DB__", "__SERVICE_CLOCK_ENV__");
const { serviceExecutionNow } = await import("../lib/service-execution-clock.ts");

async function refusal(fn){try{await fn();return null;}catch(error){if(error instanceof Response)return{status:error.status,message:await error.text()};throw error;}}

test("service clock defaults to wall clock when no override exists",async()=>{
 globalThis.__SERVICE_CLOCK_ENV__={};const before=Date.now(),value=await serviceExecutionNow(),after=Date.now();
 assert.ok(value>=before&&value<=after);
});

test("service clock override is refused unless every isolated-UAT gate is explicit",async()=>{
 const when=Date.UTC(2026,8,16,13,0,0);
 for(const runtime of[
  {PAWSPACE_UAT_EXECUTION_NOW_MS:String(when)},
  {NODE_ENV:"test",FORBID_PRODUCTION:"true",PAWSPACE_SCHEDULING_ENV:"uat",PAWSPACE_UAT_EXECUTION_NOW_MS:String(when)},
  {NODE_ENV:"test",FORBID_PRODUCTION:"false",PAWSPACE_SCHEDULING_ENV:"uat",PAWSPACE_UAT_SERVICE_CLOCK:"on",PAWSPACE_UAT_EXECUTION_NOW_MS:String(when)},
 ]){globalThis.__SERVICE_CLOCK_ENV__=runtime;const denied=await refusal(()=>serviceExecutionNow());assert.equal(denied?.status,503);assert.match(denied.message,/only in isolated test UAT/);}
});

test("service clock accepts one valid server-owned isolated-UAT instant and rejects malformed values",async()=>{
 const when=Date.UTC(2026,8,16,13,0,0),base={NODE_ENV:"test",FORBID_PRODUCTION:"true",PAWSPACE_SCHEDULING_ENV:"uat",PAWSPACE_UAT_SERVICE_CLOCK:"on"};
 globalThis.__SERVICE_CLOCK_ENV__={...base,PAWSPACE_UAT_EXECUTION_NOW_MS:String(when)};assert.equal(await serviceExecutionNow(),when);
 for(const raw of["not-a-time","0",String(Date.UTC(2200,0,1))]){globalThis.__SERVICE_CLOCK_ENV__={...base,PAWSPACE_UAT_EXECUTION_NOW_MS:raw};const denied=await refusal(()=>serviceExecutionNow());assert.equal(denied?.status,503);assert.match(denied.message,/override is invalid/);}
});
