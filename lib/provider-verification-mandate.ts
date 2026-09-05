/**
 * Per-category provider verification mandate + orchestration. Defines WHICH checks each provider
 * category must clear before it can take assignments, runs the automatable ones through IDfy, and tracks
 * the manual ones (police / house / pet-proofing) as agent-recorded outcomes. A provider becomes
 * assignment-eligible only when EVERY mandated check for its category is verified.
 *
 * Default mandates (configurable): groomer → Aadhaar+PAN; sitter → Aadhaar+PAN+address;
 * trainer → Aadhaar+PAN+police; host → Aadhaar+PAN+house+pet-proofing photo. Fail-closed: with IDfy not
 * connected, automatable checks sit 'pending' (never auto-pass); manual checks await a human. Cold-DB safe.
 */

import { idfyConfigured, verifyWithIdfy } from "./idfy-verification-client";

type Db = D1Database;
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });

export type VerificationType = { code: string; label: string; automatable: boolean };
export const VERIFICATION_TYPES: VerificationType[] = [
  { code: "aadhaar", label: "Aadhaar", automatable: true },
  { code: "pan", label: "PAN", automatable: true },
  { code: "address", label: "Address", automatable: true },
  { code: "police_verification", label: "Police verification", automatable: false },
  { code: "house_verification", label: "House / facility verification", automatable: false },
  { code: "pet_proofing_photo", label: "Pet-proofing photo", automatable: false },
  /*
   * The checks the approved Dog Walking and Pet Taxi requirements name. [PTJA-W1-F53]
   *
   * `automatable` is what IDfy can decide on its own; everything else waits for a human. Vehicle
   * documents and the two trainings are deliberately manual - a licence photo that matches a name is
   * not the same fact as a licence that is valid, and an induction is something a person signs off.
   * "Government photo ID" is NOT added here: that is the existing `aadhaar` check, and a second name
   * for the same evidence would mean two records of one fact.
   */
  { code: "selfie_liveness", label: "Selfie / liveness and identity match", automatable: true },
  { code: "references_background", label: "References / background screening", automatable: false },
  { code: "driving_licence", label: "Driving licence", automatable: true },
  { code: "vehicle_registration", label: "Vehicle registration", automatable: true },
  { code: "vehicle_insurance", label: "Vehicle insurance", automatable: false },
  { code: "vehicle_fitness_pollution", label: "Pollution / fitness documents", automatable: false },
  { code: "bank_kyc", label: "Bank account / KYC", automatable: true },
  { code: "pet_handling_induction", label: "Pet-handling induction", automatable: false },
  { code: "emergency_safety_training", label: "Emergency and safety training", automatable: false },
];
const typeByCode = (c: string) => VERIFICATION_TYPES.find(t => t.code === c) || null;
/*
 * dog_walker and pet_taxi_driver were missing, and setCategoryMandate refused every category outside the
 * four above - so there was no way to require Aadhaar of a dog walker at all, let alone a police check
 * of someone who takes sole physical custody of an animal and drives it away. [PTJA-W1-F53]
 */
export const PROVIDER_CATEGORIES = ["groomer", "pet_sitter", "trainer", "host", "dog_walker", "pet_taxi_driver"];

/** The two outcomes that are a DECISION about a check. Kept identical to TERMINAL_VERIFICATION_STATUSES
 *  in lib/idfy-callback-boundary.ts, which enforces the same rule on the callback path. */
const TERMINAL_VERIFICATION_OUTCOMES = ["verified", "failed"];

/**
 * Which mandate category an onboarding application's vertical belongs to. The onboarding application
 * carries a service vertical_key ("grooming"), while mandates are defined per provider category
 * ("groomer") - without this mapping the activation checklist could not consult the mandate at all,
 * so a host could be activated with house/pet-proofing checks still not started.
 * Every canonical service vertical is mapped. Walking and taxi were absent, and the activation
 * checklist answered that absence with a PASSING check - so two of the six services activated providers
 * with no identity mandate whatsoever. A vertical still absent from this map now BLOCKS activation
 * rather than passing it; see lib/provider-verification-policy.ts. [PTJA-W1-F53]
 */
export const VERIFICATION_CATEGORY_BY_VERTICAL: Record<string, string> = {
  grooming: "groomer",
  pet_sitting: "pet_sitter",
  sitting: "pet_sitter",
  dog_training: "trainer",
  training: "trainer",
  boarding: "host",
  dog_walking: "dog_walker",
  walking: "dog_walker",
  pet_taxi: "pet_taxi_driver",
  taxi: "pet_taxi_driver",
};
export function verificationCategoryForVertical(verticalKey: string): string | null {
  return VERIFICATION_CATEGORY_BY_VERTICAL[text(verticalKey).toLowerCase()] || null;
}
/*
 * The seed for a category nobody has configured yet. The AUTHORITY for what a vertical requires is
 * lib/provider-verification-policy.ts, which is scoped by service AND city and edited in Control Center;
 * these rows keep the existing per-category records in step for the four categories that already had
 * them, and give the two new ones a starting set that matches the approved requirements.
 */
const DEFAULT_MANDATES: Record<string, string[]> = {
  groomer: ["aadhaar", "pan"],
  pet_sitter: ["aadhaar", "pan", "address"],
  trainer: ["aadhaar", "pan", "police_verification"],
  host: ["aadhaar", "pan", "house_verification", "pet_proofing_photo"],
  dog_walker: ["aadhaar", "address", "police_verification", "selfie_liveness", "pet_handling_induction", "emergency_safety_training", "references_background"],
  pet_taxi_driver: ["aadhaar", "address", "police_verification", "selfie_liveness", "pet_handling_induction", "emergency_safety_training", "driving_licence", "vehicle_registration", "vehicle_insurance", "vehicle_fitness_pollution"],
};

async function ensureVerificationMandateTablesUncached(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS provider_category_verification_mandates (category TEXT NOT NULL,verification_type TEXT NOT NULL,required INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(category,verification_type))"),
    db.prepare("CREATE TABLE IF NOT EXISTS provider_verifications (id TEXT PRIMARY KEY,application_id TEXT NOT NULL,category TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',automated INTEGER NOT NULL DEFAULT 0,provider_ref TEXT,detail_json TEXT NOT NULL DEFAULT '{}',updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(application_id,verification_type))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_verifications_app ON provider_verifications(application_id)"),
  ]);
  /*
   * A document that was valid on the day someone was activated does not stay valid. Without an expiry
   * the platform could only ever ask "was this ever verified?", never "is it verified NOW" - so a walker
   * whose police clearance lapsed last month kept receiving work. Additive and nullable: a row with no
   * expiry is a check that does not expire, which is what every existing row means. [PTJA-W1-F53]
   */
  await db.prepare("ALTER TABLE provider_verifications ADD COLUMN expires_at INTEGER").run()
    .catch((error: unknown) => { if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error; });
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_onboarding_provider_updated ON provider_onboarding_applications(provider_id,updated_at DESC)").run().catch((error: unknown) => { if (!/no such table/i.test(error instanceof Error ? error.message : String(error))) throw error; });
}
const verificationMandateTablesReady=new WeakSet<Db>();
const verificationMandateTablesRunning=new WeakMap<Db,Promise<void>>();
export async function ensureVerificationMandateTables(db: Db) {if(verificationMandateTablesReady.has(db))return;const running=verificationMandateTablesRunning.get(db);if(running)return running;const pending=ensureVerificationMandateTablesUncached(db).then(()=>{verificationMandateTablesReady.add(db);});verificationMandateTablesRunning.set(db,pending);try{await pending;}finally{if(verificationMandateTablesRunning.get(db)===pending)verificationMandateTablesRunning.delete(db);}}

/** The statuses that mean a check is NOT currently satisfied. `revoked` is a decision, not an absence. */
export const INVALID_VERIFICATION_STATUSES = ["pending", "not_started", "failed", "rejected", "revoked", "manual_review", "expired"];

/**
 * Records a verification outcome together with the window it is valid for.
 *
 * Distinct from recordManualVerification, which deliberately refuses automatable types so a human cannot
 * hand-wave an IDfy check. This is the governance write used by Operations and by the adapter callbacks:
 * it carries the validity window, and it is the only path that can record a REVOCATION, which is a
 * decision about a check that was previously verified rather than a check that was never run.
 */
export async function recordVerificationValidity(db: Db, input: { applicationId: string; verificationType: string; status: string; expiresAt?: number | null; actorId: string; note?: string }) {
  await ensureVerificationMandateTables(db);
  const type = typeByCode(text(input.verificationType));
  if (!type) throw new Error(`Unknown verification type: ${text(input.verificationType)}`);
  const status = text(input.status);
  if (!["verified", ...INVALID_VERIFICATION_STATUSES].includes(status)) throw new Error(`Unknown verification status: ${status}`);
  const now = Date.now();
  await db.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,detail_json,expires_at,updated_by,created_at,updated_at) VALUES (?,?,'',?,?,0,?,?,?,?,?) ON CONFLICT(application_id,verification_type) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,detail_json=excluded.detail_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(uid("PVER"), text(input.applicationId), type.code, status, JSON.stringify({ note: text(input.note) || null }), input.expiresAt ?? null, input.actorId, now, now).run();
  return { applicationId: text(input.applicationId), verificationType: type.code, status, expiresAt: input.expiresAt ?? null };
}

/**
 * Seed the default mandate for any category that has NEVER been configured.
 *
 * Per-category, and deliberately not per-row. `INSERT OR IGNORE` per row looks idempotent and is not:
 * it restores rows a human removed. Because requiredVerifications() seeds on every read, an operator who
 * narrowed a category's mandate saw it silently widen back to the defaults on the next read — the
 * control surface reported a change that the enforcement path then discarded. A category that already
 * carries any row is a category somebody has decided about, and defaults must not overwrite a decision.
 */
export async function seedDefaultMandates(db: Db) {
  await ensureVerificationMandateTables(db);
  const now = Date.now();
  for (const [category, types] of Object.entries(DEFAULT_MANDATES)) {
    const existing = await db.prepare("SELECT COUNT(*) n FROM provider_category_verification_mandates WHERE category=?").bind(category).first<Row>().catch(() => null);
    if (Number(existing?.n || 0) > 0) continue;
    for (const t of types)
      await db.prepare("INSERT OR IGNORE INTO provider_category_verification_mandates (category,verification_type,required,updated_by,updated_at) VALUES (?,?,1,'system_seed',?)").bind(category, t, now).run();
  }
}

/** Set the mandated verification types for a category (replaces the set). */
export async function setCategoryMandate(db: Db, input: { category: string; verificationTypes: string[]; actorId: string }) {
  await ensureVerificationMandateTables(db);
  const category = text(input.category);
  if (!PROVIDER_CATEGORIES.includes(category)) throw new Error(`Unknown category (use one of: ${PROVIDER_CATEGORIES.join(", ")})`);
  const requested = (input.verificationTypes || []).map(text).filter(Boolean);
  // An unrecognised type is refused by name rather than dropped. Silently discarding it told an operator
  // their mandate had been applied while the check they asked for was never required of anybody.
  const unknown = requested.filter(t => !typeByCode(t));
  if (unknown.length) throw new Error(`Unknown verification type(s): ${unknown.join(", ")}`);
  const types = requested;
  if (!types.length) throw new Error("At least one valid verification type is required");
  // Validated BEFORE anything is written, so a mandate the policy floor refuses - dropping the police
  // check from a walker, say - leaves BOTH surfaces exactly as they were rather than half-applied.
  await assertCategoryMandateAllowed(db, category, types);
  const now = Date.now();
  // ONE batch. The DELETE and the INSERTs used to be separate un-batched statements, so a request that
  // failed partway through the loop - a duplicate entry hitting PRIMARY KEY(category,verification_type)
  // - answered 500 while the category was left holding only the rows inserted before the failure. It
  // never healed: seedDefaultMandates skips any category that still has a row, by design, so the deleted
  // requirements were gone for good and providers stopped being asked for checks nobody had removed on
  // purpose. A rejected mandate change must leave the mandate exactly as it was. [PTJA-P0-04]
  await db.batch([
    db.prepare("DELETE FROM provider_category_verification_mandates WHERE category=?").bind(category),
    ...types.map(t => db.prepare("INSERT INTO provider_category_verification_mandates (category,verification_type,required,updated_by,updated_at) VALUES (?,?,1,?,?)").bind(category, t, input.actorId, now)),
  ]);
  /*
   * ONE AUTHORITY. lib/provider-verification-policy.ts is what the activation gate reads, because it is
   * scoped by city as well as by vertical and is edited in Control Center. This write-through keeps the
   * two surfaces from disagreeing: an operator who narrows a category here narrows what activation
   * actually demands, which is the contract this module already promised and
   * tests/provider-activation-readiness-closure.test.mjs already asserted. Without it, narrowing would
   * have been accepted, recorded, and then quietly ignored by the gate - the same shape as the
   * catalogue-versus-quote split this audit closed in F14. [PTJA-W1-F53]
   *
   * City-specific rows are left alone: this writes the (vertical, *) row, which a (vertical, city) row
   * still overrides.
   */
  await writeCategoryMandateThrough(db, category, types, input.actorId);
  return { category, verificationTypes: types };
}

/** Refuses a proposed mandate that the vertical's policy floor would reject, before anything is written. */
async function assertCategoryMandateAllowed(db: Db, category: string, types: string[]) {
  const policy = await import("./provider-verification-policy");
  const entry = Object.entries(policy.APPROVED_VERIFICATION_BY_VERTICAL).find(([, config]) => config.category === category);
  if (!entry) return;
  const spec = (await import("./service-policy-governance")).servicePolicyDomain(policy.PROVIDER_VERIFICATION_DOMAIN);
  if (!spec) return;
  const problem = spec.problem({ ...entry[1], configured: true, requiredTypes: types, recommendedTypes: [] } as Record<string, unknown>);
  if (problem) throw new Error(problem);
}

/** Mirrors a category mandate onto the verticals that map to it, in the policy the gate reads. */
async function writeCategoryMandateThrough(db: Db, category: string, types: string[], actorId: string) {
  const policy = await import("./provider-verification-policy");
  const verticals = Object.entries(policy.APPROVED_VERIFICATION_BY_VERTICAL)
    .filter(([, config]) => config.category === category)
    .map(([vertical]) => vertical);
  if (!verticals.length) return;
  const { writeServicePolicy } = await import("./service-policy-governance");
  await policy.seedApprovedVerificationPolicies(db);
  for (const vertical of verticals) {
    const current = await policy.resolveProviderVerificationPolicy(db, vertical, "*").catch(() => null);
    await writeServicePolicy(db, {
      domain: policy.PROVIDER_VERIFICATION_DOMAIN, serviceCode: vertical, cityId: "*",
      config: { ...(current?.config ?? {}), configured: true, requiredTypes: types,
        recommendedTypes: (current?.config.recommendedTypes ?? []).filter((t: string) => !types.includes(t)) },
    }, actorId, `Category mandate for ${category} updated`);
  }
}

export async function requiredVerifications(db: Db, category: string): Promise<string[]> {
  await seedDefaultMandates(db);
  const rows = await db.prepare("SELECT verification_type FROM provider_category_verification_mandates WHERE category=? AND required=1").bind(text(category)).all<Row>().catch(empty);
  return rows.results.map(r => text(r.verification_type));
}

/** Run one mandated check. Automatable types go through IDfy (fail-closed → stays 'pending'); manual
 * types are marked 'manual_review' awaiting an agent's recorded outcome. Idempotent per (application,type). */

/**
 * Keep the assignment pool honest about verification.
 *
 * A verification write used to end at the provider_verifications row. lib/provider-capacity-governance.ts
 * loadGovernedProviders - the single pool feeder for scheduling, trainer lookup and the capacity-safe
 * replacement engine - selects on city/live/status/zones/services and never reads provider_verifications,
 * so revoking a mandated check left the staff checklist saying "not eligible" while the matching engine
 * kept offering that provider work, including as the automatic replacement on a live booking. Nothing in
 * lib/ or app/ de-listed a provider on revocation. [PTJA-P1-F50]
 *
 * The de-listing is the platform's own: the same live=0 drop a review-sensitive profile edit already
 * performs, back to 'uat_ready' - activated, not on the map - which is the state addProviderToServiceMap
 * accepts, so staff can re-map a remediated provider. ('uat_review' would be a dead end: nothing clears
 * it.) Nothing here decides a revocation is permanent, and nothing re-lists anybody automatically.
 *
 * A provider with no onboarding application, or whose vertical has no category mandate defined, is left
 * alone - there is no mandate to be out of compliance with, and the seeded UAT roster lives there.
 */
export async function syncProviderPoolEligibility(db: Db, applicationId: string) {
  const id = text(applicationId);
  if (!id) return { providerId: null, delisted: false };
  const application = await db.prepare("SELECT provider_id,vertical_key FROM provider_onboarding_applications WHERE id=?").bind(id).first<Row>().catch(() => null);
  const providerId = text(application?.provider_id);
  if (!providerId) return { providerId: null, delisted: false };
  const category = verificationCategoryForVertical(text(application?.vertical_key));
  if (!category) return { providerId, delisted: false };
  const status = await verificationMandateStatus(db, { applicationId: id, category }).catch(() => null);
  if (!status || status.allVerified) return { providerId, delisted: false };
  const result = await db.prepare("UPDATE provider_capacity_profiles SET live=0,status='uat_ready',version=version+1,updated_at=? WHERE id=? AND (live=1 OR status='active')").bind(Date.now(), providerId).run().catch(() => null);
  return { providerId, delisted: Number(result?.meta?.changes || 0) > 0 };
}

export async function runProviderVerification(db: Db, env: Env, input: { applicationId: string; category: string; verificationType: string; payload?: Record<string, unknown>; actorId: string }) {
  await ensureVerificationMandateTables(db);
  const type = typeByCode(text(input.verificationType));
  if (!type) throw new Error("Unknown verification type");
  const applicationId = text(input.applicationId), category = text(input.category), now = Date.now();
  if (!applicationId) throw new Error("applicationId is required");
  let status = "pending", automated = 0, providerRef: string | null = null, detail: Record<string, unknown> = {};
  if (type.automatable) {
    if (!idfyConfigured(env)) { status = "pending"; detail = { reason: "IDfy not connected - check queued until verification is switched on" }; }
    else { const r = await verifyWithIdfy(env, { checkType: type.code, referenceId: `${applicationId}:${type.code}`, payload: input.payload || {} }); automated = 1; if (r.connected) { status = r.status; providerRef = r.reference; detail = { via: "idfy" }; } else { status = "pending"; detail = { reason: r.reason }; } }
  } else { status = "manual_review"; detail = { reason: "Manual/agent verification required (photo or physical check)" }; }
  // A NON-DECISION MAY NOT OVERWRITE A DECISION.
  //
  // The upsert below sets status and detail_json unconditionally, so re-running this path over a check a
  // human had already resolved replaced 'failed' with 'manual_review' and replaced the inspector's note
  // with the generic "Manual/agent verification required" string. There is no verification history table
  // and the security-audit detail never carries the note, so a failed physical inspection - and the
  // reason for it - was gone from the database entirely, leaving an innocuous "awaiting review" for the
  // next agent to resolve in good faith.
  //
  // This is lib/idfy-callback-boundary.ts's own rule, applied to its sibling path: a terminal outcome may
  // overwrite anything (failed -> verified is a correction, verified -> failed a revocation, and both are
  // somebody's judgement), but a non-terminal one may only write over a check nobody has decided yet.
  // Nothing here decides what a failure means or how long it stands. [PTJA-P1-F51]
  if (!TERMINAL_VERIFICATION_OUTCOMES.includes(status)) {
    const decided = await db.prepare("SELECT status,automated,provider_ref FROM provider_verifications WHERE application_id=? AND verification_type=?").bind(applicationId, type.code).first<Row>().catch(() => null);
    const standing = text(decided?.status);
    if (TERMINAL_VERIFICATION_OUTCOMES.includes(standing))
      return { applicationId, verificationType: type.code, status: standing, automated: Number(decided?.automated) === 1, providerRef: decided?.provider_ref ? text(decided.provider_ref) : null };
  }
  const id = uid("PVER");
  await db.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,provider_ref,detail_json,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(application_id,verification_type) DO UPDATE SET status=excluded.status,automated=excluded.automated,provider_ref=COALESCE(excluded.provider_ref,provider_verifications.provider_ref),detail_json=excluded.detail_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(id, applicationId, category, type.code, status, automated, providerRef, JSON.stringify(detail), input.actorId, now, now).run();
  await syncProviderPoolEligibility(db, applicationId);
  return { applicationId, verificationType: type.code, status, automated: Boolean(automated), providerRef };
}

/** Record the outcome of a manual check (police / house / pet-proofing) done by an agent. */
export async function recordManualVerification(db: Db, input: { applicationId: string; verificationType: string; status: "verified" | "failed" | "manual_review"; note?: string; actorId: string }) {
  await ensureVerificationMandateTables(db);
  const type = typeByCode(text(input.verificationType));
  if (!type) throw new Error("Unknown verification type");
  if (type.automatable) throw new Error("This is an automatable check - run it through IDfy, don't record it manually");
  const now = Date.now();
  await db.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,detail_json,updated_by,created_at,updated_at) VALUES (?,?, '',?,?,0,?,?,?,?) ON CONFLICT(application_id,verification_type) DO UPDATE SET status=excluded.status,detail_json=excluded.detail_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(uid("PVER"), text(input.applicationId), type.code, input.status, JSON.stringify({ manual: true, note: text(input.note) || null }), input.actorId, now, now).run();
  await syncProviderPoolEligibility(db, text(input.applicationId));
  return { applicationId: text(input.applicationId), verificationType: type.code, status: input.status };
}

/** The provider's verification standing: which mandated checks are verified vs pending. Assignment
 * eligibility requires EVERY mandated check verified. */
/**
 * Every verification type this application has actually cleared, whatever the per-category mandate
 * happens to list. lib/provider-verification-policy.ts decides what a vertical REQUIRES; this is what
 * the records SHOW. Filtering the evidence through the older category list would under-report a check
 * the policy added and the provider has already passed - and, worse, could hide one it has not.
 * [PTJA-W1-F53]
 */
export async function verifiedTypesForApplication(db: Db, applicationId: string) {
  await ensureVerificationMandateTables(db);
  const rows = await db.prepare("SELECT verification_type FROM provider_verifications WHERE application_id=? AND status='verified'").bind(text(applicationId)).all<Row>().catch(empty);
  return rows.results.map(r => text(r.verification_type));
}

export async function verificationMandateStatus(db: Db, input: { applicationId: string; category: string }) {
  await ensureVerificationMandateTables(db);
  const required = await requiredVerifications(db, input.category);
  const rows = await db.prepare("SELECT verification_type,status FROM provider_verifications WHERE application_id=?").bind(text(input.applicationId)).all<Row>().catch(empty);
  const byType = new Map(rows.results.map(r => [text(r.verification_type), text(r.status)]));
  const checks = required.map(t => ({ verificationType: t, automatable: Boolean(typeByCode(t)?.automatable), status: byType.get(t) || "not_started" }));
  const verified = checks.filter(c => c.status === "verified").map(c => c.verificationType);
  const pending = checks.filter(c => c.status !== "verified").map(c => c.verificationType);
  return { applicationId: text(input.applicationId), category: text(input.category), required, checks, verified, pending, allVerified: pending.length === 0 && required.length > 0, canTakeAssignments: pending.length === 0 && required.length > 0 };
}

export async function verificationMandatesSnapshot(db: Db) {
  await seedDefaultMandates(db);
  const rows = await db.prepare("SELECT category,verification_type FROM provider_category_verification_mandates WHERE required=1 ORDER BY category").all<Row>().catch(empty);
  const by: Record<string, string[]> = {};
  for (const r of rows.results) (by[text(r.category)] ||= []).push(text(r.verification_type));
  return { types: VERIFICATION_TYPES, categories: PROVIDER_CATEGORIES.map(c => ({ category: c, required: by[c] || [] })) };
}
