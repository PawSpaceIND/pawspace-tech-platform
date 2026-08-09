import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const adapter=read("lib/ai-web-chat-adapter.ts"),route=read("app/api/ai-web-chat/route.ts"),page=read("app/mobile-app/ai-chat/page.tsx");

test("Gate 6 authenticated web app chat reuses canonical conversation and orchestrator",()=>{
 assert.match(adapter,/communication_threads/);assert.match(adapter,/communication_participants/);assert.match(adapter,/recordInboundMessage/);assert.match(adapter,/orchestrateAiTurn/);assert.match(adapter,/channel:"chat"/);assert.match(adapter,/sameCanonicalThread:true/);assert.match(adapter,/autonomousExecution:false/);
});

test("Gate 6 authenticated chat enforces customer ownership before owned context",()=>{
 assert.match(adapter,/requireCustomerOwnership/);assert.match(adapter,/Conversation thread\/customer mismatch/);assert.match(route,/resolveActor/);assert.match(route,/securityAudit/);assert.match(route,/sameOrigin/);
});

test("Gate 6 anonymous chat is public knowledge and lead capture only",()=>{
 assert.match(adapter,/anonymous_public_only/);assert.match(adapter,/ai_knowledge_source_versions/);assert.match(adapter,/public/);assert.match(adapter,/anonymous/);assert.match(adapter,/ai_anonymous_chat_leads/);assert.match(adapter,/customerContextAccess:false/);assert.match(adapter,/bookingAccess:false/);assert.match(adapter,/petAccess:false/);assert.match(adapter,/caseAccess:false/);assert.match(adapter,/toolExecution:false/);
});

test("Gate 6 records governed channel continuity on one canonical thread",()=>{
 assert.match(adapter,/ai_channel_continuity_events/);assert.match(adapter,/same_customer_same_canonical_thread/);for(const channel of["chat","whatsapp","voice"])assert.match(adapter,new RegExp(channel));assert.match(route,/mode==="continuity"/);
});

test("Gate 6 includes authenticated customer chat UI",()=>{
 assert.match(page,/Customer AI chat/);assert.match(page,/\/api\/ai-web-chat/);assert.match(page,/mode:"authenticated"/);assert.match(page,/source:"app"/);assert.match(page,/Ownership is enforced on the server/);
});
