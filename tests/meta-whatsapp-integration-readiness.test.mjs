import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__META_READINESS_DB__");

const source=fs.readFileSync(new URL("../lib/integration-readiness.ts",import.meta.url),"utf8");
const registry=await import("../lib/integration-readiness.ts");

function makeD1(sqlite){
 const statement=(sql,args=[])=>({
  bind:(...bound)=>statement(sql,bound),
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes||0)}};},
  all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  batchResult:async()=>/^SELECT\b/i.test(sql.trim())?{results:sqlite.prepare(sql).all(...args)}:statement(sql,args).run(),
 });
 return{
  prepare:sql=>statement(sql),
  batch:async items=>{sqlite.exec("BEGIN");try{const out=[];for(const item of items)out.push(await (typeof item.batchResult==="function"?item.batchResult():item.run()));sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}},
  exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0};},
 };
}

async function fresh(){
 const sqlite=new DatabaseSync(":memory:");
 const db=makeD1(sqlite);
 await registry.ensureIntegrationReadinessTables(db);
 return{sqlite,db};
}
const row=sqlite=>sqlite.prepare("SELECT * FROM integration_registry WHERE integration_code='INT-COMMS-01'").get();
const meta={
 PAWSPACE_COMMUNICATION_ENV:"uat",
 META_WHATSAPP_UAT_DELIVERY_ENABLED:"true",
 META_WHATSAPP_UAT_ACCESS_TOKEN:"token",
 META_WHATSAPP_PHONE_NUMBER_ID:"phone-id",
 META_WHATSAPP_WABA_ID:"waba-id",
 META_WHATSAPP_APP_SECRET:"app-secret",
 META_WHATSAPP_VERIFY_TOKEN:"verify-token",
 META_WHATSAPP_UAT_ALLOWLIST:"+919999999999",
 META_WHATSAPP_TEMPLATE_ALLOWLIST:"booking_update",
};

test("INT-COMMS-01 uses the direct Meta WhatsApp UAT credential contract",()=>{
 assert.match(source,/INT-COMMS-01[\s\S]*credentialDetector:"meta_whatsapp_uat"/);
 for(const name of ["META_WHATSAPP_UAT_ACCESS_TOKEN","META_WHATSAPP_PHONE_NUMBER_ID","META_WHATSAPP_WABA_ID","META_WHATSAPP_APP_SECRET","META_WHATSAPP_VERIFY_TOKEN","META_WHATSAPP_UAT_ALLOWLIST","META_WHATSAPP_TEMPLATE_ALLOWLIST"])assert.match(source,new RegExp(name));
 assert.match(source,/PAWSPACE_COMMUNICATION_ENV/);
 assert.match(source,/META_WHATSAPP_UAT_DELIVERY_ENABLED/);
 assert.doesNotMatch(source,/WATI_API_TOKEN|WATI_TENANT_URL|case"wati"/);
});

test("WATI credentials cannot satisfy canonical WhatsApp readiness, while complete Meta UAT configuration can",async()=>{
 const{sqlite,db}=await fresh();
 assert.equal(row(sqlite).credential_detector,"meta_whatsapp_uat");
 assert.equal(row(sqlite).provider,"Meta WhatsApp");
 await registry.syncIntegrationCredentialPresence(db,{WATI_API_TOKEN:"legacy",WATI_TENANT_URL:"https://legacy.invalid"});
 assert.equal(row(sqlite).credential_status,"missing");
 await registry.syncIntegrationCredentialPresence(db,{...meta,PAWSPACE_COMMUNICATION_ENV:"production"});
 assert.equal(row(sqlite).credential_status,"missing","production mode must not satisfy the UAT detector");
 await registry.syncIntegrationCredentialPresence(db,meta);
 assert.equal(row(sqlite).credential_status,"configured");
 assert.equal(row(sqlite).readiness_state,"sandbox_setup_required","credential presence must not claim verification");
});

test("existing automated WATI registry rows migrate to the Meta detector without advancing readiness",async()=>{
 const{sqlite,db}=await fresh();
 sqlite.prepare("UPDATE integration_registry SET provider='LimeChat / Meta WhatsApp',credential_detector='wati',credential_status='configured',secret_reference='env:wati',readiness_state='sandbox_setup_required',updated_by='runtime_presence_check' WHERE integration_code='INT-COMMS-01'").run();
 await registry.ensureIntegrationReadinessTables(db);
 const migrated=row(sqlite);
 assert.equal(migrated.provider,"Meta WhatsApp");
 assert.equal(migrated.credential_detector,"meta_whatsapp_uat");
 assert.equal(migrated.credential_status,"unknown");
 assert.equal(migrated.secret_reference,null);
 assert.equal(migrated.readiness_state,"sandbox_setup_required");
});