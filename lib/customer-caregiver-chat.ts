import {ensureCommunicationTables} from './communication-engine';
import {redactTrustSafetyText} from './trust-safety-governance';
type Row=Record<string,unknown>;
function safeChatText(value:string){const inspected=redactTrustSafetyText(value),redacted=inspected.redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[PRIVATE CONTACT HIDDEN]');return{redacted,hidden:inspected.detections.length>0||redacted!==inspected.redacted};}
const SERVICES=new Set(['boarding','pet_sitting','pet_taxi']);
const ACTIVE=['confirmed','assigned','accepted','on_the_way','arrived','in_service','in_progress','vehicle_assigned','pickup_confirmed','arrived_dropoff','dropoff_confirmed'];
async function ownBooking(db:D1Database,customerId:string,bookingId:string){const booking=await db.prepare('SELECT id,customer_id,provider_id,service_code,status FROM canonical_bookings WHERE id=? AND customer_id=?').bind(bookingId,customerId).first<Row>();if(!booking)throw new Response('Booking not found in your account.',{status:404});if(!SERVICES.has(String(booking.service_code)))throw new Response('Use the support route for this service.',{status:409});return booking;}
async function threadFor(db:D1Database,customerId:string,bookingId:string){await ensureCommunicationTables(db);return db.prepare("SELECT id,status FROM communication_threads WHERE booking_id=? AND customer_id=? AND COALESCE(lead_id,'')='' AND COALESCE(ticket_id,'')='' ORDER BY updated_at DESC,id DESC LIMIT 1").bind(bookingId,customerId).first<Row>();}
export async function readCustomerCaregiverChat(db:D1Database,customerId:string,bookingId:string){
 const booking=await ownBooking(db,customerId,bookingId),thread=await threadFor(db,customerId,bookingId);const providerId=String(booking.provider_id||'');
 const provider=providerId?await db.prepare('SELECT name FROM provider_capacity_profiles WHERE id=?').bind(providerId).first<Row>():null;
 const rows=thread?await db.prepare("SELECT id,direction,payload_json,status,created_at FROM communication_messages WHERE thread_id=? AND customer_id=? AND booking_id=? AND channel='chat' AND template_key IN ('customer_caregiver_chat','provider_in_app_chat') AND status IN ('received','sent','delivered','read') ORDER BY created_at DESC,id DESC LIMIT 100").bind(thread.id,customerId,bookingId).all<Row>():{results:[] as Row[]};
 const messages=rows.results.reverse().map(row=>{let stored:Row={};try{stored=JSON.parse(String(row.payload_json||'{}'));}catch{}const text=safeChatText(typeof stored.text==='string'?stored.text:'').redacted;return{id:String(row.id),sender:row.direction==='inbound'?'customer':'caregiver',text,status:String(row.status),createdAt:Number(row.created_at)};});
 const canMessage=Boolean(providerId&&thread?.status==='open'&&ACTIVE.includes(String(booking.status)));
 return{bookingId,serviceCode:String(booking.service_code),providerName:provider?String(provider.name):null,threadId:thread?String(thread.id):null,canMessage,messages,delivery:'in_app_only',notice:canMessage?'Messages stay in PawSpace. Contact details are masked. Sent is not a read receipt.':'Caregiver messaging opens after the booking is confirmed and assigned; support remains available.'};
}
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
export async function sendCustomerCaregiverChat(db:D1Database,input:{customerId:string;bookingId:string;message:string;idempotencyKey:string}){
 const {customerId,bookingId}=input,message=input.message.trim(),key=input.idempotencyKey.trim();if(!message||message.length>3000||key.length<8||key.length>160)throw new Response('Enter a message up to 3,000 characters and a valid request key.',{status:400});
 const booking=await ownBooking(db,customerId,bookingId),thread=await threadFor(db,customerId,bookingId);if(!booking.provider_id||!ACTIVE.includes(String(booking.status))||!thread||thread.status!=='open')throw new Response('This booking does not currently allow caregiver messaging.',{status:409});
 const textHash=await digest(message),idempotencyKey='customer-caregiver:'+await digest(JSON.stringify([customerId,bookingId,key]));
 const prior=await db.prepare('SELECT id,thread_id,policy_json FROM communication_messages WHERE idempotency_key=?').bind(idempotencyKey).first<Row>();
 if(prior){const policy=JSON.parse(String(prior.policy_json||'{}'));if(prior.thread_id!==thread.id||policy.textHash!==textHash||policy.providerId!==booking.provider_id)throw new Response('That request key belongs to different message details.',{status:409});return{messageId:String(prior.id),duplicatePrevented:true,delivery:'in_app_only'};}
 const now=Date.now(),id='MSG-CARE-'+crypto.randomUUID(),inspected=safeChatText(message),policy={textHash,providerId:booking.provider_id,externalDelivery:false};
 const guard=`EXISTS(SELECT 1 FROM canonical_bookings b JOIN communication_threads t ON t.booking_id=b.id WHERE b.id=? AND b.customer_id=? AND b.provider_id=? AND b.status IN (${ACTIVE.map(()=>'?').join(',')}) AND t.id=? AND t.customer_id=? AND t.status='open')`;
 const guardBinds=[bookingId,customerId,booking.provider_id,...ACTIVE,thread.id,customerId];
 try{const results=await db.batch([
  db.prepare(`INSERT INTO communication_messages(id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) SELECT ?,?,?,?,NULL,NULL,'inbound','chat','transactional','customer_caregiver_chat',?,'received','pawspace_in_app',NULL,?,?,?,?,? WHERE ${guard}`)
   .bind(id,thread.id,customerId,bookingId,JSON.stringify({text:inspected.redacted,safetyRedacted:inspected.hidden}),idempotencyKey,JSON.stringify(policy),'customer:'+customerId,now,now,...guardBinds),
  db.prepare('UPDATE communication_threads SET updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM communication_messages WHERE id=?)').bind(now,thread.id,id)
 ]);if(Number(results[0].meta.changes)!==1)throw new Response('Assignment changed; refresh before sending.',{status:409});}
 catch(error){if(error instanceof Error&&/UNIQUE/.test(error.message)){const raced=await db.prepare('SELECT id,policy_json FROM communication_messages WHERE idempotency_key=? AND thread_id=?').bind(idempotencyKey,thread.id).first<Row>();if(raced){const saved=JSON.parse(String(raced.policy_json||'{}'));if(saved.textHash===textHash&&saved.providerId===booking.provider_id)return{messageId:String(raced.id),duplicatePrevented:true,delivery:'in_app_only'};}}throw error;}
 return{messageId:id,duplicatePrevented:false,delivery:'in_app_only',safetyRedacted:inspected.hidden};
}
