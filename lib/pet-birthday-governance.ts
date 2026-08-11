/**
 * Pet birthday delight: a customer records their pet's date of birth; a daily sweep issues a
 * one-per-pet-per-year birthday reward - a flat Rs.500 off a doorstep grooming booking - and a
 * lifecycle reminder to surface it. Real, redeemable, and idempotent: a pet can never get two
 * birthday rewards for the same year, and a reward is single-use, grooming-scoped, and expires.
 *
 * The reward is a real discount validated against a real grooming booking owned by the customer -
 * it does not fabricate savings or auto-apply anything without an explicit redeem call.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

export const BIRTHDAY_GROOMING_DISCOUNT = 500;
const REWARD_VALID_DAYS = 30;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function ensurePetBirthdayTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pet_birthdays (pet_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,date_of_birth TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pet_birthday_rewards (id TEXT PRIMARY KEY,pet_id TEXT NOT NULL,customer_id TEXT NOT NULL,reward_year INTEGER NOT NULL,code TEXT NOT NULL UNIQUE,discount_amount REAL NOT NULL,service_scope TEXT NOT NULL DEFAULT 'grooming',status TEXT NOT NULL DEFAULT 'issued',expires_at INTEGER NOT NULL,redeemed_booking_id TEXT,redeemed_at INTEGER,created_at INTEGER NOT NULL,UNIQUE(pet_id,reward_year))"),
  ]);
}

/** Record/update a pet's date of birth (ownership-checked against the canonical pet record). */
export async function savePetBirthday(db: Db, input: { petId: string; customerId: string; dateOfBirth: string; actorId: string }) {
  await ensurePetBirthdayTables(db);
  if (!isDate(input.dateOfBirth)) throw new Error("Date of birth must be a valid YYYY-MM-DD date");
  if (Date.parse(input.dateOfBirth) > Date.now()) throw new Error("Date of birth cannot be in the future");
  const pet = await db.prepare("SELECT id,customer_id FROM canonical_pets WHERE id=?").bind(input.petId).first<Row>();
  if (!pet) throw new Error("Pet not found");
  if (String(pet.customer_id) !== input.customerId) throw new Error("You can only set the birthday for your own pet");
  const now = Date.now();
  await db.prepare("INSERT INTO pet_birthdays (pet_id,customer_id,date_of_birth,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET date_of_birth=excluded.date_of_birth,updated_at=excluded.updated_at")
    .bind(input.petId, input.customerId, input.dateOfBirth, now, now).run();
  return { petId: input.petId, dateOfBirth: input.dateOfBirth };
}

/**
 * Daily sweep: for every pet whose birthday (month-day) is today and who has no reward yet for the
 * current year, issue a flat Rs.500 grooming reward and return it so a reminder can be sent.
 * Idempotent via UNIQUE(pet_id,reward_year) - safe to run many times a day.
 */
export async function runPetBirthdaySweep(db: Db, input: { today?: string } = {}) {
  await ensurePetBirthdayTables(db);
  const todayStr = input.today && isDate(input.today) ? input.today : new Date().toISOString().slice(0, 10);
  const year = Number(todayStr.slice(0, 4)), monthDay = todayStr.slice(5); // MM-DD
  const now = Date.now(), expiresAt = Date.parse(todayStr) + REWARD_VALID_DAYS * 86_400_000;
  // canonical_pets is owned by another module; on a cold DB (e.g. the scheduled worker before any
  // pet has been created) it may not exist yet - fail safe to "no birthdays today" rather than throw.
  const pets = await db.prepare(
    "SELECT b.pet_id,b.customer_id,p.name FROM pet_birthdays b JOIN canonical_pets p ON p.id=b.pet_id WHERE substr(b.date_of_birth,6)=?"
  ).bind(monthDay).all<Row>().catch(() => ({ results: [] as Row[] }));
  const issued: Array<Record<string, unknown>> = [];
  for (const pet of pets.results) {
    const already = await db.prepare("SELECT id FROM pet_birthday_rewards WHERE pet_id=? AND reward_year=?").bind(String(pet.pet_id), year).first<Row>();
    if (already) continue;
    const id = uid("BDAY"), code = `BDAY${year}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    await db.prepare("INSERT INTO pet_birthday_rewards (id,pet_id,customer_id,reward_year,code,discount_amount,service_scope,status,expires_at,created_at) VALUES (?,?,?,?,?,?, 'grooming','issued',?,?)")
      .bind(id, String(pet.pet_id), String(pet.customer_id), year, code, BIRTHDAY_GROOMING_DISCOUNT, expiresAt, now).run();
    issued.push({ rewardId: id, petId: String(pet.pet_id), petName: String(pet.name), customerId: String(pet.customer_id), code, discount: BIRTHDAY_GROOMING_DISCOUNT, expiresAt });
  }
  return { date: todayStr, rewardsIssued: issued.length, rewards: issued };
}

/** Redeem a birthday reward against a real, customer-owned, completed-or-open grooming booking. */
export async function redeemBirthdayReward(db: Db, input: { code: string; customerId: string; bookingId: string; actorId: string }) {
  await ensurePetBirthdayTables(db);
  const reward = await db.prepare("SELECT * FROM pet_birthday_rewards WHERE code=?").bind(input.code.trim()).first<Row>();
  if (!reward) throw new Error("Birthday reward code not found");
  if (String(reward.customer_id) !== input.customerId) throw new Error("This birthday reward belongs to another account");
  if (String(reward.status) !== "issued") throw new Error("This birthday reward has already been used");
  if (Number(reward.expires_at) < Date.now()) throw new Error("This birthday reward has expired");
  const booking = await db.prepare("SELECT id,customer_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Booking not found");
  if (String(booking.customer_id) !== input.customerId) throw new Error("You can only apply your reward to your own booking");
  if (String(booking.service_code) !== "grooming") throw new Error("The birthday reward is valid on doorstep grooming only");
  await db.prepare("UPDATE pet_birthday_rewards SET status='redeemed',redeemed_booking_id=?,redeemed_at=? WHERE id=? AND status='issued'")
    .bind(input.bookingId, Date.now(), String(reward.id)).run();
  return { code: String(reward.code), bookingId: input.bookingId, discountApplied: Number(reward.discount_amount), serviceScope: "grooming" };
}

/** A customer's active (issued, unexpired) birthday rewards. */
export async function listBirthdayRewards(db: Db, customerId: string) {
  await ensurePetBirthdayTables(db);
  const rows = await db.prepare("SELECT id,pet_id,code,discount_amount,status,expires_at FROM pet_birthday_rewards WHERE customer_id=? AND status='issued' AND expires_at>=? ORDER BY created_at DESC").bind(customerId, Date.now()).all<Row>();
  return rows.results.map((r: Row) => ({ rewardId: String(r.id), petId: String(r.pet_id), code: String(r.code), discount: Number(r.discount_amount), expiresAt: Number(r.expires_at) }));
}
