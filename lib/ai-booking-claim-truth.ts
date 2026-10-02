type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

import {hasBookingConfirmationClaim} from "./ai-evaluation-security";

/** Fresh read-only evidence; draft context, provider flags and a quote are never booking authority. */
export async function verifiedBookingConfirmation(db:D1Database,input:{reply:string;customerId:string;threadId?:string}){
 if(!hasBookingConfirmationClaim(input.reply))return false;
 if(!input.threadId||!input.customerId||/\bbookings\b/i.test(input.reply))return false;
 try{
  const thread=await db.prepare("SELECT customer_id,booking_id,status FROM communication_threads WHERE id=?").bind(input.threadId).first<Row>();
  if(!thread||text(thread.customer_id)!==input.customerId||text(thread.status)==="closed")return false;
  const references=[
   ...input.reply.matchAll(/\bbooking\s+(?:id\s*[:#]?\s*|#\s*)([a-z0-9][a-z0-9_-]*)\b/gi),
   ...[...input.reply.matchAll(/\bbooking\s+([a-z0-9][a-z0-9_-]*)\b/gi)].filter(match=>/[0-9_-]/.test(match[1])),
  ].map(match=>match[1]);
  const distinctReferences=[...new Set(references)];
  if(distinctReferences.length>1)return false;
  // Generic claims require a conversation binding. An exact named booking may be checked independently.
  const bookingId=text(thread.booking_id)||distinctReferences[0];
  if(!bookingId||references.some(reference=>reference.toLowerCase()!==bookingId.toLowerCase()))return false;
  const booking=await db.prepare("SELECT id,customer_id,status FROM canonical_bookings WHERE id=? AND customer_id=?").bind(bookingId,input.customerId).first<Row>();
  return Boolean(booking&&["confirmed","assigned"].includes(text(booking.status).toLowerCase()));
 }catch{return false;}
}
