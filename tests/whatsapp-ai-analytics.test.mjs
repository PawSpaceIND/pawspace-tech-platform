import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installAiHooks, freshAiDb, seedCustomer, NOW } from "./helpers/ai-harness.mjs";

installAiHooks();
const analytics = await import("../lib/whatsapp-ai-analytics.ts");

async function world() {
  const { sqlite, db } = freshAiDb();
  seedCustomer(sqlite, "CUS-AN", "Analytics Customer", "9876500044");
  await analytics.ensureWhatsAppAiAnalytics(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER NOT NULL DEFAULT 0,service_consent INTEGER NOT NULL DEFAULT 0,whatsapp_consent INTEGER NOT NULL DEFAULT 0,sms_consent INTEGER NOT NULL DEFAULT 0,email_consent INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-AN','CUS-AN','BOOK-AN','LEAD-AN',NULL,'resolved','agent@pawspace.in',?, ?, ?)").run(NOW + 120_000, NOW, NOW + 300_000);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-AN-IN','THREAD-AN','CUS-AN','BOOK-AN','LEAD-AN',NULL,'inbound','whatsapp','transactional','inbound_message','{\"text\":\"hello\"}','received','sandbox_simulator','META-IN','an-in','{}','customer',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-AN-OUT','THREAD-AN','CUS-AN','BOOK-AN','LEAD-AN',NULL,'outbound','whatsapp','transactional','lead_first_response','{\"text\":\"reply\"}','sent','sandbox_simulator','META-OUT','an-out','{}','agent@pawspace.in',?,?)").run(NOW + 60_000, NOW + 60_000);
  for (const [eventType, offset] of [["delivered", 70_000], ["read", 80_000]]) sqlite.prepare("INSERT INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?,'{}',?)").run(`EV-${eventType}`, "MSG-AN-OUT", "sandbox_simulator", `META-${eventType}`, eventType, NOW + offset);
  sqlite.prepare("INSERT INTO conversation_audit_events (id,thread_id,message_id,action,actor_email,detail_json,created_at) VALUES ('AUD-RES','THREAD-AN',NULL,'status_resolved','agent@pawspace.in','{}',?)").run(NOW + 300_000);
  sqlite.prepare("INSERT INTO conversation_assignments (id,thread_id,assigned_to,assigned_by,status,reason,created_at,ended_at) VALUES ('ASG-AN','THREAD-AN','agent@pawspace.in','manager@pawspace.in','ended','resolved',?,?)").run(NOW + 30_000, NOW + 300_000);
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES ('CUS-AN',0,1,1,0,0,0,'uat','test',?)").run(NOW + 10_000);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-AN','CUS-AN','Meta','grooming','agent@pawspace.in','manager@pawspace.in','active','qualified',1,?,?,?,?,?)").run(NOW, NOW + 600_000, NOW + 900_000, NOW, NOW);
  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,fallback_queue,assigned_at,accepted_at,ended_at,ended_reason,previous_assignment_id,detail_json,created_by,created_at) VALUES ('LA-AN','la-an','LEAD-AN','agent@pawspace.in','sales_blr','POL-AN',1,'new_lead','current','whatsapp_sales',?,NULL,NULL,NULL,NULL,'{}','test',?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,status,scheduled_start,scheduled_end,channel,total_amount,currency,provider_id,provider_name,provider_status,provider_eta,created_at,updated_at) VALUES ('BOOK-AN','CUS-AN','grooming',NULL,'Grooming','confirmed','2026-08-28T10:00:00Z','2026-08-28T12:00:00Z','whatsapp',1200,'INR',NULL,NULL,NULL,NULL,?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO whatsapp_lead_attribution (id,source_platform,source_event_id,lead_id,customer_id,thread_id,campaign_id,ad_id,form_id,click_id,utm_source,utm_medium,utm_campaign,metadata_json,created_at,updated_at) VALUES ('WATTR-AN','meta','META-LEAD-AN','LEAD-AN','CUS-AN','THREAD-AN','CMP-1','AD-1','FORM-1',NULL,'meta','paid','grooming_blr','{}',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO whatsapp_conversion_facts (id,event_type,business_reference,lead_id,customer_id,thread_id,booking_id,payment_id,value_minor,currency,occurred_at,created_at) VALUES ('WCF-AN','booking_created','BOOK-AN','LEAD-AN','CUS-AN','THREAD-AN','BOOK-AN',NULL,120000,'INR',?,?)").run(NOW + 240_000, NOW + 240_000);
  sqlite.prepare("INSERT INTO whatsapp_conversion_feedback_outbox (id,fact_id,platform,payload_json,status,attempts,next_attempt_at,last_error,external_mutation,created_at,updated_at) VALUES ('WCFB-AN','WCF-AN','meta','{}','retry',2,?,'uat_simulated_provider_failure',0,?,?)").run(NOW + 300_000, NOW + 250_000, NOW + 250_000);
  sqlite.prepare("INSERT INTO ai_conversation_turns (id,session_id,thread_id,customer_id,input_message_id,idempotency_key,channel,intent_code,intent_confidence,context_id,provider,model_ref,output_text,latency_ms,input_tokens,output_tokens,cost_minor,policy_decision,outcome,handoff_reason,created_at,completed_at) VALUES ('AIT-AN','AIS-AN','THREAD-AN','CUS-AN','MSG-AN-IN','ait-an','whatsapp','service_info',0.9,'CTX-AN','sandbox',NULL,'reply',120,10,12,0,'allowed','replied',NULL,?,?)").run(NOW + 40_000, NOW + 41_000);
  sqlite.prepare("INSERT INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES ('BOT-AN','THREAD-AN','MSG-AN-IN','MSG-AN-OUT','pet','qualified','qualification_complete','reply','{}',?)").run(NOW + 50_000);
  return { sqlite, db };
}

test("WhatsApp analytics reconciles funnel, SLA, automation, queue, consent, attribution and feedback from canonical rows", async () => {
  const { db } = await world();
  const report = await analytics.buildWhatsAppAiAnalytics(db, { from: NOW - 1, to: NOW + 600_000 });
  assert.equal(report.whatsapp.funnel.inboundMessages, 1);
  assert.equal(report.whatsapp.funnel.outboundMessages, 1);
  assert.equal(report.whatsapp.funnel.deliveredEvents, 1);
  assert.equal(report.whatsapp.funnel.readEvents, 1);
  assert.equal(report.whatsapp.firstResponse.averageMs, 60_000);
  assert.equal(report.whatsapp.resolutionSla.averageMs, 300_000);
  assert.deepEqual(report.whatsapp.templateFunnel.messageStatus.map((row) => row.template_key), ["lead_first_response"]);
  assert.deepEqual(report.whatsapp.templateFunnel.deliveryEvents.map((row) => row.template_key), ["lead_first_response", "lead_first_response"]);
  assert.equal(report.automation.aiTurns, 1);
  assert.equal(report.automation.aiContainmentRate, 1);
  assert.equal(report.automation.chatbotTurns, 1);
  assert.equal(report.automation.chatbotQualifiedThreads, 1);
  assert.equal(report.people.byAssignee[0].assignee, "agent@pawspace.in");
  assert.equal(report.people.byQueueTeam[0].teamCode, "sales_blr");
  assert.equal(report.people.byQueueTeam[0].queue, "whatsapp_sales");
  assert.equal(report.consent.marketingSuppressed, 1);
  assert.equal(report.conversion.leadAttributedBookings, 1);
  assert.equal(report.conversion.leadAttributedRevenue, 1200);
  assert.equal(report.feedback.byPlatformStatus[0].status, "retry");
  assert.equal(Number(report.feedback.byPlatformStatus[0].attempts), 2);
  assert.equal(report.liveAdMutation, false);
});

test("CSV export contains the reconciled SLA, containment, suppression and attribution metrics", async () => {
  const { db } = await world();
  const report = await analytics.buildWhatsAppAiAnalytics(db, { from: NOW - 1, to: NOW + 600_000 });
  const csv = analytics.whatsappAnalyticsCsv(report);
  for (const metric of ["first_response_avg_ms", "resolution_avg_ms", "ai_containment_rate", "chatbot_qualified_threads", "marketing_suppressed", "lead_attributed_revenue"]) assert.match(csv, new RegExp(metric));
});

test("analytics screen and CSV share the reports.view authorization boundary", () => {
  const route = fs.readFileSync("app/api/whatsapp/analytics/route.ts", "utf8");
  const page = fs.readFileSync("app/team/whatsapp/analytics/page.tsx", "utf8");
  assert.match(route, /authorize\(request,"reports\.view"\)/);
  assert.match(route, /export.*csv/);
  assert.match(page, /\/api\/whatsapp\/analytics/);
  assert.match(page, /export=csv/);
  assert.match(page, /Live ad mutation disabled/);
});
