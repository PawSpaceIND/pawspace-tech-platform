import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const voice=read("lib/ai-voice-uat.ts"),route=read("app/api/ai-voice-uat/route.ts");

test("Gate 8 exposes telephony STT TTS abstractions without production transport",()=>{assert.match(voice,/VoiceTransportProvider/);assert.match(voice,/VoiceSttProvider/);assert.match(voice,/VoiceTtsProvider/);assert.match(voice,/disconnectedStt/);assert.match(voice,/disconnectedTts/);assert.match(voice,/productionTelephony:false/);assert.doesNotMatch(voice,/fetch\(/);});

test("Gate 8 stores voice transcript segments on canonical communication history and shared orchestrator",()=>{assert.match(voice,/communication_messages/);assert.match(voice,/'voice'/);assert.match(voice,/ai_voice_segments/);assert.match(voice,/orchestrateAiTurn/);assert.match(voice,/channel:"voice"/);});

test("Gate 8 records consent barge-in outcomes and reconnect failures",()=>{assert.match(voice,/Voice consent is required/);assert.match(voice,/barge_in/);assert.match(voice,/outcome/);assert.match(voice,/disposition/);assert.match(voice,/transport_reconnected/);assert.match(voice,/staffFallbackRequired/);});

test("Gate 8 live-agent transfer preserves canonical thread and governed handoff",()=>{assert.match(voice,/requestAiHumanHandoff/);assert.match(voice,/sameCanonicalThread:true/);assert.match(voice,/live_agent_transfer/);});

test("Gate 8 API is same-origin authenticated and security audited",()=>{assert.match(route,/Cross-origin AI voice write blocked/);assert.match(route,/resolveActor/);assert.match(route,/securityAudit/);assert.match(route,/ai\.voice\./);});
