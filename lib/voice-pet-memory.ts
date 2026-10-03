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
  for(const m of claim.matchAll(/\b(?:meet|introducing|here(?:['’]s| is))\s+(?:(?:my|our|a|the)\s+)?new\s+(?:kitten|puppy|cat|dog|pet)\s+(?:(?:named|called)\s+)?([A-Za-z][A-Za-z'-]{1,30})\b/gi))names.set(normalize(m[1]),m[1]);
 }
 // The supplied context has no verified new-animal/profile linkage. A name match is insufficient.
 const unlinkedNewPetNames=[...names.values()];
 const escape=(name:string)=>name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
 const mentioned=(name:string)=>new RegExp("\\b"+escape(name)+"\\b","i").test(input);
 const candidateNames=[...new Set([...pets.map(p=>String(p.name??"")),...names.values()].filter(Boolean))];
 const excluded=(name:string)=>new RegExp("(?:\\bnot|\\bnever|\\bdon['’]t|\\bexcept|\\bexcluding|\\bexclude|\\binstead of|\\brather than)\\s+(?:(?:book|groom|schedule|reserve|use|include|select|choose|substitute|for|the|saved|cat|dog|pet|profile)\\s+){0,5}"+escape(name)+"\\b","i").test(input);
 const excludedNames=candidateNames.filter(excluded);
 const exclusiveNames=new Set<string>();
 if(candidateNames.length){
  const namePattern="(?:"+candidateNames.map(escape).join("|")+")",listPattern=namePattern+"(?:\\s*(?:,|and|&)\\s*"+namePattern+")*";
  const patterns=[new RegExp("\\bonly\\s+(?:for\\s+)?("+listPattern+")\\b","gi"),new RegExp("\\b("+listPattern+")\\s+only(?=\\s*[,.;!?]|$)","gi")];
  for(const pattern of patterns)for(const match of input.matchAll(pattern))for(const name of candidateNames)if(new RegExp("\\b"+escape(name)+"\\b","i").test(match[1]))exclusiveNames.add(normalize(name));
 }
 const selected=(name:string)=>mentioned(name)&&!excluded(name)&&(!exclusiveNames.size||exclusiveNames.has(normalize(name)));
 const explicitlySelectedSavedPet=pets.some(p=>!names.has(normalize(p.name))&&selected(String(p.name??"")));
 const relevantNewNames=unlinkedNewPetNames.filter(name=>!excluded(name)&&(!exclusiveNames.size||exclusiveNames.has(normalize(name))));
 const newPetBookingNeedsProfile=relevantNewNames.length>0&&(relevantNewNames.some(selected)||!explicitlySelectedSavedPet);
 const intendedNewSavedPetIds:string[]=[];
 const allowedSavedPetIds=[...new Set([...intendedNewSavedPetIds,...pets.filter(p=>!names.has(normalize(p.name))&&selected(String(p.name??""))).map(p=>String(p.id??""))])];
 const selectionConstrained=excludedNames.length>0||exclusiveNames.size>0;

 return{selectionConstrained,allowedSavedPetIds,newPetNames:[...names.values()],unlinkedNewPetNames,newPetBookingNeedsProfile,intendedNewSavedPetIds,identityRule:"new_pets_are_separate_not_saved_profile_aliases"};
}

/** A proposal cannot add an excluded pet, omit the intended new saved pet, or fall back without IDs. */
export function voicePetProposalMatches(memory:ReturnType<typeof voicePetMemory>,petIds:unknown){
 return !memory.newPetBookingNeedsProfile&&Array.isArray(petIds)&&petIds.length>0&&petIds.every(id=>typeof id==="string"&&memory.allowedSavedPetIds.includes(id))&&memory.intendedNewSavedPetIds.every(id=>petIds.includes(id));
}
