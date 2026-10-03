import test from "node:test";
import assert from "node:assert/strict";
import {voicePetMemory,voicePetProposalMatches} from "../lib/voice-pet-memory.ts";
const history=[{role:"user",content:"Lana is my new five-month-old kitten."}];
const coco={id:"PET-COCO",name:"Coco"},lana={id:"PET-LANA",name:"Lana"};
for(const input of ["Book Lana only. Do not book Coco.","Do not substitute Coco; this is only for Lana.","Book only Lana, not Coco.","Book Lana, excluding Coco.","Book Lana. Don't book Coco.","Book Lana rather than Coco."]){
 test(`excludes wrong saved pet: ${input}`,()=>{
  const before=voicePetMemory(input,history,[coco]);
  assert.equal(before.newPetBookingNeedsProfile,true);
  assert.deepEqual(before.allowedSavedPetIds,[]);
  assert.equal(voicePetProposalMatches(before,[coco.id]),false);
  const after=voicePetMemory(input,history,[coco,lana]);
  assert.equal(after.newPetBookingNeedsProfile,true);
  assert.deepEqual(after.allowedSavedPetIds,[]);
  for(const ids of [undefined,[],[coco.id],[coco.id,lana.id]])assert.equal(voicePetProposalMatches(after,ids),false);
  assert.equal(voicePetProposalMatches(after,[lana.id]),false);
 });
}
for(const input of ["Book Coco and Lana.","Book only Coco and Lana.","Book Coco and Lana only."]){
 test(`positive multi-pet selection: ${input}`,()=>{
  const memory=voicePetMemory(input,[],[coco,lana]);
  assert.deepEqual(new Set(memory.allowedSavedPetIds),new Set([coco.id,lana.id]));
  assert.equal(voicePetProposalMatches(memory,[coco.id,lana.id]),true);
  assert.equal(voicePetProposalMatches(memory,[coco.id]),true);
  assert.equal(voicePetProposalMatches(memory,["PET-OTHER"]),false);
 });
}
test("explicit saved-pet selection excludes the newly introduced pet",()=>{
 for(const pets of [[coco],[coco,lana]]){
  const memory=voicePetMemory("Book Coco only. Don't book Lana.",history,pets);
  assert.equal(memory.newPetBookingNeedsProfile,false);
  assert.deepEqual(memory.allowedSavedPetIds,[coco.id]);
  assert.equal(voicePetProposalMatches(memory,[coco.id]),true);
 }
});
test("only describing a service need does not restrict the pet list",()=>{
 const memory=voicePetMemory("Coco only needs bathing; Lana needs nails.",[],[coco,lana]);
 assert.equal(memory.selectionConstrained,false);
 assert.equal(voicePetProposalMatches(memory,[coco.id,lana.id]),true);
});

for(const introduction of ["Meet our new pet Lana.","Introducing my new kitten Lana.","Here’s our new dog Lana.","Lana is my new kitten."]){
 test(`new identity needs verification even with a same-name profile: ${introduction}`,()=>{
  for(const pets of [[coco],[coco,{id:"PET-OLD-LANA",name:"LANA"}],[coco,{id:"PET-LANA-1",name:"Lana"},{id:"PET-LANA-2",name:"lana"}]]){
   const memory=voicePetMemory("Please book grooming for Lana.",[{role:"user",content:introduction}],pets);
   assert.deepEqual(memory.newPetNames,["Lana"]);
   assert.deepEqual(memory.unlinkedNewPetNames,["Lana"]);
   assert.equal(memory.newPetBookingNeedsProfile,true);
   assert.deepEqual(memory.allowedSavedPetIds,[]);
   for(const pet of pets)assert.equal(voicePetProposalMatches(memory,[pet.id]),false);
  }
 });
}
