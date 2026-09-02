// Automated outbound Audio Bot service-recovery. When a provider is running late or has no-showed, an AI
// voice bot calls the customer to acknowledge and reassure - BEFORE a human is pulled in - and only
// escalates to a human when the bot cannot resolve it. Every dial goes through the governed outbound-voice
// path (requestOutboundVoiceCall -> resolveVoiceCallGate: consent, opt-out, quiet hours, frequency cap,
// approved script), and every recovery is tracked in one ledger so the bot can NEVER loop or fire twice.
//
// Loop / redundant-trigger prevention (the strict disposition tracking):
//   - one track per (booking_id, recovery_reason)               -> UNIQUE, no duplicate tracks;
//   - a track in 'calling' is not re-dialled                    -> no concurrent duplicate calls;
//   - attempt_count is capped at MAX_BOT_ATTEMPTS               -> then it escalates, never re-dials;
//   - 'resolved' and 'escalated' are terminal                   -> no further calls;
//   - each dial carries a per-attempt idempotency key           -> the outbound layer dedups the dial too.
// Import-safe for `node --experimental-strip-types` (no TS parameter properties).

import{requestOutboundVoiceCall}from"./voice-outbound-governance";
import{createUnifiedCase}from"./unified-case-center";

type Db=D1Database;
type Env=Record<string,unknown>;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v??0);
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,16).toUpperCase()}`;
const nowMs=()=>Date.now();

/** The service-recovery reasons an Audio Bot may act on. Sales/marketing reasons are deliberately absent. */
export const AUDIO_BOT_RECOVERY_REASONS=new Set(["provider_late","provider_no_show"]);
/** How many bot dials before a human is pulled in. */
export const MAX_BOT_ATTEMPTS=2;
/** A call left 'calling' longer than this lost its disposition; the sweep settles it as no-answer. */
const STALE_CALLING_MS=30*60_000;
const TERMINAL=new Set(["resolved","escalated"]);
/** Bot dispositions the caller maps a call outcome onto. */
export type AudioBotOutcome="acknowledged"|"reassured"|"no_answer"|"failed"|"agent_requested"|"opt_out";

const tablesEnsured=new WeakSet<Db>();
export async function ensureAudioBotRecoveryTables(db:Db){
 if(tablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS audio_bot_recovery_attempts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,recovery_reason TEXT NOT NULL,customer_id TEXT,status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,last_call_id TEXT,last_blocked_by TEXT,last_outcome TEXT,escalation_case_id TEXT,escalated_at INTEGER,resolved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(booking_id,recovery_reason))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_audio_bot_recovery_status ON audio_bot_recovery_attempts(status,updated_at)"),
 ]);
 tablesEnsured.add(db);
}

async function loadTrack(db:Db,bookingId:string,recoveryReason:string,asOf:number){
 await db.prepare("INSERT OR IGNORE INTO audio_bot_recovery_attempts (id,booking_id,recovery_reason,status,attempt_count,created_at,updated_at) VALUES (?,?,?,'pending',0,?,?)")
  .bind(uid("ABR"),bookingId,recoveryReason,asOf,asOf).run();
 return db.prepare("SELECT * FROM audio_bot_recovery_attempts WHERE booking_id=? AND recovery_reason=?").bind(bookingId,recoveryReason).first<Row>();
}
async function patch(db:Db,id:string,fields:Record<string,unknown>,asOf:number){
 const keys=Object.keys(fields),set=[...keys.map(k=>`${k}=?`),"updated_at=?"].join(",");
 await db.prepare(`UPDATE audio_bot_recovery_attempts SET ${set} WHERE id=?`).bind(...keys.map(k=>fields[k]),asOf,id).run();
}

/** Create (idempotently) the human-intervention case for a track that the bot could not resolve. */
async function escalateToHuman(db:Db,track:Row,reason:string,actorId:string,asOf:number){
 const bookingId=text(track.booking_id),recoveryReason=text(track.recovery_reason);
 const created=await createUnifiedCase(db,{
  idempotencyKey:`audio-bot-recovery-escalation:${bookingId}:${recoveryReason}`,
  caseType:"lead_escalation",severity:"high",
  title:`Provider ${recoveryReason.replace(/_/g," ")} needs a human - booking ${bookingId}`,
  description:`Automated Audio Bot service-recovery for ${recoveryReason} on booking ${bookingId} is handing off to a human: ${reason}. Bot dial attempts so far: ${num(track.attempt_count)}.`,
  customerId:text(track.customer_id)||undefined,bookingId,
  sourceType:"audio_bot_recovery",sourceId:`${bookingId}:${recoveryReason}`,
  ownerTeam:"customer_experience",actorId,asOf,
 }).catch(()=>null) as {case?:Row}|null;
 const caseId=created?.case?.id?String(created.case.id):null;
 await patch(db,text(track.id),{status:"escalated",escalation_case_id:caseId,escalated_at:asOf,last_outcome:reason},asOf);
 return caseId;
}

export type AudioBotTriggerResult={ok:boolean;status:string;bookingId:string;recoveryReason:string;attempt?:number;callId?:string|null;caseId?:string|null;blockedBy?:string|null;reason?:string;skipped?:boolean};

/**
 * Decide whether to place a bot recovery call for a booking, and place it through the governed outbound
 * path. Resolves the customer + number server-side (never taken from the caller). Enforces every loop /
 * redundancy guard. On an un-callable number (opt-out / no consent) or an exhausted track it escalates to
 * a human instead of dialling.
 */
export async function triggerAudioBotRecovery(db:Db,env:Env,input:{bookingId:string;recoveryReason:string;actorId:string;asOf?:number}):Promise<AudioBotTriggerResult>{
 await ensureAudioBotRecoveryTables(db);
 const asOf=input.asOf??nowMs(),bookingId=text(input.bookingId),recoveryReason=text(input.recoveryReason);
 if(!bookingId)return{ok:false,status:"error",bookingId,recoveryReason,reason:"booking_id_required"};
 if(!AUDIO_BOT_RECOVERY_REASONS.has(recoveryReason))return{ok:false,status:"error",bookingId,recoveryReason,reason:"unsupported_recovery_reason"};

 let booking:Row|null=null;
 try{booking=await db.prepare("SELECT id,customer_id,city_id,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();}catch{booking=null;}
 if(!booking)return{ok:false,status:"error",bookingId,recoveryReason,reason:"booking_not_found"};
 const customerId=text(booking.customer_id),cityId=text(booking.city_id)||"blr";

 const track=await loadTrack(db,bookingId,recoveryReason,asOf);
 if(!track)return{ok:false,status:"error",bookingId,recoveryReason,reason:"track_unavailable"};
 if(!text(track.customer_id)&&customerId)await patch(db,text(track.id),{customer_id:customerId},asOf);
 const status=text(track.status),attempts=num(track.attempt_count);

 // --- loop / redundancy guards ---
 if(status==="resolved")return{ok:true,status,bookingId,recoveryReason,skipped:true,reason:"already_resolved"};
 if(status==="escalated")return{ok:true,status,bookingId,recoveryReason,skipped:true,reason:"already_escalated",caseId:text(track.escalation_case_id)||null};
 if(status==="calling")return{ok:true,status,bookingId,recoveryReason,skipped:true,reason:"call_in_flight",callId:text(track.last_call_id)||null};
 if(attempts>=MAX_BOT_ATTEMPTS){const caseId=await escalateToHuman(db,track,"max_bot_attempts_reached",input.actorId,asOf);return{ok:true,status:"escalated",bookingId,recoveryReason,reason:"max_bot_attempts_reached",caseId,attempt:attempts};}

 // Resolve the customer's number server-side. No customer, no number -> a human takes it.
 let phone="";try{const c=await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();phone=text(c?.primary_phone);}catch{phone="";}
 if(!customerId||!phone){const caseId=await escalateToHuman(db,{...track,customer_id:customerId},"customer_contact_unavailable",input.actorId,asOf);return{ok:true,status:"escalated",bookingId,recoveryReason,reason:"customer_contact_unavailable",caseId};}

 // --- place the call through the governed outbound-voice gate ---
 const result=await requestOutboundVoiceCall(db,env,{
  idempotencyKey:`audio-bot-recovery:${bookingId}:${recoveryReason}:${attempts+1}`,
  useCase:"service_recovery",phone,cityId,customerId,bookingId,
  actorId:input.actorId,actorPermissions:["communications.call","customers.manage"],asOf,
 }) as Record<string,unknown>;
 const callId=text(result.callId)||null,blockedBy=result.blockedBy?String(result.blockedBy):null;

 if(blockedBy){
  if(/opt.?out|consent/i.test(blockedBy)){const caseId=await escalateToHuman(db,track,`uncallable_by_bot:${blockedBy}`,input.actorId,asOf);return{ok:true,status:"escalated",bookingId,recoveryReason,reason:"recipient_uncallable_by_bot",blockedBy,caseId};}
  if(/quiet|frequency/i.test(blockedBy)){await patch(db,text(track.id),{status:"deferred",last_call_id:callId,last_blocked_by:blockedBy},asOf);return{ok:false,status:"deferred",bookingId,recoveryReason,reason:"deferred_by_policy",blockedBy,callId};}
  // A configuration/script problem is not something a retry fixes and must not loop; surface it.
  await patch(db,text(track.id),{last_call_id:callId,last_blocked_by:blockedBy},asOf);
  return{ok:false,status:text(track.status),bookingId,recoveryReason,reason:"blocked_by_policy",blockedBy,callId};
 }

 // Placed (or an idempotent re-trigger of the same attempt). Count a fresh dial once.
 const increment=result.duplicatePrevented?0:1;
 await patch(db,text(track.id),{status:"calling",attempt_count:attempts+increment,last_call_id:callId,last_blocked_by:null},asOf);
 return{ok:true,status:"calling",bookingId,recoveryReason,attempt:attempts+increment,callId};
}

/**
 * Record what the bot call achieved and move the track on: resolved, another bot attempt, or a human.
 */
export async function settleAudioBotRecovery(db:Db,input:{bookingId:string;recoveryReason:string;outcome:AudioBotOutcome;actorId:string;asOf?:number}){
 await ensureAudioBotRecoveryTables(db);
 const asOf=input.asOf??nowMs(),bookingId=text(input.bookingId),recoveryReason=text(input.recoveryReason),outcome=input.outcome;
 const track=await db.prepare("SELECT * FROM audio_bot_recovery_attempts WHERE booking_id=? AND recovery_reason=?").bind(bookingId,recoveryReason).first<Row>();
 if(!track)return{ok:false,status:"error",reason:"recovery_track_not_found"};
 const status=text(track.status);
 if(TERMINAL.has(status))return{ok:true,status,bookingId,recoveryReason,reason:"already_terminal",caseId:text(track.escalation_case_id)||null};

 if(outcome==="acknowledged"||outcome==="reassured"){
  await patch(db,text(track.id),{status:"resolved",resolved_at:asOf,last_outcome:outcome},asOf);
  return{ok:true,status:"resolved",bookingId,recoveryReason};
 }
 if(outcome==="agent_requested"||outcome==="opt_out"){
  const caseId=await escalateToHuman(db,track,outcome==="opt_out"?"customer_opted_out":"customer_requested_agent",input.actorId,asOf);
  return{ok:true,status:"escalated",bookingId,recoveryReason,caseId};
 }
 // no_answer / failed: another bot attempt if we have not hit the cap, otherwise a human.
 const attempts=num(track.attempt_count);
 if(attempts>=MAX_BOT_ATTEMPTS){const caseId=await escalateToHuman(db,track,`${outcome}_after_max_attempts`,input.actorId,asOf);return{ok:true,status:"escalated",bookingId,recoveryReason,caseId};}
 await patch(db,text(track.id),{status:"pending_retry",last_outcome:outcome},asOf);
 return{ok:true,status:"pending_retry",bookingId,recoveryReason,attempt:attempts};
}

/**
 * Drive open recovery tracks forward: re-dial the ones awaiting a retry or deferred by policy, and rescue
 * any call whose disposition was lost (stuck 'calling' past the stale window) by settling it as no-answer.
 * Never throws out of the scheduler - every track's failure is collected, not raised.
 */
export async function runAudioBotRecoverySweep(db:Db,env:Env,input:{actorId?:string;asOf?:number;limit?:number}={}){
 await ensureAudioBotRecoveryTables(db);
 const asOf=input.asOf??nowMs(),actorId=input.actorId||"system:audio-bot-recovery-sweep",limit=Math.max(1,Math.min(input.limit??50,200));
 const errors:string[]=[];let redialled=0,rescued=0,escalated=0,resolved=0,deferred=0;
 const rows=await db.prepare("SELECT booking_id,recovery_reason,status,updated_at FROM audio_bot_recovery_attempts WHERE status IN ('pending_retry','deferred') OR (status='calling' AND updated_at<?) ORDER BY updated_at LIMIT ?").bind(asOf-STALE_CALLING_MS,limit).all<Row>();
 for(const row of rows.results){
  const bookingId=text(row.booking_id),recoveryReason=text(row.recovery_reason);
  try{
   if(text(row.status)==="calling"){await settleAudioBotRecovery(db,{bookingId,recoveryReason,outcome:"no_answer",actorId,asOf});rescued++;}
   const res=await triggerAudioBotRecovery(db,env,{bookingId,recoveryReason,actorId,asOf});
   if(res.status==="calling")redialled++;else if(res.status==="escalated")escalated++;else if(res.status==="resolved")resolved++;else if(res.status==="deferred")deferred++;
  }catch(error){errors.push(`${bookingId}:${recoveryReason}:${error instanceof Error?error.message:String(error)}`);}
 }
 return{processed:rows.results.length,redialled,rescued,escalated,resolved,deferred,errors,ok:errors.length===0,productionReady:false};
}

/** Read model for the ops surface. Exposes no phone numbers (the ledger stores none). */
export async function audioBotRecoverySnapshot(db:Db,filter?:{bookingId?:string}){
 await ensureAudioBotRecoveryTables(db);
 const rows=filter?.bookingId
  ?await db.prepare("SELECT * FROM audio_bot_recovery_attempts WHERE booking_id=? ORDER BY updated_at DESC LIMIT 100").bind(filter.bookingId).all<Row>()
  :await db.prepare("SELECT * FROM audio_bot_recovery_attempts ORDER BY updated_at DESC LIMIT 100").all<Row>();
 const counts=await db.prepare("SELECT status,COUNT(*) n FROM audio_bot_recovery_attempts GROUP BY status").all<Row>();
 return{tracks:rows.results,byStatus:Object.fromEntries(counts.results.map(r=>[text(r.status),num(r.n)])),maxBotAttempts:MAX_BOT_ATTEMPTS,productionReady:false};
}
