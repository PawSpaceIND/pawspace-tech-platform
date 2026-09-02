import { BOT_CALL_TAG_CODES } from "./bot-call-disposition";
import { ensureCommunicationTables } from "./communication-engine";
import { ensureAiVoiceUatTables } from "./ai-voice-uat";
import { createUnifiedCase } from "./unified-case-center";
import { getUserLocale } from "./i18n-governance";
import { selectVoiceTts, voiceProvidersStatus } from "./voice-provider-adapter";
import { canonicalVoiceLocale } from "./voice-locale";
import {
  ensureVoiceCallTables,
  recordVoiceSpeechFailure,
  requestOutboundVoiceCall,
  requestVoiceHumanHandoff,
  retryVoiceCall,
  seedVoiceCallScripts,
} from "./voice-outbound-governance";
import { sha256Hex } from "./voice-telephony-provider";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const BOT_TAGS = new Set(BOT_CALL_TAG_CODES);

export const SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5 * 60_000;
const STALE_CLAIM_MS = 10 * 60_000;
const CALL_PROGRESS_TIMEOUT_MS = 15 * 60_000;

export type ServiceRecoveryAudioTrigger = "provider_no_show" | "provider_lateness" | "provider_reassignment" | "service_exception";
export type ServiceRecoveryAudioJobStatus =
  | "queued" | "claimed" | "awaiting_outcome" | "retry_pending"
  | "completed" | "escalated" | "blocked" | "failed";

const INCLUDED_RECOVERY = /(no[_ -]?show|running[_ -]?late|predicted[_ -]?late|provider[_ -]?late|late[_ -]?arrival|delay|reassign|replacement|provider[_ -]?unavailable|service[_ -]?exception)/i;
const EXCLUDED_RECOVERY = /(payment|refund|dunning|invoice|collection|wallet|cashback|coupon)/i;

export function serviceRecoveryAudioTrigger(templateKey: string, payloadJson = ""): ServiceRecoveryAudioTrigger | null {
  const value = `${text(templateKey)} ${text(payloadJson)}`;
  if (!INCLUDED_RECOVERY.test(value) || EXCLUDED_RECOVERY.test(value)) return null;
  if (/no[_ -]?show/i.test(value)) return "provider_no_show";
  if (/(running[_ -]?late|predicted[_ -]?late|provider[_ -]?late|late[_ -]?arrival|delay)/i.test(value)) return "provider_lateness";
  if (/(reassign|replacement)/i.test(value)) return "provider_reassignment";
  return "service_exception";
}

export async function ensureServiceRecoveryAudioBotTables(db: Db) {
  await ensureCommunicationTables(db);
  await ensureVoiceCallTables(db);
  await ensureAiVoiceUatTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_recovery_voice_jobs (id TEXT PRIMARY KEY,source_message_id TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,template_key TEXT NOT NULL,trigger_kind TEXT NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 2,next_attempt_at INTEGER NOT NULL,last_call_id TEXT,last_disposition TEXT,last_detail TEXT,handoff_case_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_recovery_voice_jobs_due ON service_recovery_voice_jobs(status,next_attempt_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_recovery_voice_jobs_booking ON service_recovery_voice_jobs(booking_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS service_recovery_voice_attempts (id TEXT PRIMARY KEY,job_id TEXT NOT NULL,attempt_no INTEGER NOT NULL,voice_call_id TEXT UNIQUE,ai_call_id TEXT,call_state TEXT,disposition TEXT,bot_tag TEXT,retryable INTEGER NOT NULL DEFAULT 0,human_case_id TEXT,speech_provider TEXT,opening_audio_sha256 TEXT,detail_json TEXT NOT NULL DEFAULT '{}',started_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(job_id,attempt_no))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_recovery_voice_attempts_job ON service_recovery_voice_attempts(job_id,attempt_no)"),
  ]);
}

async function runtimeEnv(): Promise<Env> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as Env;
}

async function sourceRows(db: Db, limit: number) {
  return db.prepare(`SELECT m.id,m.thread_id,m.customer_id,m.booking_id,m.template_key,m.payload_json,m.status
    FROM communication_messages m
    LEFT JOIN service_recovery_voice_jobs j ON j.source_message_id=m.id
    WHERE m.direction='outbound' AND m.purpose='service_recovery' AND m.booking_id IS NOT NULL
      AND m.status!='suppressed' AND j.source_message_id IS NULL
    ORDER BY m.created_at ASC LIMIT ?`).bind(Math.max(1, Math.min(limit, 200))).all<Row>();
}

export async function stageServiceRecoveryAudioBotJobs(db: Db, input: { asOf?: number; limit?: number } = {}) {
  await ensureServiceRecoveryAudioBotTables(db);
  const now = input.asOf ?? Date.now();
  const rows = await sourceRows(db, input.limit ?? 100);
  let staged = 0, skipped = 0, duplicates = 0;
  for (const row of rows.results) {
    const trigger = serviceRecoveryAudioTrigger(text(row.template_key), text(row.payload_json));
    if (!trigger) { skipped++; continue; }
    const jobId = uid("SRVBOT");
    const result = await db.prepare("INSERT OR IGNORE INTO service_recovery_voice_jobs (id,source_message_id,thread_id,booking_id,customer_id,template_key,trigger_kind,status,attempt_count,max_attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',0,?,?,?,?)")
      .bind(jobId,text(row.id),text(row.thread_id),text(row.booking_id),text(row.customer_id),text(row.template_key),trigger,SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS,now,now,now).run();
    if (Number(result.meta.changes)) staged++; else duplicates++;
  }
  return { staged, skipped, duplicates };
}

async function recipientForJob(db: Db, job: Row) {
  const row = await db.prepare(`SELECT b.id,b.customer_id,b.city_id,c.primary_phone
    FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.customer_id=? LIMIT 1`).bind(text(job.booking_id),text(job.customer_id)).first<Row>();
  if (!row) throw new Error("Recovery booking/customer relationship is unavailable");
  if (!text(row.primary_phone)) throw new Error("Recovery customer has no dialable phone on record");
  if (!text(row.city_id)) throw new Error("Recovery booking has no city for voice policy resolution");
  const preferredLocale = await getUserLocale(db,text(row.customer_id)).catch(()=>null);
  return { customerId:text(row.customer_id), bookingId:text(row.id), cityId:text(row.city_id), phone:text(row.primary_phone), locale:canonicalVoiceLocale(preferredLocale) };
}

function canonicalBotTag(code: string | null) {
  return code && BOT_TAGS.has(code) ? code : null;
}

function stateDisposition(state: string, previousState = "", optedOut = false) {
  if (optedOut) return { disposition:"do_not_call", botTag:canonicalBotTag("do_not_call"), retryable:false };
  const effective = state === "ended" ? previousState : state;
  if (effective === "completed") return { disposition:"info_shared", botTag:canonicalBotTag("info_shared"), retryable:false };
  if (effective === "no_answer") return { disposition:"rnr", botTag:canonicalBotTag("rnr"), retryable:true };
  if (effective === "busy") return { disposition:"busy", botTag:canonicalBotTag("busy"), retryable:true };
  if (["dial_failed","provider_unavailable","provider_error"].includes(effective)) return { disposition:"provider_failure", botTag:null, retryable:true };
  if (["stt_failed","tts_failed","handoff_requested","ai_handoff"].includes(effective)) return { disposition:"human_intervention_needed", botTag:canonicalBotTag("human_intervention_needed"), retryable:false };
  if (effective.startsWith("blocked_")) return { disposition:"policy_blocked", botTag:null, retryable:false };
  if (effective === "cancelled") return { disposition:"cancelled", botTag:null, retryable:false };
  return { disposition:"pending", botTag:null, retryable:false };
}

async function updateAttempt(db: Db, input: { jobId:string; attemptNo:number; voiceCallId?:string|null; aiCallId?:string|null; callState?:string|null; disposition?:string|null; botTag?:string|null; retryable?:boolean; humanCaseId?:string|null; speechProvider?:string|null; openingAudioSha256?:string|null; detail?:unknown; finishedAt?:number|null }) {
  const row = await db.prepare("SELECT id FROM service_recovery_voice_attempts WHERE job_id=? AND attempt_no=?").bind(input.jobId,input.attemptNo).first<Row>();
  const now = Date.now();
  if (!row) {
    await db.prepare("INSERT INTO service_recovery_voice_attempts (id,job_id,attempt_no,voice_call_id,ai_call_id,call_state,disposition,bot_tag,retryable,human_case_id,speech_provider,opening_audio_sha256,detail_json,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(uid("SRVATT"),input.jobId,input.attemptNo,input.voiceCallId||null,input.aiCallId||null,input.callState||null,input.disposition||null,input.botTag||null,input.retryable?1:0,input.humanCaseId||null,input.speechProvider||null,input.openingAudioSha256||null,JSON.stringify(input.detail??{}),now,input.finishedAt??null).run();
    return;
  }
  await db.prepare("UPDATE service_recovery_voice_attempts SET voice_call_id=COALESCE(?,voice_call_id),ai_call_id=COALESCE(?,ai_call_id),call_state=COALESCE(?,call_state),disposition=COALESCE(?,disposition),bot_tag=COALESCE(?,bot_tag),retryable=?,human_case_id=COALESCE(?,human_case_id),speech_provider=COALESCE(?,speech_provider),opening_audio_sha256=COALESCE(?,opening_audio_sha256),detail_json=?,finished_at=COALESCE(?,finished_at) WHERE job_id=? AND attempt_no=?")
    .bind(input.voiceCallId||null,input.aiCallId||null,input.callState||null,input.disposition||null,input.botTag||null,input.retryable?1:0,input.humanCaseId||null,input.speechProvider||null,input.openingAudioSha256||null,JSON.stringify(input.detail??{}),input.finishedAt??null,input.jobId,input.attemptNo).run();
}

async function escalateJob(db: Db, job: Row, input: { reason:string; disposition?:string; callId?:string|null; existingCaseId?:string|null; asOf:number; actorId:string }) {
  let caseId = text(input.existingCaseId);
  if (!caseId) {
    const created = await createUnifiedCase(db, {
      idempotencyKey:`service-recovery-voice:${text(job.id)}`,
      caseType:"provider_issue",
      severity:text(job.trigger_kind)==="provider_no_show"?"high":"medium",
      title:`Service recovery needs a human: ${text(job.trigger_kind).replaceAll("_"," ")}`,
      description:`Automated recovery stopped after ${Number(job.attempt_count||0)} attempt(s). ${text(input.reason).slice(0,400)}`,
      customerId:text(job.customer_id), bookingId:text(job.booking_id),
      sourceType:"service_recovery_voice_job", sourceId:text(job.id), ownerTeam:"customer_experience",
      actorId:input.actorId, asOf:input.asOf,
    }).catch(()=>null) as {case?:Row}|null;
    caseId = text(created?.case?.id);
  }
  const status = caseId ? "escalated" : "failed";
  await db.prepare("UPDATE service_recovery_voice_jobs SET status=?,last_disposition=?,last_detail=?,handoff_case_id=?,updated_at=? WHERE id=?")
    .bind(status,input.disposition||"human_intervention_needed",text(input.reason).slice(0,500),caseId||null,input.asOf,text(job.id)).run();
  const attemptNo = Number(job.attempt_count||0);
  if (attemptNo > 0) await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:input.callId||null,disposition:input.disposition||"human_intervention_needed",botTag:canonicalBotTag("human_intervention_needed"),retryable:false,humanCaseId:caseId||null,detail:{reason:input.reason},finishedAt:input.asOf});
  return { escalated:Boolean(caseId), caseId:caseId||null };
}

async function activateAiSession(db: Db, env: Env, job: Row, call: Row, attemptNo: number, actorId: string, asOf: number) {
  if (!["connected","speaking","listening"].includes(text(call.state))) return { activated:false, reason:"call_not_connected" };
  if (text(call.use_case)!=="service_recovery" || text(call.consent_decision)!=="granted") throw new Error("Recovery AI session requires a policy-approved service_recovery call with recorded consent");
  const priorId = text(call.ai_call_id);
  if (priorId) return { activated:false, aiCallId:priorId, reason:"already_bound" };
  const source = await db.prepare("SELECT thread_id,customer_id FROM communication_messages WHERE id=?").bind(text(job.source_message_id)).first<Row>();
  if (!source || text(source.customer_id)!==text(job.customer_id)) throw new Error("Recovery source message/customer relationship is unavailable");
  const aiCallId = uid("AIVCALL"), now = asOf, locale = canonicalVoiceLocale(call.locale);
  await db.prepare("INSERT INTO ai_voice_calls (id,thread_id,customer_id,transport_provider,direction,status,consent_status,language,started_at,created_by) VALUES (?,?,?,?, 'outbound','active','verified',?,?,?)")
    .bind(aiCallId,text(source.thread_id),text(job.customer_id),text(call.provider)==="exotel"?"exotel":"sandbox_simulator",locale,now,actorId).run();
  await db.prepare("UPDATE voice_call_orders SET ai_call_id=?,updated_at=? WHERE id=? AND ai_call_id IS NULL").bind(aiCallId,now,text(call.id)).run();

  const script = await db.prepare("SELECT opening_disclosure FROM voice_call_scripts WHERE use_case='service_recovery' AND active=1").first<Row>();
  const opening = text(script?.opening_disclosure);
  if (!opening) throw new Error("No active service recovery voice disclosure is configured");
  const tts = selectVoiceTts(env);
  if (tts.status!=="connected") throw new Error("Voice TTS became unavailable after call connection");
  const audio = await tts.synthesize({text:opening,language:locale});
  const audioHash = await sha256Hex(audio.audioRef);
  await db.prepare("INSERT INTO ai_voice_events (id,call_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?)")
    .bind(uid("AIVEVT"),aiCallId,"recovery_opening_prepared",JSON.stringify({sourceMessageId:text(job.source_message_id),voiceCallId:text(call.id),locale,speechProvider:tts.provider,latencyMs:audio.latencyMs,audioSha256:audioHash,productionTelephony:Number(call.production_call)===1}),now).run();
  await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:text(call.id),aiCallId,callState:text(call.state),speechProvider:tts.provider,openingAudioSha256:audioHash,detail:{openingPrepared:true,locale,productionTelephony:Number(call.production_call)===1}});
  return { activated:true, aiCallId, locale, speechProvider:tts.provider, openingAudioSha256:audioHash };
}

async function observeAwaitingJob(db: Db, env: Env, job: Row, actorId: string, asOf: number) {
  const callId = text(job.last_call_id);
  if (!callId) return escalateJob(db,job,{reason:"Recovery job has no voice call to observe",asOf,actorId});
  const call = await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(callId).first<Row>();
  if (!call) return escalateJob(db,job,{reason:"Recovery voice call ledger row is missing",asOf,actorId,callId});
  const attemptNo = Number(job.attempt_count||0);
  await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:callId,callState:text(call.state),detail:{observedAt:asOf,locale:canonicalVoiceLocale(call.locale)}});

  if (["connected","speaking","listening"].includes(text(call.state))) {
    try {
      const activated = await activateAiSession(db,env,job,call,attemptNo,actorId,asOf);
      return { awaiting:true, activated };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await recordVoiceSpeechFailure(db,{callId,kind:"tts",reason,actorId,asOf}); } catch {}
      const handoff = await requestVoiceHumanHandoff(db,{callId,reason:`Recovery audio bot unavailable: ${reason}`,actorId,customerId:text(job.customer_id),asOf}).catch(()=>null) as {caseId?:string|null}|null;
      return escalateJob(db,job,{reason:`Recovery audio bot failed after connection: ${reason}`,asOf,actorId,callId,existingCaseId:text(handoff?.caseId)});
    }
  }

  const optedOut = Boolean(await db.prepare("SELECT phone_key FROM voice_call_opt_outs WHERE phone_key=? AND recorded_at>=?").bind(text(call.phone_key),Number(call.requested_at||0)).first<Row>());
  const outcome = stateDisposition(text(call.state),text(call.previous_state),optedOut);
  if (outcome.disposition==="info_shared" || outcome.disposition==="do_not_call") {
    await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:callId,callState:text(call.state),disposition:outcome.disposition,botTag:outcome.botTag,retryable:false,detail:{previousState:text(call.previous_state),locale:canonicalVoiceLocale(call.locale)},finishedAt:asOf});
    await db.prepare("UPDATE service_recovery_voice_jobs SET status='completed',last_disposition=?,last_detail=?,updated_at=? WHERE id=?")
      .bind(outcome.disposition,outcome.disposition==="do_not_call"?"Customer opted out during the recovery call":"Recovery information was delivered by the audio bot",asOf,text(job.id)).run();
    return { completed:true, disposition:outcome.disposition };
  }

  if (outcome.disposition==="human_intervention_needed") {
    if (["stt_failed","tts_failed"].includes(text(call.state))) {
      const handoff = await requestVoiceHumanHandoff(db,{callId,reason:`Recovery audio bot ${text(call.state)}`,actorId,customerId:text(job.customer_id),asOf}).catch(()=>null) as {caseId?:string|null}|null;
      return escalateJob(db,job,{reason:`Recovery audio bot entered ${text(call.state)}`,asOf,actorId,callId,existingCaseId:text(handoff?.caseId)});
    }
    return escalateJob(db,job,{reason:`Recovery audio bot entered ${text(call.state)}`,asOf,actorId,callId,existingCaseId:text(call.handoff_case_id)});
  }

  if (outcome.retryable) {
    await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:callId,callState:text(call.state),disposition:outcome.disposition,botTag:outcome.botTag,retryable:true,detail:{previousState:text(call.previous_state),locale:canonicalVoiceLocale(call.locale)},finishedAt:asOf});
    if (attemptNo < Number(job.max_attempts||SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS)) {
      await db.prepare("UPDATE service_recovery_voice_jobs SET status='retry_pending',last_disposition=?,last_detail=?,next_attempt_at=?,updated_at=? WHERE id=?")
        .bind(outcome.disposition,`Retryable recovery call outcome: ${text(call.state)}`,asOf+RETRY_DELAY_MS,asOf,text(job.id)).run();
      return { retryPending:true, disposition:outcome.disposition };
    }
    return escalateJob(db,job,{reason:`Automated recovery exhausted ${attemptNo} attempt(s) after ${text(call.state)}`,disposition:outcome.disposition,asOf,actorId,callId});
  }

  if (outcome.disposition==="policy_blocked" || outcome.disposition==="cancelled") {
    await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:callId,callState:text(call.state),disposition:outcome.disposition,retryable:false,detail:{previousState:text(call.previous_state),locale:canonicalVoiceLocale(call.locale)},finishedAt:asOf});
    await db.prepare("UPDATE service_recovery_voice_jobs SET status='blocked',last_disposition=?,last_detail=?,updated_at=? WHERE id=?")
      .bind(outcome.disposition,`Automated recovery stopped in ${text(call.state)}`,asOf,text(job.id)).run();
    return escalateJob(db,{...job,attempt_count:attemptNo},{reason:`Automated recovery was ${outcome.disposition}: ${text(call.state)}`,disposition:outcome.disposition,asOf,actorId,callId});
  }

  if (["queued","dialing","ringing"].includes(text(call.state)) && asOf-Number(call.requested_at||asOf)>CALL_PROGRESS_TIMEOUT_MS) {
    return escalateJob(db,job,{reason:`Recovery call remained ${text(call.state)} beyond ${CALL_PROGRESS_TIMEOUT_MS/60_000} minutes`,asOf,actorId,callId});
  }
  return { awaiting:true, state:text(call.state) };
}

async function dialClaimedJob(db: Db, env: Env, job: Row, actorId: string, asOf: number) {
  const readiness = voiceProvidersStatus(env);
  if (!readiness.voiceAutomationReady) {
    return escalateJob(db,job,{reason:`Speech engine is not ready (${readiness.engine})`,asOf,actorId});
  }
  const recipient = await recipientForJob(db,job);
  const attemptNo = Number(job.attempt_count||0)+1;
  if (attemptNo > Number(job.max_attempts||SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS)) return escalateJob(db,job,{reason:"Automated recovery attempt ceiling reached",asOf,actorId});
  await seedVoiceCallScripts(db,actorId);

  let result: Row;
  if (text(job.status)==="claimed" && Number(job.attempt_count||0)>0 && text(job.last_call_id)) {
    result = await retryVoiceCall(db,env,{callId:text(job.last_call_id),actorId,actorPermissions:["communications.call","customers.manage"],idempotencyKey:`service-recovery-audio:${text(job.id)}:${attemptNo}`,asOf}) as Row;
  } else {
    result = await requestOutboundVoiceCall(db,env,{
      idempotencyKey:`service-recovery-audio:${text(job.id)}:${attemptNo}`,
      useCase:"service_recovery",phone:recipient.phone,cityId:recipient.cityId,locale:recipient.locale,customerId:recipient.customerId,bookingId:recipient.bookingId,
      actorId,actorPermissions:["communications.call","customers.manage"],asOf,
    }) as Row;
  }
  const callId = text(result.callId);
  const call = callId ? await db.prepare("SELECT * FROM voice_call_orders WHERE id=?").bind(callId).first<Row>() : null;
  if (!call) return escalateJob(db,job,{reason:"Voice governance returned no call ledger row",asOf,actorId});
  const dialled = call.dialed_at!=null;
  const productionCall = Number(call.production_call)===1;
  const locale = canonicalVoiceLocale(call.locale);
  await updateAttempt(db,{jobId:text(job.id),attemptNo,voiceCallId:callId,callState:text(call.state),detail:{dialled,productionCall,locale,blockedBy:text((result as Row).blockedBy)||null}});
  await db.prepare("UPDATE service_recovery_voice_jobs SET attempt_count=?,last_call_id=?,last_disposition=NULL,last_detail=?,updated_at=? WHERE id=?")
    .bind(attemptNo,callId,dialled?`Governed recovery call accepted by transport (${locale})`:`Recovery call did not dial (${text(call.state)})`,asOf,text(job.id)).run();
  const freshJob = await db.prepare("SELECT * FROM service_recovery_voice_jobs WHERE id=?").bind(text(job.id)).first<Row>() as Row;
  if (!dialled) return observeAwaitingJob(db,env,freshJob,actorId,asOf);
  await db.prepare("UPDATE service_recovery_voice_jobs SET status='awaiting_outcome',next_attempt_at=?,updated_at=? WHERE id=?").bind(asOf,asOf,text(job.id)).run();
  return { dialled:true, productionCall, callId, locale, attemptNo };
}

async function claimJob(db: Db, job: Row, asOf: number) {
  const claim = await db.prepare("UPDATE service_recovery_voice_jobs SET status='claimed',updated_at=? WHERE id=? AND status IN ('queued','retry_pending') AND next_attempt_at<=?")
    .bind(asOf,text(job.id),asOf).run();
  return Number(claim.meta.changes)>0;
}

export async function runServiceRecoveryAudioBotSweep(db: Db, input: { actorId?:string; asOf?:number; env?:Env; limit?:number } = {}) {
  const asOf = input.asOf ?? Date.now(), actorId = text(input.actorId)||"system:service-recovery-audio-bot", env = input.env ?? await runtimeEnv();
  await ensureServiceRecoveryAudioBotTables(db);
  const staged = await stageServiceRecoveryAudioBotJobs(db,{asOf,limit:input.limit??100});
  await db.prepare("UPDATE service_recovery_voice_jobs SET status='retry_pending',next_attempt_at=?,last_detail='Recovered stale worker claim',updated_at=? WHERE status='claimed' AND updated_at<=?")
    .bind(asOf,asOf,asOf-STALE_CLAIM_MS).run();

  const awaiting = await db.prepare("SELECT * FROM service_recovery_voice_jobs WHERE status='awaiting_outcome' ORDER BY updated_at ASC LIMIT ?").bind(Math.max(1,Math.min(input.limit??25,100))).all<Row>();
  let completed=0,escalated=0,retryPending=0,audioSessions=0;
  for (const job of awaiting.results) {
    const result = await observeAwaitingJob(db,env,job,actorId,asOf) as Row;
    if (result.completed) completed++;
    if (result.escalated) escalated++;
    if (result.retryPending) retryPending++;
    if ((result.activated as Row|undefined)?.activated) audioSessions++;
  }

  const due = await db.prepare("SELECT * FROM service_recovery_voice_jobs WHERE status IN ('queued','retry_pending') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?")
    .bind(asOf,Math.max(1,Math.min(input.limit??25,100))).all<Row>();
  let dialled=0,productionDials=0,failed=0;
  for (const original of due.results) {
    if (!(await claimJob(db,original,asOf))) continue;
    const job = await db.prepare("SELECT * FROM service_recovery_voice_jobs WHERE id=?").bind(text(original.id)).first<Row>() as Row;
    try {
      const result = await dialClaimedJob(db,env,job,actorId,asOf) as Row;
      if (result.dialled) { dialled++; if (result.productionCall) productionDials++; }
      if (result.escalated) escalated++;
      if (result.retryPending) retryPending++;
    } catch (error) {
      failed++;
      await escalateJob(db,job,{reason:error instanceof Error?error.message:String(error),asOf,actorId}).catch(async()=>{
        await db.prepare("UPDATE service_recovery_voice_jobs SET status='failed',last_detail=?,updated_at=? WHERE id=?").bind(text(error instanceof Error?error.message:error).slice(0,500),asOf,text(job.id)).run();
      });
    }
  }
  return { staged, dialled, productionDials, completed, escalated, retryPending, audioSessions, failed, maxAutomatedAttempts:SERVICE_RECOVERY_AUDIO_MAX_ATTEMPTS };
}

export async function serviceRecoveryAudioBotStatus(db: Db, input: { bookingId?:string; limit?:number } = {}) {
  await ensureServiceRecoveryAudioBotTables(db);
  const limit = Math.max(1,Math.min(input.limit??100,300));
  const rows = input.bookingId
    ? await db.prepare("SELECT * FROM service_recovery_voice_jobs WHERE booking_id=? ORDER BY created_at DESC LIMIT ?").bind(input.bookingId,limit).all<Row>()
    : await db.prepare("SELECT * FROM service_recovery_voice_jobs ORDER BY created_at DESC LIMIT ?").bind(limit).all<Row>();
  return rows.results.map(row=>({
    jobId:text(row.id),sourceMessageId:text(row.source_message_id),bookingId:text(row.booking_id),customerId:text(row.customer_id),templateKey:text(row.template_key),triggerKind:text(row.trigger_kind),status:text(row.status),attemptCount:Number(row.attempt_count||0),maxAttempts:Number(row.max_attempts||0),lastCallId:text(row.last_call_id)||null,lastDisposition:text(row.last_disposition)||null,handoffCaseId:text(row.handoff_case_id)||null,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),
  }));
}
