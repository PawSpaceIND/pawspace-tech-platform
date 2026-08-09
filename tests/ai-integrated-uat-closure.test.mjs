import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const whatsapp=read("lib/whatsapp-uat-adapter.ts"),whatsappRoute=read("app/api/whatsapp-uat-webhook/route.ts"),web=read("lib/ai-web-chat-adapter.ts"),voice=read("lib/ai-voice-uat.ts"),orchestrator=read("lib/ai-conversation-orchestrator.ts"),tools=read("lib/ai-tool-registry.ts"),handoff=read("lib/ai-human-handoff.ts"),evaluation=read("lib/ai-evaluation-security.ts"),analytics=read("lib/ai-analytics.ts"),evidence=read("docs/AI_ENGAGEMENT_INTEGRATED_UAT.md");

test("Integrated AI UAT keeps one canonical conversation and orchestrator across channels",()=>{
 for(const source of[whatsapp,web,voice])assert.match(source,/communication_threads|communication_messages/);
 assert.match(whatsappRoute,/orchestrateAiTurn/);assert.match(whatsappRoute,/channel:"whatsapp"/);
 assert.match(web,/orchestrateAiTurn/);assert.match(web,/channel:"chat"/);
 assert.match(voice,/orchestrateAiTurn/);assert.match(voice,/channel:"voice"/);
 assert.match(orchestrator,/AiConversationChannel="whatsapp"\|"chat"\|"voice"/);
});

test("Integrated AI UAT retains fail-closed provider and autonomy boundaries",()=>{
 assert.match(orchestrator,/notConnectedAiProvider/);assert.match(orchestrator,/autonomousExecution:false/);
 assert.match(voice,/disconnectedStt/);assert.match(voice,/disconnectedTts/);assert.match(voice,/productionTelephony:false/);
 assert.match(evidence,/PRODUCTION READY = FALSE/);
});

test("Integrated AI UAT keeps governed tools and human ownership boundaries",()=>{
 assert.match(tools,/approval_gated/);assert.match(tools,/explicitly_confirmed/);assert.match(tools,/autonomousExecution:false/);
 assert.match(handoff,/assertAiMayReply/);assert.match(handoff,/staff_active/);assert.match(handoff,/resume_ai/);assert.match(handoff,/ai_handoff_active_thread_idx/);
});

test("Integrated AI UAT retains evaluation security and canonical analytics truth",()=>{
 for(const marker of["prompt_injection","data_isolation","pii","tool_authorization","knowledge_freshness","multilingual","webhook_reliability"])assert.match(evaluation,new RegExp(marker));
 for(const marker of["ai_conversation_turns","ai_handoffs","ai_voice_calls","communication_delivery_events"])assert.match(analytics,new RegExp(marker));
 assert.match(analytics,/attributedConversionRate:null/);assert.match(analytics,/inferredSentiment:false/);assert.match(analytics,/firstResponseMs:null/);assert.match(analytics,/resolutionMs:null/);
});

test("Integrated AI UAT evidence separates engineering closure from production activation",()=>{
 assert.match(evidence,/engineering UAT candidate/);assert.match(evidence,/real-device WhatsApp and telephony UAT/);assert.match(evidence,/controlled Bengaluru pilot evidence/);assert.match(evidence,/Integration Readiness controlled-live approval/);
});
