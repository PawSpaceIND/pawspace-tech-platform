/**
 * Fixtures for the EXECUTED Fresh Food suites.
 *
 * Fresh Food is not a booking service: it has its own order, line, reservation, payment and event
 * tables, and the only foreign table it reads is canonical_pets. Everything else a Food test needs is
 * created by the module's own ensure*Tables exports, so these helpers stay small on purpose.
 */
export {
  freshSqlite, makeD1, refusal, nextKey, customerSessionCookie, seedActiveCommercialTerm, OPS_ORIGIN,
} from "./taxi-harness.mjs";
import { OPS_ORIGIN } from "./taxi-harness.mjs";

export const foodUrl = (path) => `${OPS_ORIGIN}${path}`;

/** DDL copied verbatim from lib/customer-account.ts, which owns canonical_pets. */
const CANONICAL_PETS_DDL = "CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

/**
 * A canonical pet for a customer. Fresh Food refuses a quote whose pets are missing, owned by
 * somebody else, or of the wrong species for the SKU, so every Food fixture starts here.
 */
export function seedFoodPet(sqlite, {
  petId = "PET-FOOD-1", customerId = "CUST-FOOD-1", name = "Bruno", species = "dog",
} = {}) {
  const now = Date.now();
  sqlite.exec(CANONICAL_PETS_DDL);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,'Indie','verified',NULL,?,?)")
    .run(petId, customerId, name, species, now, now);
  return { petId, customerId, species };
}

/** The three UAT catalogue SKUs, as lib/food-governance.ts seeds them. */
export const FOOD_SKUS = {
  dogAdult: { sku: "food-uat-dog-adult-2kg", price: 799, petType: "dog", packSize: "2 kg", stock: 30 },
  dogPuppy: { sku: "food-uat-dog-puppy-2kg", price: 849, petType: "dog", packSize: "2 kg", stock: 24 },
  catAdult: { sku: "food-uat-cat-adult-1kg", price: 499, petType: "cat", packSize: "1 kg", stock: 30 },
};

/**
 * A real Food order: a server quote, then the real createFoodOrder. Nothing is inserted by hand, so
 * the reservation, payment and event rows a test asserts on are the ones production would have
 * written.
 */
export async function seedFoodOrder(db, sqlite, {
  customerId = "CUST-FOOD-1", petId = "PET-FOOD-1", sku = FOOD_SKUS.dogAdult.sku,
  quantity = 1, zoneId = "blr-east", cityId = "blr", actorId = customerId, species = "dog",
} = {}) {
  const governance = await import("../../lib/food-governance.ts");
  await governance.ensureFoodGovernanceTables(db);
  seedFoodPet(sqlite, { petId, customerId, species });

  const quote = await governance.createFoodQuote(db, {
    sku, quantity, zoneId, paymentMode: "sandbox_deferred", customerId, petIds: [petId],
  });
  const order = await governance.createFoodOrder(db, {
    idempotencyKey: `idem-${quote.quoteId}`, quoteId: quote.quoteId, customerId, cityId, zoneId, actorId,
  });
  return { ...order, quote, customerId, petId, sku, quantity, zoneId, cityId, totalAmount: quote.totalAmount };
}
