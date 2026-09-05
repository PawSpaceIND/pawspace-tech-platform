import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";
installWorkersHooks("__OUTBOUND_DB__", "__OUTBOUND_ENV__");
const routing=await import("../lib/outbound-routing-policy.ts");
const outbound=await import("../lib/outbound-orchestrator.ts");
const nextBest=await import("../lib/outbound-next-best-service.ts");
const dialPolicy=await import("../lib/power-dialler-policy.ts");
async function fresh(){const sqlite=freshSqlite(),db=makeD1(sqlite);await outbound.ensureOutboundOrchestratorTables(db);return{sqlite,db}}

test("80+ and high-intent leads bypass AI while scale work routes to AI and DND suppresses",()=>{
 assert.equal(routing.decideOutboundRoute({leadScore:92,lifecycleCode:"cross_sell",marketingConsent:true,serviceConsent:true,phoneAvailable:true}).lane,"human");
 const ai=routing.decideOutboundRoute({leadScore:55,lifecycleCode:"dormant_lead",scaleIntent:true,marketingConsent:true,serviceConsent:true,phoneAvailable:true});assert.equal(ai.lane,"ai");assert.ok(ai.priorityScore>=30&&ai.priorityScore<80);
 assert.equal(routing.decideOutboundRoute({leadScore:35,lifecycleCode:"grooming_renewal",marketingConsent:true,serviceConsent:true,phoneAvailable:true}).lane,"human");
 assert.equal(routing.decideOutboundRoute({leadScore:99,lifecycleCode:"subscription_renewal",optedOut:true,serviceConsent:true,phoneAvailable:true}).lane,"suppressed");
});

test("employee disposition closes the item and returns the 2.5 second auto-advance contract",async()=>{const{sqlite,db}=await fresh(),now=Date.now();sqlite.prepare("INSERT INTO outbound_routing_queue (id,source_key,customer_id,source_type,lane,priority_score,high_intent,lifecycle_code,assigned_to,status,context_json,created_at,updated_at) VALUES ('Q-HUMAN','manual:1','C1','grooming_renewal','human',91,1,'grooming_renewal','agent@pawspace.in','claimed','{}',?,?)").run(now,now);const result=await outbound.recordPowerDiallerDisposition(db,{queueId:"Q-HUMAN",actorId:"agent@pawspace.in",disposition:"interested",asOf:now+1000});assert.equal(result.status,"completed");assert.equal(result.autoAdvanceAfterMs,2500);assert.equal(dialPolicy.POWER_DIALLER_AUTO_ADVANCE_MS,2500);assert.equal(sqlite.prepare("SELECT status FROM outbound_routing_queue WHERE id='Q-HUMAN'").get().status,"completed")});

test("AI interest/callback becomes a 100-priority human queue item",async()=>{const{sqlite,db}=await fresh(),now=Date.now();sqlite.prepare("INSERT INTO outbound_routing_queue (id,source_key,customer_id,lead_id,source_type,lane,priority_score,high_intent,lifecycle_code,status,context_json,created_at,updated_at) VALUES ('Q-AI','dormant:1','C9','L9','dormant_lead','ai',58,0,'dormant_lead','ai_dialing','{}',?,?)").run(now,now);const signal=outbound.detectAiOutboundEscalation("Yes, I am interested. Please call me tomorrow at 4 pm",now);assert.ok(signal);assert.equal(signal.reason,"interested");assert.ok(Number(signal.callbackAt)>now);const created=await outbound.enqueueHumanEscalation(db,{customerId:"C9",leadId:"L9",sourceId:"AIVCALL-9:1",reason:signal.reason,callbackAt:signal.callbackAt,aiSummary:"Customer is interested",expectedRevenue:6500,asOf:now});assert.equal(created.lane,"human");assert.equal(Number(created.priority_score),100);assert.equal(sqlite.prepare("SELECT status FROM outbound_routing_queue WHERE id='Q-AI'").get().status,"escalated")});

test("next-best intelligence supports puppy and boarding sequential journeys",()=>{const puppy=nextBest.evaluateOutboundNextBestService({pet:{petId:"P1",species:"dog",ageMonths:10},serviceHistory:[{serviceCode:"training",completedCount:4},{serviceCode:"grooming",completedCount:2}]});assert.equal(puppy[0].offerCode,"grooming_subscription");assert.equal(puppy[0].journeyCode,"puppy_growth");assert.equal(puppy[0].journeyStep,2);const boarding=nextBest.evaluateOutboundNextBestService({pet:{petId:"P2",species:"dog",ageMonths:48},serviceHistory:[{serviceCode:"boarding",completedCount:2},{serviceCode:"grooming",completedCount:1}]});assert.equal(boarding[0].targetService,"taxi");assert.equal(boarding[0].journeyCode,"boarding_concierge");assert.equal(boarding[0].journeyStep,3)});
