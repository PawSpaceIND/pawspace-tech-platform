type Message={role:string;content:string};
// A noun phrase permits descriptive modifiers without carrying negation across another request.
const discountNoun="(?:discounts?|coupons?|offers?|promos?|promotional codes?)";
const discountModifiers="(?:(?!(?:but|and|or|then|please|can|could|would|want|need|prepare|book|have|with|changing)\\b)[\\w%₹-]+\\s+)*";
const discountDeclined=new RegExp("\\b(?:no|without|excluding|exclude|omit|skip|avoid)\\s+"+discountModifiers+discountNoun+"\\b|\\b(?:do not|don't|don’t)\\s+(?:want|need|apply|use|add|give|offer)\\s+"+discountModifiers+discountNoun+"\\b","i");

/** Only customer dialogue can request a discount; eligibility remains server-owned. */
export function customerRequestedVoiceDiscount(history:Message[],currentText:string){
 let requested=false,serviceScope="";
 for(const message of [...history,{role:"user",content:currentText}]){
  if(message.role!=="user")continue;
  for(const value of message.content.trim().split(/(?<=[.!?])\s+|;\s*/)){
  const services=[...value.toLowerCase().matchAll(/\b(grooming|boarding|sitting|walking|training|taxi)\b/g)].map(match=>match[1]);
  const nextService=services.at(-1)||"";
  if(nextService&&requested&&nextService!==serviceScope)requested=false;
  if(nextService)serviceScope=nextService;
  if(/\b(?:regular|full[ -]price|undiscounted)\s+(?:price|quote|package|booking)\b/i.test(value)){requested=false;continue;}
  if(/\b(?:new|another|different)\s+(?:quote|package)\b|\b(?:switch|change|different|another|instead)\b[^.!?]{0,50}\b(?:package|quote|service)\b/i.test(value))requested=false;
  if(discountDeclined.test(value)){requested=false;continue;}
  const discount=/\b(?:discounts?|coupons?|promo(?:tion)?(?: codes?)?)\b|\b(?:approved|eligible|available|special)\s+offers?\b|\b\d+\s*%\s*off\b/i.test(value);
  const ask=/^any\s+(?:(?:available|eligible|approved)\s+)*(?:discounts?|coupons?|offers?|promos?)\b/i.test(value)
   ||discount&&(/^(?:can|could|would|may|do|does|is|are|what|which|how)\b/i.test(value)||/\b(?:i|we)\s+(?:want|need|would like)\b/i.test(value)||/(?:^|[,.;])\s*(?:please\s+)?(?:give|offer|apply|use|add)\b/i.test(value)||/^discounts?\b.*\?\s*$|\bdiscounts?\s+please[.! ]*$/i.test(value))
   ||/\b(?:do|can|could|would)\s+(?:you|i|we)\b[^.!?]{0,50}\b(?:special|available|approved)\s+offers?\b/i.test(value)
   ||/\b(?:can|could|would)\s+you\s+(?:lower|reduce)\s+(?:the\s+)?price\b|\b(?:can|could|would)\s+you\s+make\s+(?:it|this)\s+cheaper\b/i.test(value);
  if(ask)requested=true;
  }
 }
 return requested;
}

export function voiceDiscountClaim(reply:string,approvedCodes:string[]=[]){
 return /(?:₹|\brs\.?|\binr)\s*[\d,]+\s*off\b|\b\d+(?:\.\d+)?\s*(?:%|percent|per cent)\s*(?:off|discount)\b|\b(?:offer|give|apply|provide|get|available|eligible)\b[^.!?]{0,60}\b(?:discounts?|coupons?|promos?)\b/i.test(reply)
  ||approvedCodes.some(code=>new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(reply));
}

/** A spoken percentage must name the package and match its current canonical saving. */
export function voicePercentageDiscountsApproved(reply:string,offers:{package_name:string;regular_price:number;discount_amount:number}[]){
 for(const sentence of reply.split(/(?<=[.!?])\s+|\n+/)){
  for(const match of sentence.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)\s*(?:off|discount)\b/gi)){
   const prefix=sentence.slice(0,match.index);
   if(/\b(?:no|not|cannot|can't|don't|do not)(?:\s+(?:give|offer|apply|provide|a|an|the|any)){0,5}\s*$/i.test(prefix))continue;
   const rate=Number(match[1]);
   if(!offers.some(offer=>{
    const packageName=offer.package_name.split("(")[0].trim();
    return packageName&&sentence.toLowerCase().includes(packageName.toLowerCase())&&Number.isFinite(offer.regular_price)&&offer.regular_price>0&&Number((offer.discount_amount/offer.regular_price*100).toFixed(2))===rate;
   }))return false;
  }
 }
 return true;
}
