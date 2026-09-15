/*
 * A booking must never erase a pet profile the customer already filled in.
 *
 * The boarding route learned this the hard way and its conflict clause was rewritten to FILL blank
 * columns only. The sitting and both taxi routes kept the original `SET vaccination_status =
 * excluded.vaccination_status`, so the defect survived on three of the four booking surfaces:
 *
 *   customer saves pet, vaccination verified   ->  vaccination_status = 'verified'
 *   customer books a sitting stay or a taxi    ->  UI sends no status, route binds 'not_provided'
 *   stored value is overwritten                ->  vaccination_status = 'not_provided'
 *   customer books boarding for the same pet   ->  refused; boarding requires a verified status
 *
 * The customer sees a booking flow refusing a pet they vaccinated, with nothing on screen to explain
 * it. Breed was erased by the same clause, silently, on the same three paths.
 *
 * PET-1..PET-3 EXECUTE the real production clause against SQLite rather than reading it, because the
 * property at stake is what the database does, not what the source says. CANONICAL_PET_UPSERT is
 * imported from the module the routes themselves bind, so a rewrite of that clause is tested here as
 * the routes would experience it — the source-text version of this test passed against SQL that
 * erased the column.
 *
 * PET-4 and PET-5 are the source-level half: one clause is only a fix while every booking surface
 * actually routes through it, and a fifth surface added later must not quietly reintroduce its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CANONICAL_PET_UPSERT } from "../lib/canonical-pet-upsert.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PETS_DDL = "CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

/* Saves a pet the way the pet manager does, then replays one booking's write over it and reports
 * what survived. Bind order matches the route call sites exactly. */
function bookOverStoredPet(stored, booking) {
  const db = new DatabaseSync(":memory:");
  db.exec(PETS_DDL);
  db.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("PET-1", "CUST-1", stored.name, stored.species, stored.breed, stored.vaccinationStatus, "src-1", 1000, 1000);
  db.prepare(CANONICAL_PET_UPSERT)
    .run("PET-1", "CUST-1", booking.name, booking.species, booking.breed, booking.vaccinationStatus, "src-1", 2000, 2000);
  const row = db.prepare("SELECT breed,vaccination_status,updated_at FROM canonical_pets WHERE id=?").get("PET-1");
  db.close();
  return row;
}

const VACCINATED = { name: "Simba", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "verified" };
const BOOKING_WITH_NOTHING = { name: "Simba", species: "dog", breed: null, vaccinationStatus: "not_provided" };

test("PET-1: a booking carrying no vaccination status cannot erase a verified one", () => {
  const row = bookOverStoredPet(VACCINATED, BOOKING_WITH_NOTHING);
  assert.equal(row.vaccination_status, "verified",
    "booking a sitting stay or taxi ride reset the pet's vaccination status, which then blocks boarding");
});

test("PET-2: a booking carrying a real status still fills a blank one", () => {
  const row = bookOverStoredPet(
    { ...VACCINATED, vaccinationStatus: "not_provided" },
    { ...BOOKING_WITH_NOTHING, vaccinationStatus: "verified" },
  );
  assert.equal(row.vaccination_status, "verified", "the clause must still fill genuinely blank fields");
});

test("PET-3: a booking carrying no breed cannot erase a stored breed", () => {
  const row = bookOverStoredPet(VACCINATED, BOOKING_WITH_NOTHING);
  assert.equal(row.breed, "Labrador Retriever", "breed was erased by the same clause on the same paths");
  assert.equal(row.updated_at, 1000, "nothing was filled, so the row must not report a phantom edit");
});

/* lib/customer-account.ts is the pet manager: the customer editing their own pet profile. That write
 * is the AUTHORITY over these columns and must overwrite - a customer correcting a breed, or a status
 * lapsing from verified back to not_provided, has to be able to land. Only BOOKING writes are
 * constrained, so the exemption is by role, not convenience. */
const PET_PROFILE_AUTHORITY = new Set([
  "lib/customer-account.ts",
  /* The staff CSV import, behind customers.manage. Like the pet manager it is somebody deliberately
   * supplying the record rather than a booking passing through, so its write is authoritative and
   * has to be able to land. It writes name, species and breed and never touches vaccination_status,
   * so it was never part of the defect this file exists for. Whether a bulk import SHOULD be allowed
   * to overwrite a customer's own breed entry with spreadsheet data is a real question, and a
   * business one — flagged rather than decided here. */
  "app/api/admin/data-ingest/route.ts",
]);

/* The columns a customer fills in and a booking must never overwrite. Both were erased by the
 * original clause; a check covering only one of them is half a ratchet. */
const PET_PROFILE_COLUMNS = ["vaccination_status", "breed"];

test("PET-4: no booking surface overwrites pet profile columns unconditionally", () => {
  const offenders = fs.readdirSync(new URL("../app/api", import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith("route.ts"))
    .map((f) => `app/api/${String(f).replaceAll("\\", "/")}`)
    .concat(fs.readdirSync(new URL("../lib", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`))
    .filter((f) => !PET_PROFILE_AUTHORITY.has(f))
    /* Every column a booking can erase, not just vaccination. Breed was destroyed by the same clause
     * on the same paths, and a route reintroducing `breed=excluded.breed` alone would have walked
     * past a vaccination-only check. Whitespace-tolerant because `col = excluded.col` is the same
     * destructive write and an exact-match regex would wave it through. */
    .filter((f) => PET_PROFILE_COLUMNS.some((column) =>
      new RegExp(`INSERT INTO canonical_pets[\\s\\S]*?${column}\\s*=\\s*excluded\\s*\\.\\s*${column}`, "i").test(read(f))));

  assert.deepEqual(offenders, [],
    `these write canonical_pets with the destructive clause; use CANONICAL_PET_UPSERT from lib/canonical-pet-upsert.ts:\n  ${offenders.join("\n  ")}`);
});

test("PET-5: every booking flow sends the pet's real vaccination status", () => {
  /* Discovered, not listed. A hard-coded pair let a third booking client regress silently, which is
   * how taxi-flow came to send no status at all while stay-flow was being fixed. Any customer-facing
   * flow that builds a pets[] payload for a booking has to carry the pet's own status. */
  const flows = fs.readdirSync(new URL("../app/mobile-app", import.meta.url))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `app/mobile-app/${f}`)
    .filter((f) => /pets:\s*\w+\.map\(/.test(read(f)) && /vaccinationStatus/.test(read(f)));
  assert.ok(flows.length >= 2, `expected to discover the booking flows, found ${flows.length}`);
  for (const flow of flows) {
    const source = read(flow);
    assert.ok(!/vaccinationStatus:"(not_provided|)"/.test(source),
      `${flow} hardcodes a vaccination sentinel instead of sending the pet's own status`);
    assert.ok(/vaccinationStatus:p\.vaccinationStatus/.test(source),
      `${flow} builds a pets payload without the pet's vaccination status`);
  }
});

/* =====================================================================================================
 * The OTHER half of the same promise: a booking must never DUPLICATE a pet either.
 *
 * The clause above is guarded by ON CONFLICT(id), so it only ever protects the row a booking actually
 * addresses. The sitting and both taxi routes addressed a row they had MINTED — `PET-<customer>-<source>`
 * — without first asking whether the customer already had a row for that source id. A pet saved under
 * its OWN source id (seeded rows, anything whose id is not the minted shape) can never collide with that
 * mint, so ON CONFLICT(id) matched nothing and a SECOND row was INSERTED:
 *
 *   customer owns one dog, saved as   ->  id = 'E2E-PET-UI-001', source_pet_id = 'E2E-PET-UI-001'
 *   customer books sitting or taxi    ->  route mints 'PET-E2ECUSUI001-E2EPETUI001' and inserts it
 *   /api/customer-account now returns ->  the same dog, twice
 *   customer books grooming, which     ->  quoted and charged the TWO-PET price for one animal
 *   prices PER PET, and ticks both
 *
 * PET-6..PET-9 EXECUTE the real resolver and the real clause against SQLite, bound exactly as the routes
 * bind them. PET-10 is the source half: one resolver is only a fix while every surface routes through it.
 * ===================================================================================================== */
import { resolveCanonicalPets, mintCanonicalPetId } from "../lib/canonical-pet-upsert.ts";

/** The slice of D1 the resolver uses. node:sqlite is synchronous; D1 is not, so the shim is async. */
function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes || 0) } }),
  });
  return { prepare: (sql) => statement(sql) };
}

const CUSTOMER = "E2E-CUS-UI-001";

function accountWithSavedPet(extraRows = []) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(PETS_DDL);
  /* Exactly how tests/helpers/saved-pet-fixture.mjs and the seeded UAT account store a pet: the row's
   * id IS its source id. That is the shape the minted id can never match. */
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("E2E-PET-UI-001", CUSTOMER, "Bruno", "dog", "Indie", "verified", "E2E-PET-UI-001", 1000, 1000);
  for (const row of extraRows) {
    sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(row.id, CUSTOMER, row.name, row.species ?? "dog", row.breed ?? null, row.vaccinationStatus ?? "not_provided", row.sourceId ?? null, row.createdAt ?? 2000, row.createdAt ?? 2000);
  }
  return sqlite;
}

/* Replays one booking's canonical_pets write exactly as app/api/sitting-bookings/route.ts,
 * app/api/taxi-bookings/route.ts and app/api/taxi-ride-bookings/route.ts now do it: resolve identity
 * against the customer's saved rows, then bind CANONICAL_PET_UPSERT with what came back. Bind order and
 * argument order match the route call sites. */
async function book(sqlite, pets, now = 3000) {
  const resolved = await resolveCanonicalPets(d1(sqlite), CUSTOMER, pets);
  assert.ok(resolved.ok, `the booking was refused a pet identity: ${JSON.stringify(resolved)}`);
  for (const pet of resolved.pets) {
    sqlite.prepare(CANONICAL_PET_UPSERT)
      .run(pet.id, CUSTOMER, pet.name, pet.species, pet.breed, pet.vaccinationStatus, pet.sourceId, now, now);
  }
  return resolved.pets.map((pet) => pet.id);
}

const savedPets = (sqlite) => sqlite.prepare("SELECT id,name,breed,vaccination_status,source_pet_id FROM canonical_pets WHERE customer_id=? ORDER BY created_at,id").all(CUSTOMER);

/* What the sitting and taxi UIs actually send for a saved pet: the pet's source id and name, and no
 * breed. Sitting/taxi-ride also send the pet's own vaccination status; taxi sends none at all. Both
 * shapes are exercised, because the duplicate did not depend on the profile fields. */
const SITTING_PAYLOAD = [{ sourceId: "E2E-PET-UI-001", name: "Bruno", species: "dog", vaccinationStatus: "verified" }];
const TAXI_PAYLOAD = [{ sourceId: "E2E-PET-UI-001", name: "Bruno", species: "dog" }];

test("PET-6: booking sitting for a pet saved under its OWN source id leaves exactly ONE pet row", async () => {
  const sqlite = accountWithSavedPet();
  const ids = await book(sqlite, SITTING_PAYLOAD);
  const pets = savedPets(sqlite);

  assert.equal(pets.length, 1,
    `the customer owns one dog; booking minted a duplicate, so grooming prices per pet would quote the ${pets.length}-pet price: ${JSON.stringify(pets)}`);
  assert.equal(pets[0].id, "E2E-PET-UI-001", "the saved row keeps its own id - the booking must not remint it");
  assert.deepEqual(ids, ["E2E-PET-UI-001"], "the booking must reference the saved row, not a stub of its own");
  assert.equal(pets[0].breed, "Indie", "resolving to the saved row must not cost the customer their breed");
  assert.equal(pets[0].vaccination_status, "verified", "nor their vaccination status - boarding requires it");
});

test("PET-7: booking taxi over the same pet still leaves exactly ONE pet row", async () => {
  const sqlite = accountWithSavedPet();
  await book(sqlite, TAXI_PAYLOAD, 3000);
  await book(sqlite, SITTING_PAYLOAD, 4000);
  const pets = savedPets(sqlite);

  assert.equal(pets.length, 1, `two bookings over one dog produced ${pets.length} rows: ${JSON.stringify(pets)}`);
  assert.equal(pets[0].breed, "Indie", "a taxi booking carrying no breed must not erase the stored one");
  assert.equal(pets[0].vaccination_status, "verified", "nor the stored vaccination status");
});

test("PET-8: a genuinely NEW pet is still minted - the fix is not a refusal to insert", async () => {
  /* Non-vacuity. A resolver that matched everything would satisfy PET-6 and PET-7 just as well while
   * silently binding a second dog to the first dog's row - unrecoverable, unlike a duplicate. */
  const sqlite = accountWithSavedPet();
  const ids = await book(sqlite, [{ sourceId: "E2E-PET-UI-002", name: "Rex", species: "dog", breed: "Beagle" }]);
  const pets = savedPets(sqlite);

  assert.equal(pets.length, 2, "a pet the customer has not saved must still be created");
  assert.deepEqual(ids, [mintCanonicalPetId(CUSTOMER, "E2E-PET-UI-002")], "a new pet gets the minted id");
  const rex = pets.find((row) => row.name === "Rex");
  assert.equal(rex.breed, "Beagle", "and the new pet keeps what the booking supplied");
  assert.equal(rex.source_pet_id, "E2E-PET-UI-002", "bound to its own source id, not the other dog's");
});

test("PET-9: a duplicate minted before the fix is adopted, not joined by a third row", async () => {
  /* Accounts already carry the stub this defect minted. The next booking has to land on the customer's
   * real profile - the row with breed and vaccination - rather than mint again or bind to the stub. */
  const sqlite = accountWithSavedPet([
    { id: mintCanonicalPetId(CUSTOMER, "E2E-PET-UI-001"), name: "Bruno", sourceId: "E2E-PET-UI-001", createdAt: 2000 },
  ]);
  const ids = await book(sqlite, SITTING_PAYLOAD);
  const pets = savedPets(sqlite);

  assert.equal(pets.length, 2, "healing is out of scope here; what matters is that no THIRD row appears");
  assert.deepEqual(ids, ["E2E-PET-UI-001"], "the booking must bind the customer's real profile, not the stub");
  assert.equal(pets.find((row) => row.id === "E2E-PET-UI-001").vaccination_status, "verified");
});

test("PET-10: every booking surface resolves pet identity before it mints an id", async () => {
  /* Discovered, not listed - the same reason PET-4 and PET-5 discover their inputs. Three routes carried
   * their own copy of the mint precisely because the shared module only ever held half the contract. */
  const surfaces = fs.readdirSync(new URL("../app/api", import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith("route.ts"))
    .map((f) => `app/api/${String(f).replaceAll("\\", "/")}`)
    .filter((f) => /CANONICAL_PET_UPSERT/.test(read(f)));
  assert.ok(surfaces.length >= 3, `expected to discover the booking surfaces, found ${surfaces.length}`);

  const offenders = surfaces.filter((f) => {
    const source = read(f);
    /* Either it uses the shared resolver, or - as app/api/canonical-bookings/route.ts does - it reads
     * the customer's own canonical_pets rows by source_pet_id itself before minting. What is refused is
     * a route that mints an id and upserts on it with no identity lookup at all. */
    return !/resolveCanonicalPets\s*\(/.test(source)
      && !/source_pet_id[\s\S]{0,200}FROM canonical_pets WHERE customer_id=\?/.test(source);
  });
  assert.deepEqual(offenders, [],
    `these mint a canonical_pets id without resolving the customer's saved pets first, so a booking duplicates the pet; use resolveCanonicalPets from lib/canonical-pet-upsert.ts:\n  ${offenders.join("\n  ")}`);
});
