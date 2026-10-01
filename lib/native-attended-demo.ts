import { voiceAllowlist, normalisedDialKey, telephonyCredentialsConfigured, statusCallbackUrl } from "./voice-call-gate";
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
type Actor = { email: string; permissions: string[] };
const text = (x: unknown) => String(x ?? "").trim();
const refused = () => new Response("Native attended demo admission refused", { status: 403 });
export const NATIVE_DEMO_CALL_PREFIX = "NDEMO-";
export const isNativeDemoThread = (threadId: string) => threadId.startsWith("THREAD-VOICE-NDEMO-");
export async function assertNativeDemoBusinessAllowed(_db: D1Database, threadId: string) {
 // The immutable call/thread namespace is the durable deny marker. Deleting, expiring or revoking
 // a grant must never restore authority to execute a previously informational demo conversation.
 if (isNativeDemoThread(threadId)) throw new Response("This attended demo cannot create or change bookings, reservations or payments", { status: 403 });
}
async function hash(value: string) {
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
function environment(env: Env) {
 const version = text((env.PAWSPACE_VERSION_METADATA as Row | undefined)?.id);
 if (text(env.PAWSPACE_DEPLOYMENT_ENV) !== "staging" || text(env.PAWSPACE_PAYMENT_ENV) !== "sandbox"
  || text(env.FORBID_PRODUCTION) !== "true" || text(env.PAWSPACE_VOICE_PHONE_TESTS_PAUSED) !== "true"
  || text(env.PAWSPACE_VOICE_ENV) !== "disabled" || !/^[a-f0-9]{40}$/.test(text(env.PAWSPACE_STAGING_BUILD_SHA))
  || !text(env.PAWSPACE_NATIVE_DEMO_DATABASE_ID) || !version || !telephonyCredentialsConfigured(env)
  || !statusCallbackUrl(env) || typeof (env.AI as {run?:unknown} | undefined)?.run !== "function") throw refused();
 try { const stream = new URL(text(env.PAWSPACE_VOICE_STREAM_URL)); if (stream.protocol !== "wss:" || stream.pathname !== "/voice/exotel/agentstream") throw refused(); } catch { throw refused(); }
 return { release: text(env.PAWSPACE_STAGING_BUILD_SHA), database: text(env.PAWSPACE_NATIVE_DEMO_DATABASE_ID), version };
}
export async function claimNativeAttendedDemo(db: D1Database, env: Env, input: { grantId: string; token: string; actor: Actor; customerId: string; phone: string }) {
 try {
 const scope = environment(env), list = voiceAllowlist(env), phone = normalisedDialKey(input.phone);
 if (!input.actor.email || !["settings.manage", "customers.manage", "communications.call"].every(p => input.actor.permissions.includes("*") || input.actor.permissions.includes(p))
  || list.length !== 1 || list[0] !== phone || input.token.length < 32 || input.token.length > 256) throw refused();
 const now = Date.now(), callId = NATIVE_DEMO_CALL_PREFIX + crypto.randomUUID().toUpperCase();
 const tokenHash = await hash(input.token), recipientHash = await hash(phone);
 // Single atomic compare-and-consume; a trigger writes the claim audit in the same transaction.
 // No release operation exists: provider failure or uncertain acceptance consumes the attempt.
 const claimed = await db.prepare("UPDATE native_attended_demo_grants SET state='claimed',call_id=?,claimed_at=? WHERE id=? AND token_hash=? AND actor_id=? AND customer_id=? AND recipient_hash=? AND release_sha=? AND database_id=? AND version_id=? AND state='ready' AND issued_at<=? AND expires_at>? AND expires_at-issued_at<=60000 RETURNING call_id")
  .bind(callId, now, input.grantId, tokenHash, input.actor.email, input.customerId, recipientHash, scope.release, scope.database, scope.version, now, now).first<Row>();
 if (!claimed) throw refused();
 return { callId, phoneKey: phone, customerId: input.customerId, expiresAt: now + 300_000 };
 } catch(error) {
  // Refusals are audited only against an existing opaque grant; tokens and recipient data never enter audit.
  await db.prepare("INSERT INTO native_attended_demo_audit(grant_id,call_id,event,created_at) SELECT id,call_id,'refused',? FROM native_attended_demo_grants WHERE id=?").bind(Date.now(),input.grantId).run().catch(()=>{});
  throw error;
 }
}
export async function auditNativeAttendedDemo(db: D1Database, callId: string, event: "refused" | "provider_submitted" | "provider_accepted" | "provider_unknown" | "stream_started" | "ended") {
 await db.prepare("INSERT INTO native_attended_demo_audit(grant_id,call_id,event,created_at) SELECT id,call_id,?,? FROM native_attended_demo_grants WHERE call_id=?").bind(event, Date.now(), callId).run();
}
export async function assertNativeDemoSession(db: D1Database, env: Env, callId: string, customerId: string, claimStream = false) {
 if (!callId.startsWith(NATIVE_DEMO_CALL_PREFIX)) return null;
 const scope = environment(env), now = Date.now();
 const row = await db.prepare("SELECT claimed_at,recipient_hash FROM native_attended_demo_grants WHERE call_id=? AND customer_id=? AND state='claimed' AND release_sha=? AND database_id=? AND version_id=? AND claimed_at>? AND claimed_at<=?")
 .bind(callId, customerId, scope.release, scope.database, scope.version, now - 300_000, now).first<Row>();
 if (!row || voiceAllowlist(env).length !== 1 || row.recipient_hash !== await hash(voiceAllowlist(env)[0])) throw refused();
 if (claimStream) {
  const claimed = await db.prepare("UPDATE native_attended_demo_grants SET stream_claimed_at=? WHERE call_id=? AND state='claimed' AND stream_claimed_at IS NULL AND claimed_at>? RETURNING call_id").bind(now, callId, now - 300_000).first<Row>();
  if (!claimed) throw refused();
  await auditNativeAttendedDemo(db,callId,"stream_started");
 }
 return Number(row.claimed_at) + 300_000;
}
async function streamKey(env: Env) {
 return crypto.subtle.importKey("raw",new TextEncoder().encode(text(env.EXOTEL_WEBHOOK_SECRET)),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
}
const streamMessage=(callId:string,expiresAt:number,env:Env)=>new TextEncoder().encode(`native-attended-stream:${callId}:${expiresAt}:${text(env.PAWSPACE_STAGING_BUILD_SHA)}:${text((env.PAWSPACE_VERSION_METADATA as Row | undefined)?.id)}`);
export async function nativeAttendedStreamUrl(env:Env,admitted:{callId:string;expiresAt:number}) {
 environment(env);
 const signature=new Uint8Array(await crypto.subtle.sign("HMAC",await streamKey(env),streamMessage(admitted.callId,admitted.expiresAt,env)));
 const url=new URL(text(env.PAWSPACE_VOICE_STREAM_URL));url.searchParams.set("demo",admitted.callId);url.searchParams.set("expires",String(admitted.expiresAt));url.searchParams.set("signature",Array.from(signature,b=>b.toString(16).padStart(2,"0")).join(""));return url.toString();
}
export async function verifyNativeDemoStreamTicket(db:D1Database,env:Env,request:Request) {
 const url=new URL(request.url),callId=text(url.searchParams.get("demo"));if(!callId)return null;
 environment(env);
 const expiresAt=Number(url.searchParams.get("expires")),signature=text(url.searchParams.get("signature"));
 if(!callId.startsWith(NATIVE_DEMO_CALL_PREFIX)||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+300_000||! /^[a-f0-9]{64}$/.test(signature))throw refused();
 const bytes=Uint8Array.from(signature.match(/../g)!,part=>parseInt(part,16));
 if(!await crypto.subtle.verify("HMAC",await streamKey(env),bytes,streamMessage(callId,expiresAt,env)))throw refused();
 const grant=await db.prepare("SELECT customer_id,claimed_at FROM native_attended_demo_grants WHERE call_id=? AND state='claimed'").bind(callId).first<Row>();
 if(!grant||Number(grant.claimed_at)+300_000!==expiresAt)throw refused();
 await assertNativeDemoSession(db,env,callId,text(grant.customer_id));return callId;
}
