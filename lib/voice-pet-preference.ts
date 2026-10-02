type Message={role?:unknown;content?:unknown;text?:unknown};
type Pet={id?:unknown;name?:unknown};
/** Conversational preference only: never selects an ambiguous saved profile or authorizes a tool. */
export function voicePetPreference(history:unknown,pets:unknown){
 const owned=Array.isArray(pets)?pets.filter((pet):pet is Pet=>Boolean(pet&&typeof pet==='object'&&typeof pet.name==='string'&&pet.name.trim())):[];
 const names=[...new Set(owned.map(pet=>String(pet.name).trim()))];
 const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 let selected:string|null=null,preferenceHistoryIndex:number|null=null;
 for(const [historyIndex,raw] of (Array.isArray(history)?history:[]).entries()){
  if(!raw||typeof raw!=='object')continue;const row=raw as Message;if(row.role!=='user')continue;
  const content=String(row.content??row.text??'');
  const mentioned=names.filter(name=>new RegExp(`(?:^|\\b)${escape(name)}(?:\\b|$)`,'i').test(content));
  const negative=mentioned.filter(name=>new RegExp(`\\b(?:not|instead of|rather than)\\s+(?:my (?:dog|cat|pet)\\s+)?${escape(name)}\\b`,'i').test(content));
  const positive=mentioned.filter(name=>!negative.includes(name));
  // A comparison between named pets cannot silently choose either one. A clear single-pet
  // reference can carry forward through subsequent unnamed service comparisons.
  const namedPreference=positive.filter(name=>new RegExp(`\\b(?:for|named|name is|mean|pet is)\\s+(?:my (?:dog|cat|pet)\\s+)?${escape(name)}\\b|\\b${escape(name)}(?:[’'s]{1,2}|\\s+(?:needs|is my|is a|weighs|prefers|pulls))` ,'i').test(content));
  if(positive.length===1&&namedPreference.length===1){selected=positive[0];preferenceHistoryIndex=historyIndex;}
  else if(positive.length>1||selected&&negative.includes(selected))selected=null;
 }
 if(!selected)return null;
 const ids=owned.filter(pet=>String(pet.name).trim().toLowerCase()===selected.toLowerCase()).map(pet=>String(pet.id??'')).filter(Boolean);
 return{petName:selected,preferenceHistoryIndex,matchingSavedPetIds:ids,requiresProfileClarification:ids.length!==1,source:'customer_conversation_preference',mutationAuthority:false};
}
