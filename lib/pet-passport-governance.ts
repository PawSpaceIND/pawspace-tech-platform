/**
 * Pet Passport - one delightful, shareable profile per pet that ties together everything we already
 * know: the pet's basics, birthday, real vaccination status/next-due, and the owner's PawPoints
 * loyalty tier. Two views:
 *   - owner view (getPetPassport): full detail for the signed-in owner.
 *   - public share (createPetPassportShare -> getSharedPetPassport): a privacy-safe card behind an
 *     unguessable token, with NO owner PII (no phone/address/email) - safe to post on social.
 */

import { pawPointsBalance } from "./paw-points-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

const token = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

function ageFrom(dob: string | null): string | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const then = new Date(dob + "T00:00:00Z"), now = new Date();
  let months = (now.getUTCFullYear() - then.getUTCFullYear()) * 12 + (now.getUTCMonth() - then.getUTCMonth());
  if (now.getUTCDate() < then.getUTCDate()) months -= 1;
  if (months < 0) return null;
  const y = Math.floor(months / 12), m = months % 12;
  return y >= 1 ? `${y} year${y > 1 ? "s" : ""}${m ? ` ${m} mo` : ""}` : `${m} month${m === 1 ? "" : "s"}`;
}
function loyaltyTier(points: number): string {
  return points >= 2000 ? "Gold" : points >= 500 ? "Silver" : "Bronze";
}

export async function ensurePetPassportTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pet_passport_shares (token TEXT PRIMARY KEY,pet_id TEXT NOT NULL,customer_id TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_passport_share_pet ON pet_passport_shares(pet_id)"),
  ]);
}

async function petCore(db: Db, petId: string) {
  const pet = await db.prepare("SELECT id,customer_id,name,species,breed FROM canonical_pets WHERE id=?").bind(petId).first<Row>();
  if (!pet) return null;
  const birthday = await db.prepare("SELECT date_of_birth FROM pet_birthdays WHERE pet_id=?").bind(petId).first<Row>().catch(() => null);
  const dob = birthday?.date_of_birth ? String(birthday.date_of_birth) : null;
  const vax = await db.prepare("SELECT vaccine_type,administered_on,next_due_on FROM pet_vaccinations WHERE pet_id=? AND status='active' ORDER BY vaccine_type").bind(petId).all<Row>().catch(() => ({ results: [] as Row[] }));
  const today = new Date().toISOString().slice(0, 10);
  const vaccinations = vax.results.map((v: Row) => ({ vaccineType: String(v.vaccine_type), administeredOn: String(v.administered_on), nextDueOn: v.next_due_on ? String(v.next_due_on) : null, status: v.next_due_on && String(v.next_due_on) < today ? "overdue" : "up_to_date" }));
  const upToDate = vaccinations.length > 0 && vaccinations.every(v => v.status === "up_to_date");
  return { pet, dob, vaccinations, upToDate };
}

/** Full owner view (ownership enforced by the caller/route). */
export async function getPetPassport(db: Db, input: { customerId: string; petId: string }) {
  await ensurePetPassportTables(db);
  const core = await petCore(db, input.petId);
  if (!core || String(core.pet.customer_id) !== input.customerId) throw new Error("Pet not found");
  const points = await pawPointsBalance(db, input.customerId).catch(() => 0);
  return {
    petId: input.petId, name: String(core.pet.name), species: String(core.pet.species), breed: core.pet.breed ? String(core.pet.breed) : null,
    age: ageFrom(core.dob), dateOfBirth: core.dob,
    vaccinations: core.vaccinations, vaccinationUpToDate: core.upToDate,
    pawPoints: points, loyaltyTier: loyaltyTier(points),
    badges: [core.upToDate ? "Fully Vaccinated" : null, points >= 500 ? `${loyaltyTier(points)} Member` : null, core.dob ? "Birthday on file" : null].filter(Boolean),
  };
}

/** Create (or reuse) an unguessable public share link for a pet the customer owns. */
export async function createPetPassportShare(db: Db, input: { customerId: string; petId: string; actorId: string }) {
  await ensurePetPassportTables(db);
  const pet = await db.prepare("SELECT customer_id FROM canonical_pets WHERE id=?").bind(input.petId).first<Row>();
  if (!pet) throw new Error("Pet not found");
  if (String(pet.customer_id) !== input.customerId) throw new Error("You can only share your own pet's passport");
  const existing = await db.prepare("SELECT token FROM pet_passport_shares WHERE pet_id=? AND customer_id=? AND revoked=0 ORDER BY created_at DESC LIMIT 1").bind(input.petId, input.customerId).first<Row>();
  if (existing) return { token: String(existing.token), sharePath: `/pet-passport/${String(existing.token)}` };
  const t = token();
  await db.prepare("INSERT INTO pet_passport_shares (token,pet_id,customer_id,created_at) VALUES (?,?,?,?)").bind(t, input.petId, input.customerId, Date.now()).run();
  return { token: t, sharePath: `/pet-passport/${t}` };
}

export async function revokePetPassportShare(db: Db, input: { customerId: string; token: string }) {
  await ensurePetPassportTables(db);
  const row = await db.prepare("SELECT customer_id FROM pet_passport_shares WHERE token=?").bind(input.token).first<Row>();
  if (!row) throw new Error("Share link not found");
  if (String(row.customer_id) !== input.customerId) throw new Error("You can only revoke your own share link");
  await db.prepare("UPDATE pet_passport_shares SET revoked=1 WHERE token=?").bind(input.token).run();
  return { token: input.token, revoked: true };
}

/** Public, privacy-safe passport for a share token - NO owner PII. Returns null for bad/revoked tokens. */
export async function getSharedPetPassport(db: Db, token: string) {
  await ensurePetPassportTables(db);
  const share = await db.prepare("SELECT pet_id FROM pet_passport_shares WHERE token=? AND revoked=0").bind(token).first<Row>();
  if (!share) return null;
  const core = await petCore(db, String(share.pet_id));
  if (!core) return null;
  const points = await pawPointsBalance(db, String(core.pet.customer_id)).catch(() => 0);
  // deliberately no customer_id, phone, address, email, exact points - just the pet's public card
  return {
    name: String(core.pet.name), species: String(core.pet.species), breed: core.pet.breed ? String(core.pet.breed) : null,
    age: ageFrom(core.dob),
    vaccinationUpToDate: core.upToDate,
    vaccines: core.vaccinations.map(v => ({ vaccineType: v.vaccineType, status: v.status })),
    loyaltyTier: loyaltyTier(points),
    badges: [core.upToDate ? "Fully Vaccinated" : null, points >= 500 ? `${loyaltyTier(points)} Member` : null].filter(Boolean),
  };
}
