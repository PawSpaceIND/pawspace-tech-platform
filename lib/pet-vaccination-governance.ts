/**
 * Real pet vaccination records + due reminders. canonical_pets only had a single free-text
 * `vaccination_status` flag - no actual record of which vaccine was given, when, or when the next
 * one is due. This adds a real per-pet immunisation history with next-due tracking and an
 * idempotent reminder sweep (upcoming -> due -> overdue). It also keeps the canonical pet's
 * vaccination_status flag in sync, and lays the real data foundation for the future vet vertical.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const DAY = 86_400_000;

export async function ensurePetVaccinationTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pet_vaccinations (id TEXT PRIMARY KEY,pet_id TEXT NOT NULL,customer_id TEXT NOT NULL,vaccine_type TEXT NOT NULL,administered_on TEXT NOT NULL,next_due_on TEXT,administered_by TEXT,notes TEXT,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pet_vax_pet ON pet_vaccinations(pet_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pet_vaccination_reminders (id TEXT PRIMARY KEY,vaccination_id TEXT NOT NULL,pet_id TEXT NOT NULL,customer_id TEXT NOT NULL,vaccine_type TEXT NOT NULL,due_on TEXT NOT NULL,stage TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,UNIQUE(vaccination_id,stage))"),
  ]);
}

/**
 * Record a vaccination for a pet (ownership-checked). A newer record of the same vaccine type
 * supersedes the prior active one, so each vaccine has exactly one active/current record per pet.
 */
export async function recordVaccination(db: Db, input: { petId: string; customerId: string; vaccineType: string; administeredOn: string; nextDueOn?: string | null; administeredBy?: string; notes?: string; actorId: string }) {
  await ensurePetVaccinationTables(db);
  const vaccineType = input.vaccineType.trim();
  if (!vaccineType) throw new Error("Vaccine type is required");
  if (!isDate(input.administeredOn)) throw new Error("Administered date must be a valid YYYY-MM-DD date");
  if (Date.parse(input.administeredOn) > Date.now() + DAY) throw new Error("Administered date cannot be in the future");
  if (input.nextDueOn && (!isDate(input.nextDueOn) || Date.parse(input.nextDueOn) <= Date.parse(input.administeredOn))) throw new Error("Next-due date must be a valid date after the administered date");
  const pet = await db.prepare("SELECT id,customer_id FROM canonical_pets WHERE id=?").bind(input.petId).first<Row>();
  if (!pet) throw new Error("Pet not found");
  if (String(pet.customer_id) !== input.customerId) throw new Error("You can only record vaccinations for your own pet");
  const now = Date.now();
  await db.prepare("UPDATE pet_vaccinations SET status='superseded',updated_at=? WHERE pet_id=? AND vaccine_type=? AND status='active'").bind(now, input.petId, vaccineType).run();
  const id = uid("VAX");
  await db.prepare("INSERT INTO pet_vaccinations (id,pet_id,customer_id,vaccine_type,administered_on,next_due_on,administered_by,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'active',?,?)")
    .bind(id, input.petId, input.customerId, vaccineType, input.administeredOn, input.nextDueOn || null, input.administeredBy?.trim() || null, input.notes?.trim() || null, now, now).run();
  // keep the canonical pet flag in sync (best-effort; table always exists here)
  await db.prepare("UPDATE canonical_pets SET vaccination_status='recorded',updated_at=? WHERE id=?").bind(now, input.petId).run().catch(() => {});
  return { id, petId: input.petId, vaccineType, administeredOn: input.administeredOn, nextDueOn: input.nextDueOn || null };
}

/**
 * Sweep active vaccinations with a next-due date and raise the right reminder stage:
 *   overdue (due < today) > due (due == today) > upcoming (due within upcomingWindowDays).
 * Idempotent per (vaccination, stage). Returns the reminders raised this run so they can be sent.
 */
export async function runVaccinationDueSweep(db: Db, input: { today?: string; upcomingWindowDays?: number } = {}) {
  await ensurePetVaccinationTables(db);
  const todayStr = input.today && isDate(input.today) ? input.today : new Date().toISOString().slice(0, 10);
  const windowDays = Number.isFinite(input.upcomingWindowDays) ? Number(input.upcomingWindowDays) : 14;
  const today = Date.parse(todayStr), horizon = today + windowDays * DAY, now = Date.now();
  const due = await db.prepare("SELECT id,pet_id,customer_id,vaccine_type,next_due_on FROM pet_vaccinations WHERE status='active' AND next_due_on IS NOT NULL AND next_due_on<=?").bind(new Date(horizon).toISOString().slice(0, 10)).all<Row>();
  const raised: Array<Record<string, unknown>> = [];
  for (const v of due.results) {
    const dueTs = Date.parse(String(v.next_due_on));
    const stage = dueTs < today ? "overdue" : dueTs === today ? "due" : "upcoming";
    const exists = await db.prepare("SELECT id FROM pet_vaccination_reminders WHERE vaccination_id=? AND stage=?").bind(String(v.id), stage).first<Row>();
    if (exists) continue;
    const id = uid("VAXREM");
    await db.prepare("INSERT INTO pet_vaccination_reminders (id,vaccination_id,pet_id,customer_id,vaccine_type,due_on,stage,status,created_at) VALUES (?,?,?,?,?,?,?, 'queued',?)")
      .bind(id, String(v.id), String(v.pet_id), String(v.customer_id), String(v.vaccine_type), String(v.next_due_on), stage, now).run();
    raised.push({ reminderId: id, petId: String(v.pet_id), customerId: String(v.customer_id), vaccineType: String(v.vaccine_type), dueOn: String(v.next_due_on), stage });
  }
  return { date: todayStr, remindersRaised: raised.length, reminders: raised };
}

/** A pet's (or customer's) vaccination history, most recent first. */
export async function listPetVaccinations(db: Db, input: { customerId: string; petId?: string }) {
  await ensurePetVaccinationTables(db);
  const rows = input.petId
    ? await db.prepare("SELECT * FROM pet_vaccinations WHERE customer_id=? AND pet_id=? ORDER BY administered_on DESC").bind(input.customerId, input.petId).all<Row>()
    : await db.prepare("SELECT * FROM pet_vaccinations WHERE customer_id=? ORDER BY administered_on DESC LIMIT 100").bind(input.customerId).all<Row>();
  return rows.results.map((r: Row) => ({ id: String(r.id), petId: String(r.pet_id), vaccineType: String(r.vaccine_type), administeredOn: String(r.administered_on), nextDueOn: r.next_due_on ? String(r.next_due_on) : null, administeredBy: r.administered_by ? String(r.administered_by) : null, status: String(r.status) }));
}
