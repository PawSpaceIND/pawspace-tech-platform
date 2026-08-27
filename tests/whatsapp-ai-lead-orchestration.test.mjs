import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__WHATSAPP_AI_LEAD_DB__");

function makeD1(sqlite){function statement(sql,args){return{bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})};}return{prepare:sql=>statement(sql,[]),batch:async statements=>{const results=[];for(const item of statements)results.push(await item.run());return results;},exec:async sql=>sqlite.exec(sql)};}

async function world(){
 const sqlite=new DatabaseSync(":memory:"),db=makeD1(sqlite);
 sqlite.exec(`
  CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT,owner TEXT,source TEXT,lifetime_value REAL,next_action TEXT,opportunity TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,source TEXT NOT NULL,service TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,work_day INTEGER NOT NULL,assigned_at INTEGER NOT NULL,first_action_due_at INTEGER NOT NULL,manager_alert_at INTEGER NOT NULL,first_action_at INTEGER,call_attempts INTEGER NOT NULL DEFAULT 0,whatsapp_attempts INTEGER NOT NULL DEFAULT 0,last_outcome TEXT,next_action_at INTEGER,recycle_at INTEGER,recycle_cycle INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,converted_booking_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 `);
 const workflow=await import("../lib/whatsapp-ai-lead-orchestration.ts");
 await workflow.ensureWhatsAppAiLeadTables(db);
 return{sqlite,db,workflow};
}

function seed(ctx,{contactId="CU-LEAD",leadId="LEAD-1",phone="9876543210",optOut=0}={}){
 const now=Date.now();
 ctx.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,stage,owner,source,opportunity,created_at,updated_at) VALUES (?,?,?,'Bangalore','New lead','Neha','Website','Grooming',?,?)").run(contactId,"Ananya Rao",phone,now,now);
 ctx.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,opt_out,created_at,updated_at) VALUES (?,?,'Website','Grooming','Neha','Sales Manager','active','day_1',1,?,?,?,?,?,?)").run(leadId,contactId,now,now+600000,now+1800000,optOut,now,now);
 return{contactId,leadId};
}

function input(ids,overrides={}){return{...ids,idempotencyKey:`lead-created:${ids.leadId}`,consentGranted:true,consentSource:"website_contact_checkbox",consentEvidenceRef:"public-contact-whatsapp-consent-v1",actorId:"public-contact",assignedTo:"Neha",cityId:"blr",...overrides};}

test("lead without explicit consent remains staff-only and creates no outbound identity",async()=>{
 const ctx=await world(),ids=seed(ctx);
 const result=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids,{consentGranted:false,consentEvidenceRef:""}));
 assert.equal(result.status,"blocked");assert.equal(result.reason,"explicit_whatsapp_consent_required");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM canonical_customers").get().count,0);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_messages").get().count,0);
});

test("an approved non-marketing template creates one lead-linked WhatsApp conversation",async()=>{
 const ctx=await world(),ids=seed(ctx);
 ctx.sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key=?").run(ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);
 const first=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids)),replay=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(first.status,"queued");assert.equal(first.marketing,false);assert.equal(first.externalDelivery,false);
 assert.equal(replay.duplicatePrevented,true);assert.equal(replay.message_id,first.message_id);
 const thread=ctx.sqlite.prepare("SELECT customer_id,lead_id,status FROM communication_threads WHERE id=?").get(first.thread_id);
 assert.equal(thread.customer_id,ids.contactId);assert.equal(thread.lead_id,ids.leadId);assert.equal(thread.status,"open");
 const message=ctx.sqlite.prepare("SELECT purpose,template_key,status,idempotency_key FROM communication_messages WHERE id=?").get(first.message_id);
 assert.equal(message.purpose,"transactional");assert.equal(message.template_key,ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);assert.equal(message.status,"queued");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_messages").get().count,1);
 const preference=ctx.sqlite.prepare("SELECT marketing_consent,service_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").get(ids.contactId);
 assert.equal(preference.marketing_consent,0);assert.equal(preference.service_consent,0);assert.equal(preference.whatsapp_consent,1);assert.equal(preference.opt_out,0);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM whatsapp_ai_consent_evidence WHERE lead_id=? AND purpose='lead_response'").get(ids.leadId).count,1);
});

test("missing Meta template approval preserves the lead and reports setup required",async()=>{
 const ctx=await world(),ids=seed(ctx);
 const result=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(result.status,"setup_required");assert.equal(result.reason,"approved_template_required");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM crm_contacts WHERE id=?").get(ids.contactId).count,1);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_messages").get().count,0);
 ctx.sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key=?").run(ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);
 const retried=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(retried.status,"queued");assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM whatsapp_ai_consent_evidence WHERE lead_id=?").get(ids.leadId).count,1);
});

test("a lead first saved without consent can be safely retried after consent evidence is captured",async()=>{
 const ctx=await world(),ids=seed(ctx);
 const blocked=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids,{consentGranted:false,consentEvidenceRef:""}));assert.equal(blocked.status,"blocked");
 ctx.sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key=?").run(ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);
 const retried=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(retried.status,"queued");assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM whatsapp_ai_lead_triggers WHERE lead_id=?").get(ids.leadId).count,1);
});

test("ambiguous phone identity opens review instead of messaging the wrong customer",async()=>{
 const ctx=await world(),ids=seed(ctx),now=Date.now();
 for(const id of["CUS-A","CUS-B"])ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr',?,'9876543210','test','{}',?,?)").run(id,id,now,now);
 ctx.sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key=?").run(ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);
 const result=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(result.status,"identity_review");assert.equal(result.reason,"phone_matches_multiple_customers");
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM whatsapp_ai_identity_reviews WHERE lead_id=? AND status='open'").get(ids.leadId).count,1);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_messages").get().count,0);
});

test("a recorded opt-out cannot be overwritten by new lead consent",async()=>{
 const ctx=await world(),ids=seed(ctx),now=Date.now();
 ctx.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,'blr','Ananya','9876543210','test','{}',?,?)").run(ids.contactId,now,now);
 ctx.sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,0,0,0,1,'customer','customer',?)").run(ids.contactId,now);
 ctx.sqlite.prepare("UPDATE whatsapp_uat_templates SET status='approved' WHERE template_key=?").run(ctx.workflow.WHATSAPP_AI_LEAD_TEMPLATE);
 const result=await ctx.workflow.startWhatsAppAiLead(ctx.db,input(ids));
 assert.equal(result.status,"blocked");assert.equal(result.reason,"customer_opted_out");
 assert.equal(ctx.sqlite.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").get(ids.contactId).whatsapp_consent,0);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) count FROM communication_messages").get().count,0);
});
