type Row=Record<string,unknown>;
export const NEXT_AUDIO_CONTINUATION_SCHEMA="CREATE TABLE IF NOT EXISTS next_audio_batch_continuations (budget_id TEXT PRIMARY KEY,parent_run_id TEXT NOT NULL,run_id TEXT NOT NULL,source_sha TEXT NOT NULL,customer_id TEXT NOT NULL,claimed_at INTEGER NOT NULL)";
export const NEXT_AUDIO_CONTINUATION_SQL="INSERT OR IGNORE INTO next_audio_batch_continuations (budget_id,parent_run_id,run_id,source_sha,customer_id,claimed_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM next_audio_batch_claims WHERE budget_id=? AND run_id=? AND source_sha=?) AND EXISTS (SELECT 1 FROM next_audio_budget b JOIN next_audio_rate_evidence e ON e.id=b.id WHERE b.id=? AND b.cap_micros=10000000 AND b.reserved_micros=377600 AND b.conversations=1 AND b.expires_at>? AND b.receipt_json=e.receipt_json AND json_extract(b.receipt_json,'$.sourceSha')=?) AND (SELECT COUNT(*) FROM next_audio_leases WHERE budget_id=?)=1 AND EXISTS (SELECT 1 FROM next_audio_leases l JOIN ai_voice_calls c ON c.thread_id=l.thread_id AND c.customer_id=l.customer_id JOIN communication_threads t ON t.id=l.thread_id AND t.customer_id=l.customer_id WHERE l.budget_id=? AND l.customer_id=? AND l.attempts=0 AND l.expires_at<=? AND c.status='completed' AND c.transport_provider='sandbox_simulator' AND c.consent_status='verified') AND NOT EXISTS (SELECT 1 FROM next_audio_attempts) AND NOT EXISTS (SELECT 1 FROM next_audio_speech_attempts) RETURNING run_id";
export function nextAudioContinuationParams(input:{parentRunId:string;runId:string;sourceSha:string;parentSourceSha:string;customerId:string;now:number},id:string){
 if(!/^[1-9][0-9]{0,24}$/.test(input.parentRunId)||!/^[1-9][0-9]{0,24}$/.test(input.runId)||input.runId===input.parentRunId||![input.sourceSha,input.parentSourceSha].every(s=>/^[a-f0-9]{40}$/.test(s))||input.sourceSha===input.parentSourceSha||!input.customerId||!Number.isSafeInteger(input.now))throw Error('next_audio_continuation_identity_refused');
 return [id,input.parentRunId,input.runId,input.sourceSha,input.customerId,input.now,id,input.parentRunId,input.parentSourceSha,id,input.now,input.sourceSha,id,id,input.customerId,input.now];
}
export async function claimNextAudioContinuation(db:D1Database,input:{parentRunId:string;runId:string;sourceSha:string;parentSourceSha:string;customerId:string;now:number},budgetId:string){
 const params=nextAudioContinuationParams(input,budgetId);
 await db.prepare(NEXT_AUDIO_CONTINUATION_SCHEMA).run();
 const row=await db.prepare(NEXT_AUDIO_CONTINUATION_SQL).bind(...params).first<Row>();
 if(row?.run_id!==input.runId)throw Error('next_audio_continuation_already_claimed_or_unavailable');
 const claim=await db.prepare("SELECT c.token FROM next_audio_batch_claims c JOIN next_audio_batch_continuations r ON r.budget_id=c.budget_id AND r.parent_run_id=c.run_id WHERE c.budget_id=? AND c.run_id=? AND c.source_sha=? AND r.run_id=? AND r.source_sha=? AND r.customer_id=?").bind(budgetId,input.parentRunId,input.parentSourceSha,input.runId,input.sourceSha,input.customerId).first<Row>();
 if(typeof claim?.token!=='string'||!claim.token)throw Error('next_audio_continuation_readback_refused');
 return claim.token;
}
