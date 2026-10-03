import { hmac } from "./verified-identity-assertion";
import { constantTimeEqual, randomVerifierSalt, secureSixDigitOtp } from "./security-crypto";
import { findIdentityBinding } from "./identity-binding";
import { securityAudit, type AuthenticatedActor } from "./server-auth";
import { loadServiceStartOtpRuntime, serviceStartOtpExpiry, type ServiceStartOtpPolicy } from "./service-start-otp-policy";

/**
 * Service-start customer OTP.
 *
 * A customer issues a one-time code for ONE of their own bookings. The code is bound at issue time to
 * that booking, that customer and the provider currently assigned through the work order. Only that
 * provider, signed in through a verified provider session, can verify it, and only once. A successful
 * verification yields a CONSENT ARTIFACT: a record that the customer authorised this provider to start
 * this booking's service. It is deliberately NOT a lifecycle transition and does not claim the service
 * started; wiring it into the per-service start actions is a separate step owned by those lifecycles.
 *
 * Secret handling mirrors the login OTP runtimes: only a salted HMAC of the code is stored, the hash is
 * compared in constant time, the verifier is erased once the challenge leaves the issued state, and the
 * code appears nowhere but the issuing customer's own response. Nothing here logs.
 *
 * Every threshold comes from lib/service-start-otp-policy.ts, which has no defaults and refuses
 * production outright.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
type Runtime = Record<string, unknown>;
type SubjectType = "customer" | "provider";
export type ServiceStartChallengeState = "issued" | "verified" | "superseded" | "exhausted" | "expired";

export class ServiceStartOtpRefusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) { super(message); this.name = "ServiceStartOtpRefusal"; this.status = status; this.code = code; }
}

export type ServiceStartConsentArtifact = {
  kind: "service_start_customer_consent";
  consentId: string;
  bookingId: string;
  serviceCode: string;
  customerId: string;
  providerId: string;
  challengeId: string;
  issueSequence: number;
  verifiedAt: number;
  verifiedBy: string;
  /** Always false: this artifact proves consent, never that the service started. */
  serviceStarted: false;
  lifecycleIntegration: "not_applied";
};

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const CODE_SHAPE = /^\d{6}$/;

function refuse(message: string, status: number, code: string): never { throw new ServiceStartOtpRefusal(message, status, code); }
function constraintViolation(error: unknown) { return /UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error ?? "")); }

const tablesReady = new WeakSet<object>();
export async function ensureServiceStartOtpTables(db: Db) {
  if (tablesReady.has(db)) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_start_otp_challenges (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,issue_sequence INTEGER NOT NULL,service_code TEXT NOT NULL,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,booking_status_at_issue TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'issued',attempts INTEGER NOT NULL DEFAULT 0,verifier_salt TEXT,verifier_hash TEXT,issued_by TEXT NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,closed_at INTEGER,verified_at INTEGER,verified_by TEXT,consent_id TEXT,UNIQUE(booking_id,issue_sequence))"),
    // At most one live challenge per booking, enforced by the database rather than by a read.
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_service_start_otp_active ON service_start_otp_challenges(booking_id) WHERE status='issued'"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_start_otp_booking ON service_start_otp_challenges(booking_id,issue_sequence)"),
    db.prepare("CREATE TABLE IF NOT EXISTS service_start_otp_action_keys (idempotency_key TEXT PRIMARY KEY,booking_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
  tablesReady.add(db);
}

function verifier(secret: string, challengeId: string, salt: string, code: string) {
  return hmac(`service-start-otp-v1:${challengeId}:${salt}:${code}`, secret);
}

/**
 * The verified subject behind the session, with no bypass of any kind: a development preview
 * superuser, a staff identity, or a session of the other subject type is refused outright. The binding
 * is re-read so a session that outlived a revoked binding cannot act.
 */
async function boundSubject(db: Db, actor: AuthenticatedActor, subjectType: SubjectType) {
  if (actor.developmentPreview || actor.subjectType !== subjectType) refuse(`A verified ${subjectType} session is required`, 403, `${subjectType}_session_required`);
  const binding = await findIdentityBinding(db, { identitySource: actor.identitySource, principalType: actor.principalType, principalKey: actor.principalKey, subjectType });
  const subjectId = text(binding?.subject_id);
  if (!subjectId) refuse(`A verified ${subjectType} session is required`, 403, `${subjectType}_session_required`);
  return subjectId;
}

type BookingBinding = { bookingId: string; customerId: string; serviceCode: string; status: string; providerId: string };

/** The booking with the provider its work order assigns; the assignment is what a code binds to. */
async function bookingBinding(db: Db, bookingId: string): Promise<BookingBinding | null> {
  const row = await db.prepare("SELECT b.id,b.customer_id,b.service_code,b.status,w.provider_id work_order_provider_id FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id WHERE b.id=?").bind(bookingId).first<Row>();
  if (!row) return null;
  return { bookingId: text(row.id), customerId: text(row.customer_id), serviceCode: text(row.service_code).toLowerCase(), status: text(row.status).toLowerCase(), providerId: text(row.work_order_provider_id) };
}

async function activeChallenge(db: Db, bookingId: string) {
  return db.prepare("SELECT * FROM service_start_otp_challenges WHERE booking_id=? AND status='issued'").bind(bookingId).first<Row>();
}

export type IssueInput = { request: Request; runtime: Runtime; actor: AuthenticatedActor; bookingId: string; now?: number };

export async function issueServiceStartOtp(db: Db, input: IssueInput) {
  const { policy, secret } = loadServiceStartOtpRuntime(input.request, input.runtime);
  const bookingId = text(input.bookingId);
  if (!bookingId) refuse("Booking ID is required", 400, "booking_required");
  await ensureServiceStartOtpTables(db);
  const customerId = await boundSubject(db, input.actor, "customer");
  const booking = await bookingBinding(db, bookingId);
  if (!booking || booking.customerId !== customerId) refuse("Booking not found for this customer", 404, "booking_not_owned");
  if (!policy.services.has(booking.serviceCode)) refuse("Service-start OTP is not enabled for this service", 409, "service_not_enabled");
  if (!policy.eligibleStatuses.has(booking.status)) refuse(`A service-start code cannot be issued while the booking is ${booking.status}`, 409, "booking_status_ineligible");
  if (!booking.providerId) refuse("No provider is assigned to this booking yet", 409, "provider_not_assigned");

  const now = input.now ?? Date.now();
  const used = await db.prepare("SELECT COALESCE(MAX(issue_sequence),0) last FROM service_start_otp_challenges WHERE booking_id=?").bind(bookingId).first<Row>();
  const issueSequence = Number(used?.last ?? 0) + 1;
  if (issueSequence > policy.maxIssuesPerBooking) refuse("The service-start code reissue limit for this booking has been reached", 429, "reissue_limit_reached");

  const expiresAt = serviceStartOtpExpiry(now, policy);
  const code = secureSixDigitOtp(), challengeId = uid("SSOTP"), salt = randomVerifierSalt(), hash = await verifier(secret, challengeId, salt, code);
  try {
    // One batch: the previous live code is retired and the new one written together, or neither is.
    // UNIQUE(booking_id,issue_sequence) and the partial active index make a racing issuer lose here.
    await db.batch([
      db.prepare("UPDATE service_start_otp_challenges SET status='superseded',verifier_salt=NULL,verifier_hash=NULL,closed_at=? WHERE booking_id=? AND status='issued'").bind(now, bookingId),
      db.prepare("INSERT INTO service_start_otp_challenges (id,booking_id,issue_sequence,service_code,customer_id,provider_id,booking_status_at_issue,status,attempts,verifier_salt,verifier_hash,issued_by,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,'issued',0,?,?,?,?,?)")
        .bind(challengeId, bookingId, issueSequence, booking.serviceCode, booking.customerId, booking.providerId, booking.status, salt, hash, input.actor.email, now, expiresAt),
    ]);
  } catch (error) {
    if (constraintViolation(error)) refuse("Another service-start code was issued for this booking at the same time", 409, "issue_conflict");
    throw error;
  }
  await securityAudit(db, input.actor, "service_start_otp.issue", "canonical_booking", bookingId, "completed", { challengeId, issueSequence, serviceCode: booking.serviceCode, providerId: booking.providerId, expiresAt });
  return {
    challengeId, bookingId, serviceCode: booking.serviceCode, providerId: booking.providerId, issueSequence,
    issuedAt: now, expiresAt, expiresInSeconds: policy.ttlSeconds, attemptsAllowed: policy.maxAttempts,
    issuesRemaining: policy.maxIssuesPerBooking - issueSequence,
    // The code's only channel: the issuing customer's own authenticated response, and only in the
    // non-production sandbox the policy gate admits. No delivery adapter exists for it.
    codeDelivery: "customer_session_test_only" as const,
    code,
  };
}

type ClaimInput = { policy: ServiceStartOtpPolicy; challengeId: string; bookingId: string; customerId: string; providerId: string; serviceCode: string; actorId: string; consentId: string; idempotencyKey: string; artifact: ServiceStartConsentArtifact; now: number };

/**
 * The single-use claim and the idempotency-key reservation in ONE D1 batch, which D1 runs as a
 * transaction: both land or neither does.
 *
 *   1. UPDATE moves the challenge to verified only while every guard in its WHERE still holds.
 *   2. INSERT ... SELECT writes the key row only if statement 1 actually produced the verified row
 *      with this consent id, so a drifted or already-used challenge reserves no key.
 *
 * A key another booking (or another provider) already holds makes statement 2 violate the PRIMARY
 * KEY, which fails the batch and rolls statement 1 back: the loser's challenge stays issued and no
 * consent exists for it. Refusing AFTER an irreversible claim, or catching the violation once the
 * claim has committed, would leave an unkeyed consent behind; that is the defect this shape rules out.
 *
 * Returns "claimed" (both rows written), "unclaimed" (nothing written) or "key_taken" (nothing written).
 */
async function claimChallenge(db: Db, c: ClaimInput): Promise<"claimed" | "unclaimed" | "key_taken"> {
  const statuses = [...c.policy.eligibleStatuses], services = [...c.policy.services];
  const claim = db.prepare(
    "UPDATE service_start_otp_challenges SET status='verified',verified_at=?,verified_by=?,consent_id=?,verifier_salt=NULL,verifier_hash=NULL,closed_at=? " +
    "WHERE id=? AND booking_id=? AND status='issued' AND attempts<? AND expires_at>=? AND customer_id=? AND provider_id=? AND service_code=? " +
    "AND EXISTS (SELECT 1 FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id WHERE b.id=? AND b.customer_id=? AND w.provider_id=? " +
    `AND LOWER(b.service_code)=? AND LOWER(b.service_code) IN (SELECT value FROM json_each(?)) AND LOWER(b.status) IN (SELECT value FROM json_each(?)))`,
  ).bind(c.now, c.actorId, c.consentId, c.now, c.challengeId, c.bookingId, c.policy.maxAttempts, c.now, c.customerId, c.providerId, c.serviceCode, c.bookingId, c.customerId, c.providerId, c.serviceCode, JSON.stringify(services), JSON.stringify(statuses));
  const reserve = db.prepare(
    "INSERT INTO service_start_otp_action_keys (idempotency_key,booking_id,actor_id,action,result_json,created_at) SELECT ?,?,?,'verify',?,? FROM service_start_otp_challenges WHERE id=? AND status='verified' AND consent_id=?",
  ).bind(c.idempotencyKey, c.bookingId, c.actorId, JSON.stringify(c.artifact), c.now, c.challengeId, c.consentId);
  let results: D1Result[];
  try { results = await db.batch([claim, reserve]); }
  catch (error) { if (constraintViolation(error)) return "key_taken"; throw error; }
  const claimed = Number(results[0]?.meta?.changes) === 1, reserved = Number(results[1]?.meta?.changes) === 1;
  if (claimed !== reserved) throw new Error("service-start OTP claim/reservation invariant violated");
  return claimed ? "claimed" : "unclaimed";
}

export type VerifyInput = { request: Request; runtime: Runtime; actor: AuthenticatedActor; bookingId: string; code: string; idempotencyKey: string; now?: number };

export async function verifyServiceStartOtp(db: Db, input: VerifyInput): Promise<ServiceStartConsentArtifact & { replayed: boolean }> {
  const { policy, secret } = loadServiceStartOtpRuntime(input.request, input.runtime);
  const bookingId = text(input.bookingId), idempotencyKey = text(input.idempotencyKey), code = text(input.code);
  if (!bookingId) refuse("Booking ID is required", 400, "booking_required");
  if (!idempotencyKey || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) refuse("An idempotency key of at most 128 characters is required", 400, "idempotency_key_required");
  if (!CODE_SHAPE.test(code)) refuse("A six-digit service-start code is required", 400, "code_shape_invalid");
  await ensureServiceStartOtpTables(db);
  const providerId = await boundSubject(db, input.actor, "provider");
  const actorId = input.actor.email;

  const prior = await db.prepare("SELECT booking_id,actor_id,result_json FROM service_start_otp_action_keys WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) {
    if (text(prior.booking_id) !== bookingId || text(prior.actor_id) !== actorId) refuse("This idempotency key was already used for a different booking or provider", 409, "idempotency_key_conflict");
    return { ...(JSON.parse(String(prior.result_json)) as ServiceStartConsentArtifact), replayed: true };
  }

  const booking = await bookingBinding(db, bookingId);
  if (!booking) refuse("Booking not found", 404, "booking_not_found");
  if (!booking.providerId || booking.providerId !== providerId) refuse("You are not the provider assigned to this booking", 403, "provider_not_assigned");
  if (!policy.services.has(booking.serviceCode)) refuse("Service-start OTP is not enabled for this service", 409, "service_not_enabled");
  // A NEW consent needs the booking to be eligible right now, not only when the code was issued: a
  // cancelled or completed booking cannot acquire fresh consent. (The historical replay above is
  // deliberately exempt: it returns the consent that was recorded, it does not create one.)
  if (!policy.eligibleStatuses.has(booking.status)) refuse(`A service-start code cannot be verified while the booking is ${booking.status}`, 409, "booking_status_ineligible");

  const now = input.now ?? Date.now();
  const challenge = await activeChallenge(db, bookingId);
  if (!challenge) refuse("There is no active service-start code for this booking; ask the customer to issue one", 409, "no_active_challenge");
  const challengeId = text(challenge.id);
  if (text(challenge.provider_id) !== providerId || text(challenge.customer_id) !== booking.customerId) {
    refuse("The active service-start code was issued for a different provider or customer; the customer must issue a new one", 409, "challenge_binding_mismatch");
  }
  if (now > Number(challenge.expires_at)) {
    await db.prepare("UPDATE service_start_otp_challenges SET status='expired',verifier_salt=NULL,verifier_hash=NULL,closed_at=? WHERE id=? AND status='issued'").bind(now, challengeId).run();
    await securityAudit(db, input.actor, "service_start_otp.verify", "canonical_booking", bookingId, "rejected", { challengeId, reason: "expired" });
    refuse("The service-start code has expired; ask the customer to issue a new one", 410, "challenge_expired");
  }
  if (Number(challenge.attempts) >= policy.maxAttempts) refuse("Too many incorrect attempts; ask the customer to issue a new code", 429, "attempts_exhausted");

  const salt = text(challenge.verifier_salt), stored = text(challenge.verifier_hash);
  if (!salt || !stored) refuse("The service-start code is no longer valid; ask the customer to issue a new one", 409, "challenge_invalid");
  const candidate = await verifier(secret, challengeId, salt, code);
  if (!constantTimeEqual(stored, candidate)) {
    const counted = await db.prepare("UPDATE service_start_otp_challenges SET attempts=attempts+1 WHERE id=? AND status='issued' AND attempts<?").bind(challengeId, policy.maxAttempts).run();
    if (!Number(counted.meta.changes)) refuse("The service-start code is no longer active", 409, "challenge_conflict");
    const exhausted = await db.prepare("UPDATE service_start_otp_challenges SET status='exhausted',verifier_salt=NULL,verifier_hash=NULL,closed_at=? WHERE id=? AND status='issued' AND attempts>=?").bind(now, challengeId, policy.maxAttempts).run();
    const attempt = Number(challenge.attempts) + 1;
    await securityAudit(db, input.actor, "service_start_otp.verify", "canonical_booking", bookingId, "rejected", { challengeId, reason: Number(exhausted.meta.changes) ? "attempts_exhausted" : "incorrect_code", attempt });
    if (Number(exhausted.meta.changes)) refuse("Too many incorrect attempts; ask the customer to issue a new code", 429, "attempts_exhausted");
    refuse("Incorrect service-start code", 401, "incorrect_code");
  }

  const consentId = uid("SSC");
  const artifact: ServiceStartConsentArtifact = {
    kind: "service_start_customer_consent", consentId, bookingId, serviceCode: booking.serviceCode, customerId: booking.customerId, providerId, challengeId,
    issueSequence: Number(challenge.issue_sequence), verifiedAt: now, verifiedBy: actorId, serviceStarted: false, lifecycleIntegration: "not_applied",
  };
  // The single-use claim and the key reservation, together and atomically (see claimChallenge). A
  // replay, a competing verify, a late expiry, an attempt that landed in between, a booking that
  // drifted while the HMAC ran, or a key another booking took in that same window all lose here with
  // nothing written.
  const outcome = await claimChallenge(db, { policy, challengeId, bookingId, customerId: booking.customerId, providerId, serviceCode: booking.serviceCode, actorId, consentId, idempotencyKey, artifact, now });
  if (outcome === "key_taken") {
    await securityAudit(db, input.actor, "service_start_otp.verify", "canonical_booking", bookingId, "rejected", { challengeId, reason: "idempotency_key_conflict" });
    refuse("This idempotency key was already used for a different booking or provider", 409, "idempotency_key_conflict");
  }
  if (outcome === "unclaimed") {
    const current = await db.prepare("SELECT status FROM service_start_otp_challenges WHERE id=?").bind(challengeId).first<Row>();
    if (text(current?.status) !== "issued") refuse("The service-start code was already used or is no longer active", 409, "challenge_already_used");
    await securityAudit(db, input.actor, "service_start_otp.verify", "canonical_booking", bookingId, "rejected", { challengeId, reason: "booking_drift" });
    refuse("The booking changed while the code was being verified; check its current state and ask the customer to issue a new code if it is still due to start", 409, "booking_drift");
  }
  await securityAudit(db, input.actor, "service_start_otp.verify", "canonical_booking", bookingId, "completed", { challengeId, consentId, issueSequence: artifact.issueSequence, serviceStarted: false });
  return { ...artifact, replayed: false };
}

export type StatusInput = { request: Request; runtime: Runtime; actor: AuthenticatedActor; bookingId: string; now?: number };

/** What either party may see: state and timing, never the code, its hash or its salt. */
export async function readServiceStartOtpStatus(db: Db, input: StatusInput) {
  const { policy } = loadServiceStartOtpRuntime(input.request, input.runtime);
  const bookingId = text(input.bookingId);
  if (!bookingId) refuse("Booking ID is required", 400, "booking_required");
  await ensureServiceStartOtpTables(db);
  const subjectType: SubjectType | null = input.actor.subjectType === "customer" ? "customer" : input.actor.subjectType === "provider" ? "provider" : null;
  if (!subjectType) refuse("A verified customer or provider session is required", 403, "session_required");
  const subjectId = await boundSubject(db, input.actor, subjectType);
  const booking = await bookingBinding(db, bookingId);
  const owned = booking && (subjectType === "customer" ? booking.customerId === subjectId : Boolean(booking.providerId) && booking.providerId === subjectId);
  if (!owned) refuse("Booking not found for this session", 404, "booking_not_owned");

  const now = input.now ?? Date.now();
  const latest = await db.prepare("SELECT id,issue_sequence,status,attempts,provider_id,issued_at,expires_at,verified_at,consent_id FROM service_start_otp_challenges WHERE booking_id=? ORDER BY issue_sequence DESC LIMIT 1").bind(bookingId).first<Row>();
  const state: ServiceStartChallengeState | "none" = !latest ? "none" : text(latest.status) === "issued" && now > Number(latest.expires_at) ? "expired" : (text(latest.status) as ServiceStartChallengeState);
  return {
    bookingId, serviceCode: booking.serviceCode, viewer: subjectType, state,
    challengeId: latest ? text(latest.id) : null,
    issueSequence: latest ? Number(latest.issue_sequence) : 0,
    issuesAllowed: policy.maxIssuesPerBooking,
    issuedAt: latest ? Number(latest.issued_at) : null,
    expiresAt: latest ? Number(latest.expires_at) : null,
    // Only the customer, who holds the code, learns how many tries their provider has left.
    attemptsRemaining: subjectType === "customer" && state === "issued" ? Math.max(0, policy.maxAttempts - Number(latest!.attempts)) : null,
    consent: state === "verified" ? { consentId: text(latest!.consent_id), providerId: text(latest!.provider_id), verifiedAt: Number(latest!.verified_at), serviceStarted: false as const, lifecycleIntegration: "not_applied" as const } : null,
  };
}
