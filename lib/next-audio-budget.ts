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
export async function reserveNextAudioLease(db: D1Database, input: { threadId: string; customerId: string; sourceSha: string; agentConfigSha256: string; providerHardDurationSeconds: number; now: number }) {
 if (!isNextAudioThread(input.threadId) || !input.customerId || !positive(input.providerHardDurationSeconds) || input.providerHardDurationSeconds > 120) throw new Error("next_audio_identity_or_native_duration_invalid");
 const row = await db.prepare("SELECT receipt_json FROM next_audio_budget WHERE id=?").bind(NEXT_AUDIO_BUDGET_ID).first<Row>();
 if (!row) throw new Error("next_audio_rate_receipt_missing");
 const r = JSON.parse(String(row.receipt_json)) as AudioRateReceipt;
 validateAudioRateReceipt(r, input.now);
 const deadline = input.now + input.providerHardDurationSeconds * 1000;
 if (r.sourceSha !== input.sourceSha || r.agentConfigSha256 !== input.agentConfigSha256 || deadline >= r.validUntil) throw new Error("next_audio_revision_configuration_or_expiry_mismatch");
 const nativeBound = Math.ceil(input.providerHardDurationSeconds / 60 * r.nativeMicrosPerMinute);
 if (!positive(nativeBound)) throw new Error("next_audio_native_bound_invalid");
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
export async function requireNextAudioBatch(db:D1Database, token:string, sourceSha:string) {
 const row=await db.prepare("SELECT token FROM next_audio_batch_claims WHERE budget_id=? AND token=? AND source_sha=?").bind(NEXT_AUDIO_BUDGET_ID,token,sourceSha).first<Row>();
 if(!row)throw new Error("next_audio_batch_claim_required");
}
