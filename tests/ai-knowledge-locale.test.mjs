import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

await installWorkersHooks();

const locale=await import("../lib/voice-locale.ts");
const telephony=await import("../lib/voice-telephony-provider.ts");
const read=(path)=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

test("Bengaluru voice locale mapping is canonical and provider-safe",()=>{
  assert.equal(locale.canonicalVoiceLocale("English"),"en-IN");
  assert.equal(locale.canonicalVoiceLocale("hi"),"hi-IN");
  assert.equal(locale.canonicalVoiceLocale("kn_IN"),"kn-IN");
  assert.equal(locale.canonicalVoiceLocale("unsupported"),"en-IN");
  assert.equal(locale.speechLanguageCode("en-IN"),"en");
  assert.equal(locale.speechLanguageCode("hi-IN"),"hi");
  assert.equal(locale.speechLanguageCode("kn-IN"),"kn");
});

test("telephony context round-trips locale and remains backward compatible",()=>{
  const encoded=locale.encodeTelephonyCallContext("VCALL-123","Kannada");
  assert.deepEqual(locale.decodeTelephonyCallContext(encoded),{callRef:"VCALL-123",locale:"kn-IN"});
  assert.deepEqual(locale.decodeTelephonyCallContext("VCALL-OLD"),{callRef:"VCALL-OLD",locale:"en-IN"});
});

test("Exotel callback restores structured CustomField call and locale context",()=>{
  const custom=locale.encodeTelephonyCallContext("VCALL-456","Kannada");
  const body=new URLSearchParams({CallSid:"EXO-1",CallStatus:"completed",CustomField:custom}).toString();
  const event=telephony.normaliseTelephonyEvent(body,"exotel");
  assert.equal(event.callRef,"VCALL-456");
  assert.equal(event.locale,"kn-IN");
});

test("AI knowledge center reads governed package, subscription and active knowledge sources",()=>{
  const source=read("lib/ai-knowledge-center.ts");
  assert.match(source,/catalogue_packages/);
  assert.match(source,/grooming_subscription_plans/);
  assert.match(source,/ai_knowledge_source_versions/);
  assert.match(source,/status='active'/);
  assert.match(source,/effective_from/);
  assert.match(source,/visibility_scope_json/);
  assert.match(source,/groomingCatalogue\.filter/);
});

test("shared AI context and Haptik consume the governed knowledge center",()=>{
  const governance=read("lib/ai-governance.ts"),haptik=read("app/api/haptik/route.ts");
  assert.match(governance,/loadAiKnowledgeCenter/);
  assert.match(governance,/Object\.assign\(input\.context,\{knowledgeCenter\}\)/);
  assert.match(haptik,/action==="knowledge_context"/);
  assert.match(haptik,/canonicalVoiceLocale/);
});

test("speech routing maps BCP-47 locales to provider language codes",()=>{
  const workers=read("lib/voice-workers-ai.ts"),route=read("app/api/voice-speech/route.ts"),adapter=read("lib/voice-provider-adapter.ts");
  assert.match(workers,/whisper-large-v3-turbo/);
  assert.match(workers,/speechLanguageCode/);
  assert.match(workers,/request\.language=language/);
  assert.match(workers,/lang \}/);
  assert.match(route,/canonicalVoiceLocale/);
  assert.match(route,/supportedLocales/);
  assert.match(adapter,/\{ audioRef: input\.audioRef, locale, language \}/);
  assert.match(adapter,/\{ text: input\.text, locale, language \}/);
});

test("outbound ledger, Exotel and service recovery preserve the canonical locale",()=>{
  const provider=read("lib/voice-telephony-provider.ts");
  const governance=read("lib/voice-outbound-governance.ts");
  const recovery=read("lib/service-recovery-audio-bot.ts");
  assert.match(provider,/CustomField: encodeTelephonyCallContext\(intent\.callRef, intent\.locale\)/);
  assert.match(provider,/decodeTelephonyCallContext/);
  assert.match(governance,/locale TEXT NOT NULL DEFAULT 'en-IN'/);
  assert.match(governance,/callRef: id, locale/);
  assert.match(governance,/locale: canonicalVoiceLocale\(original\.locale\)/);
  assert.match(governance,/event\.locale !== callLocale/);
  assert.match(recovery,/getUserLocale/);
  assert.match(recovery,/locale:canonicalVoiceLocale\(preferredLocale\)/);
  assert.match(recovery,/language:locale/);
  assert.match(recovery,/locale:recipient\.locale/);
});
