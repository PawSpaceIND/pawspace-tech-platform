/**
 * Grooming package recommendation for the voice agents.
 *
 * Haptik's solution document asks for this four times over (new lead, reactivation, abandoned
 * checkout, offer pitch) and each time says the same thing: recommend one of the six grooming packages
 * from pet type, age, breed and coat type, and "PawSpaces will need to provide Haptik with
 * comprehensive documentation outlining each package". Handing over a written PDF is how that
 * requirement usually gets met, and it is how the bot ends up quoting a package or a price the platform
 * stopped selling months ago.
 *
 * So the recommendation is computed here instead, against two governed sources:
 *
 *   - the package itself and its price come from catalogue_packages, the same rows the booking flow
 *     charges from (via resolveCataloguePrice, so city/zone precedence and effective dates apply);
 *   - which package suits which pet comes from grooming_package_rules, an ops-owned, audited,
 *     priority-ordered rule set - not from anything inferred inside the bot.
 *
 * Nothing is invented. With no rules configured, or no rule matching the pet, the answer is an explicit
 * "no recommendation" and the call is handed to a human; a rule pointing at a package the catalogue no
 * longer sells is reported as stale rather than quoted. A bot saying "someone will call you back" is a
 * recoverable disappointment. A bot quoting a price PawSpace will not honour is not.
 */

import { resolveCataloguePrice, listCataloguePackages } from "./catalogue-governance";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => text(value).toLowerCase();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const empty = () => ({ results: [] as Row[] });

export const GROOMING_SPECIES = ["dog", "cat", "any"] as const;
export const GROOMING_COAT_TYPES = ["short", "medium", "long", "double", "curly", "wire", "hairless", "any"] as const;
export const GROOMING_SIZE_CLASSES = ["small", "medium", "large", "giant", "any"] as const;

export type GroomingPackageRule = {
  ruleCode: string; species: string; coatType: string; sizeClass: string;
  minAgeMonths: number | null; maxAgeMonths: number | null; breedPattern: string | null;
  packageCode: string; priority: number; active: boolean; notes: string | null;
};

export async function ensureGroomingPackageRuleTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS grooming_package_rules (id TEXT PRIMARY KEY,rule_code TEXT NOT NULL UNIQUE,species TEXT NOT NULL DEFAULT 'any',coat_type TEXT NOT NULL DEFAULT 'any',size_class TEXT NOT NULL DEFAULT 'any',min_age_months INTEGER,max_age_months INTEGER,breed_pattern TEXT,package_code TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 100,active INTEGER NOT NULL DEFAULT 1,notes TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_package_rules_active ON grooming_package_rules(active,priority)"),
    db.prepare("CREATE TABLE IF NOT EXISTS grooming_package_rule_audit (id TEXT PRIMARY KEY,rule_code TEXT NOT NULL,action TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

/** Create or replace one rule. Ops-owned and audited; the bot never writes here. */
export async function upsertGroomingPackageRule(db: Db, input: {
  ruleCode: string; species?: string; coatType?: string; sizeClass?: string;
  minAgeMonths?: number | null; maxAgeMonths?: number | null; breedPattern?: string | null;
  packageCode: string; priority?: number; active?: boolean; notes?: string; actorId: string;
}) {
  await ensureGroomingPackageRuleTables(db);
  const ruleCode = text(input.ruleCode), packageCode = text(input.packageCode);
  if (!ruleCode || !packageCode) throw new Error("A rule code and a package code are required");
  const species = (GROOMING_SPECIES as readonly string[]).includes(lower(input.species)) ? lower(input.species) : "any";
  const coatType = (GROOMING_COAT_TYPES as readonly string[]).includes(lower(input.coatType)) ? lower(input.coatType) : "any";
  const sizeClass = (GROOMING_SIZE_CLASSES as readonly string[]).includes(lower(input.sizeClass)) ? lower(input.sizeClass) : "any";
  const min = input.minAgeMonths == null || !Number.isFinite(Number(input.minAgeMonths)) ? null : Math.max(0, Math.floor(Number(input.minAgeMonths)));
  const max = input.maxAgeMonths == null || !Number.isFinite(Number(input.maxAgeMonths)) ? null : Math.max(0, Math.floor(Number(input.maxAgeMonths)));
  if (min != null && max != null && min > max) throw new Error("The minimum age cannot exceed the maximum age");
  const now = Date.now(), priority = Number.isFinite(Number(input.priority)) ? Math.max(1, Math.floor(Number(input.priority))) : 100;
  await db.prepare("INSERT INTO grooming_package_rules (id,rule_code,species,coat_type,size_class,min_age_months,max_age_months,breed_pattern,package_code,priority,active,notes,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rule_code) DO UPDATE SET species=excluded.species,coat_type=excluded.coat_type,size_class=excluded.size_class,min_age_months=excluded.min_age_months,max_age_months=excluded.max_age_months,breed_pattern=excluded.breed_pattern,package_code=excluded.package_code,priority=excluded.priority,active=excluded.active,notes=excluded.notes,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(uid("GPR"), ruleCode, species, coatType, sizeClass, min, max, text(input.breedPattern) || null, packageCode, priority, input.active === false ? 0 : 1, text(input.notes) || null, input.actorId, now).run();
  await db.prepare("INSERT INTO grooming_package_rule_audit (id,rule_code,action,detail_json,actor_id,created_at) VALUES (?,?, 'upsert',?,?,?)")
    .bind(uid("GPRA"), ruleCode, JSON.stringify({ species, coatType, sizeClass, minAgeMonths: min, maxAgeMonths: max, breedPattern: text(input.breedPattern) || null, packageCode, priority, active: input.active !== false }), input.actorId, now).run();
  return { ruleCode, species, coatType, sizeClass, minAgeMonths: min, maxAgeMonths: max, packageCode, priority, active: input.active !== false, updatedAt: now };
}

export async function listGroomingPackageRules(db: Db, input: { includeInactive?: boolean } = {}) {
  await ensureGroomingPackageRuleTables(db);
  const rows = await db.prepare("SELECT rule_code,species,coat_type,size_class,min_age_months,max_age_months,breed_pattern,package_code,priority,active,notes,updated_by,updated_at FROM grooming_package_rules WHERE (?=1 OR active=1) ORDER BY priority ASC,rule_code ASC").bind(input.includeInactive ? 1 : 0).all<Row>().catch(empty);
  return rows.results.map(shapeRule);
}

const shapeRule = (r: Row): GroomingPackageRule & { updatedBy: string; updatedAt: number } => ({
  ruleCode: text(r.rule_code), species: text(r.species) || "any", coatType: text(r.coat_type) || "any", sizeClass: text(r.size_class) || "any",
  minAgeMonths: r.min_age_months == null ? null : Number(r.min_age_months), maxAgeMonths: r.max_age_months == null ? null : Number(r.max_age_months),
  breedPattern: r.breed_pattern == null ? null : text(r.breed_pattern), packageCode: text(r.package_code), priority: Number(r.priority),
  active: Number(r.active) === 1, notes: r.notes == null ? null : text(r.notes), updatedBy: text(r.updated_by), updatedAt: Number(r.updated_at),
});

export type PetProfile = { species?: string; breed?: string; coatType?: string; sizeClass?: string; ageMonths?: number; ageYears?: number };

/** Normalise what a voice agent actually manages to collect on a call into the rule vocabulary. */
export function normalisePetProfile(input: PetProfile) {
  const species = ["dog", "cat"].includes(lower(input.species)) ? lower(input.species) : lower(input.species) === "puppy" ? "dog" : lower(input.species) === "kitten" ? "cat" : "";
  const coatType = (GROOMING_COAT_TYPES as readonly string[]).includes(lower(input.coatType)) && lower(input.coatType) !== "any" ? lower(input.coatType) : "";
  const sizeClass = (GROOMING_SIZE_CLASSES as readonly string[]).includes(lower(input.sizeClass)) && lower(input.sizeClass) !== "any" ? lower(input.sizeClass) : "";
  const months = Number.isFinite(Number(input.ageMonths)) && Number(input.ageMonths) > 0 ? Math.floor(Number(input.ageMonths))
    : Number.isFinite(Number(input.ageYears)) && Number(input.ageYears) > 0 ? Math.floor(Number(input.ageYears) * 12) : null;
  return { species, breed: text(input.breed), coatType, sizeClass, ageMonths: months };
}

function ruleMatches(rule: GroomingPackageRule, pet: ReturnType<typeof normalisePetProfile>) {
  // An unspecified pet attribute can only satisfy a rule that does not constrain that attribute. A
  // rule for long-coated dogs must not win for a pet whose coat nobody asked about.
  if (rule.species !== "any" && rule.species !== pet.species) return false;
  if (rule.coatType !== "any" && rule.coatType !== pet.coatType) return false;
  if (rule.sizeClass !== "any" && rule.sizeClass !== pet.sizeClass) return false;
  if (rule.minAgeMonths != null && (pet.ageMonths == null || pet.ageMonths < rule.minAgeMonths)) return false;
  if (rule.maxAgeMonths != null && (pet.ageMonths == null || pet.ageMonths > rule.maxAgeMonths)) return false;
  if (rule.breedPattern) {
    const wanted = lower(rule.breedPattern).split("|").map(part => part.trim()).filter(Boolean);
    if (!wanted.length || !pet.breed) return false;
    if (!wanted.some(part => lower(pet.breed).includes(part))) return false;
  }
  return true;
}

/** How many attributes a rule actually pins down - the tie-break after explicit priority. */
function specificity(rule: GroomingPackageRule) {
  return (rule.species !== "any" ? 1 : 0) + (rule.coatType !== "any" ? 1 : 0) + (rule.sizeClass !== "any" ? 1 : 0)
    + (rule.minAgeMonths != null ? 1 : 0) + (rule.maxAgeMonths != null ? 1 : 0) + (rule.breedPattern ? 2 : 0);
}

/**
 * The active grooming packages a caller in this city can actually be sold, deduplicated by package
 * code so a package priced per city is offered once. With no city given the whole active catalogue is
 * read rather than only the global 'ALL' rows, which would otherwise hide every city-specific package.
 */
async function activeGroomingPackages(db: Db, cityId: string, detailed = false) {
  const rows = await listCataloguePackages(db, { serviceCode: "grooming", cityId: cityId || undefined }).catch(() => [] as Array<Record<string, unknown>>);
  const byCode = new Map<string, { packageCode: string; name: string; description: string; price: number; currency: string; taxInclusive: boolean; slotMinutes: number }>();
  for (const p of rows) {
    const code = text(p.packageCode);
    if (!code || byCode.has(code)) continue;
    byCode.set(code, { packageCode: code, name: text(p.name), description: text(p.description), price: Number(p.basePrice), currency: text(p.currency) || "INR", taxInclusive: Boolean(p.taxInclusive), slotMinutes: Number(p.slotMinutes) });
  }
  const all = [...byCode.values()];
  return detailed ? all : all.map(p => ({ packageCode: p.packageCode, name: p.name, price: p.price, currency: p.currency }));
}

export type GroomingRecommendation = {
  recommended: { packageCode: string; name: string; description: string; price: number; currency: string; slotMinutes: number } | null;
  matchedRule: string | null;
  reason: string | null;
  pet: ReturnType<typeof normalisePetProfile>;
  handToHuman: boolean;
  alternatives: Array<{ packageCode: string; name: string; price: number; currency: string }>;
};

/**
 * Recommend a package for the pet described on the call. Returns handToHuman:true with a machine
 * reason for every case the bot cannot honestly answer, so the agent script can say something true.
 */
export async function recommendGroomingPackage(db: Db, input: PetProfile & { cityId?: string; zoneId?: string; at?: number }): Promise<GroomingRecommendation> {
  await ensureGroomingPackageRuleTables(db);
  const pet = normalisePetProfile(input);
  const cityId = text(input.cityId), zoneId = text(input.zoneId) || undefined;
  const alternatives = await activeGroomingPackages(db, cityId);
  const rules = (await listGroomingPackageRules(db)).filter(rule => rule.active);
  if (!rules.length) return { recommended: null, matchedRule: null, reason: "rules_not_configured", pet, handToHuman: true, alternatives };

  const matches = rules.filter(rule => ruleMatches(rule, pet)).sort((a, b) => a.priority - b.priority || specificity(b) - specificity(a) || a.ruleCode.localeCompare(b.ruleCode));
  if (!matches.length) return { recommended: null, matchedRule: null, reason: pet.species ? "no_rule_matched" : "pet_details_incomplete", pet, handToHuman: true, alternatives };

  // Walk the matches in order and take the first whose package the catalogue still actually sells, so
  // one stale rule does not silence a correct recommendation behind it.
  for (const rule of matches) {
    const priced = await resolveCataloguePrice(db, { serviceCode: "grooming", packageCode: rule.packageCode, cityId: cityId || undefined, zoneId, at: input.at });
    if (!priced) continue;
    return {
      recommended: { packageCode: text(priced.packageCode), name: text(priced.name), description: text(priced.description), price: Number(priced.basePrice), currency: text(priced.currency) || "INR", slotMinutes: Number(priced.slotMinutes) },
      matchedRule: rule.ruleCode, reason: null, pet, handToHuman: false, alternatives,
    };
  }
  return { recommended: null, matchedRule: matches[0].ruleCode, reason: "matched_package_not_in_catalogue", pet, handToHuman: true, alternatives };
}

/**
 * The "detailed textual document" the solution document asks PawSpace to hand Haptik, generated from
 * the live catalogue and the live rules. Regenerating it is how the bot's knowledge stays in agreement
 * with what the platform sells; a hand-written copy cannot.
 */
export async function groomingPackageBriefing(db: Db, input: { cityId?: string } = {}) {
  await ensureGroomingPackageRuleTables(db);
  const cityId = text(input.cityId);
  const rules = await listGroomingPackageRules(db);
  const packages = (await activeGroomingPackages(db, cityId, true)).map(p => ({
    ...p,
    recommendedFor: rules.filter(rule => rule.packageCode === text(p.packageCode) && rule.active).map(rule => ({
      ruleCode: rule.ruleCode, species: rule.species, coatType: rule.coatType, sizeClass: rule.sizeClass,
      minAgeMonths: rule.minAgeMonths, maxAgeMonths: rule.maxAgeMonths, breedPattern: rule.breedPattern, notes: rule.notes,
    })),
  }));
  const unmapped = packages.filter(p => !p.recommendedFor.length).map(p => p.packageCode);
  const stalePackageCodes = [...new Set(rules.filter(rule => rule.active && !packages.some(p => p.packageCode === rule.packageCode)).map(rule => rule.packageCode))];
  return {
    cityId: cityId || "ALL", generatedAt: Date.now(), packageCount: packages.length, packages,
    // Both halves of the drift are reported: a package no rule can reach, and a rule pointing at a
    // package that is no longer sold. Either one makes the bot's recommendations wrong.
    packagesWithoutRules: unmapped,
    rulesPointingAtMissingPackages: stalePackageCodes,
    ready: packages.length > 0 && rules.some(rule => rule.active) && stalePackageCodes.length === 0,
  };
}
