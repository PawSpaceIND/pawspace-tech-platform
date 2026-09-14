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
const PET_PROFILE_AUTHORITY = new Set(["lib/customer-account.ts"]);

test("PET-4: no booking surface overwrites pet profile columns unconditionally", () => {
  const offenders = fs.readdirSync(new URL("../app/api", import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith("route.ts"))
    .map((f) => `app/api/${String(f).replaceAll("\\", "/")}`)
    .concat(fs.readdirSync(new URL("../lib", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`))
    .filter((f) => !PET_PROFILE_AUTHORITY.has(f))
    /* Whitespace-tolerant on purpose: `vaccination_status = excluded.vaccination_status` is the same
     * destructive clause and an exact-match regex would wave it through. */
    .filter((f) => /INSERT INTO canonical_pets[\s\S]*?vaccination_status\s*=\s*excluded\s*\.\s*vaccination_status/i.test(read(f)));

  assert.deepEqual(offenders, [],
    `these write canonical_pets with the destructive clause; use CANONICAL_PET_UPSERT from lib/canonical-pet-upsert.ts:\n  ${offenders.join("\n  ")}`);
});

test("PET-5: every booking flow sends the pet's real vaccination status", () => {
  const flows = ["app/mobile-app/stay-flow.tsx", "app/mobile-app/taxi-flow.tsx"];
  for (const flow of flows) {
    const source = read(flow);
    assert.ok(!/vaccinationStatus:"(not_provided|)"/.test(source),
      `${flow} hardcodes a vaccination sentinel instead of sending the pet's own status`);
    assert.ok(/vaccinationStatus:p\.vaccinationStatus/.test(source),
      `${flow} builds a pets payload without the pet's vaccination status`);
  }
});
