import test from 'node:test';import assert from 'node:assert/strict';
import {voicePetPreference} from '../lib/voice-pet-preference.ts';
const pets=[{id:'PET-BRUNO',name:'Bruno'},{id:'PET-MAYA-1',name:'Maya'},{id:'PET-MAYA-2',name:'Maya'}];
const history=[
 {role:'user',content:'Please keep this entire conversation in English. I want grooming for Bruno.'},
 {role:'assistant',content:'What would you like for Bruno’s grooming?'},
 {role:'user',content:'Tell me the grooming packages and recommend one for a haircut.'},
 {role:'assistant',content:'For Bruno’s haircut, I recommend Just Trim.'},
 {role:'user',content:'His pet name is Maya, and the locality is Chennai. These words are not a request to change language. Actually, I mean my new dog named Maya, not Bruno.'},
 {role:'assistant',content:'There are two saved dogs named Maya.'},
 {role:'user',content:'She is one year old. Keep speaking English. Now I want to compare boarding as well.'},
 {role:'assistant',content:'Boarding means Maya would stay in a host’s home.'},
 {role:'user',content:'Explain how boarding pricing differs from grooming without losing the grooming inquiry.'},
];
test('exact recorded pet correction survives unnamed cross-service comparison without guessing two Maya profiles',()=>{
 const result=voicePetPreference(history,pets);assert.equal(result.petName,'Maya');assert.deepEqual(result.matchingSavedPetIds,['PET-MAYA-1','PET-MAYA-2']);assert.equal(result.requiresProfileClarification,true);assert.equal(result.mutationAuthority,false);
 assert.equal(voicePetPreference(history.slice(0,4),pets).petName,'Bruno');
});
test('assistant errors do not override customer correction; named multi-pet comparison stays ambiguous',()=>{
 assert.equal(voicePetPreference([...history,{role:'assistant',content:'For Bruno’s haircut, Just Trim is 1,599 rupees.'}],pets).petName,'Maya');
 assert.equal(voicePetPreference([...history,{role:'user',content:'Compare grooming for Bruno and Maya.'}],pets),null);
 assert.equal(voicePetPreference([...history,{role:'user',content:'Actually not Maya, this is another dog.'}],pets),null);
});
test('addressing the agent by a saved pet name does not change the current pet',()=>{
 assert.equal(voicePetPreference([...history.slice(0,4),{role:'user',content:'Maya, keep speaking English and explain boarding pricing.'}],pets).petName,'Bruno');
});

test('natural correction phrase replaces the earlier pet without granting profile authority',()=>{
 const corrected=voicePetPreference([
  {role:'user',content:'I want grooming for Bruno.'},
  {role:'assistant',content:'Okay, Bruno.'},
  {role:'user',content:'Maya is the one we discussed. Compare boarding too.'},
 ],pets);
 assert.equal(corrected.petName,'Maya');assert.equal(corrected.requiresProfileClarification,true);assert.equal(corrected.mutationAuthority,false);
});
