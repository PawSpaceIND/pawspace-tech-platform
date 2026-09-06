import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAWSPACE_TEST_DB__", "__PAWSPACE_TEST_ENV");

function makeD1(sqlite){function statement(sql,args){return{bind:(...bound)=>statement(sql,bound),first:async()=>{const row=sqlite.prepare(sql).get(...args);return row===undefined?null:row;},run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}let batchTail=Promise.resolve();return{prepare:(sql)=>statement(sql,[]),batch:(items)=>{const run=async()=>{const out=[];sqlite.exec("BEGIN");try{for(const item of items)out.push(await item.run());sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}};const result=batchTail.then(run,run);batchTail=result.then(()=>undefined,()=>undefined);return result;}};}
const SIGNING_KEY="uat-signing-key-0123456789abcdef0123456789abcdef";
const ASSERTION_SECRET="uat-assertion-secret-0123456789abcdef0123456789abcdef";
const APPROVED="9876543210";
function envFor(db,over={}){return{DB:db,PAWSPACE_UAT_LOGIN:"on",PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_STAGING_LIVE_CUSTOMER_OTP:"true",PAWSPACE_SMS_TEST_NUMBERS:APPROVED,FAST2SMS_API_KEY:"api-key-must-never-be-returned",PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:ASSERTION_SECRET,PAWSPACE_UAT_SIGNING_KEY:SIGNING_KEY,...over};}
function request(body){return new Request("https://pawspace-staging.example/api/customer-otp",{method:"POST",headers:{"content-type":"application/json",origin:"https://pawspace-staging.example"},body:JSON.stringify(body)});}

test("approved live staging OTP is sent out-of-band, response strips the code, and the sent code creates a customer session",async()=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);globalThis.__PAWSPACE_TEST_DB__=db;globalThis.__PAWSPACE_TEST_ENV=envFor(db);
 const originalFetch=globalThis.fetch;let providerRequest=null;
 globalThis.fetch=async(input,init)=>{providerRequest={url:String(input),init};return new Response(JSON.stringify({return:true,request_id:"REQ-LIVE-OTP"}),{status:200,headers:{"content-type":"application/json"}});};
 try{
  const route=await import("../app/api/customer-otp/route.ts");
  const sent=await route.POST(request({action:"request",phone:APPROVED}));const sentBody=await sent.text();assert.equal(sent.status,200,sentBody);const payload=JSON.parse(sentBody);
  assert.equal(payload.data?.sandboxDelivery,false);assert.equal(payload.data?.liveSmsDelivered,true);assert.equal("sandboxCode" in (payload.data||{}),false);assert.equal(JSON.stringify(payload).includes("api-key-must-never-be-returned"),false);
  assert.equal(providerRequest?.url,"https://www.fast2sms.com/dev/bulkV2");assert.equal(providerRequest?.init?.method,"POST");const providerBody=new URLSearchParams(String(providerRequest?.init?.body||""));assert.equal(providerBody.get("numbers"),APPROVED);const message=String(providerBody.get("message")||"");const code=/\b(\d{6})\b/.exec(message)?.[1];assert.match(String(code),/^\d{6}$/);
  const verified=await route.POST(request({action:"verify",challengeId:payload.data.challengeId,code,cityId:"blr"}));assert.equal(verified.status,200,await verified.text());assert.match(String(verified.headers.get("set-cookie")),/pawspace_identity_session=/);
 }finally{globalThis.fetch=originalFetch;}
});

test("live staging provider failure fails closed, leaks no provider detail, and invalidates the challenge",async()=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);globalThis.__PAWSPACE_TEST_DB__=db;globalThis.__PAWSPACE_TEST_ENV=envFor(db);
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({return:false,status_code:412,message:["provider secret detail"]}),{status:401,headers:{"content-type":"application/json"}});
 try{
  const route=await import("../app/api/customer-otp/route.ts");const response=await route.POST(request({action:"request",phone:APPROVED}));assert.equal(response.status,503);const body=await response.json();
  assert.equal(JSON.stringify(body).includes("sandboxCode"),false);assert.doesNotMatch(JSON.stringify(body),/provider secret detail|412|api-key-must-never-be-returned/);assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM customer_otp_challenges").get().count,0);
 }finally{globalThis.fetch=originalFetch;}
});

test("live staging OTP cannot be activated by the flag alone outside the staging deployment identity",async()=>{
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);globalThis.__PAWSPACE_TEST_DB__=db;globalThis.__PAWSPACE_TEST_ENV=envFor(db,{PAWSPACE_UAT_LOGIN:"off",PAWSPACE_DEPLOYMENT_ENV:"production"});
 const route=await import("../app/api/customer-otp/route.ts");const response=await route.POST(new Request("https://app.pawspace.in/api/customer-otp",{method:"POST",headers:{"content-type":"application/json",origin:"https://app.pawspace.in"},body:JSON.stringify({action:"request",phone:APPROVED})}));assert.equal(response.status,503);const body=await response.json();assert.equal(JSON.stringify(body).includes("sandboxCode"),false);
});
