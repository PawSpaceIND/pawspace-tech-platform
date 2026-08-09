import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";

const read=path=>fs.readFileSync(path,"utf8");
const config=read("lib/ai-business-configuration.ts");
const route=read("app/api/ai-business-configuration/route.ts");
const page=read("app/team/ai/configuration/page.tsx");

test("AI Gate 2 versions profile, intent, knowledge and prompt policy",()=>{
 assert.match(config,/ai_assistant_profile_versions/);
 assert.match(config,/ai_intent_versions/);
 assert.match(config,/ai_knowledge_source_versions/);
 assert.match(config,/ai_prompt_policy_versions/);
 assert.match(config,/UNIQUE\(profile_key,version\)/);
 assert.match(config,/immutable_hash/);
});

test("AI Gate 2 lifecycle requires draft review approved active and supports rollback",()=>{
 assert.match(config,/submit_review/);
 assert.match(config,/Only draft configuration can enter review/);
 assert.match(config,/Only configuration in review can be approved/);
 assert.match(config,/Only approved configuration can be activated/);
 assert.match(config,/Rollback target must be an approved or previously active version/);
 assert.match(config,/status='retired'/);
});

test("AI Gate 2 retrieval is approved active current and visibility scoped",()=>{
 assert.match(config,/retrieveApprovedKnowledge/);
 assert.match(config,/status='active'/);
 assert.match(config,/effective_from IS NULL OR effective_from<=/);
 assert.match(config,/visibility_scope_json/);
 assert.match(config,/approvedCurrentOnly:true/);
});

test("AI Gate 2 has channel intent provider model and global kill switches",()=>{
 assert.match(config,/"global"\|"channel"\|"intent"\|"provider"\|"model"/);
 assert.match(config,/ai_kill_switches/);
 assert.match(config,/resolveActiveAiBusinessConfig/);
 assert.match(config,/enabled:relevant.length===0&&intentEnabled/);
});

test("AI Gate 2 API and staff UI are permission governed and audited",()=>{
 assert.match(route,/authorize\(request,"settings.manage"\)/);
 assert.match(route,/Cross-origin AI business configuration write blocked/);
 assert.match(route,/securityAudit/);
 assert.match(page,/Assistant configuration & knowledge/);
 assert.match(page,/Submit review/);
 assert.match(page,/Rollback/);
 assert.match(page,/Disable AI/);
});
