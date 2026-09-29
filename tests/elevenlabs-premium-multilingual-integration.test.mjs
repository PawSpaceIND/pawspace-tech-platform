import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {premiumLanguagePrompt,languageDetectionTool} from '../lib/elevenlabs-language-profile.mjs';

test('ElevenLabs tuning wires all requested languages and automatic language detection',()=>{
 const runtimePrompt=premiumLanguagePrompt('Base voice rules.');
 const runtimeTool=languageDetectionTool();
 assert.match(runtimePrompt,/PawSpace premium multilingual v1/);
 assert.equal(runtimeTool.params.system_tool_type,'language_detection');
 const y=readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8');
 assert.match(y,/premiumLanguagePresets,languageDetectionTool,premiumLanguagePrompt,premiumLanguageReadiness/);
 assert.match(y,/language_presets:languagePresets/);
 assert.match(y,/language_detection:languageDetectionTool/);
 assert.match(y,/TRAINING_AGENT_ID: \$\{\{ vars\.ELEVENLABS_TRAINING_AGENT_ID \}\}/);
 for(const code of ['HI','TA','ML','TE','PA','MR','BN','KN'])assert.match(y,new RegExp('ELEVENLABS_VOICE_'+code+'_ID'));
 assert.match(y,/GROOMING_MULTILINGUAL_READY/);
 assert.match(y,/TRAINING_MULTILINGUAL_READY/);
 assert.match(y,/Premium multilingual configuration did not persist/);
 assert.match(y,/hinglish_mode:true/);
 assert.match(y,/discover-premium-voices/);
 assert.match(y,/GROOMING_MULTILINGUAL_READY=/);
});
test('sales specialist keeps already confirmed booking facts across language switches',()=>{
 const s=readFileSync(new URL('../lib/voice-sales-specialists.ts',import.meta.url),'utf8');
 assert.match(s,/language switch changes only presentation/i);
 assert.match(s,/must never reset or reinterpret a confirmed pet, date, time, address, PIN, package, payment choice or booking state/i);
 assert.match(s,/Indian code-mixed speech/i);
});

test('premium readiness verifier fails closed on missing or invalid timing values',()=>{
 const s=readFileSync(new URL('../scripts/verify-premium-maya.mjs',import.meta.url),'utf8');
 assert.match(s,/Number\.isFinite\(turnTimeout\)/);
 assert.match(s,/turnTimeout<=0/);
 assert.match(s,/turnTimeout>10/);
 assert.match(s,/Number\.isFinite\(maxDurationSeconds\)/);
 assert.match(s,/Number\.isFinite\(silenceEndCallTimeout\)/);
});
