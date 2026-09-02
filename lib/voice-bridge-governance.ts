// Two-leg number-masked voice bridge. An authenticated party to a booking (its assigned provider OR its
// pet parent) asks to be connected to the OTHER party; Exotel dials the initiator first and bridges the
// counterparty, presenting the ExoPhone (masking number) to BOTH so neither sees the other's real number.
//
// Hard rules, all enforced here and fail-closed:
//   - only a bound party to the booking may bridge (NOT staff, NOT an arbitrary caller);
//   - only while the booking is in an active service window;
//   - the client never supplies or receives either party's number - both are resolved server-side and
//     NEVER persisted (the session row keeps the ExoPhone + subject ids only);
//   - environment-gated exactly like an outbound voice call (resolveVoiceCallGate);
//   - recording is OFF by default: it happens only when the environment approves it AND the initiating
//     caller explicitly opts in.
// Import-safe for `node --experimental-strip-types` (no TS parameter properties, no cross-module cycles).

import{selectTelephonyProvider,TelephonyProviderUnavailable}from"./voice-telephony-provider";
import{resolveVoiceCallGate,callRecordingApproved,canonicalDialNumber,isVoiceAllowlisted,statusCallbackUrl,voiceMode}from"./voice-call-gate";
import{findIdentityBinding}from"./identity-binding";

type Db=D1Database;
type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
export type BridgeActor={email:string;identitySource:string;principalType:string;principalKey:string};
export type BridgeResult=
 |{ok:false;status:number;reason:string;detail?:Record<string,unknown>}
 |{ok:true;sessionId:string;status:string;recording:boolean;provider:string;productionCall:boolean;maskingNumber:string};

const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,16).toUpperCase()}`;
const now=()=>Date.now();
// A booking may be bridged only while it is live and serviceable: confirmed and assigned, up to the point
// it terminates. Terminal (completed/cancelled/no_show/refunded) and pre-confirmation states are excluded.
const ACTIVE_BRIDGE_STATUSES=new Set(["confirmed","assigned","accepted","on_the_way","checked_in","in_progress","started","arrived"]);
const WINDOW_GRACE_MS=24*60*60_000;
const TERMINAL_BRIDGE_STATUSES=new Set(["completed","failed","no_answer","busy"]);

const bytesToHex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,"0")).join("");
async function sha256Hex(value:string){return bytesToHex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));}

const tablesEnsured=new WeakSet<Db>();
export async function ensureVoiceBridgeTables(db:Db){
 if(tablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS voice_bridge_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,initiator_type TEXT NOT NULL,initiator_principal_key TEXT NOT NULL,provider_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider_call_sid TEXT UNIQUE,masking_number TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'initiating',recording_status TEXT NOT NULL DEFAULT 'not_recorded',recording_reference TEXT,recording_duration_seconds INTEGER,environment TEXT NOT NULL,requested_at INTEGER NOT NULL,connected_at INTEGER,ended_at INTEGER,end_reason TEXT,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_bridge_booking ON voice_bridge_sessions(booking_id,requested_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS voice_bridge_events (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,provider_event_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,provider_status TEXT,duration_seconds INTEGER,body_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_voice_bridge_events_session ON voice_bridge_events(session_id,created_at)"),
 ]);
 tablesEnsured.add(db);
}

/** The subject id this actor is bound to for a subject type, or null. Identity binding first, then the
 * legacy email link; NEVER the staff override - a bridge is party-only. Degrades to null on a cold DB. */
async function boundSubjectId(db:Db,actor:BridgeActor,subjectType:"customer"|"provider"):Promise<string|null>{
 try{const binding=await findIdentityBinding(db,{identitySource:actor.identitySource as never,principalType:actor.principalType as never,principalKey:actor.principalKey,subjectType});if(binding)return text(binding.subject_id);}catch{/* binding tables absent */}
 try{
  const link=subjectType==="customer"
   ?await db.prepare("SELECT customer_id id,status FROM customer_identity_links WHERE email=?").bind(actor.email).first<Row>()
   :await db.prepare("SELECT provider_id id,status FROM provider_identity_links WHERE email=?").bind(actor.email).first<Row>();
  if(link&&text(link.status)==="active")return text(link.id);
 }catch{/* link tables absent */}
 return null;
}

async function partyResolvedNumber(db:Db,env:Env,table:"canonical_customers"|"canonical_providers",id:string):Promise<string|null>{
 let row:Row|null=null;
 try{row=table==="canonical_customers"
  ?await db.prepare("SELECT primary_phone phone FROM canonical_customers WHERE id=?").bind(id).first<Row>()
  :await db.prepare("SELECT phone FROM canonical_providers WHERE id=?").bind(id).first<Row>();}
 catch{return null;}
 if(!row||!text(row.phone))return null;
 return canonicalDialNumber(env,row.phone);
}

/**
 * Initiate a masked bridge for `bookingId` on behalf of `actor`. Returns a structured result the route maps
 * to HTTP; it throws nothing for an expected refusal.
 */
export async function initiateVoiceBridge(db:Db,env:Env,input:{bookingId:string;actor:BridgeActor;recordRequested?:boolean;asOf?:number}):Promise<BridgeResult>{
 await ensureVoiceBridgeTables(db);
 const asOf=input.asOf??now(),bookingId=text(input.bookingId);
 if(!bookingId)return{ok:false,status:400,reason:"booking_id_required"};
 let booking:Row|null=null;
 try{booking=await db.prepare("SELECT id,customer_id,provider_id,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();}catch{return{ok:false,status:503,reason:"booking_store_unavailable"};}
 if(!booking)return{ok:false,status:404,reason:"booking_not_found"};
 const providerId=text(booking.provider_id),customerId=text(booking.customer_id);

 // 1. The caller must be a BOUND party to THIS booking - provider or pet parent.
 const asCustomer=await boundSubjectId(db,input.actor,"customer");
 const asProvider=await boundSubjectId(db,input.actor,"provider");
 const initiatorType=asCustomer&&asCustomer===customerId?"customer":asProvider&&asProvider===providerId?"provider":null;
 if(!initiatorType)return{ok:false,status:403,reason:"not_a_party_to_this_booking"};

 // 2. Active service window: an allowed status, and within a generous band of the schedule.
 if(!ACTIVE_BRIDGE_STATUSES.has(text(booking.status)))return{ok:false,status:409,reason:"booking_not_in_active_window",detail:{bookingStatus:text(booking.status)}};
 const startMs=Date.parse(text(booking.scheduled_start)),endMs=Date.parse(text(booking.scheduled_end));
 if(Number.isFinite(startMs)&&Number.isFinite(endMs)&&(asOf<startMs-WINDOW_GRACE_MS||asOf>endMs+WINDOW_GRACE_MS))return{ok:false,status:409,reason:"booking_not_in_active_window",detail:{bookingStatus:text(booking.status)}};

 // 3. Environment gate (identical to an outbound voice call): approved env, creds, https callback, and in
 //    UAT an explicit allow-list.
 const gate=resolveVoiceCallGate(env);
 if(!gate.ok)return{ok:false,status:gate.status,reason:gate.reason};
 const callback=statusCallbackUrl(env);
 if(!callback)return{ok:false,status:503,reason:"status_callback_not_configured"};

 // 4. Resolve BOTH real numbers server-side. Never returned to the client, never stored.
 const providerNumber=await partyResolvedNumber(db,env,"canonical_providers",providerId);
 const customerNumber=await partyResolvedNumber(db,env,"canonical_customers",customerId);
 if(!providerNumber||!customerNumber)return{ok:false,status:409,reason:"party_contact_unavailable"};
 // In UAT both legs must be explicitly allow-listed (the whole point of the UAT gate).
 if(voiceMode(env)==="uat"&&(!isVoiceAllowlisted(env,providerNumber)||!isVoiceAllowlisted(env,customerNumber)))return{ok:false,status:403,reason:"recipient_not_allowlisted"};

 // 5. Recording is OFF unless the environment approves it AND the caller opts in.
 const recordingAllowed=Boolean(input.recordRequested)&&callRecordingApproved(env);

 // 6. Dial: the initiator's own leg first, the counterparty second. Both masked by the ExoPhone.
 const firstLeg=initiatorType==="customer"?customerNumber:providerNumber;
 const secondLeg=initiatorType==="customer"?providerNumber:customerNumber;
 const provider=selectTelephonyProvider(env);
 if(typeof provider.connectTwoNumbers!=="function")return{ok:false,status:503,reason:"bridge_not_supported_by_transport"};
 const sessionId=uid("VBS"),maskingNumber=text(env.EXOTEL_CALLER_ID);
 let handle;
 try{handle=await provider.connectTwoNumbers({callRef:sessionId,firstLegNumber:firstLeg,secondLegNumber:secondLeg,statusCallbackUrl:callback,recordingAllowed,timeoutSeconds:45,simulatedOutcome:(env.PAWSPACE_VOICE_SIMULATED_OUTCOME as never)||null});}
 catch(error){if(error instanceof TelephonyProviderUnavailable)return{ok:false,status:502,reason:"telephony_provider_unavailable",detail:{message:error.message.slice(0,160)}};throw error;}

 // 7. Persist the session - subject ids + ExoPhone only; no party phone number is stored.
 await db.prepare("INSERT INTO voice_bridge_sessions (id,booking_id,initiator_type,initiator_principal_key,provider_id,customer_id,provider_call_sid,masking_number,status,recording_status,environment,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(sessionId,bookingId,initiatorType,text(input.actor.principalKey)||text(input.actor.email),providerId,customerId,text(handle.providerCallId)||null,maskingNumber,"initiating",recordingAllowed?"pending":"not_recorded",gate.mode,asOf,asOf).run();
 return{ok:true,sessionId,status:"initiating",recording:recordingAllowed,provider:provider.provider,productionCall:handle.productionCall,maskingNumber};
}

/**
 * Exotel status/recording callback for a bridged call. Unauthenticated at the network edge, so it is
 * signature-verified first, then matched by our call reference / the provider CallSid, then applied once.
 */
export async function recordVoiceBridgeCallback(db:Db,env:Env,input:{rawBody:string;headers:Headers;asOf?:number}){
 await ensureVoiceBridgeTables(db);
 const asOf=input.asOf??now(),provider=selectTelephonyProvider(env);
 const verification=await provider.verifyWebhook({rawBody:input.rawBody,headers:input.headers});
 if(!verification.verified)return{accepted:false,status:401,reason:verification.reason||"invalid_signature"};
 let event;
 try{event=provider.parseEvent(input.rawBody);}catch{return{accepted:false,status:400,reason:"invalid_callback_body"};}
 const session=await db.prepare("SELECT * FROM voice_bridge_sessions WHERE id=? OR provider_call_sid=? LIMIT 1").bind(text(event.callRef),text(event.providerCallId)).first<Row>();
 if(!session)return{accepted:true,status:202,matched:false,reason:"unknown_call_reference"};
 const bodyDigest=await sha256Hex(input.rawBody);
 const inserted=await db.prepare("INSERT OR IGNORE INTO voice_bridge_events (id,session_id,provider_event_id,kind,provider_status,duration_seconds,body_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .bind(uid("VBE"),text(session.id),event.providerEventId,event.kind,event.providerStatus,event.durationSeconds,bodyDigest,asOf).run();
 const duplicatePrevented=(inserted.meta?.changes??0)===0;
 if(duplicatePrevented)return{accepted:true,status:200,matched:true,sessionId:text(session.id),kind:event.kind,duplicatePrevented:true};

 // Apply the event. A terminal call is never dragged back into an active state (callbacks arrive out of
 // order); recording is stored ONLY when the session opted in and the environment approved it.
 const current=text(session.status),isTerminal=TERMINAL_BRIDGE_STATUSES.has(current);
 const set:string[]=["updated_at=?"];const binds:unknown[]=[asOf];
 const setStatus=(status:string,terminal:boolean)=>{if(isTerminal)return;set.push("status=?");binds.push(status);if(terminal){set.push("ended_at=?","end_reason=?");binds.push(asOf,event.kind);}};
 if(event.kind==="connected"){if(!isTerminal){set.push("status=?");binds.push("connected");if(session.connected_at==null){set.push("connected_at=?");binds.push(asOf);}}}
 else if(event.kind==="completed")setStatus("completed",true);
 else if(event.kind==="failed")setStatus("failed",true);
 else if(event.kind==="no_answer")setStatus("no_answer",true);
 else if(event.kind==="busy")setStatus("busy",true);
 else if(event.kind==="ringing"){if(current==="initiating"){set.push("status=?");binds.push("ringing");}}
 else if(event.kind==="recording_available"){
  if(text(session.recording_status)!=="not_recorded"&&text(event.recordingRef)){set.push("recording_status=?","recording_reference=?");binds.push("recorded",text(event.recordingRef));if(event.durationSeconds!=null){set.push("recording_duration_seconds=?");binds.push(event.durationSeconds);}}
 }
 binds.push(text(session.id));
 await db.prepare(`UPDATE voice_bridge_sessions SET ${set.join(",")} WHERE id=?`).bind(...binds).run();
 return{accepted:true,status:200,matched:true,sessionId:text(session.id),kind:event.kind,duplicatePrevented:false};
}

/** Read one session for the ops/party surface. Exposes no phone numbers (there are none to expose). */
export async function getVoiceBridgeSession(db:Db,sessionId:string){
 await ensureVoiceBridgeTables(db);
 const session=await db.prepare("SELECT id,booking_id,initiator_type,provider_id,customer_id,provider_call_sid,masking_number,status,recording_status,recording_reference,recording_duration_seconds,environment,requested_at,connected_at,ended_at,end_reason FROM voice_bridge_sessions WHERE id=?").bind(text(sessionId)).first<Row>();
 if(!session)return null;
 const events=await db.prepare("SELECT provider_event_id,kind,provider_status,duration_seconds,created_at FROM voice_bridge_events WHERE session_id=? ORDER BY created_at").bind(text(sessionId)).all<Row>();
 return{session,events:events.results,productionReady:false};
}
