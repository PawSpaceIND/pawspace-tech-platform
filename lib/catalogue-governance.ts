/**
 * Generalized service catalogue - create/update/retire NET-NEW packages and prices for ANY service,
 * city- and zone-wise. The existing pricing-control seeds fixed packages and only allows edits; this is
 * the complete admin: add a brand-new package for any service_code, priced per city/zone, with
 * versioning + audit. Resolution prefers the most specific price (zone → city → global default).
 *
 * Additive and non-destructive: it does not touch the live pricing engine's seeded service_packages.
 * resolveCataloguePrice() is the read path a booking/pricing flow can adopt. Cold-DB safe; audited.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 10).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const empty = () => ({ results: [] as Row[] });
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const EDITABLE = ["name", "description", "base_price", "slot_minutes", "blocking_minutes", "active", "effective_from", "effective_to"];

export async function ensureCatalogueTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,package_code TEXT NOT NULL,city_id TEXT NOT NULL DEFAULT 'ALL',zone_id TEXT,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',base_price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',tax_inclusive INTEGER NOT NULL DEFAULT 1,slot_minutes INTEGER NOT NULL DEFAULT 60,blocking_minutes INTEGER NOT NULL DEFAULT 90,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,created_by TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(service_code,package_code,city_id,zone_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_catalogue_lookup ON catalogue_packages(service_code,package_code,city_id,active)"),
    db.prepare("CREATE TABLE IF NOT EXISTS catalogue_audit (id TEXT PRIMARY KEY,package_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  ]);
}

const shape = (r: Row) => ({ id: String(r.id), serviceCode: String(r.service_code), packageCode: String(r.package_code), cityId: String(r.city_id), zoneId: r.zone_id ? String(r.zone_id) : null, name: String(r.name), description: String(r.description || ""), basePrice: Number(r.base_price), currency: String(r.currency || "INR"), taxInclusive: Number(r.tax_inclusive) === 1, slotMinutes: Number(r.slot_minutes), blockingMinutes: Number(r.blocking_minutes), active: Number(r.active) === 1, version: Number(r.version), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null, updatedAt: Number(r.updated_at) });

/** Create a brand-new catalogue package/price for any service, city/zone-wise. */
export async function createCataloguePackage(db: Db, input: { serviceCode: string; packageCode: string; cityId?: string; zoneId?: string; name: string; description?: string; basePrice: number; currency?: string; taxInclusive?: boolean; slotMinutes?: number; blockingMinutes?: number; effectiveFrom?: string; effectiveTo?: string; reason?: string; actorId: string }) {
  await ensureCatalogueTables(db);
  const serviceCode = text(input.serviceCode), packageCode = text(input.packageCode), name = text(input.name);
  if (!SERVICES.includes(serviceCode)) throw new Error(`Unsupported service (use one of: ${SERVICES.join(", ")})`);
  if (!packageCode || !name) throw new Error("packageCode and name are required");
  if (!Number.isFinite(Number(input.basePrice)) || Number(input.basePrice) < 0) throw new Error("A valid base price is required");
  const cityId = text(input.cityId) || "ALL", zoneId = text(input.zoneId) || null, now = Date.now(), id = uid("PKG");
  const existing = await db.prepare("SELECT id FROM catalogue_packages WHERE service_code=? AND package_code=? AND city_id=? AND COALESCE(zone_id,'')=COALESCE(?,'')").bind(serviceCode, packageCode, cityId, zoneId).first<Row>().catch(() => null);
  if (existing) throw new Error("A package with this code already exists for this city/zone (update it instead)");
  await db.prepare("INSERT INTO catalogue_packages (id,service_code,package_code,city_id,zone_id,name,description,base_price,currency,tax_inclusive,slot_minutes,blocking_minutes,active,version,effective_from,effective_to,created_by,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)")
    .bind(id, serviceCode, packageCode, cityId, zoneId, name, text(input.description), Number(input.basePrice), text(input.currency) || "INR", input.taxInclusive === false ? 0 : 1, Number(input.slotMinutes) || 60, Number(input.blockingMinutes) || 90, text(input.effectiveFrom) || new Date(now).toISOString().slice(0, 10), text(input.effectiveTo) || null, input.actorId, input.actorId, now).run();
  const row = await db.prepare("SELECT * FROM catalogue_packages WHERE id=?").bind(id).first<Row>();
  await db.prepare("INSERT INTO catalogue_audit (id,package_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,NULL,?,?,?,?)").bind(uid("CAUD"), id, "created", JSON.stringify(shape(row!)), input.actorId, text(input.reason) || "New package", now).run();
  return shape(row!);
}

/** Versioned update to an existing catalogue package (price change, rename, retire, dates). */
export async function updateCataloguePackage(db: Db, input: { id: string; changes: Record<string, unknown>; reason: string; actorId: string }) {
  await ensureCatalogueTables(db);
  if (!text(input.reason) || text(input.reason).length < 5) throw new Error("A change reason (min 5 chars) is required");
  const before = await db.prepare("SELECT * FROM catalogue_packages WHERE id=?").bind(input.id).first<Row>();
  if (!before) throw new Error("Package not found");
  const entries = Object.entries(input.changes || {}).filter(([k]) => EDITABLE.includes(k));
  if (!entries.length) throw new Error("No supported package fields supplied");
  if (entries.some(([k, v]) => k === "base_price" && (!Number.isFinite(Number(v)) || Number(v) < 0))) throw new Error("A valid base price is required");
  const now = Date.now(), set = entries.map(([k]) => `${k}=?`).join(",");
  await db.prepare(`UPDATE catalogue_packages SET ${set},version=version+1,updated_by=?,updated_at=? WHERE id=?`).bind(...entries.map(([k, v]) => k === "active" ? (v ? 1 : 0) : v as never), input.actorId, now, input.id).run();
  const after = await db.prepare("SELECT * FROM catalogue_packages WHERE id=?").bind(input.id).first<Row>();
  await db.prepare("INSERT INTO catalogue_audit (id,package_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(uid("CAUD"), input.id, "updated", JSON.stringify(shape(before)), JSON.stringify(shape(after!)), input.actorId, text(input.reason), now).run();
  return shape(after!);
}

export async function listCataloguePackages(db: Db, input: { serviceCode?: string; cityId?: string; includeInactive?: boolean } = {}) {
  await ensureCatalogueTables(db);
  const clauses: string[] = ["1=1"], binds: unknown[] = [];
  if (input.serviceCode) { clauses.push("service_code=?"); binds.push(text(input.serviceCode)); }
  if (input.cityId) { clauses.push("(city_id=? OR city_id='ALL')"); binds.push(text(input.cityId)); }
  if (!input.includeInactive) clauses.push("active=1");
  const rows = await db.prepare(`SELECT * FROM catalogue_packages WHERE ${clauses.join(" AND ")} ORDER BY service_code,package_code,city_id`).bind(...binds).all<Row>().catch(empty);
  return rows.results.map(shape);
}

/** Resolve the effective price for a service/package in a city/zone: most specific wins
 * (zone → city → global 'ALL'), active + inside its effective window. Returns null if none. */
export async function resolveCataloguePrice(db: Db, input: { serviceCode: string; packageCode: string; cityId?: string; zoneId?: string; at?: number }) {
  await ensureCatalogueTables(db);
  const serviceCode = text(input.serviceCode), packageCode = text(input.packageCode), cityId = text(input.cityId) || "ALL", zoneId = text(input.zoneId) || null;
  const at = input.at ?? Date.now(), today = new Date(at).toISOString().slice(0, 10);
  const rows = await db.prepare("SELECT * FROM catalogue_packages WHERE service_code=? AND package_code=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (city_id=? OR city_id='ALL')").bind(serviceCode, packageCode, today, today, cityId).all<Row>().catch(empty);
  if (!rows.results.length) return null;
  // rank: exact zone match (3) > city-level, no zone (2) > global ALL (1). A zone-specific row that
  // doesn't match the requested zone is NOT eligible (score 0), so it can't win a zone-less lookup.
  const ranked = rows.results.map(r => {
    const rz = text(r.zone_id), rc = text(r.city_id);
    let score = 0;
    if (rz) score = (zoneId && rz === zoneId) ? 3 : 0;
    else if (rc !== "ALL" && rc === cityId) score = 2;
    else if (rc === "ALL") score = 1;
    return { r, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || (Number(b.r.version) - Number(a.r.version)));
  return ranked.length ? shape(ranked[0].r) : null;
}
