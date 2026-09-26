const INDIA_OFFSET=330*60_000;
/** Calendar controls always represent India time, independent of the browser's timezone. */
export function indiaDateOffset(days=0,now=Date.now()){return new Date(now+days*86_400_000+INDIA_OFFSET).toISOString().slice(0,10);}
export function indiaDateTimeInput(value:string|number){const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?new Date(ms+INDIA_OFFSET).toISOString().slice(0,16):'';}
export function indiaInputInstant(value:string){
 if(!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value))return '';
 const ms=Date.parse(value+':00+05:30');
 return Number.isFinite(ms)&&indiaDateTimeInput(ms)===value?new Date(ms).toISOString():'';
}
export function requireFutureIndiaInput(value:string,now=Date.now()){const iso=indiaInputInstant(value);if(!iso||Date.parse(iso)<=now)throw new Error('Choose a valid future date and time in IST.');return iso;}
export type ReviewedQuote={totalAmount:number;amountDueNow:number;paymentMode:string;scheduledStart:string;scheduledEnd:string;petCount:number};
/** A refreshed price is not permission to charge a different amount from the customer's review. */
export function sameReviewedStayQuote(reviewed:ReviewedQuote,fresh:ReviewedQuote){
 return ['totalAmount','amountDueNow','petCount','paymentMode'].every(k=>reviewed[k as keyof ReviewedQuote]===fresh[k as keyof ReviewedQuote])&&['scheduledStart','scheduledEnd'].every(k=>Date.parse(String(reviewed[k as keyof ReviewedQuote]))===Date.parse(String(fresh[k as keyof ReviewedQuote])));
}
export function scopedBookingHref(service:'boarding'|'sitting'|'taxi',bookingId:string,v2=true){return `${v2?'/v2':''}/${service}/manage?bookingId=${encodeURIComponent(bookingId)}`;}
export function rememberBookingReference(bookingId:string){
 if(!bookingId.trim())throw new Error('A saved booking reference is required.');
 const url=new URL(window.location.href);url.searchParams.set('bookingId',bookingId);window.history.replaceState(window.history.state,'',url.pathname+url.search);
}
