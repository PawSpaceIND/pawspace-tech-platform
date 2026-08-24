/**
 * IDfy verification callback boundary.
 *
 * WHY THIS EXISTS. `verifyWithIdfy` submits a check and reads whatever the synchronous HTTP response
 * happens to carry. Real IDfy verification is asynchronous: the POST enqueues a task and returns a
 * request_id, and the OUTCOME arrives later on a webhook. Without a callback boundary an automatable
 * check submitted to a live IDfy account could only ever settle as `manual_review` - the tri-state
 * default - so every provider would queue for a human, and the one path that could set `verified`
 * automatically did not exist. There was no route, no signature check, no correlation and no replay
 * protection for the callback IDfy would actually send.
 *
 * SHAPE. Deliberately the same shape as the telephony callback in lib/voice-telephony-provider.ts,
 * because the threat is the same: an endpoint a carrier/provider posts to with no session cookie.
 *
 *   - HMAC-SHA256 over `${timestamp}.${rawBody}` in `x-idfy-signature`, hex, constant-time compared.
 *   - A freshness window on the timestamp, so a captured body cannot be replayed indefinitely.
 *   - IDFY_WEBHOOK_SECRET absent => 503 and NOTHING is accepted. There is no unverified path in.
 *   - Deduplication on the provider's own event id with a UNIQUE index, so a redelivery (providers
 *     retry on any non-2xx) answers 200 and changes no state.
 *
 * WHAT IT DELIBERATELY WILL NOT DO.
 *   - It will not create a verification. A callback may only settle a check that THIS system already
 *     submitted: the correlated row must be automated and must already carry the provider reference
 *     the callback names. No submission, no provider_ref, no settlement - so with IDfy switched off
 *     (provider_ref stays NULL) a callback can never correlate to anything at all.
 *   - It will not touch a manual check. Police/house/pet-proofing outcomes are recorded by a human
 *     through recordManualVerification; letting a webhook write them would collapse the separation
 *     between automated and human verification authority into one forgeable channel.
 *   - It will not invent an outcome. The pass/fail/review mapping is mapStatus() from the submission
 *     adapter, reused rather than restated, so the two channels cannot drift apart.
 */

import { mapStatus } from "./idfy-verification-client";

type Db = D1Database;
type Row = Record<string, unknown>;
type Env = Record<string, unknown> | null | undefined;

export const IDFY_SIGNATURE_HEADER = "x-idfy-signature";
export const IDFY_TIMESTAMP_HEADER = "x-idfy-timestamp";
/** Same window the telephony callback uses. A signature older than this is refused even if it verifies. */
export const IDFY_SIGNATURE_FRESHNESS_MS = 300_000;

/** The two states that represent a decision. Anything else is work still in progress. */
export const TERMINAL_VERIFICATION_STATUSES = ["verified", "failed"];

const text = (value: unknown) => String(value ?? "").trim();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
function safeEqual(a: string, b: string) { if (a.length !== b.length) return false; let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0; }
export async function idfyHmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

export async function ensureIdfyCallbackTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS provider_verification_callbacks (id TEXT PRIMARY KEY,provider_event_id TEXT NOT NULL UNIQUE,provider_ref TEXT NOT NULL,application_id TEXT,verification_type TEXT,outcome TEXT NOT NULL,accepted INTEGER NOT NULL,rejection_reason TEXT,payload_sha256 TEXT NOT NULL,received_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_verification_callbacks_ref ON provider_verification_callbacks(provider_ref)"),
  ]);
}

export type CallbackResult =
  | { accepted: true; status: number; applicationId: string; verificationType: string; outcome: string; duplicate: boolean }
  | { accepted: false; status: number; reason: string };

/**
 * Verify and apply one IDfy callback.
 *
 * `rawBody` is the exact bytes as received. It is what the signature covers, so it must never be
 * re-serialised from a parsed object before verification - a re-serialised body is a different string
 * and would either fail valid signatures or, worse, invite a "parse first, verify later" ordering.
 */
export async function applyIdfyCallback(db: Db, env: Env, input: { rawBody: string; headers: Headers }): Promise<CallbackResult> {
  const secret = text(env?.IDFY_WEBHOOK_SECRET);
  // Fail closed, and say so with 503 rather than 401: the caller is not unauthorised, this deployment
  // simply has no verification channel switched on. A 401 would invite a credential hunt that cannot
  // succeed, and would be indistinguishable from a wrong signature.
  if (!secret) return { accepted: false, status: 503, reason: "IDfy callbacks are not connected (IDFY_WEBHOOK_SECRET not configured)" };

  const signature = text(input.headers.get(IDFY_SIGNATURE_HEADER)), stamp = text(input.headers.get(IDFY_TIMESTAMP_HEADER));
  if (!signature || !stamp) return { accepted: false, status: 401, reason: "Signature and timestamp headers are required" };
  const stampMs = Number(stamp);
  if (!Number.isFinite(stampMs)) return { accepted: false, status: 401, reason: "Signature timestamp is not a number" };
  // Absolute difference, so a timestamp in the FUTURE is as unacceptable as one in the past. Comparing
  // only `now - stamp` would let a far-future timestamp keep one captured body replayable forever.
  if (Math.abs(Date.now() - stampMs) > IDFY_SIGNATURE_FRESHNESS_MS) return { accepted: false, status: 401, reason: "Signature timestamp is outside the freshness window" };
  // The provider signs the exact header value it sent. `${stampMs}` re-serialises Number(stamp), so any
  // non-canonical numeric form the provider might send - "1700000000000.0", "+1700000000000", a leading
  // zero, exponent notation - all pass Number.isFinite and then serialise differently, breaking a
  // legitimate signature and 401-ing a callback that would never settle. stampMs is for freshness only.
  const expected = await idfyHmacHex(secret, `${stamp}.${input.rawBody}`);
  if (!safeEqual(expected, signature)) return { accepted: false, status: 401, reason: "Signature verification failed" };

  // Only now is the body worth parsing.
  let body: Record<string, unknown>;
  try { body = JSON.parse(input.rawBody) as Record<string, unknown>; }
  catch { return { accepted: false, status: 400, reason: "Callback body is not valid JSON" }; }

  const eventId = text(body.event_id || body.id), providerRef = text(body.request_id || body.reference_id);
  if (!eventId) return { accepted: false, status: 400, reason: "Callback event id is required" };
  if (!providerRef) return { accepted: false, status: 400, reason: "Callback provider reference is required" };

  await ensureIdfyCallbackTables(db);
  const payloadHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rawBody)));

  // Replay check BEFORE any mutation. A redelivery is normal - providers retry on any non-2xx - so it
  // answers 200 (stop retrying) and changes nothing.
  // ONLY an accepted record is terminal. Keying this on the event id alone meant a REFUSED delivery
  // poisoned that id: the 404 recorded the event, IDfy retried once the row was readable, and the retry
  // matched here and was answered `{accepted:true, status:200, outcome:"unmatched"}` - so the provider
  // stopped retrying, the response claimed success, and the verification stayed manual_review forever.
  const seen = await db.prepare("SELECT application_id,verification_type,outcome FROM provider_verification_callbacks WHERE provider_event_id=? AND accepted=1").bind(eventId).first<Row>();
  if (seen) return { accepted: true, status: 200, applicationId: text(seen.application_id), verificationType: text(seen.verification_type), outcome: text(seen.outcome), duplicate: true };

  const record = async (outcome: string, accepted: boolean, reason: string | null, appId: string, vType: string) => {
    // provider_event_id is UNIQUE, so INSERT OR IGNORE alone would leave the earlier REFUSED row in
    // place and the accepted=1 replay check above would never match - the retry would settle the
    // verification but every later duplicate would correlate and settle it again. Upserting keeps the
    // one row per event id and makes it describe the delivery that actually took effect.
    await db.prepare("INSERT INTO provider_verification_callbacks (id,provider_event_id,provider_ref,application_id,verification_type,outcome,accepted,rejection_reason,payload_sha256,received_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_event_id) DO UPDATE SET provider_ref=excluded.provider_ref,application_id=excluded.application_id,verification_type=excluded.verification_type,outcome=excluded.outcome,accepted=excluded.accepted,rejection_reason=excluded.rejection_reason,payload_sha256=excluded.payload_sha256,received_at=excluded.received_at")
      .bind(`IDFYCB-${crypto.randomUUID().slice(0, 12).toUpperCase()}`, eventId, providerRef, appId || null, vType || null, outcome, accepted ? 1 : 0, reason, payloadHash, Date.now()).run();
  };

  // Correlation. The row must exist, must be one WE submitted (automated=1 with a provider_ref set by
  // the submission), and its provider_ref must be the one the callback names. An unknown or mismatched
  // reference is refused and recorded - a rejected callback is evidence too, so it is never dropped.
  // No .catch here. Swallowing a read failure into `null` answered a transient D1 error with the same
  // 404 as a genuinely unknown reference; the error must surface so the route answers 5xx and the
  // provider retries.
  const row = await db.prepare("SELECT id,application_id,verification_type,status,automated,provider_ref FROM provider_verifications WHERE provider_ref=?").bind(providerRef).first<Row>();
  if (!row) { await record("unmatched", false, "no_verification_for_provider_reference", "", ""); return { accepted: false, status: 404, reason: "No submitted verification matches this provider reference" }; }
  const applicationId = text(row.application_id), verificationType = text(row.verification_type);
  if (Number(row.automated || 0) !== 1) {
    await record("refused", false, "manual_verification_cannot_be_settled_by_callback", applicationId, verificationType);
    return { accepted: false, status: 409, reason: "Manual verification outcomes are recorded by a human, not by a provider callback" };
  }

  const outcome = mapStatus(body);
  // MONOTONIC. IDfy delivery is asynchronous and unordered, so a callback that merely reports progress
  // can arrive AFTER the one carrying the decision. Applying it unconditionally rewrote a `verified`
  // row back to `manual_review`, and because assignment eligibility requires every mandated check to be
  // `verified`, that silently revoked a provider who had already passed.
  //
  // Only the two decided states are terminal, and both are the provider's own judgement: verified may
  // still become failed (a later revocation) and failed may still become verified (a correction). What
  // may never happen is a NON-decision overwriting a decision. No new status is introduced.
  // ONE atomic conditional UPDATE. The rule lives in the WHERE clause, so there is no window between
  // deciding and writing for a concurrent delivery to slip through: IDfy delivers callbacks in parallel,
  // and read-decide-write let a stale nonterminal delivery commit over a `verified` that landed while it
  // was in flight - measured, from a `pending` start, as canTakeAssignments going true -> false.
  //
  // A terminal outcome may overwrite anything (verified -> failed is a revocation, failed -> verified a
  // correction; both are the provider's own judgement and both were already approved). A NON-decision
  // may only overwrite a row that has not been decided. Same rule as before, expressed where it is
  // enforced atomically rather than in a variable computed from a stale read. No new status.
  // An AND-chain of inequalities rather than a NOT IN list, deliberately. tests/d1-in-clause-fanout
  // forbids assembling an IN list in lib/ because a list built at runtime can outgrow D1's bound
  // parameter cap. This one is a two-element compile-time constant and could not, but the equivalent
  // chain (status is NOT NULL, so the two forms mean the same thing) needs no exemption at all, and
  // stays correct if the constant ever changes.
  const notDecided = TERMINAL_VERIFICATION_STATUSES.map(() => "status<>?").join(" AND ");
  const outcomeIsTerminal = TERMINAL_VERIFICATION_STATUSES.includes(outcome) ? 1 : 0;
  await db.prepare(`UPDATE provider_verifications SET status=?,detail_json=?,updated_by='idfy_callback',updated_at=? WHERE id=? AND (?=1 OR (${notDecided})) AND status!=?`)
    .bind(outcome, JSON.stringify({ via: "idfy_callback", providerRef, eventId }), Date.now(), text(row.id), outcomeIsTerminal, ...TERMINAL_VERIFICATION_STATUSES, outcome).run();

  // What actually stands, read back rather than assumed - `row.status` is now known to be stale. This
  // one value is used for the evidence record, the supersession reason and the returned outcome, so a
  // caller can never be told something the database does not say.
  const effective = text((await db.prepare("SELECT status FROM provider_verifications WHERE id=?").bind(text(row.id)).first<Row>())?.status) || outcome;
  // Recorded either way - a superseded callback is evidence that it arrived and was declined.
  await record(effective, true, effective === outcome ? null : `nonterminal_${outcome}_ignored_after_${effective}`, applicationId, verificationType);
  return { accepted: true, status: 200, applicationId, verificationType, outcome: effective, duplicate: false };
}
