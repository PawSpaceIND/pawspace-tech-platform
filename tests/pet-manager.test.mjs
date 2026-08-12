import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const component = read("app/mobile-app/pet-manager.tsx");
const componentCss = read("app/mobile-app/pet-manager.module.css");
const clientLib = read("lib/customer-account-client.ts");
const accountRoute = read("app/api/customer-account/route.ts");

const statementsOf = (source) => [...source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]);

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        sqlite.prepare(sql).run(...args);
        return { success: true, meta: {} };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; } };
}

async function accountStack({ legacyPetsTable = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  if (legacyPetsTable) {
    // The OLD canonical_pets DDL (without age/weight), exactly as another route creates it.
    const legacyDdl = statementsOf(read("app/api/canonical-bookings/route.ts")).find((sql) => sql.includes("CREATE TABLE IF NOT EXISTS canonical_pets"));
    assert.ok(legacyDdl, "legacy canonical_pets DDL found in its other creator");
    sqlite.exec(legacyDdl);
  }
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-PET-1", "blr", "Pet Parent", "9999900501", null, null, "customer_app", "{}", now, now);
  return { sqlite, db, account };
}

const rejectsWith = async (promise, status, pattern) => {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof Response, "server validation raises a Response");
  assert.equal(caught.status, status);
  assert.match(await caught.text(), pattern);
};

// ---------------------------------------------------------------------------
// Real execution — schema migration, add, edit-in-place, ownership, idempotency.
// ---------------------------------------------------------------------------
test("real execution: the owning lib migrates a legacy canonical_pets table with the new profile columns", async () => {
  const { sqlite } = await accountStack({ legacyPetsTable: true });
  const columns = sqlite.prepare("PRAGMA table_info(canonical_pets)").all().map((row) => row.name);
  assert.ok(columns.includes("age_years"), "age_years added to the pre-existing table");
  assert.ok(columns.includes("weight_kg"), "weight_kg added to the pre-existing table");
});

test("real execution: adding a pet persists the full profile and reads back typed", async () => {
  const { db, account } = await accountStack();
  const result = await account.mutateCustomerAccount(db, {
    customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: "pm-add-1",
    pet: { name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified", ageYears: 3, weightKg: 22.5 },
  });
  assert.equal(result.duplicatePrevented, false);
  const record = await account.readCustomerAccount(db, "CUS-PET-1");
  assert.equal(record.pets.length, 1);
  assert.deepEqual(
    { name: record.pets[0].name, species: record.pets[0].species, breed: record.pets[0].breed, vaccinationStatus: record.pets[0].vaccinationStatus, ageYears: record.pets[0].ageYears, weightKg: record.pets[0].weightKg },
    { name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified", ageYears: 3, weightKg: 22.5 }
  );
});

test("real execution: edit-in-place updates the same pet row (no duplicate) and preserves the source link", async () => {
  const { db, account } = await accountStack();
  const created = await account.mutateCustomerAccount(db, {
    customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: "pm-add-2",
    pet: { name: "Coco", species: "cat", sourceId: "Coco", vaccinationStatus: "pending", ageYears: 2, weightKg: 4 },
  });
  const updated = await account.mutateCustomerAccount(db, {
    customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: "pm-edit-1",
    pet: { id: created.entityId, name: "Coco", species: "cat", breed: "Persian", vaccinationStatus: "verified", ageYears: 3, weightKg: 4.4 },
  });
  assert.equal(updated.entityId, created.entityId, "edit targets the same canonical pet");
  const record = await account.readCustomerAccount(db, "CUS-PET-1");
  assert.equal(record.pets.length, 1, "editing never duplicates the pet");
  assert.equal(record.pets[0].breed, "Persian");
  assert.equal(record.pets[0].vaccinationStatus, "verified");
  assert.equal(record.pets[0].ageYears, 3);
  assert.equal(record.pets[0].weightKg, 4.4);
  assert.equal(record.pets[0].sourceId, "Coco", "flow source link survives edits");
});

test("real execution: a customer cannot edit another customer's pet", async () => {
  const { sqlite, db, account } = await accountStack();
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-PET-2", "blr", "Other Parent", "9999900502", null, null, "customer_app", "{}", now, now);
  const foreign = await account.mutateCustomerAccount(db, {
    customerId: "CUS-PET-2", action: "upsert_pet", idempotencyKey: "pm-foreign-1",
    pet: { name: "Rex", species: "dog", vaccinationStatus: "not_provided" },
  });
  await rejectsWith(
    account.mutateCustomerAccount(db, {
      customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: "pm-steal-1",
      pet: { id: foreign.entityId, name: "Hijacked", species: "dog", vaccinationStatus: "not_provided" },
    }),
    403, /Pet ownership denied/
  );
});

test("real execution: replaying the same idempotency key is a duplicate-prevented no-op", async () => {
  const { db, account } = await accountStack();
  const input = { customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: "pm-idem-1", pet: { name: "Milo", species: "dog", vaccinationStatus: "not_provided" } };
  const first = await account.mutateCustomerAccount(db, input);
  const replay = await account.mutateCustomerAccount(db, input);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.entityId, first.entityId);
});

// ---------------------------------------------------------------------------
// Validation — server rejects, and the shared pure validator flags identically.
// ---------------------------------------------------------------------------
test("real execution: server-side validation rejects bad pet profiles with clear messages", async () => {
  const { db, account } = await accountStack();
  const attempt = (pet, key) => account.mutateCustomerAccount(db, { customerId: "CUS-PET-1", action: "upsert_pet", idempotencyKey: key, pet });
  await rejectsWith(attempt({ name: "", species: "dog", vaccinationStatus: "not_provided" }, "pm-v1"), 400, /Pet name is required/);
  await rejectsWith(attempt({ name: "Rex", species: "parrot", vaccinationStatus: "not_provided" }, "pm-v2"), 400, /species must be dog, cat or other/);
  await rejectsWith(attempt({ name: "Rex", species: "dog", vaccinationStatus: "maybe" }, "pm-v3"), 400, /Vaccination status must be/);
  await rejectsWith(attempt({ name: "Rex", species: "dog", vaccinationStatus: "not_provided", ageYears: 99 }, "pm-v4"), 400, /age must be between 0 and 40/);
  await rejectsWith(attempt({ name: "Rex", species: "dog", vaccinationStatus: "not_provided", weightKg: 0 }, "pm-v5"), 400, /weight must be between 0 and 120/);
});

test("the UI validator is the server's validator — one shared pure function", async () => {
  const { petProfileIssues } = await import("../lib/customer-account.ts");
  assert.deepEqual(petProfileIssues({ name: "Bruno", species: "dog", vaccinationStatus: "verified", ageYears: 3, weightKg: 22 }), []);
  assert.match(petProfileIssues({ name: "", species: "parrot", vaccinationStatus: "maybe", ageYears: 99, weightKg: 500 }).join("; "), /name is required.*dog, cat or other.*Vaccination status.*0 and 40.*0 and 120/s);
  // The component imports and calls this exact function before submitting.
  assert.match(component, /import \{ petProfileIssues \} from "\.\.\/\.\.\/lib\/customer-account"/);
  assert.match(component, /petProfileIssues\(candidate\)/);
});

// ---------------------------------------------------------------------------
// Contract — component shape, client-lib-only IO, route ownership posture.
// ---------------------------------------------------------------------------
test("pet manager is embeddable with the required props and performs no direct fetches", () => {
  assert.match(component, /"use client"/);
  assert.match(component, /\{ customer, onPetsChanged \}: \{ customer: LoggedInCustomer; onPetsChanged\?/);
  assert.doesNotMatch(component, /fetch\(/, "all IO goes through the customer-account client lib");
  assert.match(component, /from "\.\.\/\.\.\/lib\/customer-account-client"/);
  assert.match(component, /onPetsChanged\?\.\(refreshed\)/, "flows are told when the pet list changes");
  assert.doesNotMatch(component, /from\s*"\.\/(grooming-flow|stay-flow|training-flow|walking-flow|food-flow|page)/);
});

test("pet manager offers the required fields with add and edit-in-place", () => {
  for (const marker of ['value="dog"', 'value="cat"', "Age (years)", "Weight (kg)", 'value="not_provided"', 'value="verified"', 'value="pending"']) {
    assert.ok(component.includes(marker), `form offers ${marker}`);
  }
  assert.match(component, /openEdit/, "edit-in-place entry point exists");
  assert.match(component, /form\?\.id === pet\.id \?/, "the pet row itself becomes the edit form");
  assert.match(component, /Save changes/);
  assert.match(componentCss, /#01261f/i);
  assert.match(componentCss, /#e6b34e/i);
  assert.match(componentCss, /system-ui/);
});

test("the account route keeps ownership server-side via the platform session", () => {
  assert.match(accountRoute, /resolvePlatformSession/, "customer identity resolves from the session when not supplied");
  assert.match(accountRoute, /requireCustomerOwnership/, "explicit customer IDs still pass the ownership check");
  assert.match(accountRoute, /sameOrigin\(request\)/, "writes carry the cross-origin guard");
  assert.match(clientLib, /idempotencyKey: `pet-manager:\$\{crypto\.randomUUID\(\)\}`/, "every save is idempotency-keyed");
});
