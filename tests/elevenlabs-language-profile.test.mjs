import test from 'node:test';
import assert from 'node:assert/strict';
import {PREMIUM_LANGUAGE_CODES,PREMIUM_LANGUAGES,premiumLanguagePresets,languageDetectionTool,premiumLanguagePrompt,PREMIUM_CALL_TARGETS,evaluatePremiumCallQuality,premiumLanguageReadiness} from '../lib/elevenlabs-language-profile.mjs';

test('premium Maya supports English plus eight requested Indian languages',()=>{
 assert.deepEqual(PREMIUM_LANGUAGE_CODES,['en','hi','ta','ml','te','pa','mr','bn','kn']);
 for(const code of PREMIUM_LANGUAGE_CODES){
  const row=PREMIUM_LANGUAGES[code];
  assert.equal(row.code,code);
  assert.ok(row.name);
  assert.ok(row.firstMessage.includes('PawSpace'));
  assert.ok(row.firstMessage.length>25);
 }
});
test('language presets keep localized greetings and accept optional language-specific voices',()=>{
 const presets=premiumLanguagePresets({hi:'voice-hi',ta:'voice-ta'});
 assert.deepEqual(Object.keys(presets),['hi','ta','ml','te','pa','mr','bn','kn']);
 assert.equal(presets.hi.overrides.tts.voice_id,'voice-hi');
 assert.equal(presets.ta.overrides.tts.voice_id,'voice-ta');
 assert.equal(presets.kn.overrides.tts,undefined);
 assert.match(presets.bn.overrides.agent.first_message,/PawSpace/);
});
test('language detection is a system tool and is conservative about Indian code mixing',()=>{
 const tool=languageDetectionTool({description:'old',params:{existing:true}});
 assert.equal(tool.type,'system');
 assert.equal(tool.name,'language_detection');
 assert.equal(tool.params.system_tool_type,'language_detection');
 assert.equal(tool.params.existing,true);
 assert.match(tool.description,/code-mixing/i);
 assert.match(tool.description,/pet name/i);
 assert.match(tool.description,/preserve all already confirmed booking details/i);
});
test('premium multilingual prompt is idempotent and protects canonical booking state',()=>{
 const once=premiumLanguagePrompt('Base PawSpace rules.');
 const twice=premiumLanguagePrompt(once);
 assert.equal((twice.match(/\[PawSpace premium multilingual v1\]/g)||[]).length,1);
 assert.match(twice,/Hindi, Tamil, Malayalam, Telugu, Punjabi, Marathi, Bengali and Kannada/);
 assert.match(twice,/Preserve every already confirmed booking fact/i);
 assert.match(twice,/never translate or alter internal IDs/i);
 assert.match(twice,/dominant language/i);
});
test('premium quality targets require natural, complete, transferable booking calls',()=>{
 assert.equal(PREMIUM_CALL_TARGETS.replyStartP95Ms,2000);
 const good=evaluatePremiumCallQuality({replyStartP50Ms:900,replyStartP95Ms:1700,toolAcknowledgementMs:700,maxSilentGapMs:600,naturalTurns:12,repeatedKnownFacts:0,bookingCompleted:true,gracefulEnding:true,humanTransferReady:true});
 assert.equal(good.pass,true);
 const slow=evaluatePremiumCallQuality({...good.metrics,replyStartP95Ms:2500});
 assert.equal(slow.pass,false);assert.equal(slow.checks.replyP95,false);
 const incomplete=evaluatePremiumCallQuality({...good.metrics,bookingCompleted:false});
 assert.equal(incomplete.pass,false);assert.equal(incomplete.checks.bookingCompleted,false);
});
test('multilingual readiness distinguishes language enablement from premium localized voice certification',()=>{
 const presets=premiumLanguagePresets({hi:'h',ta:'t',ml:'m',te:'e',pa:'p',mr:'r',bn:'b',kn:'k'});
 const prompt={built_in_tools:{language_detection:languageDetectionTool()}};
 const ready=premiumLanguageReadiness({language_presets:presets,agent:{prompt}});
 assert.equal(ready.allLanguagesConfigured,true);
 assert.equal(ready.languageDetection,true);
 assert.equal(ready.localizedVoicesComplete,true);
 assert.equal(ready.configurationComplete,true);
 assert.equal(ready.premiumCertified,false);
 const fallback=premiumLanguageReadiness({language_presets:premiumLanguagePresets(),agent:{prompt}});
 assert.equal(fallback.allLanguagesConfigured,true);
 assert.equal(fallback.premiumCertified,false);
 assert.deepEqual(fallback.localizedVoiceCodes,['en']);
 const malformed=premiumLanguageReadiness({
  language_presets:{...premiumLanguagePresets(),hi:{},ta:{overrides:{agent:{first_message:''}}}},
  agent:{prompt}
 });
 assert.equal(malformed.allLanguagesConfigured,false);
 assert.equal(malformed.configuredCodes.includes('hi'),false);
 assert.equal(malformed.configuredCodes.includes('ta'),false);
 assert.equal(malformed.premiumCertified,false);
});

for(const invalid of [null,undefined,"",-1,NaN,Infinity,"900"]){
 test(`premium latency rejects unmeasured or invalid input ${String(invalid)}`,()=>{
  const metrics={replyStartP50Ms:900,replyStartP95Ms:1700,toolAcknowledgementMs:700,maxSilentGapMs:600,naturalTurns:12,repeatedKnownFacts:0,bookingCompleted:true,gracefulEnding:true,humanTransferReady:true};
  for(const key of ['replyStartP50Ms','replyStartP95Ms','toolAcknowledgementMs','maxSilentGapMs','repeatedKnownFacts'])assert.equal(evaluatePremiumCallQuality({...metrics,[key]:invalid}).pass,false,key);
 });
}
