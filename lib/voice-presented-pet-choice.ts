type Message={role:string;content:string};
type Pet={id:string;name:string;breed?:string|null;species?:string};
const ordinals=["first","second","third","fourth","fifth"];
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const contains=(value:string,term:string)=>Boolean(term)&&new RegExp(`(?:^|[^a-z0-9])${escape(term)}(?:$|[^a-z0-9])`,"i").test(value);
const explicitPetQuestion=(content:string)=>/\b(?:which|choose|select|pick)\s+(?:(?:saved|your|the)\s+)*(?:pets?|dogs?|cats?)\b/i.test(content);
const otherChoiceQuestion=(content:string)=>!explicitPetQuestion(content)&&/\b(?:which|choose|select|pick|prefer)\b.*\b(?:appointment|time|date|package|payment|service|address|pickup|drop)\b/i.test(content);

function presentedOptions(content:string,pets:Pet[]):Pet[]|null {
 if(otherChoiceQuestion(content))return null;
 const markers=[...content.matchAll(/\b(first|second|third|fourth|fifth|[1-5])\s*(?:(?:one|pet|option)\s*)?(?:is\b|[:.)-])/gi)];
 if(markers.length<2)return null;
 // A package/time option list must not become a pet preference.
 if(!/\b(?:pets?|dogs?|cats?)\b/i.test(content))return pets.some(pet=>contains(content,pet.name))?[]:null;
 const options:Pet[]=[];
 for(let i=0;i<markers.length;i++){
  const marker=markers[i],position=/^[1-5]$/.test(marker[1])?Number(marker[1])-1:ordinals.indexOf(marker[1].toLowerCase());
  if(position!==i)return [];
  const description=content.slice(marker.index!+marker[0].length,markers[i+1]?.index??content.length);
  const named=pets.filter(pet=>contains(description,pet.name));
  const matching=named.length>1?named.filter(pet=>contains(description,pet.breed??"")):named;
  if(matching.length!==1||options.some(pet=>pet.id===matching[0].id))return [];
  options.push(matching[0]);
 }
 return options;
}
function ordinalChoice(content:string,pets:Pet[]):number|"conflict"|null {
 const names=[...new Set(pets.map(pet=>pet.name).filter(Boolean))].map(escape).join("|");
 const pattern=new RegExp(`^(?:(?:no|actually|sorry),?\\s+)?(?:(?:i mean|i want|choose|select|please)\\s+)?(?:the\\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\\s+(?:one|pet|option${names?"|"+names:""}))?[.!? ]*$`,"i");
 const parts=content.trim().replace(/^(?:no|actually|sorry),\s*/i,"").split(/\s*(?:,|\band\b|\bor\b)\s*(?=(?:the\s+)?(?:first|second|third|fourth|fifth|[1-5](?:st|nd|rd|th))\b)/i);
 const choices=parts.map(part=>pattern.exec(part.trim()));
 if(choices.some(choice=>!choice))return null;
 const positions=choices.map(choice=>/^\d/.test(choice![1])?Number(choice![1][0])-1:ordinals.indexOf(choice![1].toLowerCase()));
 return positions.every(position=>position===positions[0])?positions[0]:"conflict";
}
const label=(pet:Pet)=>`${pet.name}${pet.breed?`, ${pet.breed}`:""}`;

/** Explicit ordinal preferences are dialogue, never identity or booking consent. */
export function presentedOwnedPetChoice(history:Message[],currentText:string,ownedPets:unknown){
 const pets:Pet[]=Array.isArray(ownedPets)?ownedPets.flatMap(value=>{
  if(!value||typeof value!=="object")return[];
  const pet=value as Record<string,unknown>;
  return typeof pet.id==="string"&&pet.id&&typeof pet.name==="string"&&pet.name?[{id:pet.id,name:pet.name,breed:typeof pet.breed==="string"?pet.breed:null}]:[];
 }):[];
 let options:Pet[]|null=null,selected:Pet|null=null,awaitingPetChoice=false,needsPetClarification=false;
 for(const message of [...history,{role:"user",content:currentText}]){
  if(message.role==="assistant"){
   const presented=presentedOptions(message.content,pets);
   if(presented!==null){options=presented;selected=null;awaitingPetChoice=true;needsPetClarification=false;}
   else{
    awaitingPetChoice=!otherChoiceQuestion(message.content)&&/\b(?:which|choose|select|pick)\b/i.test(message.content)&&(/\b(?:pets?|dogs?|cats?)\b/i.test(message.content)||pets.some(pet=>contains(message.content,pet.name)));
    if(!awaitingPetChoice)options=null;
   }
  }else if(message.role==="user"){
   const ordinal=ordinalChoice(message.content,pets);
   const rejection=/\b(?:not|don't|don’t|do not)\s+(?:(?:want|choose|select|use|the)\s+)*(first|second|third|fourth|fifth)\b/i.exec(message.content);
   if(ordinal==="conflict"&&awaitingPetChoice){needsPetClarification=true;}
   else if(rejection&&options!==null){
    const rejected=options[ordinals.indexOf(rejection[1].toLowerCase())];
    if(!selected||selected.id===rejected?.id){selected=null;needsPetClarification=true;}
   }else if(typeof ordinal==="number"&&(awaitingPetChoice||pets.some(pet=>contains(message.content,pet.name)))){selected=options?.[ordinal]??null;needsPetClarification=!selected;}
   // A new explicit pet or plural request must not inherit an old single-pet constraint.
   else if(/\b(?:both|all (?:my |the )?pets)\b/i.test(message.content)||pets.some(pet=>pet.id!==selected?.id&&((pet.name!==selected?.name&&contains(message.content,pet.name))||(pet.breed!==selected?.breed&&contains(message.content,pet.breed??""))))){selected=null;needsPetClarification=false;}
  }
 }
 const currentOrdinal=ordinalChoice(currentText,pets);
 const choiceClarification=pets.length?`I couldn't match that choice to a clear saved-pet list. ${pets.slice(0,5).map((pet,index)=>`${ordinals[index]}: your pet ${label(pet)}`).join("; ")}. Which pet do you mean?`:"I couldn't match that choice to a saved pet. What is your pet's saved name?";
 const clarification=needsPetClarification||(!selected&&currentOrdinal!==null&&(awaitingPetChoice||pets.some(pet=>contains(currentText,pet.name))))?choiceClarification:null;
 const proposalClarification=needsPetClarification||(!selected&&awaitingPetChoice)?choiceClarification:null;
 const canonicalPetIndex=selected&&Array.isArray(ownedPets)?ownedPets.findIndex(pet=>pet&&typeof pet==="object"&&(pet as Record<string,unknown>).id===selected!.id):null;
 return{selectedPet:selected,canonicalPetIndex,clarification,proposalClarification};
}

export function proposalMatchesSelectedPet(actions:{toolCode:string;arguments:Record<string,unknown>}[],pet:Pet){
 return actions.filter(action=>["schedule.reserve","booking.create"].includes(action.toolCode)).every(action=>Array.isArray(action.arguments.petIds)&&action.arguments.petIds.length===1&&action.arguments.petIds[0]===pet.id);
}
