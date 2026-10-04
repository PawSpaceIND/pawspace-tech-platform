import test from "node:test";
import assert from "node:assert/strict";
import {presentedOwnedPetChoice,proposalMatchesSelectedPet} from "../lib/voice-presented-pet-choice.ts";
const pets=[{id:"BRUNO",name:"Bruno"},{id:"COCO",name:"Coco"},{id:"MAYA-1",name:"Maya",breed:"German Shepherd"},{id:"MAYA-2",name:"Maya",breed:"German Shepherd"}];
for(const reply of ["The first Maya.","First one."])test(`recorded Maya subset cannot map to the global first pet: ${reply}`,()=>{
 const choice=presentedOwnedPetChoice([{role:"assistant",content:"There are two German Shepherds named Maya on your profile. Which one would you like groomed—the first Maya or the second Maya? For hygiene..."}],reply,pets);
 assert.equal(choice.selectedPet,null);
 assert.equal(choice.canonicalPetIndex,null);
 assert.match(choice.clarification,/same breed details/);
 assert.match(choice.clarification,/select the correct pet profile in the PawSpace app/);
 assert.doesNotMatch(choice.clarification,/first:|second:|Bruno|Coco/);
});
test("verified distinct descriptions preserve explicit subset ordering and proposal identity guard",()=>{
 const owned=[pets[0],{id:"MAYA-LAB",name:"Maya",breed:"Labrador"},{id:"MAYA-BEAGLE",name:"Maya",breed:"Beagle"}];
 const choice=presentedOwnedPetChoice([{role:"assistant",content:"First: your pet Maya, Beagle; second: your pet Maya, Labrador. Which pet?"}],"The first Maya.",owned);
 assert.equal(choice.selectedPet.id,"MAYA-BEAGLE");
 assert.equal(choice.canonicalPetIndex,2);
 assert.equal(choice.clarification,null);
 assert.equal(proposalMatchesSelectedPet([{toolCode:"booking.create",arguments:{petIds:["BRUNO"]}}],choice.selectedPet),false);
 assert.equal(proposalMatchesSelectedPet([{toolCode:"booking.create",arguments:{petIds:["MAYA-BEAGLE"]}}],choice.selectedPet),true);
});

test('recorded explicit Bruno replacement clears unresolved Maya ordinal scope',()=>{
 const history=[{role:'assistant',content:'There are two German Shepherds named Maya. Which pet do you mean—the first Maya or second Maya?'},{role:'user',content:'The first Maya.'},{role:'assistant',content:'Your saved profiles include two pets named Maya with the same breed details. Please select the correct pet profile.'}];
 const choice=presentedOwnedPetChoice(history,'Okay, I would like to go with Bruno.',pets);
 assert.equal(choice.clarification,null);assert.equal(choice.proposalClarification,null);
 assert.equal(choice.selectedPet,null,'this helper does not invent an ordinal selection or bypass canonical pet memory');
});
