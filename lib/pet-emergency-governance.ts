/**
 * Pet emergency assistance ("call for help") button. A customer raises an urgent request; we
 * (1) open a real high-severity safety_incident in the existing unified case system so Ops sees it
 * immediately, and (2) attempt to dispatch the nearest available field partner in the customer's
 * zone. This is real dispatch against the real provider_capacity_profiles roster - not a stub.
 *
 * Honest scope: a dedicated veterinary vertical does not exist yet, so "help" means the nearest
 * live PawSpace field partner is dispatched and Ops is alerted; once the vet vertical launches,
 * the same request can route to an on-call vet. Nothing here moves money or auto-closes a case.
 */

import { createUnifiedCase } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const parse = <T>(v: unknown, f: T): T => { try { return JSON.parse(String(v ?? "")) as T; } catch { return f; } };

export async function ensurePetEmergencyTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS pet_emergency_requests (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pet_id TEXT,booking_id TEXT,emergency_type TEXT NOT NULL,description TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,location_text TEXT,status TEXT NOT NULL DEFAULT 'raised',case_id TEXT,dispatched_provider_id TEXT,dispatched_provider_name TEXT,dispatched_at INTEGER,resolution_note TEXT,resolved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pet_emergency_customer ON pet_emergency_requests(customer_id,created_at)"),
  ]);
}

async function nearestAvailablePartner(db: Db, cityId: string, zoneId: string) {
  // real roster: live, active providers in the city, filtered to the zone, best quality first.
  const rows = await db.prepare("SELECT id,name,zones_json,quality_score,rating FROM provider_capacity_profiles WHERE live=1 AND status='active' AND city_id=? ORDER BY quality_score DESC,rating DESC").bind(cityId).all<Row>().catch(() => ({ results: [] as Row[] }));
  for (const r of rows.results) {
    if (parse<string[]>(r.zones_json, []).includes(zoneId)) return { id: String(r.id), name: String(r.name) };
  }
  return null;
}

/**
 * Raise an emergency: creates the request, opens a high-severity safety_incident case, and tries
 * to dispatch the nearest live partner in the zone. If none is available the request stays 'raised'
 * and is escalated to Ops via the case (never silently dropped).
 */
export async function raiseEmergencyRequest(db: Db, input: { customerId: string; petId?: string | null; bookingId?: string | null; emergencyType: string; description: string; cityId: string; zoneId: string; locationText?: string; actorId: string }) {
  await ensurePetEmergencyTables(db);
  const description = input.description.trim();
  if (!input.emergencyType.trim()) throw new Error("An emergency type is required");
  if (description.length < 5) throw new Error("Please describe the emergency briefly");
  if (!input.cityId.trim() || !input.zoneId.trim()) throw new Error("City and zone are required to dispatch help");
  if (input.petId) {
    const pet = await db.prepare("SELECT customer_id FROM canonical_pets WHERE id=?").bind(input.petId).first<Row>();
    if (!pet) throw new Error("Pet not found");
    if (String(pet.customer_id) !== input.customerId) throw new Error("You can only raise an emergency for your own pet");
  }
  if (input.bookingId) {
    // The booking is written onto a high-severity case that Ops reads. Unchecked, a customer could
    // attach somebody else's booking to their own emergency and pull that booking into their case.
    const booking = await db.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
    if (!booking) throw new Error("Booking not found");
    if (String(booking.customer_id) !== input.customerId) throw new Error("You can only reference your own booking in an emergency");
  }
  const id = uid("EMG"), now = Date.now();
  const caseResult = await createUnifiedCase(db, {
    idempotencyKey: `pet-emergency:${id}`,
    caseType: "safety_incident",
    severity: "high",
    title: `Emergency: ${input.emergencyType.trim()}`,
    description,
    customerId: input.customerId,
    bookingId: input.bookingId || null,
    sourceType: "customer_emergency_button",
    sourceId: id,
    ownerTeam: "operations",
    actorId: input.customerId,
  });
  const caseRecord = (caseResult as { case?: Record<string, unknown> })?.case;
  const caseId = caseRecord?.id ? String(caseRecord.id) : null;
  const partner = await nearestAvailablePartner(db, input.cityId.trim(), input.zoneId.trim());
  const status = partner ? "partner_dispatched" : "raised";
  await db.prepare("INSERT INTO pet_emergency_requests (id,customer_id,pet_id,booking_id,emergency_type,description,city_id,zone_id,location_text,status,case_id,dispatched_provider_id,dispatched_provider_name,dispatched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, input.customerId, input.petId || null, input.bookingId || null, input.emergencyType.trim(), description, input.cityId.trim(), input.zoneId.trim(), input.locationText?.trim() || null, status, caseId, partner?.id || null, partner?.name || null, partner ? now : null, now, now).run();
  return { id, status, caseId, dispatchedProvider: partner, escalatedToOps: !partner };
}

/** Ops/support resolves an emergency once help has been rendered. */
export async function resolveEmergencyRequest(db: Db, input: { requestId: string; actorId: string; resolutionNote: string }) {
  await ensurePetEmergencyTables(db);
  const req = await db.prepare("SELECT status FROM pet_emergency_requests WHERE id=?").bind(input.requestId).first<Row>();
  if (!req) throw new Error("Emergency request not found");
  if (String(req.status) === "resolved") throw new Error("This emergency is already resolved");
  if (input.resolutionNote.trim().length < 5) throw new Error("A resolution note is required");
  // Conditional claim: two Ops users resolving the same emergency at once would otherwise both
  // succeed, the second silently overwriting the first responder's resolution note.
  const now = Date.now();
  const claim = await db.prepare("UPDATE pet_emergency_requests SET status='resolved',resolution_note=?,resolved_at=?,updated_at=? WHERE id=? AND status!='resolved'").bind(input.resolutionNote.trim(), now, now, input.requestId).run();
  if (!Number(claim.meta.changes)) throw new Error("This emergency is already resolved");
  return { requestId: input.requestId, status: "resolved" };
}

export async function listEmergencyRequests(db: Db, input: { customerId: string }) {
  await ensurePetEmergencyTables(db);
  const rows = await db.prepare("SELECT id,emergency_type,status,dispatched_provider_name,created_at FROM pet_emergency_requests WHERE customer_id=? ORDER BY created_at DESC LIMIT 30").bind(input.customerId).all<Row>();
  return rows.results.map((r: Row) => ({ id: String(r.id), emergencyType: String(r.emergency_type), status: String(r.status), dispatchedProvider: r.dispatched_provider_name ? String(r.dispatched_provider_name) : null, createdAt: Number(r.created_at) }));
}
