import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";

installWorkersHooks("__AUTH_LEGACY_DB__","__AUTH_LEGACY_ENV__");

function makeD1(sqlite){function statement(sql,args=[]){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out;}};}

test("legacy plaintext OTP rows are invalidated and scrubbed during in-place schema upgrade",async()=>{
 const sqlite=new DatabaseSync(":memory:");
 const now=Date.now();
 sqlite.exec("CREATE TABLE customer_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)");
 sqlite.exec("CREATE TABLE partner_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)");
 sqlite.prepare("INSERT INTO customer_otp_challenges VALUES (?,?,?,?,?,?,?)").run("OLD-C","9876543210","123456",0,0,now,now+300000);
 sqlite.prepare("INSERT INTO partner_otp_challenges VALUES (?,?,?,?,?,?,?)").run("OLD-P","9988776655","654321",0,0,now,now+300000);
 const db=makeD1(sqlite);
 globalThis.__AUTH_LEGACY_DB__=db;
 globalThis.__AUTH_LEGACY_ENV__={DB:db,PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT:"legacy-upgrade-secret-0123456789abcdef0123456789abcdef",PAWSPACE_IDENTITY_ENV:"sandbox",PAWSPACE_PAYMENT_ENV:"sandbox"};
 const{ensureCustomerOtpTables}=await import("../lib/customer-otp.ts");
 const{ensurePartnerOtpTables}=await import("../lib/partner-otp.ts");
 await ensureCustomerOtpTables(db);await ensurePartnerOtpTables(db);
 const customer=sqlite.prepare("SELECT code,consumed,verifier_salt,verifier_hash FROM customer_otp_challenges WHERE id='OLD-C'").get();
 const partner=sqlite.prepare("SELECT code,consumed,verifier_salt,verifier_hash FROM partner_otp_challenges WHERE id='OLD-P'").get();
 for(const row of[customer,partner]){assert.equal(row.code,"[hashed]");assert.equal(row.consumed,1);assert.equal(row.verifier_salt,null);assert.equal(row.verifier_hash,null);}
 assert.ok(!JSON.stringify(customer).includes("123456"));assert.ok(!JSON.stringify(partner).includes("654321"));
});
