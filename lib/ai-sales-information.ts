/** Read-only sales questions preserve a quoted offer; ambiguity/changed details still supersede it.
 * This classifier never grants confirmation or action authority. */
export function isSalesInformationQuestion(input:string):boolean{
 if(!input||input.length>1200)return false;
 const text=input.normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
 const question=text.replace(/^(?:this is an (?:enquiry|inquiry) only|i am not confirming a service|do not (?:book anything|create a booking|reserve a slot))\.\s*/i,'').replace(/\.\s*do not (?:create a payment link|book anything|change any booking)\.?$/i,'');
 // Mixed commands, changed date/pet/package/payment details and real incidents fail closed.
 if(/[;{}<>]|[?!.]\s*\S/.test(question)||/^(?:what about|how about|why not)\b/i.test(question))return false;
 if(/\b(?:instead|rather|actually|also|but|different|another|extra|change|switch|replace|add|remove|cancel|reschedule|reserve|confirm|proceed|book|refund|complaint|human|agent|staff|manager|representative|coordinator|unsafe|injured|charged|debited|dispute)\b/i.test(question))return false;
 if(/\b(?:i|we) (?:want|need|prefer|choose)|\b(?:make it|use my|use the|let's|lets)\b/i.test(question))return false;
 if(!/^(?:what|which|why|how|when|where|does|do|is|are|will|can|could|please explain|explain|tell me)\b/i.test(question))return false;
 return /\b(?:include[ds]?|inclusions?|exclusions?|bring|equipment|products?|shampoo|towels?|prepare|preparation|duration|how long|payment|pay|cash|upi|tax|taxes|gst|prices?|costs?|validity|expire[sd]?|expiry|packs?|packages?|difference|supplies|haircut|nails|nail clipping|owner practice)\b/i.test(question);
}
export const SALES_INFORMATION_DIRECTIVE="This is a read-only sales information question. Answer it without preparing, replacing, invalidating or confirming a sales offer. Use no action envelope or mutation tools, and do not close with a new booking proposal. An existing quote retains only its original terms and expiry, not newly discussed alternatives. A change of pet, package, address, time, price or payment terms needs a refreshed quote and separate confirmation. Do not claim a booking, payment, reservation or completed handoff. Channel permissions and all receipt checks are unchanged.";
