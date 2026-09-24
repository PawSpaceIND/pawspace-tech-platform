import test from "node:test";
const calibration=await import('../lib/intelligence/atlas-outcome-calibration.ts');
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__ATLAS_SNAPSHOT_DB__","__PAWSPACE_TEST_ENV__");
const atlas=await import("../lib/intelligence/atlas-business-snapshot.ts");
const atlasData=await import("../lib/intelligence/atlas-data.ts");
const freshnessBuilder=await import("../lib/intelligence/atlas-proposal-freshness.ts");
const challengeBuilder=await import("../lib/intelligence/atlas-challenge-review.ts");
const qualityBuilder=await import("../lib/intelligence/atlas-decision-quality.ts");
const consistencyBuilder=await import("../lib/intelligence/atlas-recommendation-consistency.ts");
const revenue=await import("../lib/revenue-mission-control.ts");
const marketing=await import("../lib/marketing-governance.ts");

function makeD1(sqlite){
 const statement=(sql,args=[])=>({bind:(...values)=>statement(sql,values),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const r=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes)}}}});
 return{prepare:sql=>statement(sql),batch:async items=>{sqlite.exec("BEGIN");try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out}catch(e){sqlite.exec("ROLLBACK");throw e}}};
}
function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite),now=2_000_000_000_000;
 sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,service_code TEXT,status TEXT); CREATE TABLE booking_invoices(id TEXT PRIMARY KEY,booking_id TEXT,issued_at INTEGER); CREATE TABLE unified_cases(id TEXT PRIMARY KEY,status TEXT,first_responded_at INTEGER,first_response_due_at INTEGER,resolution_due_at INTEGER); CREATE TABLE provider_assignment_offers(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE ops_completion_controls(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE training_session_earnings(session_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE training_compensation_rules(id TEXT PRIMARY KEY,status TEXT);");
 sqlite.exec("INSERT INTO canonical_bookings VALUES ('B1','grooming','completed'),('B2','grooming','assigned'),('B3','dog_training','cancelled'); INSERT INTO booking_invoices VALUES ('I1','B2',1999999999000); INSERT INTO unified_cases VALUES ('C1','open',NULL,1999999999000,2000000001000); INSERT INTO provider_assignment_offers VALUES ('O1','pending'); INSERT INTO ops_completion_controls VALUES ('H1','collection_hold'); INSERT INTO training_session_earnings VALUES ('E1','pending_rate_configuration'),('E2','earned'); INSERT INTO training_compensation_rules VALUES ('R1','published');");
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
 assert.deepEqual(result.action,{type:'campaign.activate',campaignId:'CAMP1'});assert.equal(result.externalMutation,false);assert.ok(result.operatingTasks.length>=2);const autoRows=sqlite.prepare("SELECT action_code,artifact_type FROM atlas_operating_artifacts ORDER BY created_at").all();assert.ok(autoRows.some(row=>row.action_code==='brief.generate'&&row.artifact_type==='brief'));assert.ok(autoRows.some(row=>row.action_code==='task.draft'&&row.artifact_type==='task_draft'));
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

test("daily analysis reclaims a stale running lease",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);globalThis.__PAWSPACE_TEST_ENV__={};
 const dayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
 sqlite.prepare("INSERT INTO atlas_daily_runs (day_key,run_id,status,summary_json,created_at,completed_at) VALUES (?,?,\'running\',\'{}\',?,NULL)").run(dayKey,"STALE-RUN",now-(31*60*1000));
 const result=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});
 assert.equal(result.status,"completed");assert.equal(result.recoveredStaleRun,true);assert.notEqual(result.runId,"STALE-RUN");
 const stored=sqlite.prepare("SELECT run_id,status FROM atlas_daily_runs WHERE day_key=?").get(dayKey);assert.equal(stored.run_id,result.runId);assert.equal(stored.status,"completed");
});

test("daily analysis preserves a fresh running lease",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);globalThis.__PAWSPACE_TEST_ENV__={};
 const dayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
 sqlite.prepare("INSERT INTO atlas_daily_runs (day_key,run_id,status,summary_json,created_at,completed_at) VALUES (?,?,\'running\',\'{}\',?,NULL)").run(dayKey,"FRESH-RUN",now-(5*60*1000));
 const result=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});
 assert.deepEqual(result,{status:"already_running",duplicatePrevented:true});
 assert.equal(sqlite.prepare("SELECT run_id,status FROM atlas_daily_runs WHERE day_key=?").get(dayKey).run_id,"FRESH-RUN");
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


test("Founder approval rejects proposal/message action mismatch and restores approval state",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await marketing.ensureMarketingGovernance(db);
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),proposalAction={type:"campaign.activate",campaignId:"C-A"},messageAction={type:"campaign.activate",campaignId:"C-B"};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:"campaign_activation",summary:"Bound to A",snapshot,basisId:"MISMATCH",riskClass:"high",action:proposalAction,createdBy:"atlas"});
 const message=await atlasData.recordAtlasMessage(db,{role:"atlas",actorEmail:"system:atlas",content:"Mismatched action",action:messageAction,actionStatus:"approval_required",proposalId:proposal.id,createdAt:now});
 const error=await atlasData.executeAtlasApprovedAction(db,{messageId:message.messageId,actorEmail:"founder@pawspace.test"}).then(()=>null,e=>e);
 assert.equal(error instanceof Response,true);assert.equal(error.status,409);assert.equal(await error.text(),"Atlas proposal action binding mismatch");
 assert.equal(sqlite.prepare("SELECT action_status FROM atlas_chat_messages WHERE id=?").get(message.messageId).action_status,"approval_required");
 assert.equal(sqlite.prepare("SELECT status FROM atlas_proposals WHERE id=?").get(proposal.id).status,"proposed");
});


test("proposal status helper is exact-id only and enforces lifecycle transitions",async()=>{
 const{db,now}=world(),snapshot={asOf:now,mission:{value:null,source:"fixture",asOf:now,reason:"fixture"},bookings:{value:[],source:"fixture",asOf:now},ops:{open_cases:{value:0,source:"fixture",asOf:now},sla_breaches:{value:0,source:"fixture",asOf:now},sitting_pending_accepts:{value:0,source:"fixture",asOf:now},boarding_pending_accepts:{value:0,source:"fixture",asOf:now},cash_collection_holds:{value:null,source:"fixture",asOf:now,reason:"not_available"}},finance:{invoice_completed_gap:{value:null,source:"fixture",asOf:now,reason:"fixture"},trainer_earnings:{value:null,source:"fixture",asOf:now,reason:"fixture"}},integrations:{payments:{value:false,source:"fixture",asOf:now},maps:{value:false,source:"fixture",asOf:now},whatsapp:{value:false,source:"fixture",asOf:now},ai:{value:false,source:"fixture",asOf:now}},limitations:["fixture"],insufficient_data:true,production_ready:false};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:"staffing_hold",summary:"Hold",snapshot,basisId:"STATE",riskClass:"medium",createdBy:"atlas"});
 assert.equal((await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"proposed",to:"rejected",actorId:"founder@pawspace.test"})).updated,true);
 await assert.rejects(()=>atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"rejected",to:"approved",actorId:"founder@pawspace.test"}),/Invalid Atlas proposal transition rejected->approved/);
 await assert.rejects(()=>atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:"rejected",to:"executed",actorId:"founder@pawspace.test"}),/Invalid Atlas proposal transition rejected->executed/);
 const source=(await import("node:fs")).readFileSync(new URL("../lib/intelligence/atlas-business-snapshot.ts",import.meta.url),"utf8");
 assert.doesNotMatch(source,/proposalType\?:string/);assert.doesNotMatch(source,/actionJson\?:Record/);assert.match(source,/WHERE id=\? AND status=\?/);
});


test("daily retry never re-offers rejected or executed terminal proposals",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);await atlasData.ensureAtlasTables(db);
 sqlite.exec("CREATE TABLE governed_marketing_campaigns(id TEXT PRIMARY KEY,name TEXT,approval_status TEXT,status TEXT,updated_at INTEGER); INSERT INTO governed_marketing_campaigns VALUES ('C-TERM','Terminal campaign','approved','approved',2000000000000);");
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('MT','Terminal retry mission',1000,'INR',?,?,?,'collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+10000,JSON.stringify({type:'company'}),now-10000,now);
 sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('TC','MT','terminal-collected','collected','C','B','P',NULL,'grooming','blr',400,0,400,'INR',?,'test','{}',?)").run(now-1000,now);globalThis.__PAWSPACE_TEST_ENV__={};
 const first=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});const proposal=sqlite.prepare("SELECT id FROM atlas_proposals WHERE proposal_type='campaign_activation' ORDER BY created_at DESC LIMIT 1").get();
 await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:'proposed',to:'rejected',actorId:'founder@pawspace.test'});
 sqlite.prepare("UPDATE atlas_daily_runs SET status='failed',summary_json='{}',completed_at=NULL WHERE day_key=?").run(first.dayKey);
 const second=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});assert.equal(second.action,null);
 const latest=sqlite.prepare("SELECT action_status,proposal_id,content FROM atlas_chat_messages WHERE role='atlas' ORDER BY created_at DESC LIMIT 1").get();assert.equal(latest.action_status,null);assert.equal(latest.proposal_id,null);assert.match(latest.content,/already rejected; Atlas will not re-offer/);
 sqlite.prepare("UPDATE atlas_proposals SET status='executed' WHERE id=?").run(proposal.id);sqlite.prepare("UPDATE atlas_daily_runs SET status='failed',summary_json='{}',completed_at=NULL WHERE day_key=?").run(first.dayKey);
 const third=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});assert.equal(third.action,null);const latest2=sqlite.prepare("SELECT action_status,proposal_id,content FROM atlas_chat_messages WHERE role='atlas' ORDER BY created_at DESC LIMIT 1").get();assert.equal(latest2.action_status,null);assert.equal(latest2.proposal_id,null);assert.match(latest2.content,/already executed; Atlas will not re-offer/);
});


test("invoice gap counts only invoices linked to completed canonical bookings",async()=>{
 const{db,now}=world();const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now});
 assert.deepEqual(snapshot.finance.invoice_completed_gap.value,{completed_jobs:1,issued_invoices:0,gap:1});
 assert.equal(snapshot.finance.invoice_completed_gap.source,"canonical_bookings + booking_invoices");
});

test("integration flags reuse canonical credential detectors instead of partial secret heuristics",async()=>{
 const{db,now}=world();
 globalThis.__PAWSPACE_TEST_ENV__={
  PAWSPACE_PAYMENT_ENV:"sandbox",
  META_WHATSAPP_UAT_ACCESS_TOKEN:"token",
  META_WHATSAPP_PHONE_NUMBER_ID:"phone",
  PAWSPACE_COMMUNICATION_ENV:"uat",
  META_WHATSAPP_UAT_DELIVERY_ENABLED:"true",
  GOOGLE_MAPS_SERVER_API_KEY_UAT:"maps",
  PAWSPACE_AI_PROVIDER_API_KEY:"ai-key"
 };
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now});
 assert.equal(snapshot.integrations.payments.value,false,"payment env alone is not sandbox readiness");
 assert.equal(snapshot.integrations.whatsapp.value,false,"token + phone alone are not Meta UAT readiness");
 assert.equal(snapshot.integrations.maps.value,true);
 assert.equal(snapshot.integrations.ai.value,true);
 assert.match(snapshot.integrations.whatsapp.source,/integration-readiness credential detector/);
 globalThis.__PAWSPACE_TEST_ENV__={};
});

test("Atlas proposal outcome waits seven days and records observed non-causal mission change",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);await atlas.ensureAtlasProposalJournal(db);
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('MO','Outcome mission',5000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-10000,now+atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS+10000,JSON.stringify({type:'company'}),now-10000,now);
 const ins=sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 ins.run('OB1','MO','baseline-collected','collected','C','B1','P1',null,'grooming','blr',400,0,400,'INR',now-1000,'test','{}',now);
 const baseline=await atlas.buildAtlasBusinessSnapshot(db,{missionId:'MO',asOf:now});
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:'campaign_activation',summary:'Measure after execution',snapshot:baseline,basisId:'OUTCOME',riskClass:'high',action:{type:'campaign.activate',campaignId:'C-OUTCOME'},createdBy:'atlas'});
 await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:'proposed',to:'approved',actorId:'founder@pawspace.test'});await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:'approved',to:'executed',actorId:'founder@pawspace.test'});
 const first=await atlas.recordAtlasProposalOutcomeBaseline(db,{proposalId:proposal.id,snapshot:baseline,asOf:now});
 const duplicate=await atlas.recordAtlasProposalOutcomeBaseline(db,{proposalId:proposal.id,snapshot:baseline,asOf:now+1});
 assert.equal(first.recorded,true);assert.equal(first.status,'pending');assert.equal(duplicate.recorded,false);
 assert.deepEqual(await atlas.refreshAtlasProposalOutcomes(db,{asOf:now+atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS-1}),{evaluated:0,measured:0,insufficient:0,windowMs:atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS,causalAttribution:false});
 ins.run('OB2','MO','later-collected','collected','C','B2','P2',null,'grooming','blr',125,0,125,'INR',now+atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS,'test','{}',now+atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS);
 const refreshed=await atlas.refreshAtlasProposalOutcomes(db,{asOf:now+atlas.ATLAS_PROPOSAL_OUTCOME_WINDOW_MS+1});assert.equal(refreshed.measured,1);assert.equal(refreshed.causalAttribution,false);
 const outcome=(await atlas.listAtlasProposalOutcomes(db,5))[0];assert.equal(outcome.status,'measured');assert.equal(outcome.mission_id,'MO');assert.equal(outcome.baseline_net,400);assert.equal(outcome.observed_net,525);assert.equal(outcome.observed_net_delta,125);assert.equal(outcome.observed_collected_delta,125);assert.match(outcome.attribution_note,/not causal attribution/i);
});

test("recovered already-active campaign does not fabricate an Atlas outcome baseline",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await marketing.ensureMarketingGovernance(db);
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),action={type:'campaign.activate',campaignId:'C-RECOVER-NO-BASELINE'};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:'campaign_activation',summary:'Recovered active campaign',snapshot,basisId:'REC-NO-BASELINE',riskClass:'high',action,createdBy:'atlas'});
 await atlas.updateAtlasProposalStatus(db,{id:proposal.id,from:'proposed',to:'approved',actorId:'founder@pawspace.test'});
 sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,approved_by,approved_at,created_by,created_at,updated_at) VALUES ('C-RECOVER-NO-BASELINE','Recovered','retention','grooming','blr','{}',1000,'INR',10,'active','approved','founder@pawspace.test',?,'founder@pawspace.test',?,?)").run(now,now,now);
 const message=await atlasData.recordAtlasMessage(db,{role:'atlas',actorEmail:'system:atlas',content:'Already active',action,actionStatus:'executing',proposalId:proposal.id,createdAt:now});
 const result=await atlasData.executeAtlasApprovedAction(db,{messageId:message.messageId,actorEmail:'founder@pawspace.test'});assert.equal(result.recovered,true);
 await atlas.ensureAtlasProposalOutcomes(db);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM atlas_proposal_outcomes WHERE proposal_id=?").get(proposal.id).n,0);
});

test("team AI labels proposal outcome measurements as observed rather than causal",async()=>{
 const fs=await import('node:fs');const page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8'),route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8');
 assert.match(page,/proposal outcomes .* observed, not causal/i);assert.match(page,/does not prove the campaign caused the change/i);assert.match(route,/proposalOutcomes/);
});

test("default Atlas snapshot refuses expired active mission while explicit historical lookup remains available",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M-EXPIRED','Expired mission',1000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(now-20000,now-10000,JSON.stringify({type:'company'}),now-20000,now-10000);
 const current=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now});assert.equal(current.mission.value,null);assert.equal(current.mission.reason,'current_mission_not_found');assert.match(current.limitations.join(' '),/expired or future mission/i);
 const historical=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now,missionId:'M-EXPIRED'});assert.equal(historical.mission.value.id,'M-EXPIRED');assert.equal(historical.mission.value.target,1000);
});

test("daily Atlas does not propose an out-of-period approved campaign",async()=>{
 const{sqlite,db,now}=world();await revenue.ensureRevenueMissionTables(db);await atlasData.ensureAtlasTables(db);
 const start=now-10000,end=now+10000;sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M-CURRENT','Current mission',1000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(start,end,JSON.stringify({type:'company'}),start,now);
 sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,payment_id,refund_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES ('MC1','M-CURRENT','mc1','collected','C','B','P',NULL,'grooming','blr',100,0,100,'INR',?,'test','{}',?)").run(now-1000,now);
 sqlite.exec("CREATE TABLE governed_marketing_campaigns(id TEXT PRIMARY KEY,name TEXT,approval_status TEXT,status TEXT,updated_at INTEGER);");sqlite.prepare("INSERT INTO governed_marketing_campaigns VALUES ('OLD-CAMP','Old approved campaign','approved','approved',?)").run(start-1);
 globalThis.__PAWSPACE_TEST_ENV__={};const result=await atlasData.runAtlasDailyAnalysis(db,{asOf:now});assert.equal(result.facts.missionId,'M-CURRENT');assert.ok(result.facts.pacingGapPercent<=-10);assert.equal(result.action,null);await atlas.ensureAtlasProposalJournal(db);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM atlas_proposals WHERE proposal_type='campaign_activation'").get().n,0);
});

test("Founder approval revalidates daily proposal freshness and rejects an expired mission before campaign execution",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await revenue.ensureRevenueMissionTables(db);await marketing.ensureMarketingGovernance(db);
 const expiredStart=now-30000,expiredEnd=now-20000;
 sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M-OLD','Old mission',1000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(expiredStart,expiredEnd,JSON.stringify({type:'company'}),expiredStart,expiredEnd);
 const historical=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now,missionId:'M-OLD'}),action={type:'campaign.activate',campaignId:'C-STALE-EXEC'};
 const proposal=await atlas.recordAtlasProposal(db,{proposalType:'campaign_activation',summary:'Old daily proposal',snapshot:historical,basisId:'daily:2033-05-18:M-OLD',riskClass:'high',action,createdBy:'system:atlas'});
 sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,approved_by,approved_at,created_by,created_at,updated_at) VALUES ('C-STALE-EXEC','Old campaign','retention','grooming','blr','{}',1000,'INR',10,'approved','approved','founder@pawspace.test',?,'founder@pawspace.test',?,?)").run(expiredStart,expiredStart,expiredStart);
 sqlite.prepare("INSERT INTO marketing_audience_snapshots (id,campaign_id,snapshot_at,total_candidates,eligible_count,holdout_count,suppressed_count,policy_json,created_by) VALUES ('AUD-STALE-EXEC','C-STALE-EXEC',?,0,0,0,0,'{}','founder@pawspace.test')").run(expiredStart);
 const message=await atlasData.recordAtlasMessage(db,{role:'atlas',actorEmail:'system:atlas',content:'Old activation?',action,actionStatus:'approval_required',proposalId:proposal.id,createdAt:now-1000});
 const error=await atlasData.executeAtlasApprovedAction(db,{messageId:message.messageId,actorEmail:'founder@pawspace.test',asOf:now}).then(()=>null,e=>e);
 assert.equal(error instanceof Response,true);assert.equal(error.status,409);assert.equal(await error.text(),'Atlas campaign proposal is stale and has been rejected');
 assert.equal(sqlite.prepare("SELECT status FROM atlas_proposals WHERE id=?").get(proposal.id).status,'rejected');assert.equal(sqlite.prepare("SELECT action_status FROM atlas_chat_messages WHERE id=?").get(message.messageId).action_status,'rejected');
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_governance_events WHERE campaign_id='C-STALE-EXEC' AND event_type='activated'").get().n,0);
});

test("Founder approval still executes a fresh daily proposal inside the current mission period",async()=>{
 const{sqlite,db,now}=world();await atlasData.ensureAtlasTables(db);await revenue.ensureRevenueMissionTables(db);await marketing.ensureMarketingGovernance(db);
 const start=now-10000,end=now+10000;sqlite.prepare("INSERT INTO revenue_missions (id,name,target_amount,currency,period_start,period_end,scope_json,revenue_basis,status,approval_reference,config_version,created_by,created_at,updated_by,updated_at) VALUES ('M-FRESH','Fresh mission',1000,'INR',?,?,?,'net_collected','active_uat','APR',1,'owner',?,'owner',?)").run(start,end,JSON.stringify({type:'company'}),start,now);
 const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),action={type:'campaign.activate',campaignId:'C-FRESH-EXEC'};const proposal=await atlas.recordAtlasProposal(db,{proposalType:'campaign_activation',summary:'Fresh daily proposal',snapshot,basisId:'daily:2033-05-18:M-FRESH',riskClass:'high',action,createdBy:'system:atlas'});
 sqlite.prepare("INSERT INTO governed_marketing_campaigns (id,name,objective,service_code,city_id,audience_rule_json,budget_amount,currency,holdout_percent,status,approval_status,approved_by,approved_at,created_by,created_at,updated_at) VALUES ('C-FRESH-EXEC','Fresh campaign','retention','grooming','blr','{}',1000,'INR',10,'approved','approved','founder@pawspace.test',?,'founder@pawspace.test',?,?)").run(now,now,now);
 sqlite.prepare("INSERT INTO marketing_audience_snapshots (id,campaign_id,snapshot_at,total_candidates,eligible_count,holdout_count,suppressed_count,policy_json,created_by) VALUES ('AUD-FRESH-EXEC','C-FRESH-EXEC',?,0,0,0,0,'{}','founder@pawspace.test')").run(now);
 const message=await atlasData.recordAtlasMessage(db,{role:'atlas',actorEmail:'system:atlas',content:'Fresh activation?',action,actionStatus:'approval_required',proposalId:proposal.id,createdAt:now});const result=await atlasData.executeAtlasApprovedAction(db,{messageId:message.messageId,actorEmail:'founder@pawspace.test',asOf:now});
 assert.equal(result.status,'executed');assert.equal(sqlite.prepare("SELECT status FROM atlas_proposals WHERE id=?").get(proposal.id).status,'executed');assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM marketing_governance_events WHERE campaign_id='C-FRESH-EXEC' AND event_type='activated'").get().n,1);
});


test("Atlas outcome calibration is review-only, sample-gated and non-causal",async()=>{
 const{sqlite,db}=world();await atlas.ensureAtlasProposalOutcomes(db);
 const ins=sqlite.prepare("INSERT INTO atlas_proposal_outcomes (proposal_id,proposal_type,action_json,mission_id,baseline_net,baseline_collected,baseline_at,evaluate_after,observed_net,observed_collected,observed_net_delta,observed_collected_delta,evaluated_at,status,reason,attribution_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'measured',NULL,?)");
 for(let i=0;i<4;i++)ins.run('CAL-'+i,'campaign_activation','{}','M',100,100,i,i,100+(i-1)*10,100+(i-1)*10,(i-1)*10,(i-1)*10,i,'Observed only; not causal');
 let rows=await calibration.buildAtlasOutcomeCalibration(db);assert.equal(rows.length,1);assert.equal(rows[0].measured,4);assert.equal(rows[0].usableForReview,false);assert.equal(rows[0].confidenceMutationAllowed,false);assert.equal(rows[0].causalAttribution,false);
 ins.run('CAL-4','campaign_activation','{}','M',100,100,5,5,130,130,30,30,5,'Observed only; not causal');
 rows=await calibration.buildAtlasOutcomeCalibration(db);assert.equal(rows[0].measured,5);assert.equal(rows[0].usableForReview,true);assert.equal(rows[0].positive,3);assert.equal(rows[0].flat,1);assert.equal(rows[0].negative,1);assert.match(rows[0].note,/human calibration review only/i);
});

test("Atlas business snapshot API exposes calibration evidence without automatic confidence mutation",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');
 assert.match(route,/outcomeCalibration=await buildAtlasOutcomeCalibration/);assert.match(page,/calibration evidence .* review only/i);assert.match(page,/does not automatically alter confidence, policies, budgets or approval gates/i);
});

test("Atlas decision quality scores process only and keeps outcome non-causal",async()=>{
 const quality=await import('../lib/intelligence/atlas-decision-quality.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);await atlas.ensureAtlasProposalOutcomes(db);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at,reviewed_by,reviewed_at,executed_at) VALUES ('DQ1','campaign_activation','x','h','b',?,'high','executed','{}','atlas',?,'founder',?,?)").run(JSON.stringify(['s1','s2','s3','s4']),now-30*60*1000,now,now);
 sqlite.prepare("INSERT INTO atlas_proposal_outcomes (proposal_id,proposal_type,action_json,mission_id,baseline_net,baseline_collected,baseline_at,evaluate_after,observed_net,observed_collected,observed_net_delta,observed_collected_delta,evaluated_at,status,reason,attribution_note) VALUES ('DQ1','campaign_activation','{}','M',100,100,?,?,50,50,-50,-50,?,'measured',NULL,'not causal')").run(now,now,now);
 const first=(await quality.buildAtlasDecisionQuality(db,5))[0];assert.equal(first.score,100);assert.equal(first.dimensions.grounding,100);assert.equal(first.dimensions.reviewTimeliness,100);assert.equal(first.dimensions.resolution,100);assert.equal(first.outcome.direction,'negative');assert.equal(first.outcome.causalAttribution,false);assert.equal(first.authorityMutationAllowed,false);assert.match(first.note,/business outcomes.*do not affect the score/i);
});

test("Team AI exposes advisory-only decision quality without authority mutation",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/decisionQuality=await buildAtlasDecisionQuality/);assert.match(page,/decision quality .* advisory only/i);assert.match(page,/never changes the score, authority or confidence/i);
});

test("Atlas recommendation consistency flags only exact-evidence action divergence",async()=>{
 const consistency=await import('../lib/intelligence/atlas-recommendation-consistency.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);
 const ins=sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES (?,?,?,?,?,'[]','high','proposed',?,'atlas',?)");
 ins.run('RC1','campaign_activation','x','SAME','b1',JSON.stringify({type:'campaign.activate',campaignId:'A'}),now-3);
 ins.run('RC2','campaign_activation','x','SAME','b2',JSON.stringify({campaignId:'A',type:'campaign.activate'}),now-2);
 ins.run('RC3','campaign_activation','x','SAME','b3',JSON.stringify({type:'campaign.activate',campaignId:'B'}),now-1);
 ins.run('RC4','campaign_activation','x','OTHER','b4',JSON.stringify({type:'campaign.activate',campaignId:'C'}),now);
 const rows=await consistency.buildAtlasRecommendationConsistency(db,10);const group=rows.find(x=>x.snapshotHash==='SAME');assert.equal(group.proposalCount,3);assert.equal(group.distinctActions,2);assert.equal(group.consistent,false);assert.equal(group.requiresFounderReview,true);assert.equal(group.advisoryOnly,true);assert.equal(group.authorityMutationAllowed,false);assert.match(group.note,/Founder review is required/i);
 assert.equal(rows.some(x=>x.snapshotHash==='OTHER'),false,'single proposal is not a replay group');
});

test("Team AI exposes exact-evidence replay consistency without authority mutation",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/recommendationConsistency=await buildAtlasRecommendationConsistency/);assert.match(page,/recommendation consistency .* replay review/i);assert.match(page,/same recorded snapshot hash and proposal type/i);
});

test("Atlas challenge review surfaces missing evidence and contradictions without mutating authority",async()=>{
 const challenge=await import('../lib/intelligence/atlas-challenge-review.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now});
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES ('CH1','campaign_activation','x','','','[]','high','proposed',?,'atlas',?)").run(JSON.stringify({type:'campaign.activate',campaignId:'A'}),now);
 const rows=await challenge.buildAtlasChallengeReview(db,snapshot,5),r=rows[0];assert.equal(r.proposalId,'CH1');assert.equal(r.requiresFounderReview,true);assert.equal(r.advisoryOnly,true);assert.equal(r.authorityMutationAllowed,false);assert.ok(r.missingEvidence.includes('proposal_has_no_recorded_source_ids'));assert.ok(r.missingEvidence.includes('proposal_snapshot_hash_missing'));assert.ok(r.reasonsNotToAct.includes('high_risk_proposal_requires_human_approval'));assert.match(r.note,/never executes, rejects, approves/i);
});

test("Team AI exposes advisory dissent reasons before reusable precedent",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/challengeReview=await buildAtlasChallengeReview/);assert.match(page,/challenge review .* reasons not to act/i);assert.match(page,/missing evidence, contradictions and defer\/stop reasons/i);
});

test("Atlas proposal freshness requires re-evaluation when canonical snapshot changes",async()=>{
 const freshness=await import('../lib/intelligence/atlas-proposal-freshness.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),currentHash=await atlas.atlasSnapshotHash(snapshot);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES ('FR1','campaign_activation','x',?,'b','[]','high','proposed','{}','atlas',?)").run('old-hash',now);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES ('FR2','campaign_activation','x',?,'b','[]','high','proposed','{}','atlas',?)").run(currentHash,now-1);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES ('FR3','campaign_activation','x',?,'b','[]','high','executed','{}','atlas',?)").run('old-hash',now-2);
 const rows=await freshness.buildAtlasProposalFreshness(db,snapshot,10),stale=rows.find(x=>x.proposalId==='FR1'),fresh=rows.find(x=>x.proposalId==='FR2'),terminal=rows.find(x=>x.proposalId==='FR3');assert.equal(stale.requiresReevaluation,true);assert.equal(stale.reason,'canonical_snapshot_changed_since_proposal');assert.equal(stale.authorityMutationAllowed,false);assert.equal(fresh.fresh,true);assert.equal(fresh.requiresReevaluation,false);assert.equal(terminal.terminal,true);assert.equal(terminal.requiresReevaluation,false);
});

test("Team AI exposes proposal freshness as advisory re-evaluation only",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/proposalFreshness=await buildAtlasProposalFreshness/);assert.match(page,/proposal freshness .* re-evaluation review/i);assert.match(page,/does not auto-reject or auto-approve here/i);
});

test("Atlas precedent readiness is synthesis-only and never grants reuse authority",async()=>{
 const precedent=await import('../lib/intelligence/atlas-precedent-readiness.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),hash=await atlas.atlasSnapshotHash(snapshot);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at,reviewed_by,reviewed_at) VALUES ('PR1','report.generate','x',?,'b',?,'low','approved','{}','atlas',?,'founder',?)").run(hash,JSON.stringify(['s1','s2','s3','s4']),now-1000,now);
 const [freshness,challenges,quality,consistency]=await Promise.all([freshnessBuilder.buildAtlasProposalFreshness(db,snapshot,10),challengeBuilder.buildAtlasChallengeReview(db,snapshot,10),qualityBuilder.buildAtlasDecisionQuality(db,10),consistencyBuilder.buildAtlasRecommendationConsistency(db,10)]),rows=precedent.buildAtlasPrecedentReadiness(freshness,challenges,quality,consistency),r=rows.find(x=>x.proposalId==='PR1');assert.equal(r.requiresFounderReview,true);assert.equal(r.advisoryOnly,true);assert.equal(r.authorityMutationAllowed,false);assert.equal(r.causalOutcomeUsed,false);assert.equal(r.readiness,'not_ready');assert.ok(r.blockers.includes('exact_evidence_replay_unavailable'));assert.match(r.note,/human review only/i);
});

test("Atlas precedent readiness blocks stale, challenged, inconsistent or low-quality proposals",async()=>{
 const precedent=await import('../lib/intelligence/atlas-precedent-readiness.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now});
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at) VALUES ('PR2','campaign_activation','x','old','b','[]','high','proposed','{}','atlas',?)").run(now);
 const [freshness,challenges,quality,consistency]=await Promise.all([freshnessBuilder.buildAtlasProposalFreshness(db,snapshot,10),challengeBuilder.buildAtlasChallengeReview(db,snapshot,10),qualityBuilder.buildAtlasDecisionQuality(db,10),consistencyBuilder.buildAtlasRecommendationConsistency(db,10)]),r=precedent.buildAtlasPrecedentReadiness(freshness,challenges,quality,consistency).find(x=>x.proposalId==='PR2');assert.equal(r.readiness,'not_ready');assert.ok(r.blockers.includes('canonical_snapshot_changed_since_proposal'));assert.ok(r.blockers.includes('challenge_review_has_open_findings'));assert.ok(r.blockers.includes('decision_quality_below_review_threshold'));
});

test("Team AI exposes precedent readiness as Founder review only",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/precedentReadiness=buildAtlasPrecedentReadiness\(proposalFreshness,challengeReview,decisionQuality,recommendationConsistency,policyCompatibility,decisionInputIntegrity\)/);assert.match(page,/precedent readiness .* Founder reuse review/i);assert.match(page,/eligible for human review only/i);
});

test("Atlas decision lineage exposes provenance and never invents historical policy version",async()=>{
 const lineage=await import('../lib/intelligence/atlas-decision-lineage.ts');const{sqlite,db,now}=world();await atlas.ensureAtlasProposalJournal(db);const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:now}),hash=await atlas.atlasSnapshotHash(snapshot);
 sqlite.prepare("INSERT INTO atlas_proposals (id,proposal_type,summary,snapshot_hash,basis_id,source_ids_json,risk_class,status,action_json,created_by,created_at,reviewed_by,reviewed_at) VALUES ('LN1','report.generate','x',?,'basis-1',?,'low','approved','{}','atlas',?,'founder',?)").run(hash,JSON.stringify(['s1','s2']),now-1000,now);
 const [freshness,challenges,quality,consistency]=await Promise.all([freshnessBuilder.buildAtlasProposalFreshness(db,snapshot,10),challengeBuilder.buildAtlasChallengeReview(db,snapshot,10),qualityBuilder.buildAtlasDecisionQuality(db,10),consistencyBuilder.buildAtlasRecommendationConsistency(db,10)]),precedentBuilder=await import('../lib/intelligence/atlas-precedent-readiness.ts'),precedent=precedentBuilder.buildAtlasPrecedentReadiness(freshness,challenges,quality,consistency),proposals=await atlas.listAtlasProposals(db,10),r=lineage.buildAtlasDecisionLineage(proposals,freshness,challenges,quality,precedent).find(x=>x.proposalId==='LN1');assert.equal(r.snapshotHash,hash);assert.equal(r.basisId,'basis-1');assert.deepEqual(r.sourceIds,['s1','s2']);assert.equal(r.humanDecisionRecorded,true);assert.equal(r.proposalPolicyVersionRecorded,false);assert.ok(r.missingLineage.includes('proposal_policy_version_not_recorded_at_creation'));assert.equal(r.authorityMutationAllowed,false);assert.match(r.note,/does not infer historical policy provenance/i);
});

test("Atlas decision lineage flags missing human review records for resolved proposals",async()=>{
 const lineage=await import('../lib/intelligence/atlas-decision-lineage.ts');const row={id:'LN2',proposal_type:'x',snapshot_hash:'h',basis_id:'b',source_ids_json:'["s"]',risk_class:'low',status:'approved',created_by:'atlas',created_at:1,reviewed_by:null,reviewed_at:null,executed_at:null};const r=lineage.buildAtlasDecisionLineage([row],[],[],[],[])[0];assert.equal(r.lineageComplete,false);assert.ok(r.missingLineage.includes('human_review_record_missing'));assert.equal(r.advisoryOnly,true);
});

test("Team AI exposes decision lineage as read-only audit trace",async()=>{
 const fs=await import('node:fs');const route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8');assert.match(route,/decisionLineage=buildAtlasDecisionLineage/);assert.match(page,/decision lineage .* audit trace/i);assert.match(page,/Historical policy is shown when recorded at proposal creation/i);assert.match(page,/legacy proposals remain explicitly unknown rather than inferred/i);
});

test("new Atlas proposals persist governance policy version at creation",async()=>{
 const{sqlite,db}=world();const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:Date.now()}),proposal=await atlas.recordAtlasProposal(db,{proposalType:'report.generate',summary:'x',snapshot,basisId:'policy-provenance',riskClass:'low',createdBy:'atlas'}),row=sqlite.prepare("SELECT policy_version FROM atlas_proposals WHERE id=?").get(proposal.id);assert.equal(row.policy_version,'atlas-v2.2');assert.equal(proposal.policyVersion,'atlas-v2.2');
});

test("Atlas decision lineage distinguishes recorded policy from legacy unknown",async()=>{
 const lineage=await import('../lib/intelligence/atlas-decision-lineage.ts');const current={id:'PNEW',proposal_type:'report.generate',snapshot_hash:'h',basis_id:'b',source_ids_json:'["s"]',risk_class:'low',status:'proposed',created_by:'atlas',created_at:1,reviewed_by:null,reviewed_at:null,executed_at:null,policy_version:'atlas-v2.2'},legacy={...current,id:'PLEGACY',policy_version:null};const rows=lineage.buildAtlasDecisionLineage([current,legacy],[],[],[],[]),now=rows.find(x=>x.proposalId==='PNEW'),old=rows.find(x=>x.proposalId==='PLEGACY');assert.equal(now.proposalPolicyVersionRecorded,true);assert.equal(now.proposalPolicyVersion,'atlas-v2.2');assert.equal(now.lineageComplete,true);assert.equal(old.proposalPolicyVersionRecorded,false);assert.ok(old.missingLineage.includes('proposal_policy_version_not_recorded_at_creation'));assert.match(old.note,/legacy proposal/i);
});

test("Atlas policy compatibility blocks unknown and old policy provenance",async()=>{
 const policy=await import('../lib/intelligence/atlas-policy-compatibility.ts');const rows=policy.buildAtlasPolicyCompatibility([{id:'PC1',policy_version:'atlas-v2.2'},{id:'PC2',policy_version:'atlas-v1'},{id:'PC3',policy_version:null}]),by=Object.fromEntries(rows.map(x=>[x.proposalId,x]));assert.equal(by.PC1.compatible,true);assert.equal(by.PC1.reason,'policy_current');assert.equal(by.PC2.compatible,false);assert.equal(by.PC2.reason,'policy_version_changed');assert.equal(by.PC3.compatible,false);assert.equal(by.PC3.reason,'proposal_policy_version_unknown');assert.equal(by.PC3.authorityMutationAllowed,false);
});

test("Atlas precedent readiness requires current policy compatibility",async()=>{
 const precedent=await import('../lib/intelligence/atlas-precedent-readiness.ts');const baseFresh={proposalId:'PX',proposalType:'report.generate',status:'proposed',riskClass:'low',recordedSnapshotHash:'h',currentSnapshotHash:'h',fresh:true,terminal:false,requiresReevaluation:false,requiresFounderReview:false,advisoryOnly:true,authorityMutationAllowed:false,reason:'proposal_snapshot_matches_current_canonical_snapshot'},quality=[{proposalId:'PX',proposalType:'report.generate',status:'proposed',score:100,dimensions:{grounding:100,reviewTimeliness:100,resolution:100,stability:100},sourceCount:4,reviewLatencyMs:0,artifactStatus:'generated',outcome:{status:null,observedNetDelta:null,direction:'unknown',causalAttribution:false},advisoryOnly:true,authorityMutationAllowed:false,note:'x'}],consistency=[{snapshotHash:'h',proposalType:'report.generate',proposalCount:2,distinctActions:1,distinctStatuses:1,consistent:true,basisIds:['b'],proposalIds:['PX','PY'],actions:[{}],statuses:['proposed'],requiresFounderReview:false,advisoryOnly:true,authorityMutationAllowed:false,note:'x'}],oldPolicy=[{proposalId:'PX',proposalPolicyVersion:'atlas-v1',currentPolicyVersion:'atlas-v2.2',compatible:false,requiresReevaluation:true,reason:'policy_version_changed',requiresFounderReview:true,advisoryOnly:true,authorityMutationAllowed:false}],currentPolicy=[{...oldPolicy[0],proposalPolicyVersion:'atlas-v2.2',compatible:true,requiresReevaluation:false,reason:'policy_current'}];const blocked=precedent.buildAtlasPrecedentReadiness([baseFresh],[],quality,consistency,oldPolicy)[0],ready=precedent.buildAtlasPrecedentReadiness([baseFresh],[],quality,consistency,currentPolicy)[0];assert.equal(blocked.readiness,'not_ready');assert.ok(blocked.blockers.includes('policy_version_changed'));assert.equal(blocked.policyCompatible,false);assert.equal(ready.policyCompatible,true);
});

test("Team AI exposes policy compatibility as a reuse guard",async()=>{const fs=await import('node:fs');const page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8'),route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8');assert.match(page,/policy compatibility .* reuse guard/i);assert.match(page,/requires Founder re-evaluation before reuse/i);assert.match(route,/policyCompatibility=buildAtlasPolicyCompatibility/);});

test("new Atlas proposals persist a deterministic decision-input fingerprint",async()=>{
 const{sqlite,db}=world();const snapshot=await atlas.buildAtlasBusinessSnapshot(db,{asOf:Date.now()}),proposal=await atlas.recordAtlasProposal(db,{proposalType:'report.generate',summary:'x',snapshot,basisId:'fingerprint',riskClass:'low',action:{type:'report.generate'},createdBy:'atlas'}),row=sqlite.prepare("SELECT decision_fingerprint FROM atlas_proposals WHERE id=?").get(proposal.id);assert.equal(row.decision_fingerprint,proposal.decisionFingerprint);assert.equal(typeof proposal.decisionFingerprint,'string');assert.equal(proposal.decisionFingerprint.length,64);
});

test("Atlas decision-input integrity detects legacy missing and tampered governed inputs",async()=>{
 const integrity=await import('../lib/intelligence/atlas-decision-input-integrity.ts'),base={id:'R1',proposal_type:'report.generate',snapshot_hash:'h',basis_id:'b',source_ids_json:'["s2","s1"]',risk_class:'low',status:'proposed',action_json:'{"type":"report.generate"}',created_by:'atlas',policy_version:'atlas-v2.2'},fp=await atlas.atlasDecisionInputFingerprint({proposalType:'report.generate',snapshotHash:'h',basisId:'b',sourceIds:['s1','s2'],riskClass:'low',actionJson:'{"type":"report.generate"}',createdBy:'atlas',policyVersion:'atlas-v2.2'}),rows=await integrity.buildAtlasDecisionInputIntegrity([{...base,decision_fingerprint:fp},{...base,id:'R2',decision_fingerprint:null},{...base,id:'R3',basis_id:'changed',decision_fingerprint:fp}]),by=Object.fromEntries(rows.map(x=>[x.proposalId,x]));assert.equal(by.R1.matches,true);assert.equal(by.R1.reason,'decision_input_fingerprint_matches');assert.equal(by.R2.matches,false);assert.equal(by.R2.reason,'decision_input_fingerprint_missing');assert.equal(by.R3.matches,false);assert.equal(by.R3.reason,'decision_input_fingerprint_mismatch');assert.equal(by.R3.authorityMutationAllowed,false);
});

test("Atlas precedent readiness blocks unreproducible stored decision inputs",async()=>{
 const precedent=await import('../lib/intelligence/atlas-precedent-readiness.ts');const fresh=[{proposalId:'RI',proposalType:'report.generate',status:'proposed',riskClass:'low',recordedSnapshotHash:'h',currentSnapshotHash:'h',fresh:true,terminal:false,requiresReevaluation:false,requiresFounderReview:false,advisoryOnly:true,authorityMutationAllowed:false,reason:'proposal_snapshot_matches_current_canonical_snapshot'}],quality=[{proposalId:'RI',proposalType:'report.generate',status:'proposed',score:100,dimensions:{grounding:100,reviewTimeliness:100,resolution:100,stability:100},sourceCount:4,reviewLatencyMs:0,artifactStatus:'generated',outcome:{status:null,observedNetDelta:null,direction:'unknown',causalAttribution:false},advisoryOnly:true,authorityMutationAllowed:false,note:'x'}],consistency=[{snapshotHash:'h',proposalType:'report.generate',proposalCount:2,distinctActions:1,distinctStatuses:1,consistent:true,basisIds:['b'],proposalIds:['RI','RJ'],actions:[{}],statuses:['proposed'],requiresFounderReview:false,advisoryOnly:true,authorityMutationAllowed:false,note:'x'}],policy=[{proposalId:'RI',proposalPolicyVersion:'atlas-v2.2',currentPolicyVersion:'atlas-v2.2',compatible:true,requiresReevaluation:false,reason:'policy_current',requiresFounderReview:true,advisoryOnly:true,authorityMutationAllowed:false}],bad=[{proposalId:'RI',recordedFingerprint:'x',recomputedFingerprint:'y',verifiable:true,matches:false,requiresReevaluation:true,reason:'decision_input_fingerprint_mismatch',requiresFounderReview:true,advisoryOnly:true,authorityMutationAllowed:false,note:'x'}],r=precedent.buildAtlasPrecedentReadiness(fresh,[],quality,consistency,policy,bad)[0];assert.equal(r.readiness,'not_ready');assert.equal(r.decisionInputsReproducible,false);assert.ok(r.blockers.includes('decision_input_fingerprint_mismatch'));
});

test("Team AI exposes decision-input reproducibility without claiming model replay",async()=>{const fs=await import('node:fs'),page=fs.readFileSync(new URL('../app/team/ai/page.tsx',import.meta.url),'utf8'),route=fs.readFileSync(new URL('../app/api/ai-intelligence/route.ts',import.meta.url),'utf8');assert.match(page,/decision-input reproducibility .* integrity guard/i);assert.match(page,/does not pretend to replay unrecorded model reasoning/i);assert.match(route,/decisionInputIntegrity=await buildAtlasDecisionInputIntegrity/);});
