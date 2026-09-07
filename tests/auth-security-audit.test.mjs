import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import * as nodeModule from "node:module";

const WORKERS_SHIM=`export const env=new Proxy({}, {get:(_,key)=>globalThis.__PAWSPACE_TEST_ENV?.[key]});`;
const workersUrl=`data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if(typeof nodeModule.registerHooks==="function"){
 nodeModule.registerHooks({resolve(specifier,context,nextResolve){if(specifier==="cloudflare:workers")return{url:workersUrl,shortCircuit:true};try{return nextResolve(specifier,context);}catch(error){if(specifier.startsWith(".")&&!specifier.endsWith(".ts"))return nextResolve(`${specifier}.ts`,context);throw error;}}});
}else{
 const hook=`const workersUrl=${JSON.stringify(workersUrl)}; export async function resolve(specifier,context,nextResolve){if(specifier==="cloudflare:workers")return{url:workersUrl,shortCircuit:true};try{return await nextResolve(specifier,context);}catch(error){if(specifier.startsWith(".")&&!specifier.endsWith(".ts"))return nextResolve(specifier+".ts",context);throw error;}}`;
 nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const SECRET="auth-audit-identity-secret-0123456789abcdef0123456789abcdef";

function makeD1(sqlite){
 function statement(sql,args=[]){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}
 return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out;}};
}

function fresh(){
 const sqlite=new DatabaseSync(":memory:");
 const db=makeD1(sqlite);
 globalThis.__PAWSPACE_TEST_ENV={DB:db,PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:SECRET,PAWSPACE_IDENTITY_ENV:"sandbox",PAWSPACE_PAYMENT_ENV:"sandbox"};
 return{sqlite,db};
}

test("audit harness itself is locked to sandbox and production-forbid",()=>{
 assert.equal(process.env.PAWSPACE_PAYMENT_ENV,"sandbox");
 assert.equal(process.env.FORBID_PRODUCTION,"true");
 const pkg=JSON.parse(read("package.json"));
 const command=String(pkg.scripts?.["test:auth-security-audit"]||"");
 assert.match(command,/PAWSPACE_PAYMENT_ENV=sandbox/);
 assert.match(command,/FORBID_PRODUCTION=true/);
});

test("customer and partner OTPs use Web Crypto CSPRNG and never Math.random",async()=>{
 const customer=read("lib/customer-otp.ts"),partner=read("lib/partner-otp.ts"),cryptoSource=read("lib/security-crypto.ts");
 assert.doesNotMatch(customer,/Math\.random/);assert.doesNotMatch(partner,/Math\.random/);
 assert.match(customer,/secureSixDigitOtp/);assert.match(partner,/secureSixDigitOtp/);assert.match(cryptoSource,/crypto\.getRandomValues/);
 const{secureSixDigitOtp}=await import("../lib/security-crypto.ts");
 for(let i=0;i<256;i++)assert.match(secureSixDigitOtp(),/^[1-9][0-9]{5}$/);
});

test("customer OTP persists only a salted keyed verifier, erases it on use, and purges stale rows",async()=>{
 const{requestCustomerOtp,verifyCustomerOtp,purgeCustomerOtpChallenges}=await import("../lib/customer-otp.ts");
 const{sqlite,db}=fresh();
 const challenge=await requestCustomerOtp(db,{phone:"9876543210"});
 const row=sqlite.prepare("SELECT code,verifier_salt,verifier_hash FROM customer_otp_challenges WHERE id=?").get(challenge.challengeId);
 assert.equal(row.code,"[hashed]");assert.ok(row.verifier_salt.length>=32);assert.ok(row.verifier_hash.length>20);
 assert.notEqual(row.verifier_hash,challenge.sandboxCode);assert.ok(!JSON.stringify(row).includes(challenge.sandboxCode));
 const verified=await verifyCustomerOtp(db,{challengeId:challenge.challengeId,code:challenge.sandboxCode});
 assert.ok(verified.assertion.includes("."));
 const consumed=sqlite.prepare("SELECT consumed,verifier_salt,verifier_hash FROM customer_otp_challenges WHERE id=?").get(challenge.challengeId);
 assert.equal(consumed.consumed,1);assert.equal(consumed.verifier_salt,null);assert.equal(consumed.verifier_hash,null);
 sqlite.prepare("UPDATE customer_otp_challenges SET created_at=? WHERE id=?").run(Date.now()-2*60*60*1000,challenge.challengeId);
 await purgeCustomerOtpChallenges(db);
 assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_otp_challenges WHERE id=?").get(challenge.challengeId).c,0);
 const expired=await requestCustomerOtp(db,{phone:"9876543211"});
 sqlite.prepare("UPDATE customer_otp_challenges SET expires_at=? WHERE id=?").run(Date.now()-2*60*60*1000,expired.challengeId);
 await purgeCustomerOtpChallenges(db);
 assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_otp_challenges WHERE id=?").get(expired.challengeId).c,0);
});

test("partner OTP persists only a salted keyed verifier and erases it on use",async()=>{
 const{requestPartnerOtp,verifyPartnerOtp}=await import("../lib/partner-otp.ts");
 const{sqlite,db}=fresh();
 const challenge=await requestPartnerOtp(db,{phone:"9988776655"});
 const row=sqlite.prepare("SELECT code,verifier_salt,verifier_hash FROM partner_otp_challenges WHERE id=?").get(challenge.challengeId);
 assert.equal(row.code,"[hashed]");assert.ok(row.verifier_salt.length>=32);assert.ok(row.verifier_hash.length>20);assert.ok(!JSON.stringify(row).includes(challenge.sandboxCode));
 const verified=await verifyPartnerOtp(db,{challengeId:challenge.challengeId,code:challenge.sandboxCode,name:"Audit Provider"});
 assert.ok(verified.assertion.includes("."));
 const consumed=sqlite.prepare("SELECT consumed,verifier_salt,verifier_hash FROM partner_otp_challenges WHERE id=?").get(challenge.challengeId);
 assert.equal(consumed.consumed,1);assert.equal(consumed.verifier_salt,null);assert.equal(consumed.verifier_hash,null);
});

test("UAT access codes and signed tokens are checked through constant-time comparison",async()=>{
 const source=read("lib/uat-staging-auth.ts");
 assert.match(source,/constantTimeEqual\(String\(code\|\|""\),expected\)/);
 assert.match(source,/constantTimeEqual\(expect,sig\)/);
 assert.doesNotMatch(source,/expect\s*!==\s*sig/);
 const uat=await import("../lib/uat-staging-auth.ts");
 const env={PAWSPACE_UAT_ACCESS_CODE:"A".repeat(40),PAWSPACE_UAT_LOGIN:"on",PAWSPACE_UAT_SIGNING_KEY:"B".repeat(40)};
 assert.equal(uat.uatAccessCodeValid(env,"A".repeat(40)),true);assert.equal(uat.uatAccessCodeValid(env,"A".repeat(39)+"B"),false);
});

test("all central API authorization errors receive no-store, nosniff, and referrer policy",async()=>{
 const{secureApiResponse}=await import("../lib/api-security-headers.ts");
 for(const status of[401,403]){const response=secureApiResponse(Response.json({error:"denied"},{status}));assert.equal(response.status,status);assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("x-content-type-options"),"nosniff");assert.equal(response.headers.get("referrer-policy"),"same-origin");}
 const worker=read("worker/index.ts");
 assert.match(worker,/sessionAccess instanceof Response\)return secureApiResponse\(sessionAccess\)/);
 assert.match(worker,/access instanceof Response\) return secureApiResponse\(access\)/);
});

test("caller-supplied workspace identity is stripped on direct or undeclared-trust deployed ingress",async()=>{
 const{resolveTrustedWorkspaceIdentity,requestForAuthorization}=await import("../lib/trusted-workspace-identity.ts");
 const headers={"oai-authenticated-user-email":"founder@pawspace.in","oai-authenticated-user-full-name":"Founder"};
 const direct=new Request("https://pawspace-test.workers.dev/api/finance-control",{headers});
 assert.equal(resolveTrustedWorkspaceIdentity(direct,{PAWSPACE_DEPLOYMENT_ENV:"production",PAWSPACE_WORKSPACE_IDENTITY_TRUST:"openai-dispatch"}),null,"direct Worker hostname is never a trusted dispatch boundary");
 const deployed=new Request("https://app.pawspace.in/api/finance-control",{headers});
 assert.equal(resolveTrustedWorkspaceIdentity(deployed,{PAWSPACE_DEPLOYMENT_ENV:"production"}),null,"declared production without dispatch trust fails closed");
 const sanitized=requestForAuthorization(deployed,{PAWSPACE_DEPLOYMENT_ENV:"production"});
 assert.equal(sanitized.headers.get("oai-authenticated-user-email"),null);
 const trusted=resolveTrustedWorkspaceIdentity(deployed,{PAWSPACE_DEPLOYMENT_ENV:"production",PAWSPACE_WORKSPACE_IDENTITY_TRUST:"openai-dispatch"});
 assert.equal(trusted?.email,"founder@pawspace.in");
 assert.match(read("lib/server-auth.ts"),/resolveTrustedWorkspaceIdentity/);
 assert.match(read("worker/index.ts"),/requestForAuthorization/);
});
