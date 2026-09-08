import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney} from "./helpers/grooming-journey-harness.mjs";
async function recover(body){const {POST}=await import("../app/api/provider-assignment-recovery/route.ts");const response=await POST(new Request("https://uat.pawspace.in/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":"closure-admin@pawspace.test"},body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};}
function config(){const start=new Date(Date.now()+9*86400000);start.setUTCHours(5,30,0,0);return {customerId:"OPS-BOUNDARY-CUSTOMER",customerName:"Recovery test parent",phone:"+919900000707",petSourceId:"OPS-BOUNDARY-PET",petName:"Test dog",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:"OPS-BOUNDARY-GROUP",start:start.toISOString(),stopAfterCapture:true};}
const tables=["canonical_bookings","provider_work_orders","booking_payments","scheduling_reservations","scheduling_assignment_decisions","provider_assignment_offers","booking_lifecycle_events"];
function snapshot(sqlite){return Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));}


async function verifiedCandidate(ctx){
 const onboarding=await import("../lib/provider-onboarding-transactional.ts"),mandate=await import("../lib/provider-verification-mandate.ts");await onboarding.ensureProviderOnboardingTransactional(ctx.db);await mandate.ensureVerificationMandateTables(ctx.db);const now=Date.now();
 ctx.sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,country_code,region_code,city_code,status,locale_code,basic_info_json,policy_ref,quiz_version_ref,verification_status,quiz_status,interview_status,human_decision,created_by,created_at,updated_at) VALUES ('VERIFIED-CANDIDATE','groom_sanjay','grooming','IN','KA','blr','approved','en','{}',NULL,NULL,'verified','passed','passed','approved','test',?,?)").run(now,now);
 for(const type of ["aadhaar","pan"])ctx.sqlite.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,detail_json,updated_by,created_at,updated_at) VALUES (?,'VERIFIED-CANDIDATE','groomer',?,'verified',0,'{}','test',?,?)").run(`AUTH-${type}`,type,now,now);
 const {providerAssignmentBlock}=await import("../lib/provider-assignment-eligibility.ts");const verdict=await providerAssignmentBlock(ctx.db,"groom_sanjay",Date.now()+9*86400000);assert.equal(verdict.blocked,false,JSON.stringify(verdict));assert.equal(verdict.evaluated,true);
}
for(const change of ["unchanged","revocation","expiry","policy","application"])test(`verified replacement handles ${change} authority at commit`,async t=>{
 const ctx=await setupJourney();t.after(ctx.close);const input=config(),job=await runCompletedJourney(ctx,input);await verifiedCandidate(ctx);let before;
 ctx.db.beforeBatch=async statements=>{if(!statements.some(s=>s._sql.includes("UPDATE scheduling_reservations SET provider_id=")))return;ctx.db.beforeBatch=null;
 if(change==="revocation")ctx.sqlite.prepare("UPDATE provider_verifications SET status='revoked' WHERE id='AUTH-pan'").run();
 if(change==="expiry")ctx.sqlite.prepare("UPDATE provider_verifications SET expires_at=? WHERE id='AUTH-pan'").run(Date.now()-1);
 if(change==="policy")assert.ok(ctx.sqlite.prepare("UPDATE service_policy_configs SET active=0 WHERE policy_domain='provider_verification_policy'").run().changes>0);
 if(change==="application")ctx.sqlite.prepare("UPDATE provider_onboarding_applications SET vertical_key='pet_taxi' WHERE id='VERIFIED-CANDIDATE'").run();
 before=snapshot(ctx.sqlite);};
 const result=await recover({bookingId:job.bookingId,providerId:job.provider.id,action:"unavailable",reason:"Controlled verification authority race"});assert.ok(before,"replacement batch must be reached");
 if(change==="unchanged"){assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.replacement.id,"groom_sanjay");}
 else{assert.equal(result.status,409,JSON.stringify(result.body));assert.deepEqual(snapshot(ctx.sqlite),before);assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_recovery_cases").get().n,0);}
});
