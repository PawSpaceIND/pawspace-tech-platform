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
  assert.equal(after.newPetBookingNeedsProfile,false);
  assert.deepEqual(after.allowedSavedPetIds,[lana.id]);
  for(const ids of [undefined,[],[coco.id],[coco.id,lana.id]])assert.equal(voicePetProposalMatches(after,ids),false);
  assert.equal(voicePetProposalMatches(after,[lana.id]),true);
 });
}
for(const input of ["Book Coco and Lana.","Book only Coco and Lana.","Book Coco and Lana only."]){
 test(`positive multi-pet selection: ${input}`,()=>{
  const memory=voicePetMemory(input,history,[coco,lana]);
  assert.deepEqual(new Set(memory.allowedSavedPetIds),new Set([coco.id,lana.id]));
  assert.equal(voicePetProposalMatches(memory,[coco.id,lana.id]),true);
  assert.equal(voicePetProposalMatches(memory,[coco.id]),false);
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
 const memory=voicePetMemory("Coco only needs bathing; Lana needs nails.",history,[coco,lana]);
 assert.equal(memory.selectionConstrained,false);
 assert.equal(voicePetProposalMatches(memory,[coco.id,lana.id]),true);
});
