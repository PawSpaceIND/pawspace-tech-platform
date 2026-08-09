import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const adapter=read("lib/ai-web-chat-adapter.ts"),route=read("app/api/ai-web-chat/route.ts"),page=read("app/chat/page.tsx");

test("Gate 6 public chat is limited to approved public knowledge and lead capture",()=>{assert.match(adapter,/ai_knowledge_source_versions/);assert.match(adapter,/scope\.includes\("public"\)/);assert.match(adapter,/customerDataAccess:false/);assert.match(adapter,/toolExecution:false/);assert.match(adapter,/ai_web_leads/);});

test("Gate 6 authenticated chat uses canonical customer ownership thread messages and shared orchestrator",()=>{assert.match(adapter,/requireCustomerOwnership/);assert.match(adapter,/communication_threads/);assert.match(adapter,/communication_messages/);assert.match(adapter,/'inbound','chat'/);assert.match(adapter,/orchestrateAiTurn/);assert.match(adapter,/channel:"chat"/);});

test("Gate 6 API enforces same origin and security audit",()=>{assert.match(route,/Cross-origin AI web chat write blocked/);assert.match(route,/resolveActor/);assert.match(route,/securityAudit/);assert.match(route,/ai\.web_chat\.turn/);});

test("Gate 6 staff handoff continuity remains on canonical thread",()=>{assert.match(adapter,/threadId/);assert.match(adapter,/autonomousExecution:false/);assert.match(page,/Canonical thread/);assert.match(page,/Authenticated customer/);});
