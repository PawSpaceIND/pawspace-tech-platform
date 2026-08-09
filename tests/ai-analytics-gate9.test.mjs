import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const analytics=read("lib/ai-analytics.ts"),route=read("app/api/ai-analytics/route.ts"),page=read("app/team/ai/analytics/page.tsx");

test("Gate 9 derives volume containment handoff performance and delivery from canonical sources",()=>{for(const marker of["ai_conversation_turns","ai_handoffs","ai_voice_calls","communication_delivery_events"])assert.match(analytics,new RegExp(marker));assert.match(analytics,/byChannel/);assert.match(analytics,/byIntent/);assert.match(analytics,/handoffTurns/);assert.match(analytics,/avgLatencyMs/);assert.match(analytics,/inputTokens/);assert.match(analytics,/outputTokens/);assert.match(analytics,/costMinor/);});

test("Gate 9 does not fabricate conversion resolution response or CSAT",()=>{assert.match(analytics,/canonicalBookingLinkedThreads/);assert.match(analytics,/attributedConversionRate:null/);assert.match(analytics,/ai_explicit_csat/);assert.match(analytics,/inferredSentiment:false/);assert.match(analytics,/firstResponseMs:null/);assert.match(analytics,/resolutionMs:null/);assert.match(analytics,/no causal conversion claim/);});

test("Gate 9 analytics API is report governed and filter bounded",()=>{assert.match(route,/authorize\(request,"reports\.view"\)/);assert.match(route,/whatsapp/);assert.match(route,/chat/);assert.match(route,/voice/);assert.match(route,/Unsupported channel filter/);assert.match(route,/cache-control/);});

test("Gate 9 staff surface labels unsupported KPIs instead of inventing values",()=>{assert.match(page,/Source-derived operational analytics only/);assert.match(page,/Attributed conversion/);assert.match(page,/Not claimed/);assert.match(page,/First response/);assert.match(page,/Not attributable yet/);assert.match(page,/Explicit CSAT/);});

test("Gate 9 remains UAT engineering only",()=>{assert.match(analytics,/productionReady:false/);assert.doesNotMatch(analytics,/Math\.random\(/);assert.doesNotMatch(page,/demo KPI|sample conversion|fake/);});
