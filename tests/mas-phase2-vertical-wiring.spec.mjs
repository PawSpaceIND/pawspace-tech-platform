import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {phase2ToolSchemas,executePhase2Tool} from "../lib/atlas-phase2-vertical-tools.ts";

const actor={email:"atlas@pawspace.test",role:"founder",permissions:["*"]};
const db={};
const call=(toolCode,agentCode,env,arguments_={})=>executePhase2Tool(db,{agentCode,goalId:"G1",toolCode,arguments:arguments_,actor,idempotencyKey:"phase2-test-key",env});

test("all requested Phase 2 vertical tools are registered",()=>{
 const expected=["ops.voice.dispatch","ops.rpa.execute_legacy_sync","marketing.ads.read_metrics","marketing.proposal.submit","marketing.ads.budget.reallocate","marketing.ads.keyword.mutate","finance.yield.calculate_surge","vet.triage.evaluate","vet.prescription.digitize","finance.vet_payout.calculate"];
 assert.deepEqual(Object.keys(phase2ToolSchemas).sort(),expected.sort());
});

test("global AI executive kill switch fails every vertical closed",async()=>{
 for(const [tool,agent] of [["ops.voice.dispatch","ops"],["marketing.ads.read_metrics","marketing"],["finance.yield.calculate_surge","finance"],["vet.triage.evaluate","healthcare"]]){
  const result=await call(tool,agent,{PAWSPACE_AI_EXECUTIVE_ACTIVE:"false",AI_ATLAS_ACTIVE:"true"});assert.equal(result.status,"human_handoff");assert.equal(result.executed,false);
 }
});

test("Ops voice needs external communication switch even with Ops enabled",async()=>{
 const result=await call("ops.voice.dispatch","ops",{PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_OPS_ACTIVE:"true",AI_EXTERNAL_COMMUNICATION_ACTIVE:"false"},{bookingId:"B1",useCase:"booking_confirmation"});
 assert.equal(result.status,"human_handoff");
});

test("Marketing external mutation fails closed without communication mutation switch",async()=>{
 const result=await call("marketing.ads.budget.reallocate","marketing",{PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_MARKETING_ACTIVE:"true",AI_EXTERNAL_COMMUNICATION_ACTIVE:"false"});
 assert.equal(result.status,"human_handoff");
});
test("Vet payout fails closed without financial mutation switch",async()=>{
 const result=await call("finance.vet_payout.calculate","finance",{PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_FINANCE_ACTIVE:"true",AI_FINANCIAL_MUTATION_ACTIVE:"false"});
 assert.equal(result.status,"human_handoff");
});

test("Healthcare tools fail closed when Healthcare head is disabled",async()=>{
 const result=await call("vet.triage.evaluate","healthcare",{PAWSPACE_AI_EXECUTIVE_ACTIVE:"true",AI_ATLAS_ACTIVE:"true",AI_HEALTHCARE_ACTIVE:"false"},{customerId:"C1",petId:"P1",symptoms:"limping"});
 assert.equal(result.status,"human_handoff");
});

test("Vet schema physically pins SAC 998351 and zero GST",()=>{
 const sql=readFileSync(new URL("../drizzle/0034_vet_doorstep_healthcare.sql",import.meta.url),"utf8");
 assert.match(sql,/sac_code TEXT NOT NULL DEFAULT '998351' CHECK\(sac_code='998351'\)/);
 assert.match(sql,/tax_paise INTEGER NOT NULL DEFAULT 0 CHECK\(tax_paise=0\)/);
});

test("Marketing approval path pins SHA-256 and atomic single-use claim",()=>{
 const src=readFileSync(new URL("../lib/marketing-agent-gateway.ts",import.meta.url),"utf8");
 assert.match(src,/crypto\.subtle\.digest\("SHA-256"/);
 assert.match(src,/status='executing'.*status='approved'.*executed_at IS NULL/);
 assert.match(src,/gce_budget_envelopes/);
});