type Message={role:string;content:string};
const acknowledgement=/^(?:yes|yes[, ]+that(?:'s| is) (?:right|correct)|correct|that's right|that is correct|sure|okay|ok)[.! ]*$/i;
/** Dialogue facts only. Never saved-address identity, geocoding or action consent. */
export function voiceSalesDialogueState(history:Message[],currentText:string){
 let groomingGoals:string[]=[],service:string|null=null,pincode:string|null=null,addressConfirmation:string|null=null;
 const messages=[...history,{role:'user',content:currentText}];
 for(let i=0;i<messages.length;i++){
  const message=messages[i];if(message.role!=='user')continue;
  const value=message.content;
  const positive=(term:string)=>new RegExp(`\\b${term}\\b`,'i').test(value)&&!new RegExp(`(?:no|not|don't want|don’t want)\\s+(?:any\\s+)?${term}`,'i').test(value);
  if(['training','puppy skills','boarding','sitting','taxi','funeral','cremation'].some(positive))service='other';
  if(['grooming','groom','haircut','hygiene','trim','bath'].some(positive))service='grooming';
  const labelledPins=[...value.matchAll(/\b(?:pin(?: code)?|pincode|postal code)\s*(?:is|:|=)?\s*([1-9]\d{5})\b/gi)];
  const pin=labelledPins.at(-1)?.[1]??(/^[1-9]\d{5}[.! ]*$/.test(value.trim())?value.trim().slice(0,6):undefined);
  const prior=messages.slice(0,i).reverse().find(item=>item.role==='assistant')?.content??'';
  if(pin){pincode=pin;addressConfirmation=null;}
  if(/\b(?:address is|new address|different address|instead use|correction)\b/i.test(value)||(isAddressFactQuestion(prior)&&!acknowledgement.test(value.trim())))addressConfirmation=null;
  if(acknowledgement.test(value.trim())&&isAddressFactQuestion(prior))addressConfirmation=prior;
  if(service==='grooming'){
   const goals=[...value.matchAll(/\b(hygiene|haircut|trim|bath)\b/gi)].map(match=>match[1].toLowerCase());
   if(goals.length){
    if(/\b(?:instead|rather|only|not|don't|don’t)\b/i.test(value))groomingGoals=[];
    for(const goal of goals){if(new RegExp(`(?:not|no|don't want|don’t want)\\s+(?:a\\s+)?${goal}`,'i').test(value))continue;if(!groomingGoals.includes(goal))groomingGoals.push(goal);}
   }
  }
 }
 return{currentService:service,groomingGoals:service==='grooming'?groomingGoals:[],customerStatedPincode:pincode,addressConfirmation,identityVerified:false,bookingConsent:false};
}
export function isAddressFactQuestion(value:string){
 return /\b(?:address|pin(?: code)?|pincode)\b/i.test(value)&&/\b(?:confirm|correct|is that right|still)\b/i.test(value)&&!/\b(?:confirm (?:this |the )?(?:booking|offer|quote)|reply .?yes.? to (?:book|confirm)|shall I book)\b/i.test(value);
}
export function isVoiceAddressFactAcknowledgement(history:Message[],currentText:string){
 const prior=[...history].reverse().find(item=>item.role==='assistant')?.content??'';
 return acknowledgement.test(currentText.trim())&&isAddressFactQuestion(prior);
}
