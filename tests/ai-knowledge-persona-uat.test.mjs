import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
installWorkersHooks();
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const runtime=await import("../lib/ai-grounded-runtime-provider.ts");
const orchestrator=await import("../lib/ai-conversation-orchestrator.ts");

test("UAT prompts classify realistic service, booking and refund queries deterministically",()=>{
 assert.equal(orchestrator.classifyAiIntent("What is the price for doorstep dog training?").intent,"service_info");
 assert.equal(orchestrator.classifyAiIntent("Can I book a grooming session?").intent,"booking_create");
 assert.equal(orchestrator.classifyAiIntent("I need a refund for yesterday.").intent,"refund_review");
});

test("voice persona is TTS-safe while chat and WhatsApp permit structured replies",()=>{
 const voice=runtime.pawspaceChannelSystemPrompt("voice");
 assert.match(voice,/No markdown/);assert.match(voice,/no bullets/);assert.match(voice,/no emojis/);assert.match(voice,/one to three short sentences/);
 const chat=runtime.pawspaceChannelSystemPrompt("chat");assert.match(chat,/bullets/);assert.match(chat,/payment link/);
 const whatsapp=runtime.pawspaceChannelSystemPrompt("whatsapp");assert.match(whatsapp,/compact bullets/);assert.match(whatsapp,/payment links/);
});

test("human-by-exception intents fail closed before an external model call",()=>{
 for(const message of["I need a refund for yesterday","My dog is bleeding, this is an emergency","The trainer did not come today","I want to make a serious complaint about this service"]){assert.equal(runtime.requiresImmediateHumanHandoff(message),true,message);}
 assert.equal(runtime.requiresImmediateHumanHandoff("What is the price for doorstep dog training?"),false);
});

test("grounding uses approved internal read tools and never invokes mutation tools",()=>{
 const source=read("lib/ai-grounded-runtime-provider.ts");
 assert.match(source,/toolCode:\"approved_knowledge\.read\"/);assert.match(source,/toolCode:\"service_catalogue\.read\"/);
 for(const forbidden of["refund.issue","payment.capture","price.override","provider.assign","booking.request","booking_cancel.request","booking_reschedule.request"])assert.doesNotMatch(source,new RegExp(`toolCode:\\"${forbidden.replaceAll(".","\\.")}\\"`));
 assert.match(source,/mutationsAuthorized:false/);assert.match(source,/readOnlyToolsOnly:true/);
});

test("canonical UAT catalogue coverage includes the major PawSpace service verticals",()=>{
 const source=read("lib/ai-grounded-runtime-provider.ts");
 for(const table of["service_packages","training_commercial_packages","boarding_commercial_packages","sitting_commercial_packages","walking_commercial_packages","taxi_route_classes"])assert.match(source,new RegExp(table));
 assert.match(source,/dogTraining/);assert.match(source,/petSitting/);assert.match(source,/dogWalking/);assert.match(source,/petTaxi/);
});

test("Chat, WhatsApp and Voice all use the same grounded runtime provider",()=>{
 const web=read("lib/ai-web-chat-adapter.ts"),wa=read("lib/meta-whatsapp-ai-executor.ts"),voice=read("lib/inbound-ai-telephony.ts");
 for(const source of[web,wa,voice])assert.match(source,/createGroundedAiRuntimeProvider/);
 assert.match(web,/createGroundedAiRuntimeProvider\(db,input\.actor,\"chat\"\)/);
 assert.match(wa,/createGroundedAiRuntimeProvider\(db,serviceActor,\"whatsapp\"\)/);
 assert.match(voice,/createGroundedAiRuntimeProvider\(db,serviceActor,\"voice\"\)/);
});
