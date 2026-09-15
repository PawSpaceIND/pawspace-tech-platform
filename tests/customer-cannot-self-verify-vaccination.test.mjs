/*
 * A customer could mark their own pet's vaccination "verified".
 *
 * `/api/customer-account` is customer-scoped, so every caller of upsert_pet is the pet's owner. Two
 * paths wrote the strongest value in the enum straight from the owner's own tick-box: a top-level
 * `vaccinationStatus`, and the rich-profile branch (`vaccinated ? "verified" : "not_provided"`).
 * Neither did any verifying. A host or ops user deciding whether to accept a pet reads that column.
 *
 * MEASURED before the fix, against the real engine: a hand-crafted upsert_pet asking for "verified"
 * stored exactly that. A screen-side fix cannot close this - the request need not come from a screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__VACCINATION_SELF_VERIFY_DB__");

const CUSTOMER = "CUS-VAX-CONTRACT";
let seq = 0;
const upsert = async (db, pet) => {
  const { mutateCustomerAccount } = await import("../lib/customer-account.ts");
  return mutateCustomerAccount(db, { customerId: CUSTOMER, action: "upsert_pet", idempotencyKey: `vax-${seq += 1}`, pet });
};
const statusOf = async (db, id) =>
  String((await db.prepare("SELECT vaccination_status FROM canonical_pets WHERE id=?").bind(id).first())?.vaccination_status ?? "");

async function world() {
  const harness = freshCountingD1();
  globalThis.__VACCINATION_SELF_VERIFY_DB__ = harness.db;
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureCustomerAccountTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(CUSTOMER, "blr", "Vax Contract", "9100000441", "uat_customer_app", "{}", now, now).run();
  return harness;
}

test("VAX-SELF-1: an owner asking for `verified` gets a claim, not a verification", async () => {
  const { db } = await world();
  await upsert(db, { id: "PET-SELF", name: "Simba", species: "dog", vaccinationStatus: "verified" });
  const stored = await statusOf(db, "PET-SELF");
  assert.notEqual(stored, "verified", "a customer must not be able to verify their own pet");
  assert.equal(stored, "pending", "their claim is recorded as awaiting verification");
});

test("VAX-SELF-2: a staff verification survives the owner editing the pet", async () => {
  // The opposite failure mode: clamping must not silently revoke a verification staff really did.
  const { db } = await world();
  await upsert(db, { id: "PET-STAFF", name: "Kaju", species: "dog", vaccinationStatus: "pending" });
  await db.prepare("UPDATE canonical_pets SET vaccination_status='verified' WHERE id=?").bind("PET-STAFF").run();
  await upsert(db, { id: "PET-STAFF", name: "Kaju Renamed", species: "dog", vaccinationStatus: "pending" });
  assert.equal(await statusOf(db, "PET-STAFF"), "verified", "renaming a pet must not revoke a staff verification");
});

test("VAX-SELF-3: the values staff paths actually stamp can round-trip an owner edit", async () => {
  // lib/pet-vaccination-governance.ts stamps "recorded"; seeded rows carry "vaccinated". Both used to
  // be refused by this endpoint, so editing such a pet lowered it.
  const { db } = await world();
  for (const staffValue of ["recorded", "vaccinated"]) {
    const id = `PET-${staffValue.toUpperCase()}`;
    await upsert(db, { id, name: staffValue, species: "dog", vaccinationStatus: "not_provided" });
    await db.prepare("UPDATE canonical_pets SET vaccination_status=? WHERE id=?").bind(staffValue, id).run();
    await upsert(db, { id, name: `${staffValue} renamed`, species: "dog", vaccinationStatus: "not_provided" });
    assert.equal(await statusOf(db, id), staffValue, `${staffValue} must survive an owner edit`);
  }
});

test("VAX-SELF-4: an owner can still say no, and that is honoured", async () => {
  const { db } = await world();
  await upsert(db, { id: "PET-NO", name: "Nobody", species: "dog", vaccinationStatus: "not_provided" });
  assert.equal(await statusOf(db, "PET-NO"), "not_provided", "the clamp must not invent a claim nobody made");
});
