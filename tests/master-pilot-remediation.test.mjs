import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {HAPTIK_OUTBOUND_TIMEOUT_MS,triggerHaptikCall} from "../lib/haptik-outbound-client.ts";
import {sanitizeProviderDetail} from "../lib/provider-pii-sanitizer.ts";
import {upsertOpportunityFromLead} from "../lib/crm-pipeline-forecast.ts";

function makeD1(sqlite){
  const statement=(sql,args=[])=>({sql,args,bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>{const result=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(result.changes)}};}});
  return{prepare:(sql)=>statement(sql),batch:async(statements)=>statements.map(item=>{const result=sqlite.prepare(item.sql).run(...item.args);return{success:true,meta:{changes:Number(result.changes)}};})};
}

test("Haptik SSRF sabotage: metadata/private endpoints are refused before bearer credentials reach fetch",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("fetch must not be reached");};
  try{
    for(const url of ["http://169.254.169.254/latest/meta-data","https://169.254.169.254/latest/meta-data","https://127.0.0.1/admin","https://10.0.0.1/internal","https://[::1]/admin"]){
      const result=await triggerHaptikCall({HAPTIK_OUTBOUND_API_KEY:"super-secret-bearer",HAPTIK_OUTBOUND_URL:url},{phone:"9999999999",campaign:"test"});
      assert.equal(result.connected,false,url);
    }
    assert.equal(calls,0,"blocked destinations must be rejected before a request carrying Authorization exists");
    assert.equal(HAPTIK_OUTBOUND_TIMEOUT_MS,2500);
  }finally{globalThis.fetch=original;}
});

test("Haptik redirect sabotage: credential is never forwarded to a redirect target",async()=>{
  const original=globalThis.fetch;const seen=[];
  globalThis.fetch=async(input,init)=>{seen.push({url:String(input),authorization:new Headers(init?.headers).get("authorization"),redirect:init?.redirect});return new Response(null,{status:302,headers:{location:"http://169.254.169.254/latest/meta-data"}});};
  try{
    const result=await triggerHaptikCall({HAPTIK_OUTBOUND_API_KEY:"secret",HAPTIK_OUTBOUND_URL:"https://voice.example.com/outbound"},{phone:"9999999999",campaign:"test"});
    assert.equal(result.connected,false);
    assert.equal(seen.length,1,"manual redirect policy must prevent a second credentialed request");
    assert.equal(seen[0].redirect,"manual");
  }finally{globalThis.fetch=original;}
});

test("provider PII sabotage recursively removes raw contact and doorstep data from historical detail_json",()=>{
  const malicious={customer_phone:"+91 9876543210",email:"parent@example.com",doorstep_address:"12 Secret Street",nested:{note:"Call 9876543210 or mail parent@example.com",landmark:"Gate 2"},safe:"Pet is anxious around dryers"};
  const clean=sanitizeProviderDetail(malicious);
  const serialized=JSON.stringify(clean);
  assert.doesNotMatch(serialized,/9876543210/);
  assert.doesNotMatch(serialized,/parent@example\.com/i);
  assert.doesNotMatch(serialized,/Secret Street|Gate 2/i);
  assert.match(serialized,/Pet is anxious around dryers/);
});

test("CRM sabotage executes the canonical lead-to-opportunity INSERT with exactly aligned values",async()=>{
  const sqlite=new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service TEXT,owner TEXT,status TEXT,stage TEXT,converted_booking_id TEXT,updated_at INTEGER NOT NULL); INSERT INTO lead_work_items VALUES ('LEAD-1','CUST-1','grooming','Agent A','open','new',NULL,1);");
  const db=makeD1(sqlite);
  const result=await upsertOpportunityFromLead(db,{leadId:"LEAD-1",amount:1999,actorId:"test:least-privilege",source:"regression"});
  assert.equal(result.created,true);
  const row=sqlite.prepare("SELECT lead_id,customer_id,service_code,amount,next_best_action,next_action_at,source,created_by FROM crm_opportunities WHERE lead_id='LEAD-1'").get();
  assert.equal(row.customer_id,"CUST-1");
  assert.equal(row.service_code,"grooming");
  assert.equal(row.amount,1999);
  assert.equal(row.source,"regression");
  assert.equal(row.created_by,"test:least-privilege");
  assert.ok(String(row.next_best_action).length>0);
});
