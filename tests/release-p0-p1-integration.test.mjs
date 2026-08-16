/**
 * CONSOLIDATED RELEASE REGRESSION — P0/P1 integration candidate.
 *
 * Covers, in one place, every behaviour this release depends on:
 *   scheduling-group authority (all-distinct-owner, mixed-owner), the idempotency replay bypass,
 *   customer-distinct Training keys, refusal compensation, and pet-profile preservation.
 *
 * NON-VACUITY — READ BEFORE EDITING
 * isDevelopmentPreview() is true for hostname "localhost", and a preview actor short-circuits
 * requireCustomerOwnership entirely, so a localhost test proves NOTHING about ownership — every
 * assertion here would still pass with the guards reverted. These tests therefore use a NON-preview
 * host and REAL minted sessions (verified identity binding + issuePlatformSession + cookie). The first
 * test fails loudly if that ever stops being true.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__RI_DB__", "__RI_ENV__");

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const account = await import("../lib/customer-account.ts");
const bindings = await import("../lib/identity-binding.ts");
const sessions = await import("../lib/platform-session.ts");
const providerGov = await import("../lib/provider-capacity-governance.ts");

const START = "2026-09-01T04:30:00.000Z", END = "2026-09-01T06:30:00.000Z";
const MAA_START = "2026-09-01T09:30:00.000Z", MAA_END = "2026-09-01T11:30:00.000Z";
const HOST = "https://staging.pawspace.test";
const db = () => globalThis.__RI_DB__;
let seq = 0;
function freshDb() { const s = new DatabaseSync(":memory:"); globalThis.__RI_DB__ = createD1(s); globalThis.__RI_ENV__ = {}; return s; }

async function realCustomer(id, pets) {
  const phone = `+9190000000${++seq}`;
  await account.ensureCustomerAccountTables(db());
  await db().prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'t','{}',?,?)").bind(id, "blr", id, phone, Date.now(), Date.now()).run();
  for (const pet of pets) await account.mutateCustomerAccount(db(), { customerId: id, action: "upsert_pet", idempotencyKey: `p-${id}-${pet.name}-${++seq}`, pet });
  const rows = await db().prepare("SELECT id,name,breed,vaccination_status,source_pet_id FROM canonical_pets WHERE customer_id=? ORDER BY created_at").bind(id).all();
  const b = await bindings.upsertIdentityBinding(db(), { identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id, verificationState: "verified", actorId: "release-test", reason: "p0/p1 integration regression" });
  const issued = await sessions.issuePlatformSession(db(), { bindingId: String(b.id ?? b.binding?.id ?? b), identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id });
  return { id, pets: rows.results, petId: String(rows.results[0].id), cookie: `pawspace_identity_session=${issued.token}` };
}
const req = (p, body, cookie) => new Request(`${HOST}${p}`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function reserve(cust, group, o = {}) {
  const r = await schedulingRoute.POST(req("/api/uat-scheduling", { clientRequestId: group, customerId: cust.id, petIds: o.petIds ?? [cust.petId], serviceCode: "grooming", cityId: o.cityId ?? "blr", zoneId: o.zoneId ?? "blr-east", scheduledStart: o.start ?? START, scheduledEnd: o.end ?? END }, cust.cookie));
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b.data;
}
const bodyFor = (c, group, provider, o = {}) => ({
  idempotencyKey: o.idempotencyKey ?? `bk-${group}-${c.id}`, scheduleGroupId: group,
  customer: { id: c.id, name: "C", primaryPhone: "+919000000001" },
  pets: o.pets ?? [{ sourceId: c.pets[0].name, name: c.pets[0].name, species: "dog" }],
  cityId: o.cityId ?? "blr", zoneId: o.zoneId ?? "blr-east",
  serviceCode: o.serviceCode ?? "pet_sitting", packageCode: o.packageCode ?? "sit-basic", packageName: "Pet sitting",
  scheduledStart: o.start ?? START, scheduledEnd: o.end ?? END, provider,
  totalAmount: o.totalAmount ?? 2400, amountDueNow: o.amountDueNow ?? 2400,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "t" }, pricing: { discount: 0 },
});
const book = async (c, b) => { const r = await bookingRoute.POST(req("/api/canonical-bookings", b, c.cookie)); return { status: r.status, body: await r.json() }; };
const resRows = (s, g) => s.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(g);
const arte = (s, id) => ({ bookings: s.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(id).n, payments: s.prepare("SELECT COUNT(*) n FROM booking_payments WHERE customer_id=?").get(id).n, workOrders: s.prepare("SELECT COUNT(*) n FROM provider_work_orders").get().n });
const petRows = (s, id) => s.prepare("SELECT id,name,breed,vaccination_status FROM canonical_pets WHERE customer_id=? ORDER BY name").all(id);
async function cardPets(s, customerId) {
  const row = s.prepare("SELECT pet_ids_json FROM canonical_bookings WHERE customer_id=? ORDER BY created_at DESC").get(customerId);
  const r = await db().prepare("SELECT id,name,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(customerId, row.pet_ids_json).all();
  return r.results;
}

test("0 non-vacuity: the ownership boundary is live (not the development-preview superuser)", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const r = await bookingRoute.POST(req("/api/canonical-bookings", bodyFor(a, "G", { id: "p", name: "n", model: "commission" }), undefined));
  assert.ok(r.status === 401 || r.status === 403, `unauthenticated write must be refused, got ${r.status}`);
});

test("1 B quoting A's scheduleGroupId is 403, with zero artefacts and A unchanged", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const b = await realCustomer("CUS-B", [{ name: "Bolt", species: "dog", breed: "Pug", vaccinationStatus: "pending" }]);
  const sched = await reserve(a, "G1");
  const before = resRows(s, "G1");
  const hostile = await book(b, bodyFor(b, "G1", sched.provider));
  assert.equal(hostile.status, 403, JSON.stringify(hostile.body));
  assert.deepEqual(arte(s, "CUS-B"), { bookings: 0, payments: 0, workOrders: 0 });
  assert.deepEqual(resRows(s, "G1"), before, "A's reservation rows byte-identical");
});

test("2 a mixed-owner group is 403 for EVERY caller, with nothing mutated", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const b = await realCustomer("CUS-B", [{ name: "Bolt", species: "dog", breed: "Pug", vaccinationStatus: "pending" }]);
  const sched = await reserve(a, "G2");
  const row = s.prepare("SELECT * FROM scheduling_reservations WHERE group_id='G2' LIMIT 1").get();
  const cols = Object.keys(row);
  s.prepare(`INSERT INTO scheduling_reservations (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map(c => (c === "id" ? `${row.id}-B` : c === "customer_id" ? "CUS-B" : c === "occurrence_number" ? Number(row.occurrence_number ?? 1) + 1 : row[c])));
  const before = resRows(s, "G2");
  const aRes = await book(a, bodyFor(a, "G2", sched.provider));
  const bRes = await book(b, bodyFor(b, "G2", sched.provider));
  assert.equal(aRes.status, 403, `A refused on a mixed-owner group: ${JSON.stringify(aRes.body)}`);
  assert.equal(bRes.status, 403, `B refused on a mixed-owner group: ${JSON.stringify(bRes.body)}`);
  assert.deepEqual(arte(s, "CUS-A"), { bookings: 0, payments: 0, workOrders: 0 });
  assert.deepEqual(arte(s, "CUS-B"), { bookings: 0, payments: 0, workOrders: 0 });
  assert.deepEqual(resRows(s, "G2"), before, "every reservation row unchanged");
});

test("3 B holding their OWN group cannot obtain A's bundle with A's idempotency key", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const b = await realCustomer("CUS-B", [{ name: "Bolt", species: "dog", breed: "Pug", vaccinationStatus: "pending" }]);
  const aSched = await reserve(a, "G-A");
  const aOk = await book(a, bodyFor(a, "G-A", aSched.provider, { idempotencyKey: "SHARED-KEY" }));
  assert.equal(aOk.status, 201);
  const aId = aOk.body.data.bookingId;

  const bSched = await reserve(b, "G-B");
  const attempt = await book(b, bodyFor(b, "G-B", bSched.provider, { idempotencyKey: "SHARED-KEY" }));
  const text = JSON.stringify(attempt.body);
  assert.equal(text.includes(aId), false, `must not disclose A's bundle: ${attempt.status} ${text}`);
  assert.equal(text.includes("CUS-A"), false, "must not disclose A's customer id");
  // idempotency_key is globally UNIQUE, so B cannot book under it either. Controlled 4xx, no 500.
  assert.equal(attempt.status, 409, `a foreign key must be an explicit controlled refusal, got ${attempt.status}`);
  assert.equal(arte(s, "CUS-B").bookings, 0, "zero mutation for B");
  // A is untouched and can still replay their own booking.
  const aReplay = await book(a, bodyFor(a, "G-A", aSched.provider, { idempotencyKey: "SHARED-KEY" }));
  assert.equal(aReplay.body.data.bookingId, aId, "A still owns and can replay their bundle");
});

test("4 two customers booking the same package/start/frequency get customer-distinct Training keys", async () => {
  const src = await readFile(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
  assert.equal(src.includes("TST101"), false, "no hardcoded fixture id may appear in this flow at all");
  // Evaluate EVERY Training request-key template for real, not just the one that was wrong.
  const templates = [...src.matchAll(/requestId=`(training[^`]*)`/g)].map(m => m[1]);
  assert.ok(templates.length >= 2, `expected the Training key templates, found ${templates.length}`);
  const ctx = (customerId) => ({
    customer: { customerId }, quote: { packageCode: "training-2-starter" },
    selectedStart: new Date("2026-09-01T04:30:00.000Z"), start: new Date("2026-09-01T04:30:00.000Z"),
    frequency: "Tue & Sat", selectedTrainer: { id: "train_kiran" },
  });
  const build = (tpl, c) => new Function("customer", "quote", "selectedStart", "start", "frequency", "selectedTrainer",
    "return `" + tpl + "`;")(c.customer, c.quote, c.selectedStart, c.start, c.frequency, c.selectedTrainer);
  for (const tpl of templates) {
    const keyA = build(tpl, ctx("CUS-A")), keyB = build(tpl, ctx("CUS-B"));
    assert.notEqual(keyA, keyB, `identical package/slot/frequency must yield customer-distinct keys, got '${keyA}' for both`);
    assert.ok(keyA.includes("CUS-A"), `the key must carry the real customer identity: ${keyA}`);
    // Same customer, identical inputs -> identical key, so a retry stays idempotent.
    assert.equal(build(tpl, ctx("CUS-A")), keyA, `same-customer retry must stay idempotent: ${keyA}`);
  }
});

test("5 a same-customer retry returns the same rightful bundle and creates nothing new", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const sched = await reserve(a, "G5");
  const body = bodyFor(a, "G5", sched.provider);
  const first = await book(a, body);
  assert.equal(first.status, 201);
  const before = arte(s, "CUS-A");
  const retry = await book(a, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.bookingId, first.body.data.bookingId, "same bundle");
  assert.deepEqual(arte(s, "CUS-A"), before, "retry creates nothing new");
});

test("6 BLR refusal compensates, Chennai missing policy is 409 and releases, zero money either way", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const sched = await reserve(a, "G6");
  const refused = await book(a, bodyFor(a, "G6", sched.provider, { serviceCode: "grooming", packageCode: "groom-basic", totalAmount: 1, amountDueNow: 1 }));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.ok(resRows(s, "G6").every(r => r.status === "cancelled"), "BLR hold released");
  assert.ok(refused.body.capacityReleased >= 1, "compensation reported");
  assert.deepEqual(arte(s, "CUS-A"), { bookings: 0, payments: 0, workOrders: 0 }, "zero money on refusal");

  const s2 = freshDb();
  await providerGov.seedProviderCapacityDefaults(db());
  s2.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,'active',1,'2026-08-01',NULL,'t',?)")
    .run("groom_maa_1", "maa", "L", "full_time", JSON.stringify(["grooming"]), JSON.stringify(["maa-central"]), 4.9, 97, 1, 30, 4, 0, Date.now());
  const a2 = await realCustomer("CUS-A2", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const sch2 = await reserve(a2, "G6M", { cityId: "maa", zoneId: "maa-central", start: MAA_START, end: MAA_END });
  const maa = await book(a2, bodyFor(a2, "G6M", sch2.provider, { serviceCode: "grooming", packageCode: "groom-basic", cityId: "maa", zoneId: "maa-central", start: MAA_START, end: MAA_END }));
  assert.equal(maa.status, 409, `Chennai missing policy must be 409: ${JSON.stringify(maa.body)}`);
  assert.ok(resRows(s2, "G6M").every(r => r.status === "cancelled"), "Chennai hold released");
});

test("7 a successful booking retains its reservation", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rex", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const sched = await reserve(a, "G7");
  const ok = await book(a, bodyFor(a, "G7", sched.provider));
  assert.equal(ok.status, 201);
  assert.ok(resRows(s, "G7").some(r => r.status !== "cancelled"), "the confirmed booking keeps its hold");
});

test("8 a saved pet profile survives minimal and blank repeat booking payloads", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Coco", species: "dog", breed: "Beagle", vaccinationStatus: "verified" }]);
  const sched = await reserve(a, "G8");
  await book(a, bodyFor(a, "G8", sched.provider, { pets: [{ sourceId: "Coco", name: "Coco", species: "dog" }] }));
  let seen = await cardPets(s, "CUS-A");
  assert.equal(seen[0].breed, "Beagle", "a minimal payload must not blank the saved breed");
  assert.equal(seen[0].vaccination_status, "verified");
  assert.equal(petRows(s, "CUS-A").length, 1, "no duplicate pet row minted");

  const sched2 = await reserve(a, "G8b", { start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z" });
  await book(a, bodyFor(a, "G8b", sched2.provider, { start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z", pets: [{ sourceId: "Coco", name: "Coco", species: "dog", breed: null, vaccinationStatus: "not_provided" }] }));
  seen = await cardPets(s, "CUS-A");
  assert.equal(seen[0].breed, "Beagle", "an explicit null breed must not erase the stored one");
  assert.equal(seen[0].vaccination_status, "verified", "'not_provided' must not demote a recorded status");
});

test("9 cross-customer pet identifiers cannot cross-resolve", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified" }]);
  const b = await realCustomer("CUS-B", [{ name: "Bruno", species: "dog", breed: "Pug", vaccinationStatus: "pending" }]);
  const aSource = petRows(s, "CUS-A")[0].id;
  const sched = await reserve(b, "G9");
  // B books using A's pet NAME and even A's canonical pet id as the source id.
  await book(b, bodyFor(b, "G9", sched.provider, { pets: [{ sourceId: aSource, name: "Bruno", species: "dog" }] }));
  const bSeen = await cardPets(s, "CUS-B");
  assert.equal(bSeen.every(p => p.breed !== "Labrador"), true, "B must never resolve onto A's pet");
  const aRows = petRows(s, "CUS-A");
  assert.equal(aRows.length, 1, "A's pet set untouched");
  assert.equal(aRows[0].breed, "Labrador", "A's profile untouched");
  assert.equal(aRows[0].vaccination_status, "verified");
});

test("10 an existing polluted duplicate does not pin the new booking to the blank row", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [{ name: "Rocky", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
  const sched = await reserve(a, "G10");
  await book(a, bodyFor(a, "G10", sched.provider, { pets: [{ sourceId: "seed", name: "Rocky", species: "dog" }] }));
  // The empty duplicate a pre-fix booking used to leave behind: keyed by the pet NAME, no profile.
  await db().prepare("INSERT OR IGNORE INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,NULL,'not_provided',?,?,?)")
    .bind("PET-CUSA-ROCKY", "CUS-A", "Rocky", "dog", "Rocky", Date.now(), Date.now()).run();
  const sched2 = await reserve(a, "G10b", { start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z" });
  await book(a, bodyFor(a, "G10b", sched2.provider, { start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z", pets: [{ sourceId: "Rocky", name: "Rocky", species: "dog" }] }));
  const seen = await cardPets(s, "CUS-A");
  assert.equal(seen.length, 1, `one pet on the card: ${JSON.stringify(seen)}`);
  assert.equal(seen[0].breed, "Indie", "the profiled row wins over the blank duplicate");
  assert.equal(seen[0].vaccination_status, "verified");
});

test("11 pricing and multi-pet governance are unchanged by pet resolution", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", [
    { name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified" },
    { name: "Milo", species: "cat", breed: "Persian", vaccinationStatus: "verified" },
  ]);
  const ids = petRows(s, "CUS-A").map(r => r.id);
  const sched = await reserve(a, "G11", { petIds: ids });
  const ok = await book(a, bodyFor(a, "G11", sched.provider, { pets: [{ sourceId: "Bruno", name: "Bruno", species: "dog" }, { sourceId: "Milo", name: "Milo", species: "cat" }] }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = s.prepare("SELECT pet_ids_json,source_pet_ids_json,total_amount FROM canonical_bookings WHERE id=?").get(ok.body.data.bookingId);
  assert.deepEqual(JSON.parse(row.source_pet_ids_json), ["Bruno", "Milo"], "submitted pet vector recorded verbatim");
  assert.equal(JSON.parse(row.pet_ids_json).length, 2, "pet count unchanged by resolution");
  assert.equal(row.total_amount, 2400, "client-priced total unchanged");
  const species = await db().prepare("SELECT name,species FROM canonical_pets WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.pet_ids_json).all();
  assert.deepEqual(species.results.map(r => `${r.name}:${r.species}`), ["Bruno:dog", "Milo:cat"], "species vector the governors price on is preserved");

  // Multi-pet policy enforcement still refuses beyond the city maximum (governance intact, 409 not 500).
  const many = Array.from({ length: 9 }, (_, i) => ({ sourceId: `p${i}`, name: `P${i}`, species: "dog" }));
  const sched2 = await reserve(a, "G11b", { petIds: ids, start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z" });
  const over = await book(a, bodyFor(a, "G11b", sched2.provider, { serviceCode: "grooming", packageCode: "groom-basic", pets: many, start: "2026-09-08T04:30:00.000Z", end: "2026-09-08T06:30:00.000Z" }));
  assert.equal(over.status, 409, `multi-pet governance must still refuse with 409: ${JSON.stringify(over.body)}`);
});
