import test from"node:test";
import assert from"node:assert/strict";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
import{makeD1,freshSqlite,seedRecipient,uatVoiceEnv,ALLOWLISTED_PHONE,FOUNDER_PERMISSIONS,DAYTIME}from"./helpers/voice-harness.mjs";

installWorkersHooks("__EXOTEL_RECON_DB__","__EXOTEL_RECON_ENV__");
const gov=await import("../lib/voice-outbound-governance.ts");
const route=await import("../app/api/voice-provider-webhook/route.ts");
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch;});

const EXOTEL_CALL_SID="eca9f0f232781a95";

async function fresh(){
 const sqlite=freshSqlite(),db=makeD1(sqlite),env=uatVoiceEnv();
 globalThis.__EXOTEL_RECON_DB__=db;globalThis.__EXOTEL_RECON_ENV__=env;
 const{ensureSecurityTables}=await import("../lib/server-auth.ts");
 await ensureSecurityTables(db);await gov.ensureVoiceCallTables(db);await gov.seedVoiceCallScripts(db);seedRecipient(sqlite);
 await gov.recordVoiceConsent(db,{phone:ALLOWLISTED_PHONE,subjectType:"customer",subjectId:"CON-V1",granted:true,source:"booking_form_consent",actorId:"ops@pawspace.in",asOf:DAYTIME});
 const call=await gov.requestOutboundVoiceCall(db,env,{idempotencyKey:"exotel-recon-1",useCase:"booking_confirmation",phone:ALLOWLISTED_PHONE,cityId:"blr",customerId:"CON-V1",leadId:"LEAD-V1",bookingId:"BKG-V1",actorId:"operator@pawspace.in",actorPermissions:FOUNDER_PERMISSIONS,asOf:DAYTIME});
 sqlite.prepare("UPDATE voice_call_orders SET provider='exotel',provider_call_id=? WHERE id=?").run(EXOTEL_CALL_SID,call.callId);
 return{sqlite,db,env,call};
}

const state=(sqlite,callId)=>sqlite.prepare("SELECT state,recording_ref FROM voice_call_orders WHERE id=?").get(callId);
const events=sqlite=>sqlite.prepare("SELECT * FROM voice_call_provider_events ORDER BY created_at,id").all();

function exotelDetailsSequence(items){
 let index=0,calls=0;
 globalThis.fetch=async(url,init={})=>{
  calls++;
  const parsed=new URL(String(url));
  assert.equal(parsed.protocol,"https:");
  assert.equal(parsed.hostname,"api.exotel.com");
  assert.equal(parsed.pathname,`/v1/Accounts/test-sid/Calls/${EXOTEL_CALL_SID}.json`);
  assert.equal(parsed.search,"","single-call details must not fall back to the bulk Calls search API");
  assert.equal(String(init.method||"GET"),"GET");
  assert.equal(new Headers(init.headers).get("authorization"),`Basic ${btoa("test-key:test-token")}`);
  assert.equal(new Headers(init.headers).get("accept"),"application/json");
  const item=items[Math.min(index++,items.length-1)];
  return Response.json({Call:{Sid:EXOTEL_CALL_SID,...item}});
 };
 return()=>calls;
}

async function post(body){return route.POST(new Request("https://uat.pawspace.in/api/voice-provider-webhook",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body}));}

test("unsigned Exotel callbacks are trigger-only and authoritative Call Details drives connected then completed",async()=>{
 const{sqlite,call}=await fresh();
 const getFetchCount=exotelDetailsSequence([
  {Status:"in-progress",Duration:7},
  {Status:"completed",Duration:18,RecordingUrl:"https://recordings.exotel.com/private-example.mp3"},
 ]);
 // Deliberately forge every mutable field except CallSid. None of these values may become authoritative.
 const forged=new URLSearchParams({CallSid:EXOTEL_CALL_SID,CallStatus:"failed",CustomField:"VCALL-ATTACKER",CallDuration:"9999",RecordingUrl:"https://attacker.invalid/fake.mp3"}).toString();
 const first=await post(forged);assert.equal(first.status,200);assert.equal(state(sqlite,call.callId).state,"connected");
 const second=await post(forged);assert.equal(second.status,200);assert.equal(state(sqlite,call.callId).state,"completed");
 assert.equal(getFetchCount(),2,"each provider trigger is reconciled against Exotel, never trusted directly");
 const rows=events(sqlite);assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>row.provider_status),["in-progress","completed"]);
 assert.ok(rows.every(row=>row.signature_mechanism==="exotel_call_details_api"));
 assert.ok(rows.every(row=>/^[0-9a-f]{64}$/.test(row.payload_sha256)),"authoritative provider responses are hashed, not stored raw");
 assert.equal(state(sqlite,call.callId).recording_ref,null,"a carrier recording URL is discarded when recording was not approved");
 const trail=sqlite.prepare("SELECT to_state FROM voice_call_state_transitions WHERE call_id=? ORDER BY sequence").all(call.callId).map(row=>row.to_state);
 assert.ok(trail.includes("connected"));assert.ok(trail.includes("completed"));
});

test("single-call details accepts a lower-case provider envelope but still requires the exact owned Sid",async()=>{
 const{sqlite,call}=await fresh();
 globalThis.fetch=async()=>Response.json({call:{sid:EXOTEL_CALL_SID,status:"completed",duration:22}});
 const response=await post(new URLSearchParams({CallSid:EXOTEL_CALL_SID,CallStatus:"ringing"}).toString());
 assert.equal(response.status,200);assert.equal(state(sqlite,call.callId).state,"completed");
 assert.equal(events(sqlite)[0].provider_status,"completed");
});

test("an unknown CallSid is acknowledged without using PawSpace as an Exotel API proxy",async()=>{
 const{sqlite}=await fresh();
 let fetched=false;globalThis.fetch=async()=>{fetched=true;throw new Error("must not fetch")};
 const response=await post(new URLSearchParams({CallSid:"unknown-exotel-call-123",CallStatus:"completed"}).toString());
 assert.equal(response.status,202);assert.equal(fetched,false);assert.equal(events(sqlite).length,0);
});

test("Call Details must return the exact ledger-owned CallSid before any lifecycle mutation",async()=>{
 const{sqlite,call}=await fresh();
 globalThis.fetch=async()=>Response.json({Call:{Sid:"different-provider-call",Status:"completed",Duration:18}});
 const response=await post(new URLSearchParams({CallSid:EXOTEL_CALL_SID,CallStatus:"completed"}).toString());
 assert.equal(response.status,503);assert.equal(state(sqlite,call.callId).state,"dialing");assert.equal(events(sqlite).length,0);
});

test("provider API failure leaves D1 unchanged and fails closed for carrier retry",async()=>{
 const{sqlite,call}=await fresh();
 globalThis.fetch=async()=>Response.json({error:"temporary"},{status:503});
 const response=await post(new URLSearchParams({CallSid:EXOTEL_CALL_SID,CallStatus:"completed"}).toString());
 assert.equal(response.status,503);assert.equal(state(sqlite,call.callId).state,"dialing");assert.equal(events(sqlite).length,0);
});
