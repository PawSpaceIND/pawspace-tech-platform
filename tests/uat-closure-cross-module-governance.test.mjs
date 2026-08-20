import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAWSPACE_CROSS_MODULE_DB__");
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
function makeD1(sqlite){function statement(sql,args=[]){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes||0)}}},all:async()=>({results:sqlite.prepare(sql).all(...args)})}}return{prepare:sql=>statement(sql),batch:async list=>{const output=[];for(const item of list)output.push(await item.run());return output}}}

test("marketing rules execute only durable governed sandbox actions and remain idempotent",async()=>{
 const db=makeD1(new DatabaseSync(":memory:")),rules=await import("../lib/marketing-automation-rules.ts");
 const created=await rules.createAutomationRule(db,{name:"Pause on anomaly",triggerCode:"spend_anomaly",condition:{threshold:0.2,operator:"gte"},action:{type:"pause_campaign",campaignId:"uat-only"},approvalMode:"notify_only",actor:"maker@pawspace.test"});
 await rules.setAutomationRuleEnabled(db,{ruleId:created.id,enabled:true,reason:"Reviewed for sandbox execution",actor:"checker@pawspace.test"});
 const first=await rules.runMarketingAutomationSandboxSweep(db,{signals:{spend_anomaly:0.4},signalKey:"snapshot:1",actor:"scheduler@pawspace.test"});
 assert.equal(first.sandboxExecuted,1);assert.equal(first.externalConnectors,false);assert.equal(first.liveSpend,false);
 const row=await db.prepare("SELECT * FROM marketing_automation_action_runs WHERE rule_id=?").bind(created.id).first();
 assert.equal(row.status,"sandbox_executed");assert.equal(row.external_execution,0);assert.equal(row.live_spend,0);
 const second=await rules.runMarketingAutomationSandboxSweep(db,{signals:{spend_anomaly:0.4},signalKey:"snapshot:1"});
 assert.equal(second.duplicatePrevented,1);
});

test("city and service coverage advertises explicit Bengaluru pincodes and fails closed",async()=>{
 const db=makeD1(new DatabaseSync(":memory:")),cities=await import("../lib/city-governance.ts"),zones=await import("../lib/service-zones.ts");
 const supported=await cities.resolveCityServiceCoverage(db,{cityCode:"blr",serviceCode:"grooming",pincode:"560102"});
 assert.equal(supported.supported,true);
 const pincodeGap=await cities.resolveCityServiceCoverage(db,{cityCode:"blr",serviceCode:"grooming",pincode:"560110"});
 assert.deepEqual({supported:pincodeGap.supported,reason:pincodeGap.reason},{supported:false,reason:"pincode_not_supported"});
 const cityGap=await cities.resolveCityServiceCoverage(db,{cityCode:"mum",serviceCode:"grooming",pincode:"400001"});
 assert.deepEqual({supported:cityGap.supported,reason:cityGap.reason},{supported:false,reason:"city_not_live"});
 assert.equal(await zones.resolveZoneByPincode(db,"560110"),null,"a broad city range cannot fabricate a zone");
});

test("reminder scheduler has an executable sandbox sink with explicit status and no external connector",()=>{
 const reminders=read("lib/customer-reminder-governance.ts"),scheduler=read("lib/background-scheduler.ts"),onboarding=read("app/partner/onboarding/page.tsx"),workforce=read("app/admin/workforce-panel.tsx");
 for(const token of["consumeCustomerReminderSandboxOutbox","reminder_sandbox_deliveries","sandbox_delivered","governed_uat_sink","externalDelivery:false","connectorsEnabled:false"])assert.match(reminders,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
 assert.match(scheduler,/marketingAutomationSandbox/);assert.match(scheduler,/runMarketingAutomationSandboxSweep/);
 assert.match(onboarding,/Bengaluru \(supported pilot\)/);assert.doesNotMatch(onboarding,/<input value=\{form\.cityCode\}/);
 assert.match(workforce,/Payout run unavailable/);assert.match(workforce,/Not payable/);
});

test("reminder sandbox consumer closes a due lifecycle outbox record without external delivery",async()=>{
 const db=makeD1(new DatabaseSync(":memory:")),communications=await import("../lib/communication-engine.ts"),reminders=await import("../lib/customer-reminder-governance.ts"),now=Date.now();
 await communications.ensureCommunicationTables(db);
 await db.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES ('thread-1','customer-1','open',?,?)").bind(now,now).run();
 await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('message-1','thread-1','customer-1','outbound','whatsapp','lifecycle','grooming_rebooking_reminder','{}','queued','reminder-1','{}','scheduler',?,?)").bind(now,now).run();
 await db.prepare("INSERT INTO communication_outbox (message_id,status,next_attempt_at,attempt_count,max_attempts,updated_at) VALUES ('message-1','queued',?,0,5,?)").bind(now-1,now).run();
 const result=await reminders.consumeCustomerReminderSandboxOutbox(db,{asOf:now});
 assert.deepEqual({delivered:result.sandboxDelivered,status:result.deliveryStatus,external:result.externalDelivery},{delivered:1,status:"sandbox_delivered",external:false});
 const message=await db.prepare("SELECT status,provider,provider_reference FROM communication_messages WHERE id='message-1'").first();
 assert.deepEqual({...message},{status:"sandbox_delivered",provider:"governed_uat_sink",provider_reference:null});
 const delivery=await db.prepare("SELECT delivery_status,external_delivery FROM reminder_sandbox_deliveries WHERE message_id='message-1'").first();
 assert.deepEqual({...delivery},{delivery_status:"sandbox_delivered",external_delivery:0});
});
