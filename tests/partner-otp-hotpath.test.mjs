import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";

installWorkersHooks("__PARTNER_OTP_HOTPATH_DB__","__PARTNER_OTP_HOTPATH_ENV__");

function makeD1(sqlite,seen){
  function statement(sql,args=[]){return{
    bind:(...bound)=>statement(sql,bound),
    first:async()=>{seen.push(sql);return sqlite.prepare(sql).get(...args)??null;},
    run:async()=>{seen.push(sql);const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
    all:async()=>{seen.push(sql);return{results:sqlite.prepare(sql).all(...args)}}
  };}
  return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out;}};
}

function world(withSchema=true){
  const sqlite=new DatabaseSync(":memory:");
  if(withSchema){
    sqlite.exec("CREATE TABLE partner_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,verifier_salt TEXT,verifier_hash TEXT)");
    sqlite.exec("CREATE INDEX idx_partner_otp_phone ON partner_otp_challenges(phone,created_at)");
    sqlite.exec("CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  }
  const seen=[];const db=makeD1(sqlite,seen);
  globalThis.__PARTNER_OTP_HOTPATH_DB__=db;
  globalThis.__PARTNER_OTP_HOTPATH_ENV__={DB:db,PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:"partner-otp-hotpath-secret-0123456789abcdef0123456789abcdef",PAWSPACE_IDENTITY_ENV:"sandbox",PAWSPACE_PAYMENT_ENV:"sandbox"};
  return{sqlite,db,seen};
}

const ddl=/^(?:CREATE|ALTER|PRAGMA)/i;

test("steady-state partner OTP request avoids schema DDL/PRAGMA on the login hot path",async()=>{
  const {db,seen}=world(true);
  const {requestPartnerOtp}=await import("../lib/partner-otp.ts");
  const issued=await requestPartnerOtp(db,{phone:"9000000901"});
  assert.match(issued.sandboxCode,/^\d{6}$/);
  assert.equal(seen.some(sql=>ddl.test(sql.trim())),false,`unexpected schema SQL: ${seen.filter(sql=>ddl.test(sql.trim())).join(" | ")}`);
  assert.ok(seen.some(sql=>/INSERT INTO partner_otp_challenges/.test(sql)),"challenge insert must still execute");
});

test("missing partner OTP schema self-heals once and still issues a challenge",async()=>{
  const {db,seen}=world(false);
  const {requestPartnerOtp}=await import("../lib/partner-otp.ts");
  const issued=await requestPartnerOtp(db,{phone:"9000000901"});
  assert.match(issued.sandboxCode,/^\d{6}$/);
  assert.ok(seen.some(sql=>/^CREATE TABLE IF NOT EXISTS partner_otp_challenges/i.test(sql.trim())),"fallback must provision missing OTP table");
  assert.ok(seen.some(sql=>/INSERT INTO partner_otp_challenges/.test(sql)),"challenge insert must succeed after fallback");
});

test('verified partner OTP clears a prior staff persona cookie',async()=>{
 const{db}=world(false);Object.assign(globalThis.__PARTNER_OTP_HOTPATH_ENV__,{PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'uat-partner-persona-test-0123456789abcdef0123456789'});
 const{requestPartnerOtp}=await import('../lib/partner-otp.ts');const issued=await requestPartnerOtp(db,{phone:'9000000901'});
 const{POST}=await import('../app/api/partner-otp/route.ts');const response=await POST(new Request('https://staging.example/api/partner-otp',{method:'POST',headers:{origin:'https://staging.example','content-type':'application/json',cookie:'pawspace_uat=prior-staff-cookie'},body:JSON.stringify({action:'verify',challengeId:issued.challengeId,code:issued.sandboxCode,name:'QA provider',cityId:'blr'})}));
 assert.equal(response.status,200,await response.clone().text());const{clearUatCookie}=await import('../lib/uat-staging-auth.ts');assert.ok(response.headers.getSetCookie().includes(clearUatCookie()));assert.ok(response.headers.getSetCookie().some(value=>value.startsWith('pawspace_identity_session=')));
});
