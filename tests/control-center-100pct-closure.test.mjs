import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{DatabaseSync}from"node:sqlite";
function makeD1(sqlite){function statement(sql,args=[]){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes||0)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})}}return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out}}}
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("emergency runtime switches default enabled and block only governed writes when stopped",async()=>{
 const db=makeD1(new DatabaseSync(":memory:")),mod=await import("../lib/control-runtime-switches.ts");
 const initial=await mod.listControlRuntimeSwitches(db);assert.equal(initial.length,6);assert.equal(initial.every(x=>x.enabled),true);
 await mod.setControlRuntimeSwitch(db,{code:"voice_outbound",enabled:false,reason:"Founder emergency stop",actor:"founder@pawspace.test"});
 const blocked=await mod.runtimeControlBlock(db,new Request("https://pawspace.test/api/voice-outbound",{method:"POST"}));assert.equal(blocked?.status,503);
 assert.equal(await mod.runtimeControlBlock(db,new Request("https://pawspace.test/api/voice-outbound",{method:"GET"})),null);
 assert.equal(await mod.runtimeControlBlock(db,new Request("https://pawspace.test/api/pricing-control",{method:"POST"})),null);
});
test("Control Center routes formerly static domains through live backend panels",()=>{
 const page=read("app/control/page.tsx"),panel=read("app/control/live-control-panel.tsx"),api=read("app/api/control-center-live/route.ts");
 assert.match(page,/new Set<View>\(\)/);assert.match(page,/section="subscriptions"/);assert.match(page,/section="marketing"/);assert.match(page,/section="audit"/);
 assert.doesNotMatch(page,/GroomingSubscriptionsPanel/);assert.doesNotMatch(page,/PlatformAuditPanel/);assert.doesNotMatch(page,/MarketingControlPanel/);
 for(const name of["approvals","master","inventory","quality","security","health"])assert.match(page,new RegExp(`section=\\"${name}\\"`));
 assert.match(panel,/\/api\/control-center-live/);assert.match(panel,/Server-enforced kill switches/);assert.match(api,/customer_grooming_subscriptions/);assert.match(api,/communication_outbox/);assert.match(api,/provider_onboarding_applications/);assert.match(api,/security_audit_events/);
});

test("API gateway applies runtime stop before protected mutations",()=>{
 const gateway=read("lib/api-gateway.ts");assert.match(gateway,/runtimeControlBlock/);assert.match(gateway,/\/api\/control-center-live/);assert.match(gateway,/if\(emergencyBlock\)return emergencyBlock/);
});
