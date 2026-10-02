import { isVoiceAllowlisted } from "./voice-call-gate";
import { readBoundedText } from "./provider-response-bounds";
/** Inactive-by-default controls for the one approved $5 synthetic audio test budget. */
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
export const MANAGED_AUDIO_PROFILE = "managed-audio-usd5-v1";
export const MANAGED_AUDIO_THREAD_PREFIX = "THREAD-MANAGED-AUDIO-";
export const MANAGED_AUDIO_CALL_PREFIX = "AIVCALL-MANAGED-AUDIO-";
export const MANAGED_AUDIO_BUDGET_ID = "managed-audio-approved-usd5-20261002";
export const MANAGED_AUDIO_CAP_MICROS = 5_000_000;
export const MANAGED_AUDIO_ATTEMPTS = 6;
export const MANAGED_AUDIO_OUTPUT_TOKENS = 700;
export const MANAGED_AUDIO_MODEL = "gpt-5.6-luna";
export const MANAGED_AUDIO_ATTEMPT_MICROS = 526_260;
export const MANAGED_AUDIO_RATES_EXPIRE_AT = Date.parse("2026-10-03T00:00:00Z");
export const isManagedAudioThread = (id: string) => id.startsWith(MANAGED_AUDIO_THREAD_PREFIX);
export const managedAudioNoSend = (env: Env) => text(env.PAWSPACE_MANAGED_AUDIO_ISOLATION) !== "";
export function assertManagedAudioSendAllowed(env: Env) {
 // Any nonempty value denies sends, including malformed or accidentally production bindings.
 if (managedAudioNoSend(env)) throw new Response("managed_audio_external_send_suppressed", { status: 403 });
}
export async function managedAudioEnvironment(): Promise<Env> {
 try { return (await import("cloudflare:workers")).env as unknown as Env; }
 catch { return (globalThis as typeof globalThis & { __PAWSPACE_TEST_ENV__?: Env }).__PAWSPACE_TEST_ENV__ ?? {}; }
}
export function managedAudioIsolationGates(env: Env) {
 const required = { PAWSPACE_MANAGED_AUDIO_ISOLATION: "no-send-v1", PAWSPACE_DEPLOYMENT_ENV: "staging", FORBID_PRODUCTION: "true", PAWSPACE_VOICE_PHONE_TESTS_PAUSED: "true", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", PAWSPACE_RAZORPAYX_ENV: "sandbox", PAWSPACE_RAZORPAYX_LIVE_APPROVED: "false" };
 return Object.entries(required).filter(([key, value]) => text(env[key]) !== value).map(([key]) => `managed_audio_isolation_unproven:${key}`);
}
export function managedAudioCostBound(durationSeconds: unknown, optionalFeesMicros: unknown, now = Date.now()) {
 const duration = Number(durationSeconds);
 if (!Number.isInteger(duration) || duration < 60 || duration > 600) throw new Error("managed_audio_native_duration_unbounded");
 if (typeof optionalFeesMicros !== "number" || !Number.isSafeInteger(optionalFeesMicros) || optionalFeesMicros < 0) throw new Error("managed_optional_speech_llm_cost_upper_bound_not_attested");
 if (!Number.isFinite(now) || now < Date.parse("2026-10-02T00:00:00Z") || now >= MANAGED_AUDIO_RATES_EXPIRE_AT) throw new Error("managed_audio_rate_evidence_expired");
 const speech = Math.ceil(duration / 60) * 160_000;
 const total = speech + MANAGED_AUDIO_ATTEMPTS * MANAGED_AUDIO_ATTEMPT_MICROS + optionalFeesMicros;
 if (!Number.isSafeInteger(total) || total > MANAGED_AUDIO_CAP_MICROS) throw new Error("managed_audio_budget_insufficient");
 return { speechMicros: speech, modelMicros: MANAGED_AUDIO_ATTEMPTS * MANAGED_AUDIO_ATTEMPT_MICROS, optionalFeesMicros, totalMicros: total };
}
export async function ensureManagedAudioControl(db: D1Database) {
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS managed_audio_test_budget (id TEXT PRIMARY KEY,cap_micros INTEGER NOT NULL CHECK(cap_micros=5000000),reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros BETWEEN 0 AND 5000000))"),
  db.prepare("CREATE TABLE IF NOT EXISTS managed_audio_fee_evidence (id TEXT PRIMARY KEY,agent_config_sha256 TEXT NOT NULL,provider_region TEXT NOT NULL,optional_upper_micros INTEGER,valid_until INTEGER NOT NULL,evidence_reference TEXT NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS managed_audio_test_conversations (thread_id TEXT PRIMARY KEY,call_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,budget_id TEXT NOT NULL,profile TEXT NOT NULL,max_attempts INTEGER NOT NULL CHECK(max_attempts=6),max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens=700),attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 6),reservation_id TEXT NOT NULL UNIQUE,reserved_micros INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("INSERT OR IGNORE INTO managed_audio_test_budget (id,cap_micros,reserved_micros) VALUES (?,5000000,0)").bind(MANAGED_AUDIO_BUDGET_ID),
 ]);
}
export async function managedAudioReadiness(db: D1Database, env: Env, now = Date.now()) {
 const gates = managedAudioIsolationGates(env);
 if (text(env.PAWSPACE_AI_PROVIDER) !== "openai" || text(env.PAWSPACE_AI_VOICE_MODEL) !== MANAGED_AUDIO_MODEL) gates.push("managed_audio_runtime_model_unproven");
 if (now >= MANAGED_AUDIO_RATES_EXPIRE_AT || now < Date.parse("2026-10-02T00:00:00Z")) gates.push("managed_audio_rate_evidence_expired");
 let evidence: Row | null = null;
 try { evidence = await db.prepare("SELECT agent_config_sha256,provider_region,optional_upper_micros,valid_until,evidence_reference FROM managed_audio_fee_evidence WHERE id=?").bind(MANAGED_AUDIO_BUDGET_ID).first<Row>(); }
 catch { gates.push("managed_audio_control_schema_missing"); }
 const region = text(env.ELEVENLABS_API_BASE) || "https://api.in.residency.elevenlabs.io";
 let bound: ReturnType<typeof managedAudioCostBound> | null = null;
 // No HTTP input or environment amount can create this pricing evidence. The table is read-only
 // here; a separately reviewed evidence receipt must be provisioned through the existing route.
 if (!evidence || !/^[a-f0-9]{64}$/.test(text(evidence.agent_config_sha256)) || text(evidence.provider_region) !== region || Number(evidence.valid_until) <= now || !text(evidence.evidence_reference)) {
  gates.push("managed_optional_speech_llm_cost_upper_bound_not_attested");
 } else if (!gates.length) {
  try {
   if (!["https://api.elevenlabs.io", "https://api.in.residency.elevenlabs.io"].includes(region) || !text(env.ELEVENLABS_API_KEY) || !text(env.ELEVENLABS_GROOMING_AGENT_ID)) throw new Error("managed_audio_agent_read_unavailable");
   const response = await fetch(`${region}/v1/convai/agents/${encodeURIComponent(text(env.ELEVENLABS_GROOMING_AGENT_ID))}`, { headers: { "xi-api-key": text(env.ELEVENLABS_API_KEY) }, redirect: "error", signal: AbortSignal.timeout(15_000) });
   if (!response.ok) throw new Error("managed_audio_agent_read_denied");
   const raw = await readBoundedText(response, 512 * 1024);
   const config = JSON.parse(raw) as Row;
   const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config)))), byte => byte.toString(16).padStart(2, "0")).join("");
   if (hash !== evidence.agent_config_sha256) throw new Error("managed_audio_agent_fee_evidence_changed");
   const conversation = config.conversation_config as Row, agent = conversation?.agent as Row, prompt = agent?.prompt as Row, custom = prompt?.custom_llm as Row, tts = conversation?.tts as Row;
   if (text(custom?.url) !== "https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1" || text(tts?.model_id) !== "eleven_v3_conversational") throw new Error("managed_audio_provider_configuration_unproven");
   const duration = (conversation?.conversation as Row)?.max_duration_seconds;
   bound = managedAudioCostBound(duration, evidence.optional_upper_micros, now);
   if (Math.min(Number(evidence.valid_until), MANAGED_AUDIO_RATES_EXPIRE_AT) < now + Number(duration) * 1000) throw new Error("managed_audio_fee_evidence_expires_during_session");
  } catch (error) { gates.push(error instanceof Error ? error.message : "managed_audio_fee_read_unavailable"); }
 }
 return { profile: MANAGED_AUDIO_PROFILE, budgetId: MANAGED_AUDIO_BUDGET_ID, capMicros: MANAGED_AUDIO_CAP_MICROS, maximumAttempts: MANAGED_AUDIO_ATTEMPTS, maximumOutputTokens: MANAGED_AUDIO_OUTPUT_TOKENS, bound, gates: [...new Set(gates)], paidExecutionAllowed: gates.length === 0 && bound !== null };
}
export async function reserveManagedAudioConversation(db: D1Database, input: { threadId: string; callId: string; customerId: string; bound: ReturnType<typeof managedAudioCostBound>; expiresAt: number; now?: number }) {
 const now = input.now ?? Date.now();
 if (!isManagedAudioThread(input.threadId) || !input.callId.startsWith(MANAGED_AUDIO_CALL_PREFIX) || !input.customerId || input.expiresAt <= now || input.expiresAt > Math.min(now + 600_000, MANAGED_AUDIO_RATES_EXPIRE_AT)) throw new Error("managed_audio_identity_or_deadline_invalid");
 // Recompute rather than trusting a caller's total or a client receipt.
 const expected = managedAudioCostBound(input.bound.speechMicros / 160_000 * 60, input.bound.optionalFeesMicros, now);
 if (JSON.stringify(expected) !== JSON.stringify(input.bound)) throw new Error("managed_audio_cost_receipt_invalid");
 const reservationId = crypto.randomUUID();
 const results = await db.batch([
  db.prepare("INSERT INTO managed_audio_test_conversations (thread_id,call_id,customer_id,budget_id,profile,max_attempts,max_output_tokens,attempts_used,reservation_id,reserved_micros,expires_at,created_at) SELECT ?,?,?,?, ?,6,700,0,?,?,?,? WHERE EXISTS (SELECT 1 FROM managed_audio_test_budget WHERE id=? AND cap_micros=5000000 AND reserved_micros+?<=cap_micros)").bind(input.threadId,input.callId,input.customerId,MANAGED_AUDIO_BUDGET_ID,MANAGED_AUDIO_PROFILE,reservationId,expected.totalMicros,input.expiresAt,now,MANAGED_AUDIO_BUDGET_ID,expected.totalMicros),
  db.prepare("UPDATE managed_audio_test_budget SET reserved_micros=reserved_micros+? WHERE id=? AND EXISTS (SELECT 1 FROM managed_audio_test_conversations WHERE thread_id=? AND call_id=? AND reservation_id=?)").bind(expected.totalMicros,MANAGED_AUDIO_BUDGET_ID,input.threadId,input.callId,reservationId),
 ]);
 if (Number(results[0]?.meta?.changes) !== 1 || Number(results[1]?.meta?.changes) !== 1) throw new Error("managed_audio_budget_insufficient");
}
export async function claimManagedAudioAttempt(db: D1Database, env: Env, input: { threadId: string; customerId: string; provider: string; modelRef: string; maxOutputTokens: number; now?: number }) {
 const now = input.now ?? Date.now();
 if (!isManagedAudioThread(input.threadId)) throw new Error("managed_audio_identity_invalid");
 if (managedAudioIsolationGates(env).length || input.provider !== "openai" || input.modelRef !== MANAGED_AUDIO_MODEL || !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > MANAGED_AUDIO_OUTPUT_TOKENS || !Number.isFinite(now) || now < Date.parse("2026-10-02T00:00:00Z") || now >= MANAGED_AUDIO_RATES_EXPIRE_AT) throw new Error("managed_audio_attempt_policy_refused");
 const result = await db.prepare("UPDATE managed_audio_test_conversations SET attempts_used=attempts_used+1 WHERE thread_id=? AND customer_id=? AND profile=? AND budget_id=? AND max_attempts=6 AND max_output_tokens=700 AND attempts_used<6 AND expires_at>? AND EXISTS (SELECT 1 FROM ai_voice_calls c WHERE c.id=managed_audio_test_conversations.call_id AND c.thread_id=managed_audio_test_conversations.thread_id AND c.customer_id=managed_audio_test_conversations.customer_id AND c.status='active')").bind(input.threadId,input.customerId,MANAGED_AUDIO_PROFILE,MANAGED_AUDIO_BUDGET_ID,now).run();
 if (Number(result.meta?.changes) !== 1) throw new Error("managed_audio_attempt_budget_exhausted_or_inactive");
}

/** Admission is independent of model use: deterministic replies must use the same reservation. */
export const MANAGED_AUDIO_ACTIVE_PREDICATE = "EXISTS (SELECT 1 FROM managed_audio_test_conversations m JOIN ai_voice_calls c ON c.id=m.call_id AND c.thread_id=m.thread_id AND c.customer_id=m.customer_id JOIN managed_audio_test_budget b ON b.id=m.budget_id WHERE m.thread_id=? AND m.customer_id=? AND m.profile='managed-audio-usd5-v1' AND m.budget_id='managed-audio-approved-usd5-20261002' AND m.max_attempts=6 AND m.max_output_tokens=700 AND m.reservation_id<>'' AND m.reserved_micros>0 AND m.reserved_micros<=5000000 AND b.cap_micros=5000000 AND b.reserved_micros>=m.reserved_micros AND m.expires_at>? AND c.status='active')";
export async function admitManagedAudioCallback(db: D1Database, env: Env, hints: Row, now = Date.now()) {
 const threadId=text(hints.pawspace_thread_id), customerHint=text(hints.pawspace_customer_id);
 if (!managedAudioNoSend(env) && !isManagedAudioThread(threadId)) return null;
 const refuse=()=>new Response("managed_audio_callback_identity_refused",{status:403});
 if (managedAudioIsolationGates(env).length || !isManagedAudioThread(threadId) || !customerHint || text(hints.pawspace_voice_session_id) || text(hints.pawspace_voice_call_id)) throw refuse();
 let row: Row | null;
 try {
  row=await db.prepare("SELECT t.id AS thread_id,t.customer_id,k.primary_phone FROM communication_threads t JOIN canonical_customers k ON k.id=t.customer_id WHERE t.id=? AND t.customer_id=? AND t.status='open' AND (t.assigned_to IS NULL OR t.assigned_to='' OR t.assigned_to='ai-orchestrator') AND "+MANAGED_AUDIO_ACTIVE_PREDICATE).bind(threadId,customerHint,threadId,customerHint,now).first<Row>();
 } catch { throw refuse(); }
 if (!row || !isVoiceAllowlisted(env,row.primary_phone)) throw refuse();
 return {sessionId:null,threadId:text(row.thread_id),customerId:text(row.customer_id),managedAudio:true};
}
