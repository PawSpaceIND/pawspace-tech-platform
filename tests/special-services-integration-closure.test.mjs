import test from "node:test";
import assert from "node:assert/strict";
import {freshSqlite,makeD1}from"./helpers/taxi-harness.mjs";
import {installWorkersHooks}from"./helpers/module-hooks.mjs";
installWorkersHooks("__SPECIAL_DB__","__SPECIAL_ENV__");
const relocation=await import("../lib/relocation-governance.ts");
const funeral=await import("../lib/funeral-memorial-governance.ts");
const manual=await import("../lib/funeral-manual-order.ts");
const DAYTIME_IST=Date.parse("2026-09-11T08:30:00.000Z"); // 14:00 Asia/Kolkata

test("Relocation case creation lands in canonical CRM and communication outbox",async t=>{
 t.mock.method(Date,"now",()=>DAYTIME_IST);
 const sqlite=freshSqlite(),db=makeD1(sqlite),customerId="CUST-RELO-LINK";
 const row=await relocation.createRelocationCase(db,{customerId,petName:"Milo",breed:"Indie",ageYears:4,sizeClass:"medium",travelMode:"air",originCountry:"India",originCity:"Bengaluru",destinationCountry:"UAE",destinationCity:"Dubai",targetTravelDate:new Date(Date.now()+30*86400000).toISOString(),crateRequirement:"assessment_required"},"agent@pawspace.test");
 const link=sqlite.prepare("SELECT * FROM special_service_case_links WHERE case_id=?").get(row.id);
 assert.equal(link.customer_id,customerId); assert.equal(link.service_code,"relocation");
 const lead=sqlite.prepare("SELECT service,lifecycle_state FROM lead_work_items WHERE id=?").get(link.lead_id);
 assert.equal(lead.service,"relocation"); assert.equal(lead.lifecycle_state,"qualified");
 const message=sqlite.prepare("SELECT m.template_key,o.status FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.lead_id=?").get(link.lead_id);
 assert.equal(message.template_key,"relocation_case_created"); assert.ok(["queued","scheduled"].includes(message.status),`lifecycle outbox must remain dispatchable, got ${message.status}`);
});

test("Funeral request uses canonical sensitive-care CRM and lifecycle communication",async t=>{
 t.mock.method(Date,"now",()=>DAYTIME_IST);
 const sqlite=freshSqlite(),db=makeD1(sqlite),customerId="CUST-FUN-LINK";
 await funeral.saveFuneralServiceConfig(db,{serviceType:"cremation",enabled:true,baseAmount:6500,cashAllowed:false},"ops@pawspace.test");
 const row=await funeral.createFuneralCase(db,{customerId,petName:"Bruno",petSpecies:"dog",pickupAddress:"HSR Layout",serviceType:"cremation",memorialOption:"none"},"care@pawspace.test");
 const link=sqlite.prepare("SELECT * FROM special_service_case_links WHERE case_id=?").get(row.id);
 assert.equal(link.customer_id,customerId); assert.equal(link.service_code,"funeral");
 const message=sqlite.prepare("SELECT m.template_key,m.payload_json,o.status FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.lead_id=?").get(link.lead_id);
 assert.equal(message.template_key,"funeral_request_received"); assert.ok(["queued","scheduled"].includes(message.status),`lifecycle outbox must remain dispatchable, got ${message.status}`);
 assert.match(JSON.parse(message.payload_json).message,/received your request/i);
});

test("Funeral manual converted orders take tax only from canonical Funeral finance policy",async()=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);
 const changed=await manual.setFuneralManualGstMode(db,{enabled:true,gstRate:.18,actorId:"finance@pawspace.test"});
 assert.equal(changed.canonicalTaxAuthority,"funeral_commercial_finance");
 await db.prepare("UPDATE funeral_manual_gst_config SET gst_enabled=0,gst_rate=.01 WHERE id='default'").run();
 const order=await manual.recordFuneralConvertedOrder(db,{customerName:"Test Parent",phone:"9999999999",paymentMethod:"uat",orderValue:1180,orderDate:new Date().toISOString().slice(0,10),actorId:"finance@pawspace.test"});
 assert.equal(order.gstEnabled,true); assert.equal(order.gstAmount,180); assert.equal(order.totalAmount,1180);
 assert.equal(order.canonicalTaxAuthority,"funeral_commercial_finance");
 const directory=await manual.funeralManualOrderDirectory(db);
 assert.equal(directory.truth.legacyGstToggleAuthoritative,false);
 assert.equal(directory.truth.canonicalTaxAuthority,"funeral_commercial_finance");
});
