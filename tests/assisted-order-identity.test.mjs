/**
 * QA (H2): staff assisted booking failed with 403 "Pet ownership denied" for a new CRM lead and for an existing
 * customer, because pets were sent to the scheduler by their browser source id and a lead's pet was never saved;
 * the request also carried Customer 360's masked phone/email. These cases run the identity step on real SQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__ASSISTED_IDENTITY_DB__", "__ASSISTED_IDENTITY_ENV__");
const { ensureCustomerAccountTables, mutateCustomerAccount } = await import("../lib/customer-account.ts");
const { assistedCustomer, assistedPetIds } = await import("../lib/assisted-order-identity.ts");

async function world() {
  const sqlite = new DatabaseSync(":memory:"), db = d1(sqlite);
  await ensureCustomerAccountTables(db);
  sqlite.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT)");
  return { sqlite, db };
}
const masked = { primaryPhone: "+91 ••••••1234", email: "•••@pawspace.test" };

test("an existing customer books with their saved pet's canonical id and real contact, never the masked copy", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,source,consent_json,created_at,updated_at) VALUES ('CU-1','blr','Meera','+919800000101','meera@pawspace.test','uat','{}',1,1)").run();
  await mutateCustomerAccount(db, { customerId: "CU-1", action: "upsert_pet", idempotencyKey: "seed-bruno", pet: { sourceId: "crm-bruno", name: "Bruno", species: "dog", vaccinationStatus: "verified" } });
  const saved = sqlite.prepare("SELECT id FROM canonical_pets WHERE customer_id='CU-1'").get().id;
  const resolved = await assistedCustomer(db, { id: "CU-1", name: "Meera", ...masked });
  assert.equal(resolved.customer.primaryPhone, "+919800000101");
  assert.equal(resolved.customer.email, "meera@pawspace.test");
  const pets = await assistedPetIds(db, resolved, { idempotencyKey: "k1", customer: resolved.customer, pets: [{ sourceId: "Bruno", canonicalId: saved, name: "Bruno", species: "dog" }] });
  assert.deepEqual(pets.ids, [saved]);
  assert.equal(pets.pets[0].sourceId, "crm-bruno", "the booking receives the stored source id, so it reuses the same pet");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_pets").get().n, 1, "no duplicate pet");
});

test("a CRM lead's pet is saved to a new canonical customer before the groomer is reserved", async () => {
  const { sqlite, db } = await world();
  sqlite.prepare("INSERT INTO crm_contacts VALUES ('CU-28963','Priya Lead Test','+919876500001','priya@pawspace.test')").run();
  const resolved = await assistedCustomer(db, { id: "CU-28963", name: "Priya Lead Test", ...masked });
  assert.equal(resolved.customer.primaryPhone, "+919876500001");
  const pets = await assistedPetIds(db, resolved, { idempotencyKey: "k2", cityId: "blr", customer: resolved.customer, pets: [{ sourceId: "Coco", name: "Coco", species: "dog" }] });
  const row = sqlite.prepare("SELECT id,customer_id,species FROM canonical_pets").get();
  assert.deepEqual(pets.ids, [row.id]);
  assert.equal(row.customer_id, "CU-28963");
  assert.equal(sqlite.prepare("SELECT primary_phone FROM canonical_customers WHERE id='CU-28963'").get().primary_phone, "+919876500001");
});

test("a masked phone with no stored contact is refused instead of being saved on a booking", async () => {
  const { db } = await world();
  await assert.rejects(assistedCustomer(db, { id: "CU-UNKNOWN", name: "Nobody", ...masked }), error => error instanceof Response && error.status === 400);
});
