export type AtlasCareContext={serviceCode?:string;species?:'dog'|'cat';packageCode?:string};
/** Context is a public hint, not part of the user's question or pricing/coupon intent. */
export function atlasCareContext(value:unknown):AtlasCareContext|undefined{
 if(!value||typeof value!=='object')return undefined;const input=value as Record<string,unknown>,context:AtlasCareContext={};
 for(const key of ['serviceCode','packageCode'] as const)if(typeof input[key]==='string'&&/^[a-z0-9_-]{1,80}$/i.test(input[key] as string))context[key]=input[key] as string;
 if(input.species==='dog'||input.species==='cat')context.species=input.species;
 return Object.keys(context).length?context:undefined;
}
export function customerRequestedCoupon(question:string){
 // Keep a negated offer/application clause from becoming positive intent through "can" or "?".
 if(/\b(?:no|without(?:\s+(?:applying|using|adding))?|(?:do not|don't|don’t)(?:\s+(?:want|need|apply|use|add))?|not interested in)\s+(?:(?:a|an|the|any)\s+)?(?:offers?|coupons?|discounts?|promos?|promo(?:tion)? codes?|cashback)\b/i.test(question))return false;
 return /\b(?:coupons?|discounts?|promo(?:tion)? codes?|cashback)\b/i.test(question)&&/(?:\?|^(?:coupons?|discounts?|promo(?:tion)? codes?|cashback)$|\b(?:any|what|which|how|can|could|please|check|find|show|apply|give|need|want|have|available|eligible|offer)\b)/i.test(question.trim());
}
export function hasMonetaryPromotion(reply:string){return /\b(?:discount|save|savings?|cashback)\b.{0,24}(?:₹|INR|Rs\.?|\d)|(?:₹|INR|Rs\.?)\s*\d[\d,.]*\s*(?:off|back)|\d+(?:\.\d+)?\s*%\s*(?:off|discount|cashback)/i.test(reply);}
export function careReplyWithoutUnrequestedOffers(reply:string,couponRequested:boolean){
 return !couponRequested&&(hasMonetaryPromotion(reply)||/\b(?:coupons?|discounts?|promo(?:tion)? codes?|cashback|GROOM\d+|WELCOME)\b|\d+(?:\.\d+)?\s*%\s*off/i.test(reply))?'Please review the published care options in PawSpace. I could not verify a care-only answer to that question.':reply;
}
function validDay(value:unknown):value is string{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const ms=Date.parse(value+'T00:00:00Z');return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value;}
export function effectiveOnDate(date:unknown,from:unknown,to:unknown){
 if(!validDay(date)||!validDay(from)||date<from)return false;
 return to===null||to===undefined||to===''?true:validDay(to)&&date<=to;
}
