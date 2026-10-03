import {nextAudioContinuationLeaseBatch,NEXT_AUDIO_CONTINUATION_AUTH_SQL} from "./next-audio-continuation";
/** Same next-ten allocation, increased to $10 total on 2026-10-03. Reservations and claims never reset. */
export const NEXT_AUDIO_BUDGET_ID = "next-ten-audio-additional-usd5-20261002";
export const NEXT_AUDIO_CAP_MICROS = 10_000_000;
export const NEXT_AUDIO_MODEL_BATCH_CAP_MICROS = 1_000_000;
export const NEXT_AUDIO_THREAD_PREFIX = "THREAD-VOICE-NDEMO-NEXT-AUDIO-";
export const isNextAudioThread = (id: string) => id.startsWith(NEXT_AUDIO_THREAD_PREFIX);
type Row = Record<string, unknown>;
export type AudioRateReceipt = {
 currency: "USD"; inclusiveOfFeesAndTaxes: true; sourceSha: string; agentConfigSha256: string;
 provider: "openai"; model: "gpt-5.6-luna"; validUntil: number;
 nativeMicrosPerMinute: number; optionalBatchMicros: number;
 inputMicrosPerToken: number; outputMicrosPerToken: number; framingTokenUpper: number;
 evidenceReference: string;
};
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
export function validateAudioRateReceipt(r: AudioRateReceipt, now: number) {
 if (r.currency !== "USD" || r.inclusiveOfFeesAndTaxes !== true || r.provider !== "openai" || r.model !== "gpt-5.6-luna"
  || !/^[a-f0-9]{40}$/.test(r.sourceSha) || !/^[a-f0-9]{64}$/.test(r.agentConfigSha256)
  || !Number.isFinite(now) || !Number.isSafeInteger(r.validUntil) || r.validUntil <= now
  || !positive(r.nativeMicrosPerMinute) || !positive(r.inputMicrosPerToken) || !positive(r.outputMicrosPerToken)
  || !positive(r.framingTokenUpper) || !Number.isSafeInteger(r.optionalBatchMicros) || r.optionalBatchMicros < 0 || r.optionalBatchMicros > NEXT_AUDIO_CAP_MICROS
  || !r.evidenceReference?.trim()) throw new Error("next_audio_inclusive_rate_evidence_unproven");
}
/** UTF-8 bytes conservatively bound BPE input tokens; framing is separately attested. */
export function modelAttemptBound(r: AudioRateReceipt, system: string, user: string, outputTokens: number, now: number) {
 validateAudioRateReceipt(r, now);
 if (!positive(outputTokens) || outputTokens > 700) throw new Error("next_audio_output_bound_invalid");
 const bytes = new TextEncoder().encode(system).byteLength + new TextEncoder().encode(user).byteLength;
 const bound = (bytes + r.framingTokenUpper) * r.inputMicrosPerToken + outputTokens * r.outputMicrosPerToken;
 if (!positive(bound) || bound > NEXT_AUDIO_CAP_MICROS) throw new Error("next_audio_attempt_exceeds_batch_cap");
 return bound;
}
export async function ensureNextAudioBudget(db: D1Database) {
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS next_audio_budget (id TEXT PRIMARY KEY, cap_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL, conversations INTEGER NOT NULL, receipt_json TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS next_audio_leases (thread_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, customer_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS next_audio_batch_claims (budget_id TEXT PRIMARY KEY, token TEXT NOT NULL, run_id TEXT NOT NULL, source_sha TEXT NOT NULL, claimed_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS next_audio_speech_attempts (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,kind TEXT NOT NULL,units INTEGER NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS next_audio_attempts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, reserved_micros INTEGER NOT NULL, created_at INTEGER NOT NULL)"),
 ]);
}
/** Provision only through the existing authenticated administrative route, never a caller body. */
export async function provisionNextAudioBudget(db: D1Database, receipt: AudioRateReceipt, now: number) {
 validateAudioRateReceipt(receipt, now);
 await ensureNextAudioBudget(db);
 await db.prepare("INSERT OR IGNORE INTO next_audio_budget (id,cap_micros,reserved_micros,conversations,receipt_json,expires_at) VALUES (?,10000000,?,0,?,?)")
  .bind(NEXT_AUDIO_BUDGET_ID, receipt.optionalBatchMicros, JSON.stringify(receipt), receipt.validUntil).run();
 const stored = await db.prepare("SELECT receipt_json FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if (stored?.receipt_json !== JSON.stringify(receipt)) throw new Error("next_audio_budget_receipt_already_pinned");
 // Upgrade only the previously authorized cap; preserve all spent/reserved amounts, leases and dispatch claims.
 await db.prepare("UPDATE next_audio_budget SET cap_micros=10000000 WHERE id=? AND cap_micros=5000000").bind(NEXT_AUDIO_BUDGET_ID).run();
}
export async function reserveNextAudioLease(db: D1Database, input: { threadId: string; customerId: string; sourceSha: string; agentConfigSha256: string; providerHardDurationSeconds: number; now: number; continuationRunId?:string }) {
 if (!isNextAudioThread(input.threadId) || !input.customerId || !positive(input.providerHardDurationSeconds) || input.providerHardDurationSeconds > 120) throw new Error("next_audio_identity_or_native_duration_invalid");
 const row = await db.prepare("SELECT receipt_json FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if (!row) throw new Error("next_audio_rate_receipt_missing");
 const r = JSON.parse(String(row.receipt_json)) as AudioRateReceipt;
 validateAudioRateReceipt(r, input.now);
 const originalClaim=await db.prepare("SELECT source_sha FROM next_audio_batch_claims WHERE budget_id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if(originalClaim&&originalClaim.source_sha!==input.sourceSha&&!input.continuationRunId)throw Error("next_audio_continuation_lease_binding_required");
 const deadline = input.now + input.providerHardDurationSeconds * 1000;
 if (r.sourceSha !== input.sourceSha || r.agentConfigSha256 !== input.agentConfigSha256 || deadline >= r.validUntil) throw new Error("next_audio_revision_configuration_or_expiry_mismatch");
 const nativeBound = Math.ceil(input.providerHardDurationSeconds / 60 * r.nativeMicrosPerMinute);
 if (!positive(nativeBound)) throw new Error("next_audio_native_bound_invalid");
 if(input.continuationRunId){
  const batch=nextAudioContinuationLeaseBatch(NEXT_AUDIO_BUDGET_ID,{threadId:input.threadId,customerId:input.customerId,runId:input.continuationRunId,sourceSha:input.sourceSha,deadline,nativeBound,now:input.now});
  const results=await db.batch(batch.map(q=>db.prepare(q.sql).bind(...q.params)));
  if(results.length!==3||results.some(r=>Number(r.meta?.changes)!==1))throw Error("next_audio_continuation_lease_already_consumed_or_unavailable");
  return {deadline,nativeBound};
 }
 const results = await db.batch([
  db.prepare("INSERT INTO next_audio_leases (thread_id,budget_id,customer_id,attempts,expires_at) SELECT ?,?,?,0,? WHERE EXISTS (SELECT 1 FROM next_audio_budget WHERE id=? AND cap_micros=10000000 AND conversations<10 AND reserved_micros+?<=cap_micros AND expires_at>?)")
   .bind(input.threadId,NEXT_AUDIO_BUDGET_ID,input.customerId,deadline,NEXT_AUDIO_BUDGET_ID,nativeBound,deadline),
  db.prepare("UPDATE next_audio_budget SET reserved_micros=reserved_micros+?,conversations=conversations+1 WHERE id=? AND EXISTS (SELECT 1 FROM next_audio_leases WHERE thread_id=? AND customer_id=? AND expires_at=?)")
   .bind(nativeBound,NEXT_AUDIO_BUDGET_ID,input.threadId,input.customerId,deadline),
 ]);
 if (Number(results[0].meta?.changes) !== 1 || Number(results[1].meta?.changes) !== 1) throw new Error("next_audio_native_budget_exhausted");
 return {deadline,nativeBound};
}
/** Every actual provider HTTP attempt, including repair/retry, must call this before fetch. */
export async function reserveNextAudioAttempt(db: D1Database, input: {threadId:string; customerId:string; provider:string; model:string; sourceSha:string; systemPrompt:string; userPrompt:string; outputTokens:number; now:number}) {
 const row = await db.prepare("SELECT receipt_json FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if (!row || !isNextAudioThread(input.threadId)) throw new Error("next_audio_lease_missing");
 const receipt = JSON.parse(String(row.receipt_json)) as AudioRateReceipt;
 if (input.sourceSha !== receipt.sourceSha || input.provider !== receipt.provider || input.model !== receipt.model) throw new Error("next_audio_runtime_provider_mismatch");
 const bound = modelAttemptBound(receipt,input.systemPrompt,input.userPrompt,input.outputTokens,input.now), id=crypto.randomUUID();
 const result = await db.batch([
  db.prepare("INSERT INTO next_audio_attempts (id,thread_id,reserved_micros,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM next_audio_budget b JOIN next_audio_leases l ON l.budget_id=b.id WHERE b.id=? AND b.cap_micros=10000000 AND b.reserved_micros+?<=b.cap_micros AND b.expires_at>? AND l.thread_id=? AND l.customer_id=? AND l.expires_at>? AND l.attempts<6 AND (SELECT COALESCE(SUM(reserved_micros),0) FROM next_audio_attempts)+?<=1000000)")
   .bind(id,input.threadId,bound,input.now,NEXT_AUDIO_BUDGET_ID,bound,input.now,input.threadId,input.customerId,input.now,bound),
  db.prepare("UPDATE next_audio_budget SET reserved_micros=reserved_micros+? WHERE id=? AND EXISTS (SELECT 1 FROM next_audio_attempts WHERE id=?)").bind(bound,NEXT_AUDIO_BUDGET_ID,id),
  db.prepare("UPDATE next_audio_leases SET attempts=attempts+1 WHERE thread_id=? AND EXISTS (SELECT 1 FROM next_audio_attempts WHERE id=?)").bind(input.threadId,id),
 ]);
 if (result.some(r=>Number(r.meta?.changes)!==1)) throw new Error("next_audio_attempt_budget_exhausted_or_expired");
 return {id,reservedMicros:bound};
}

/** A dispatch consumes this allocation once, even if it fails before its first socket. No reclaim/reset. */
export async function claimNextAudioBatch(db:D1Database, runId:string, sourceSha:string, now:number) {
 if (!/^[0-9]+$/.test(runId)||!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("next_audio_batch_identity_invalid");
 const token=crypto.randomUUID();
 const r=await db.prepare("INSERT OR IGNORE INTO next_audio_batch_claims (budget_id,token,run_id,source_sha,claimed_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM next_audio_budget WHERE id=? AND conversations=0 AND expires_at>?)").bind(NEXT_AUDIO_BUDGET_ID,token,runId,sourceSha,now,NEXT_AUDIO_BUDGET_ID,now).run();
 if(Number(r.meta?.changes)!==1)throw new Error("next_audio_batch_already_claimed_or_unavailable");
 return token;
}
export async function requireNextAudioBatch(db:D1Database, token:string, sourceSha:string,execution?:{runId:string;customerId:string}) {
 const original=await db.prepare("SELECT token FROM next_audio_batch_claims WHERE budget_id=? AND token=? AND source_sha=?").bind(NEXT_AUDIO_BUDGET_ID,token,sourceSha).first<Row>();
 if(original)return null;
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='next_audio_batch_continuations'").first<Row>();
 if(exists&&execution&&/^[1-9][0-9]{0,24}$/.test(execution.runId)&&execution.customerId){
  const row=await db.prepare(NEXT_AUDIO_CONTINUATION_AUTH_SQL).bind(NEXT_AUDIO_BUDGET_ID,token,sourceSha,execution.runId,execution.customerId).first<Row>();
  if(row)return {runId:String(row.run_id),customerId:String(row.customer_id),threadId:row.thread_id===null?null:String(row.thread_id)};
 }
 throw new Error("next_audio_batch_claim_required");
}

/** Speech envelope: <=4 x30s ASR and <=4 x2500 UTF-8 bytes TTS per lease; charge on failed attempts too. */
export async function reserveNextAudioSpeech(db:D1Database,input:{threadId:string;customerId:string;kind:"stt"|"tts"|"brain";units:number;now:number}) {
 if(!isNextAudioThread(input.threadId)||!Number.isSafeInteger(input.units)||input.units<=0||(input.kind==="stt"&&input.units>960000)||(input.kind==="tts"&&input.units>2500)||(input.kind==="brain"&&input.units>1000))throw new Error("next_audio_speech_unit_limit");
 const r=await db.prepare("INSERT INTO next_audio_speech_attempts (id,thread_id,kind,units,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM next_audio_leases WHERE thread_id=? AND customer_id=? AND expires_at>?) AND (SELECT COUNT(*) FROM next_audio_speech_attempts WHERE thread_id=? AND kind=?)<4").bind(crypto.randomUUID(),input.threadId,input.kind,input.units,input.now,input.threadId,input.customerId,input.now,input.threadId,input.kind).run();
 if(Number(r.meta?.changes)!==1)throw new Error("next_audio_speech_budget_or_lease_refused");
}

/** Fixed diagnostic vocabulary only; raw provider/DB errors never enter the HTTP response. */
export class NextAudioReadinessFailure extends Error {
 readonly stage: string;readonly kind: string;
 constructor(stage:string,error:unknown){super('Next audio readiness refused');this.stage=['authentication','customer_schema','voice_schema','budget_schema','rate_evidence','receipt_validation','native_url','native_headers','native_request_base','native_timeout','native_request','native_fetch','native_json','native_hash','budget_provision'].includes(stage)?stage:'unknown';const name=error instanceof Error?error.name:'';const message=error instanceof Error?error.message:'';this.kind=['TypeError','ReferenceError','SyntaxError','RangeError','ProviderResponseTooLarge'].includes(name)?name:message.includes('D1_ERROR')?'D1_ERROR':message.includes('SQLITE_ERROR')?'SQLITE_ERROR':message.includes('Cannot perform I/O on behalf of a different request')?'cross_request_io':message==='next_audio_budget_receipt_already_pinned'?'receipt_already_pinned':message==='next_audio_inclusive_rate_evidence_unproven'?'rate_evidence_invalid':'unexpected';}
}
