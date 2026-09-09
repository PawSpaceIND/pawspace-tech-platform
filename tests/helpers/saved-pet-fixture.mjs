/** Explicit fixture setup: the production checkout now requires a saved, owned pet. */
export async function seedOwnedPet(db, customerId, petId, name = "Fixture dog") {
  const {ensureCustomerAccountTables} = await import("../../lib/customer-account.ts");
  await ensureCustomerAccountTables(db);
  await db.prepare("INSERT OR IGNORE INTO canonical_pets(id,customer_id,source_pet_id,name,species,vaccination_status,created_at,updated_at) VALUES (?,?,?,?,'dog','verified',?,?)").bind(petId,customerId,petId,name,Date.now(),Date.now()).run();
}

