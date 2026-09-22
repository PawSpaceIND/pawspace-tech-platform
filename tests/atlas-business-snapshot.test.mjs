import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks();
const atlas=await import("../lib/intelligence/atlas-business-snapshot.ts");
const atlasData=await import("../lib/intelligence/atlas-data.ts");
const revenue=await import("../lib/revenue-mission-control.ts");
const marketing=await import("../lib/marketing-governance.ts");

function makeD1(sqlite){
 const statement=(sql,args=[])=>({bind:(...values)=>statement(sql,values),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const r=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes)}}}});
 return{prepare:sql=>statement(sql),batch:async items=>{sqlite.exec("BEGIN");try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out}catch(e){sqlite.exec("ROLLBACK");throw e}}};
}
function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite),now=2_000_000_000_000;
 sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,status TEXT); CREATE TABLE booking_invoices(id TEXT PRIMARY KEY,issued_at INTEGER); CREATE TABLE unified_cases(id TEXT PRIMARY KEY,status TEXT,first_responded_at INTEGER,first_response_due_at INTEGER,resolution_due_at INTEGER); CREATE TABLE provider_assignment_offers(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE ops_completion_controls(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE training_session_earnings(session_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE training_compensation_rules(id TEXT PRIMARY KEY,status TEXT);");
 sqlite.exec("INSERT INTO canonical_bookings VALUES ('B1','grooming','completed'),('B2','grooming','assigned'),('B3','dog_training','cancelled'); INSERT INTO booking_invoices VALUES ('I1',1999999999000); INSERT INTO unified_cases VALUES ('C1','open',NULL,1999999999000,2000000001000); INSERT INTO provider_assignment_offers VALUES ('O1','pending'); INSERT INTO ops_completion_controls VALUES ('H1','collection_hold'); INSERT INTO training_session_earnings VALUES ('E1','pending_rate_configuration'),('E2','earned'); INSERT INTO training_compensation_rules VALUES ('R1','published');");
 return{sqlite,db,now};
}
test("snapshot mission math matches revenueMissionSummary and keeps pipeline outside achieved",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M1','UAT mission',1000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+10000,JSON.stringify({type:"company"}),now-10000,now);
 const ins=sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 ins.run("E1","M1","b","booked","C","BK",null,null,"grooming","blr",500,0,500,"INR",now-5000,"test","{}",now);ins.run("E2","M1","c","collected","C","BK","P",null,"grooming","blr",400,0,400,"INR",now-4000,"test","{}",now);ins.run("E3","M1","r","refunded","C","BK","P","R","grooming","blr",0,50,-50,"INR",now-3000,"test","{}",now);
 const summary=await revenue.revenueMissionSummary(db,"M1"),snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now,missionId:"M1"});
 assert.equal(snapshot.mission.value.target,summary.metrics.target);assert.equal(snapshot.mission.value.booked,summary.metrics.booked);assert.equal(snapshot.mission.value.collected,summary.metrics.collected);assert.equal(snapshot.mission.value.refunded,summary.metrics.refunded);assert.equal(snapshot.mission.value.net,summary.metrics.netCollected);assert.equal(snapshot.mission.value.achieved,summary.metrics.achieved);assert.equal(snapshot.mission.value.percent,summary.metrics.percent);assert.equal(snapshot.mission.value.pipeline_weighted,null);assert.equal(snapshot.production_ready,false);
});
test("empty database reports insufficient_data with nulls rather than fake zero",async()=>{const sqlite=new DatabaseSync(":memory:"),snapshot=await atlas.buildAtlasBusinessSnapshot(makeD1(sqlite),{asOf:2_000_000_000_000});assert.equal(snapshot.insufficient_data,true);assert.equal(snapshot.mission.value,null);assert.equal(snapshot.bookings.value,null);assert.match(snapshot.mission.reason,/missing_table/);});
test("ask without AI key still returns grounded numbers",async()=>{const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M2','UAT mission',1000,'INR',?,?,?,'collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+10000,JSON.stringify({type:"company"}),now-10000,now);sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('X','M2','x','collected','C','B','P',NULL,'grooming','blr',400,0,400,'INR',?,'test','{}',?)").run(now-1000,now);globalThis.__PAWSPACE_TEST_ENV__={};const answer=await atlas.answerAtlasBusinessQuestion(db,{question:"How are we doing?",missionId:"M2",asOf:now});assert.equal(answer.narrativeAvailable,false);assert.match(answer.content,/Narrative unavailable; numbers only/);assert.match(answer.content,/collected INR 400/);});
test("tighten-only rejects inflated achievement and unauthorized activation language",async()=>{const{db,now}=world();const snapshot={asOf:now,mission:{value:{id:"M",target:1000,booked:500,collected:400,refunded:0,net:400,achieved:400,percent:40,period:{start:1,end:2},basis:"collected",pipeline_weighted:null,pipeline_unweighted:null,forecast:null},source:"fixture",asOf:now},bookings:{value:[],source:"fixture",asOf:now},ops:{open_cases:{value:0,source:"fixture",asOf:now},sla_breaches:{value:0,source:"fixture",asOf:now},sitting_pending_accepts:{value:0,source:"fixture",asOf:now},boarding_pending_accepts:{value:0,source:"fixture",asOf:now},cash_collection_holds:{value:null,source:"fixture",asOf:now,reason:"not_available"}},finance:{invoice_completed_gap:{value:{completed_jobs:0,issued_invoices:0,gap:0},source:"fixture",asOf:now},trainer_earnings:{value:{pending_rate:0,held_payment:0,earned:0,published_uat_rates:0},source:"fixture",asOf:now}},integrations:{payments:{value:false,source:"fixture",asOf:now},maps:{value:false,source:"fixture",asOf:now},whatsapp:{value:false,source:"fixture",asOf:now},ai:{value:false,source:"fixture",asOf:now}},limitations:[],insufficient_data:false,production_ready:false};assert.equal(atlas.atlasNarrativeIsTightEnough(snapshot,"We achieved 100% of target").ok,false);assert.equal(atlas.atlasNarrativeIsTightEnough(snapshot,"Activate all campaigns now").ok,false);const proposal=await atlas.recordAtlasProposal(db,{proposalType:"campaign_activation",summary:"Consider campaign",snapshot,basisId:"fixture",riskClass:"high",action:{type:"campaign.activate",campaignId:"C1"},createdBy:"test"});assert.equal(proposal.status,"proposed");assert.equal(proposal.executed,false);assert.ok(proposal.sourceIds.length>0);});
test("existing registry keeps money and provider/campaign tools approval gated",async()=>{const fs=await import("node:fs");const source=fs.readFileSync(new URL("../lib/ai-tool-registry.ts",import.meta.url),"utf8");for(const code of["refund.issue","payment.capture","payout.release","provider.assign","campaign.activate"])assert.match(source,new RegExp('code:"'+code.replace(".","\\.")+'",mode:"approval_gated"'));assert.match(source,/status:"approval_required",executed:false/);});

test("tighten-only blocks all four prohibited model-output classes",async()=>{
 const now=2_000_000_000_000,snapshot={asOf:now,mission:{value:{id:"M",target:1000,booked:500,collected:400,refunded:50,net:350,achieved:350,percent:35,period:{start:1,end:2},basis:"net_collected",pipeline_weighted:null,pipeline_unweighted:null,forecast:null},source:"fixture",asOf:now},bookings:{value:[],source:"fixture",asOf:now},ops:{open_cases:{value:0,source:"fixture",asOf:now},sla_breaches:{value:0,source:"fixture",asOf:now},sitting_pending_accepts:{value:0,source:"fixture",asOf:now},boarding_pending_accepts:{value:0,source:"fixture",asOf:now},cash_collection_holds:{value:null,source:"fixture",asOf:now,reason:"not_available"}},finance:{invoice_completed_gap:{value:{completed_jobs:0,issued_invoices:0,gap:0},source:"fixture",asOf:now},trainer_earnings:{value:{pending_rate:0,held_payment:0,earned:0,published_uat_rates:0},source:"fixture",asOf:now}},integrations:{payments:{value:false,source:"fixture",asOf:now},maps:{value:false,source:"fixture",asOf:now},whatsapp:{value:false,source:"fixture",asOf:now},ai:{value:false,source:"fixture",asOf:now}},limitations:[],insufficient_data:false,production_ready:false};
 assert.deepEqual(atlas.atlasNarrativeIsTightEnough(snapshot,"Collected INR 1,000 and achieved INR 900."),{ok:false,reason:"narrative_overstates_achievement"});
 assert.deepEqual(atlas.atlasNarrativeIsTightEnough(snapshot,"I activated all campaigns."),{ok:false,reason:"narrative_claims_campaign_execution"});
 assert.deepEqual(atlas.atlasNarrativeIsTightEnough(snapshot,"I assigned provider P-123 to the booking."),{ok:false,reason:"narrative_claims_provider_assignment"});
 assert.deepEqual(atlas.atlasNarrativeIsTightEnough(snapshot,"I captured the payment and refunded INR 100."),{ok:false,reason:"narrative_claims_money_movement"});
});
test("proposal journal supports proposed approved rejected executed lifecycle without executing itself",async()=>{
 const{db,now}=world(),snapshot={asOf:now,mission:{value:null,source:"fixture",asOf:now,reason:"fixture"},bookings:{value:[],source:"fixture",asOf:now},ops:{open_cases:{value:0,source:"fixture",asOf:now},sla_breaches:{value:0,source:"fixture",asOf:now},sitting_pending_accepts:{value:0,source:"fixture",asOf:now},boarding_pending_accepts:{value:0,source:"fixture",asOf:now},cash_collection_holds:{value:null,source:"fixture",asOf:now,reason:"not_available"}},finance:{invoice_completed_gap:{value:null,source:"fixture",asOf:now,reason:"fixture"},trainer_earnings:{value:null,source:"fixture",asOf:now,reason:"fixture"}},integrations:{payments:{value:false,source:"fixture",asOf:now},maps:{value:false,source:"fixture",asOf:now},whatsapp:{value:false,source:"fixture",asOf:now},ai:{value:false,source:"fixture",asOf:now}},limitations:["fixture"],insufficient_data:true,production_ready:false};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:"staffing_hold",summary:"Hold hiring pending verified demand.",snapshot,basisId:"fixture",riskClass:"medium",createdBy:"atlas"});
 assert.equal(proposal.status,"proposed");assert.equal(proposal.executed,false);
 assert.equal((await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"proposed",to:"approved",actorId:"founder@pawspace.test"})).updated,true);
 assert.equal((await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"approved",to:"executed",actorId:"founder@pawspace.test"})).updated,true);
 const rows=await atlas.listAtlasProposals(db,5);assert.equal(rows[0].status,"executed");assert.equal(typeof rows[0].source_ids_json,"string");
});

test("daily founder analysis uses canonical mission snapshot and ignores misleading Tally benchmarks",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);await atlasData.ensureAtlasTables(db);
 sqlite.exec("CREATE TABLE governed_marketing_campaigns(id TEXT PRIMARY KEY,name TEXT,approval_status TEXT,status TEXT,updated_at INTEGER); INSERT INTO governed_marketing_campaigns VALUES ('CAMP1','Approved UAT campaign','approved','approved',2000000000000);");
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('MD','Daily UAT mission',1000,'INR',?,?,?,'collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+10000,JSON.stringify({type:"company"}),now-10000,now);
 sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('DC','MD','daily-collected','collected','C','B','P',NULL,'grooming','blr',400,0,400,'INR',?,'test','{}',?)").run(now-1000,now);
 sqlite.prepare("INSERT INTO analytics_historical_financials (id,source_kind,source_file,source_row,entry_date,period_month,currency,revenue_amount,cost_amount,payment_amount,net_amount,raw_json,ingest_batch_id,ingested_at) VALUES ('T1','tally','fake.csv',1,'2033-05-01','2033-05','INR',999999,0,0,999999,'{}','BATCH',?)").run(now);
 globalThis.__PAWSPACE_TEST_ENV__={};
 const result=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});
 assert.equal(result.facts.missionId,'MD');assert.equal(result.facts.target,1000);assert.equal(result.facts.net,400);assert.equal(Math.round(result.facts.achievedPercent),40);
 assert.ok(Math.abs(result.facts.elapsedPercent-50)<0.01);assert.equal(result.facts.expectedToDate,500);assert.equal(result.facts.pacingGapPercent,-20);
 assert.equal('priorYearRevenue' in result.facts,false);assert.equal('historicalImportedRevenue' in result.facts,false);assert.equal('targetToDate' in result.facts,false);assert.equal(result.tallyMemoryUsed,false);assert.equal(result.productionReady,false);
 assert.deepEqual(result.action,{type:'campaign.activate',campaignId:'CAMP1'});assert.equal(result.externalMutation,false);
 const proposal=sqlite.prepare("SELECT proposal_type,status,basis_id FROM atlas_proposals ORDER BY created_at DESC LIMIT 1").get();
 assert.equal(proposal.proposal_type,'campaign_activation');assert.equal(proposal.status,'proposed');assert.match(proposal.basis_id,/^daily:.*:MD$/);
});


test("Founder approval transitions only the exact linked Atlas proposal",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await marketing.ensureMarketingGovernance(db);
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),action={type:"campaign.activate",campaignId:"C-EXACT"};
 const p1=await atlas.recordAtlasProposal(db,{proposalType:"campaign_activation",summary:"Proposal one",snapshot,basisId:"B1",riskClass:"high",action,createdBy:"atlas"});
 const p2=await atlas.recordAtlasProposal(db,{proposalType:"campaign_activation",summary:"Proposal two",snapshot,basisId:"B2",riskClass:"high",action,createdBy:"atlas"});
 sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,approved_by,approved_at,created_by,created_at,updated_at) VALUES ('C-EXACT','Exact binding','retention','grooming','blr','{}',1000,'INR',10,'approved','approved','founder@pawspace.test',?,'founder@pawspace.test',?,?)").run(now,now,now);
 sqlite.prepare("INSERT INTO marketing_audience_snapshots (id,campaign_id,snapshot_at,total_candidates,eligible_count,holdout_count,suppressed_count,policy_json,created_by) VALUES ('AUD-EXACT','C-EXACT',?,0,0,0,0,'{}','founder@pawspace.test')").run(now);
 const m1=await atlasData.recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:"Activate exact campaign?",action,actionStatus:"approval_required",proposalId:p1.id,createdAt:now});
 const m2=await atlasData.recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:"Same action, second proposal",action,actionStatus:"approval_required",proposalId:p2.id,createdAt:now+1});
 const result=await atlasData.executeAtlasApprovedAction(db,{messageId:m1.messageId,actorEmail:"founder@pawspace.test"});
 assert.equal(result.status,"executed");assert.equal(result.proposalId,p1.id);assert.equal(result.journalUpdated,true);
 const rows=sqlite.prepare("SELECT id,status FROM atlas_proposals WHERE id IN (?,?) ORDER BY id").all(p1.id,p2.id);const byId=Object.fromEntries(rows.map(r=>[r.id,r.status]));
 assert.equal(byId[p1.id],"executed");assert.equal(byId[p2.id],"proposed");
 const second=sqlite.prepare("SELECT action_status,proposal_id FROM atlas_chat_messages WHERE id=?").get(m2.messageId);assert.equal(second.action_status,"approval_required");assert.equal(second.proposal_id,p2.id);
 const legacy=await atlasData.recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:"Legacy action",action,actionStatus:"approval_required",createdAt:now+2});
 const error=await atlasData.executeAtlasApprovedAction(db,{messageId:legacy.messageId,actorEmail:"founder@pawspace.test"}).then(()=>null,e=>e);
 assert.equal(error instanceof Response,true);assert.equal(error.status,409);assert.equal(await error.text(),"Atlas proposal journal link is required");
});


test("executing Atlas approval recovers from canonical active campaign without duplicate activation",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await marketing.ensureMarketingGovernance(db);
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),action={type:"campaign.activate",campaignId:"C-RECOVER"};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:"campaign_activation",summary:"Recover",snapshot,basisId:"REC",riskClass:"high",action,createdBy:"atlas"});
 await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"proposed",to:"approved",actorId:"founder@pawspace.test"});
 sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,approved_by,approved_at,created_by,created_at,updated_at) VALUES ('C-RECOVER','Recover','retention','grooming','blr','{}',1000,'INR',10,'active','approved','founder@pawspace.test',?,'founder@pawspace.test',?,?)").run(now,now,now);
 const message=await atlasData.recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:"Recover action",action,actionStatus:"executing",proposalId:proposal.id,createdAt:now});
 const result=await atlasData.executeAtlasApprovedAction(db,{messageId:message.messageId,actorEmail:"founder@pawspace.test"});
 assert.equal(result.status,"executed");assert.equal(result.recovered,true);assert.equal(result.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT status FROM atlas_proposals WHERE id=?").get(proposal.id).status,"executed");assert.equal(sqlite.prepare("SELECT action_status FROM atlas_chat_messages WHERE id=?").get(message.messageId).action_status,"executed");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_governance_events WHERE campaign_id='C-RECOVER' AND event_type='activated'").get().n,0);
});

test("daily retry reuses existing campaign proposal for same day mission and action",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);await atlasData.ensureAtlasTables(db);
 sqlite.exec("CREATE TABLE governed_marketing_campaigns(id TEXT PRIMARY KEY,name TEXT,approval_status TEXT,status TEXT,updated_at INTEGER); INSERT INTO governed_marketing_campaigns VALUES ('C-RETRY','Retry campaign','approved','approved',2000000000000);");
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('MR','Retry mission',1000,'INR',?,?,?,'collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+10000,JSON.stringify({type:'company'}),now-10000,now);
 sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('RC','MR','retry-collected','collected','C','B','P',NULL,'grooming','blr',400,0,400,'INR',?,'test','{}',?)").run(now-1000,now);globalThis.__PAWSPACE_TEST_ENV__={};
 const first=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});const count1=sqlite.prepare("SELECT COUNT(*) n FROM atlas_proposals WHERE proposal_type='campaign_activation'").get().n;
 sqlite.prepare("UPDATE atlas_daily_runs SET status='failed',summary_json='{}',completed_at=NULL WHERE day_key=?").run(first.dayKey);const second=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});const count2=sqlite.prepare("SELECT COUNT(*) n FROM atlas_proposals WHERE proposal_type='campaign_activation'").get().n;
 assert.equal(count1,1);assert.equal(count2,1);assert.deepEqual(second.action,{type:'campaign.activate',campaignId:'C-RETRY'});
});
