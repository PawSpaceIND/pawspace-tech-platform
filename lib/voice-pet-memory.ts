/** Customer-described new pets are enquiry facts, never aliases for saved profiles. */
export const VOICE_PET_MEMORY_DIRECTIVE = `Pet identity: a customer introducing a NEW pet is describing a separate animal, even if another saved pet has the same species. Never ask whether a new kitten is the saved cat, substitute a saved pet, or reinterpret a new name as a rename without an explicit correction. Keep name, species, age and needs attached to the intended animal. Ask only for missing facts. A new unsaved pet can receive general service information; booking requires its own verified saved profile. Conversation facts cannot create a canonical pet ID or authorize a profile merge.`;
type Pet = {id?:unknown;name?:unknown};
type History = {role:string;content?:unknown;text?:unknown};
const normalize=(s:unknown)=>String(s??"").normalize("NFKC").toLowerCase();
export function voicePetMemory(input:string,history:History[],pets:Pet[]){
 const claims=history.filter(m=>m.role==="user").map(m=>String(m.content??m.text??""));claims.push(input);
 const names=new Map<string,string>();
 for(const claim of claims){
  for(const m of claim.matchAll(/\b([A-Za-z][A-Za-z'-]{1,30})\s+is\s+(?:my|our|a)\s+new\b[^.!?\n]{0,70}?\b(?:kitten|puppy|cat|dog|pet)\b/gi))names.set(normalize(m[1]),m[1]);
  for(const m of claim.matchAll(/\bnew\s+(?:kitten|puppy|cat|dog|pet)\s+(?:named|called)\s+([A-Za-z][A-Za-z'-]{1,30})\b/gi))names.set(normalize(m[1]),m[1]);
 }
 const savedNames=new Set(pets.map(p=>normalize(p.name))),unlinkedNewPetNames=[...names].filter(([name])=>!savedNames.has(name)).map(([,name])=>name);
 const mentioned=(name:string)=>new RegExp("\\b"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","i").test(input);
 const explicitlySelectedSavedPet=pets.some(p=>mentioned(String(p.name??"")));
 const newPetBookingNeedsProfile=unlinkedNewPetNames.length>0&&(unlinkedNewPetNames.some(mentioned)||!explicitlySelectedSavedPet);
 const intendedNewSavedPetIds=pets.filter(p=>names.has(normalize(p.name))&&(mentioned(String(p.name??""))||!explicitlySelectedSavedPet)).map(p=>String(p.id??""));
 const allowedSavedPetIds=[...new Set([...intendedNewSavedPetIds,...pets.filter(p=>mentioned(String(p.name??""))).map(p=>String(p.id??""))])];
 return{allowedSavedPetIds,newPetNames:[...names.values()],unlinkedNewPetNames,newPetBookingNeedsProfile,intendedNewSavedPetIds,identityRule:"new_pets_are_separate_not_saved_profile_aliases"};
}

