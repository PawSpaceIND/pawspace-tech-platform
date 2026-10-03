import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {VOICE_CONSULTATIVE_SALES,VOICE_CONVERSATION_STYLE} from "../lib/voice-conversation-style.mjs";
import {humanCallPrompt} from "../lib/elevenlabs-human-call-profile.mjs";
installWorkersHooks("__CONSULTATIVE_DB__","__CONSULTATIVE_ENV__");
const {specialistSalesPrompt}=await import("../lib/voice-sales-specialists.ts");
test("native provider profile retains existing instructions and includes the same consultant policy as the brain",()=>{
 const profile=humanCallPrompt("Existing safety and identity instructions.");
 assert.ok(profile.startsWith("Existing safety and identity instructions."));
 assert.ok(profile.includes(VOICE_CONSULTATIVE_SALES));
 assert.ok(VOICE_CONVERSATION_STYLE.includes(VOICE_CONSULTATIVE_SALES));
 assert.equal(humanCallPrompt(profile),profile,"profile regeneration does not duplicate consultant instructions");
 assert.doesNotMatch(profile,/two or three.*discovery/);
});
for(const service of ["grooming","dog_training","all_services","pet_taxi","boarding","pet_sitting"]){
 test(`${service} specialist inherits the consultant policy without dropping its existing authority limits`,()=>{
  const prompt=specialistSalesPrompt(service);
  assert.ok(prompt.includes(VOICE_CONSULTATIVE_SALES));
  assert.match(prompt,/First learn the customer's goal/);
  assert.match(prompt,/do not restart discovery/);
  assert.doesNotMatch(prompt,/two or three.*discovery/);
  if(service==="boarding"||service==="pet_sitting")assert.match(prompt,/Final booking is completed by the customer in the PawSpace app/);
  else assert.match(prompt,/booking|checkout/);
  assert.match(prompt,/Do not diagnose/);
 });
}
