type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

import {hasBookingConfirmationClaim} from "./ai-evaluation-security";

const referenceMarkers=new Set(["reference","referenced","ref","id","identifier","number","no","code","#"]);
const referenceLinks=new Set(["as","is","the","a","an","with","under","associated","linked","to","for"]);
const reservedClaimWords=new Set(["booking","confirmed","ready","your","my","we","i","and"]);

/** One lexical pass identifies references independently of their position or surrounding punctuation.
 * Unknown words are never discarded to manufacture a generic confirmation. */
function bookingConfirmationReference(reply:string){
 const tokens=reply.match(/[\p{L}\p{N}_-]+|#/gu)||[],references=new Set<string>();
 for(const token of tokens)if(/[-_\d]/.test(token))references.add(token);
 for(let index=0;index<tokens.length;index++){
  if(!referenceMarkers.has(tokens[index].toLowerCase()))continue;
  let next=index+1;
  while(next<tokens.length&&(referenceMarkers.has(tokens[next].toLowerCase())||referenceLinks.has(tokens[next].toLowerCase())))next++;
  const candidate=tokens[next];
  if(!candidate||reservedClaimWords.has(candidate.toLowerCase()))return null;
  references.add(candidate);
 }
 if(references.size>1)return null;
 const words=tokens.filter(token=>!references.has(token)&&!(references.size&&(referenceMarkers.has(token.toLowerCase())||referenceLinks.has(token.toLowerCase())))).join(" ").toLowerCase();
 // Fail closed for any unresolved text. Only a complete, unambiguous singular confirmation uses a binding.
 const generic=/^(?:(?:your|the|this) )?(?:(?:current|existing) )?booking (?:(?:is|was|has been) )?(?:(?:now|already) )?confirmed(?: (?:and )?(?:is )?ready)?$/
  .test(words)||/^(?:(?:your|the|this) )?(?:(?:current|existing) )?confirmed booking (?:is )?ready$/.test(words)
  ||/^(?:we|i) (?:have )?confirmed (?:your|the|this) (?:(?:current|existing) )?booking$/.test(words);
 return generic?{explicitId:[...references][0]||null}:null;
}

/** Fresh read-only evidence; draft context, provider flags and a quote are never booking authority. */
export async function verifiedBookingConfirmation(db:D1Database,input:{reply:string;customerId:string;threadId?:string}){
 if(!hasBookingConfirmationClaim(input.reply)||!input.threadId||!input.customerId)return false;
 const reference=bookingConfirmationReference(input.reply);
 if(!reference)return false;
 try{
  const thread=await db.prepare("SELECT customer_id,booking_id,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
  if(!thread||text(thread.customer_id)!==input.customerId||text(thread.status)==="closed")return false;
  const boundId=text(thread.booking_id);
  if(reference.explicitId&&boundId&&reference.explicitId.toLowerCase()!==boundId.toLowerCase())return false;
  const bookingId=reference.explicitId?(boundId||reference.explicitId):boundId;
  if(!bookingId)return false;
  const booking=await db.prepare("SELECT id,customer_id,status FROM canonical_bookings WHERE id=? AND customer_id=?").bind(bookingId,input.customerId).first<Row>();
  return Boolean(booking&&["confirmed","assigned"].includes(text(booking.status).toLowerCase()));
 }catch{return false;}
}
