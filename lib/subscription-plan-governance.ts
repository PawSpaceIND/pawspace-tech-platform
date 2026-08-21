/**
 * Service-agnostic subscription plans - the grooming plan admin generalized to EVERY service. Create
 * and manage subscription/session plans for grooming, training, boarding, sitting, walking, taxi:
 * per city (and zone), with a validity window (days or months) that defines each customer's expiry
 * from the date they subscribe, session counts, pause/grace/renewal policy, benefits and terms.
 *
 * computePlanExpiry() is the single source of truth for "every subscription/session expires N months
 * (or days) from the booked date" - the expiry rule the business asked to be defined per plan.
 * Versioned + audited. Cold-DB safe.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });
const DAY = 86_400_000;
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const EDITABLE = ["name", "price", "session_count", "validity_value", "validity_unit", "max_pets_per_booking", "credits_per_pet", "family_wallet", "pause_days", "grace_days", "renewal_window_days", "benefits_json", "terms_json", "active", "effective_from", "effective_to"];

export async function ensureSubscriptionPlanTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS subscription_plans (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,plan_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT,name TEXT NOT NULL,price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',session_count INTEGER NOT NULL,validity_value INTEGER NOT NULL,validity_unit TEXT NOT NULL,eligible_pet_types_json TEXT NOT NULL DEFAULT '[\"dog\",\"cat\"]',service_package_code TEXT NOT NULL,max_pets_per_booking INTEGER NOT NULL DEFAULT 4,credits_per_pet INTEGER NOT NULL DEFAULT 1,family_wallet INTEGER NOT NULL DEFAULT 1,pause_days INTEGER NOT NULL DEFAULT 0,grace_days INTEGER NOT NULL DEFAULT 0,renewal_window_days INTEGER NOT NULL DEFAULT 30,benefits_json TEXT NOT NULL DEFAULT '[]',terms_json TEXT NOT NULL DEFAULT '{}',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,created_by TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(service_code,plan_code,city_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_subplan_lookup ON subscription_plans(service_code,city_id,active)"),
    db.prepare("CREATE TABLE IF NOT EXISTS subscription_plan_audit (id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

/** The expiry rule: a plan bought at `startAt` expires `validityValue` days/months later. */
export function computePlanExpiry(startAt: number, validityValue: number, validityUnit: "days" | "months"): number {
  const v = Math.max(1, Math.floor(Number(validityValue) || 0));
  if (validityUnit === "months") { const d = new Date(startAt); d.setUTCMonth(d.getUTCMonth() + v); return d.getTime(); }
  return startAt + v * DAY;
}

const shape = (r: Row) => ({ id: String(r.id), serviceCode: String(r.service_code), planCode: String(r.plan_code), cityId: String(r.city_id), zoneId: r.zone_id ? String(r.zone_id) : null, name: String(r.name), price: Number(r.price), currency: String(r.currency || "INR"), sessionCount: Number(r.session_count), validityValue: Number(r.validity_value), validityUnit: String(r.validity_unit), servicePackageCode: String(r.service_package_code), maxPetsPerBooking: Number(r.max_pets_per_booking), creditsPerPet: Number(r.credits_per_pet), familyWallet: Number(r.family_wallet) === 1, pauseDays: Number(r.pause_days), graceDays: Number(r.grace_days), renewalWindowDays: Number(r.renewal_window_days), active: Number(r.active) === 1, version: Number(r.version), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null, updatedAt: Number(r.updated_at) });

export async function createSubscriptionPlan(db: Db, input: { serviceCode: string; planCode: string; cityId: string; zoneId?: string; name: string; price: number; currency?: string; sessionCount: number; validityValue: number; validityUnit: "days" | "months"; servicePackageCode: string; eligiblePetTypes?: string[]; maxPetsPerBooking?: number; creditsPerPet?: number; familyWallet?: boolean; pauseDays?: number; graceDays?: number; renewalWindowDays?: number; benefits?: unknown[]; terms?: Record<string, unknown>; effectiveFrom?: string; effectiveTo?: string; reason?: string; actorId: string }) {
  await ensureSubscriptionPlanTables(db);
  const serviceCode = text(input.serviceCode), planCode = text(input.planCode), cityId = text(input.cityId), name = text(input.name);
  if (!SERVICES.includes(serviceCode)) throw new Error(`Unsupported service (use one of: ${SERVICES.join(", ")})`);
  if (!planCode || !cityId || !name || !text(input.servicePackageCode)) throw new Error("planCode, cityId, name and servicePackageCode are required");
  if (!["days", "months"].includes(String(input.validityUnit))) throw new Error("validityUnit must be 'days' or 'months'");
  if (!Number.isFinite(Number(input.price)) || Number(input.price) < 0) throw new Error("A valid price is required");
  if (!(Number(input.sessionCount) >= 1) || !(Number(input.validityValue) >= 1)) throw new Error("sessionCount and validityValue must be at least 1");
  const existing = await db.prepare("SELECT id FROM subscription_plans WHERE service_code=? AND plan_code=? AND city_id=?").bind(serviceCode, planCode, cityId).first<Row>().catch(() => null);
  if (existing) throw new Error("A plan with this code already exists for this service/city (update it instead)");
  const now = Date.now(), id = uid("SPLAN");
  await db.prepare("INSERT INTO subscription_plans (id,service_code,plan_code,city_id,zone_id,name,price,currency,session_count,validity_value,validity_unit,eligible_pet_types_json,service_package_code,max_pets_per_booking,credits_per_pet,family_wallet,pause_days,grace_days,renewal_window_days,benefits_json,terms_json,active,version,effective_from,effective_to,created_by,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)")
    .bind(id, serviceCode, planCode, cityId, text(input.zoneId) || null, name, Number(input.price), text(input.currency) || "INR", Math.floor(Number(input.sessionCount)), Math.floor(Number(input.validityValue)), String(input.validityUnit), JSON.stringify(input.eligiblePetTypes || ["dog", "cat"]), text(input.servicePackageCode), Number(input.maxPetsPerBooking) || 4, Number(input.creditsPerPet) || 1, input.familyWallet === false ? 0 : 1, Number(input.pauseDays) || 0, Number(input.graceDays) || 0, Number(input.renewalWindowDays) || 30, JSON.stringify(input.benefits || []), JSON.stringify(input.terms || {}), text(input.effectiveFrom) || new Date(now).toISOString().slice(0, 10), text(input.effectiveTo) || null, input.actorId, input.actorId, now).run();
  const row = await db.prepare("SELECT * FROM subscription_plans WHERE id=?").bind(id).first<Row>();
  await db.prepare("INSERT INTO subscription_plan_audit (id,plan_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,NULL,?,?,?,?)").bind(uid("SPAUD"), id, "created", JSON.stringify(shape(row!)), input.actorId, text(input.reason) || "New subscription plan", now).run();
  const s = shape(row!);
  return { ...s, sampleExpiryFromToday: computePlanExpiry(now, s.validityValue, s.validityUnit as "days" | "months") };
}

/** Update a plan without allowing PATCH input to bypass commercial or type invariants. */
export async function updateSubscriptionPlan(db: Db, input: { id: string; changes: Record<string, unknown>; reason: string; actorId: string }) {
  await ensureSubscriptionPlanTables(db);
  if (!text(input.reason) || text(input.reason).length < 5) throw new Error("A change reason (min 5 chars) is required");
  const before = await db.prepare("SELECT * FROM subscription_plans WHERE id=?").bind(input.id).first<Row>();
  if (!before) throw new Error("Subscription plan not found");
  const entries = Object.entries(input.changes || {}).filter(([k]) => EDITABLE.includes(k));
  if (!entries.length) throw new Error("No supported plan fields supplied");

  // PATCH must preserve the same core commercial invariants enforced at plan creation. Validate JSON
  // types before normalization so null, strings and truthy values cannot silently change commercial data.
  const normalizedEntries = entries.map(([key, value]): [string, unknown] => {
    if (key === "price") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("A valid numeric price is required");
      return [key, value];
    }
    if (key === "session_count" || key === "validity_value") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new Error("session_count and validity_value must be numeric values of at least 1");
      return [key, Math.floor(value)];
    }
    if (key === "validity_unit") {
      if (typeof value !== "string" || !["days", "months"].includes(value)) throw new Error("validity_unit must be 'days' or 'months'");
      return [key, value];
    }
    if (key === "active" || key === "family_wallet") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      return [key, value ? 1 : 0];
    }
    return [key, value];
  });

  const now = Date.now(), set = normalizedEntries.map(([k]) => `${k}=?`).join(",");
  await db.prepare(`UPDATE subscription_plans SET ${set},version=version+1,updated_by=?,updated_at=? WHERE id=?`).bind(...normalizedEntries.map(([, v]) => v as never), input.actorId, now, input.id).run();
  const after = await db.prepare("SELECT * FROM subscription_plans WHERE id=?").bind(input.id).first<Row>();
  await db.prepare("INSERT INTO subscription_plan_audit (id,plan_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(uid("SPAUD"), input.id, "updated", JSON.stringify(shape(before)), JSON.stringify(shape(after!)), input.actorId, text(input.reason), now).run();
  return shape(after!);
}

export async function listSubscriptionPlans(db: Db, input: { serviceCode?: string; cityId?: string; includeInactive?: boolean } = {}) {
  await ensureSubscriptionPlanTables(db);
  const clauses: string[] = ["1=1"], binds: unknown[] = [];
  if (input.serviceCode) { clauses.push("service_code=?"); binds.push(text(input.serviceCode)); }
  if (input.cityId) { clauses.push("city_id=?"); binds.push(text(input.cityId)); }
  if (!input.includeInactive) clauses.push("active=1");
  const rows = await db.prepare(`SELECT * FROM subscription_plans WHERE ${clauses.join(" AND ")} ORDER BY service_code,city_id,plan_code`).bind(...binds).all<Row>().catch(empty);
  return rows.results.map(shape);
}
