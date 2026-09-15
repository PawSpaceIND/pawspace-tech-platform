/**
 * CONFIRMED customer-mispricing defect: booking Pet Sitting or Pet Taxi permanently DUPLICATED the
 * customer's pet in their own account.
 *
 * The three routes minted `PET-<customer>-<source>` for every pet in the payload and upserted it with
 * ON CONFLICT(id). A pet saved under its OWN source id — which is how the seeded accounts and
 * tests/helpers/saved-pet-fixture.mjs store one — can never collide with that mint, so the conflict
 * clause matched nothing and a SECOND row was INSERTED beside the customer's real profile:
 *
 *   GET /api/customer-account, one dog, after one sitting booking:
 *     {"id":"E2E-PET-UI-001","sourceId":"E2E-PET-UI-001","name":"Bruno","weightKg":14}
 *     {"id":"PET-E2ECUSUI001-E2EPETUI001","sourceId":"E2E-PET-UI-001","name":"Bruno","weightKg":null}
 *
 * Grooming prices PER PET. A customer who ticks both copies of their one dog is quoted and charged the
 * two-pet price, which is why this is a pricing defect and not a cosmetic one.
 *
 * Nothing here reads a source file. This drives the REAL /api/sitting-bookings route — real session,
 * real scheduling assignment, real server quote, real sandbox capture — over a real SQLite-backed D1,
 * and counts the rows the route left behind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

installWorkersHooks("__PET_DUP_DB__", "__PET_DUP_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  // Route code reached through another route's ensure* helpers re-enters batch(); only the outermost
  // batch owns the transaction, exactly as in tests/ptja-p0-regressions.test.mjs.
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function call(modulePath, method, path, body, cookie, extraHeaders = {}) {
  const route = await import(modulePath);
  const request = new Request(`https://uat.pawspace.in${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await route[method](request);
  return { status: response.status, body: await response.json() };
}

async function customerCookie(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "pet-duplicate-regression", reason: "pet duplication executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

/* One real customer owning ONE pet, saved the way the account and the seed store it: the row's id IS
 * its source id. Plus one real sitter assignment, one real server quote and one real sandbox capture. */
async function sittingWorld(tag) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PET_DUP_DB__ = db;
  globalThis.__PET_DUP_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_SCHEDULING_ENV: "uat",
    PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_MAPS_ENV: "sandbox",
  };
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY;");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedDefaultZones } = await import("../lib/service-zones.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedDefaultZones(db);
  await seedProviderCapacityDefaults(db);

  const customerId = `CUS-PETDUP-${tag}`;
  const savedPetId = `PETDUP${tag}`;
  await seedOwnedPet(db, customerId, savedPetId, "Bruno");
  // A breed the customer filled in themselves. The clause in lib/canonical-pet-upsert.ts must keep it,
  // and resolving to this row rather than minting must not cost it either.
  sqlite.prepare("UPDATE canonical_pets SET breed=? WHERE id=?").run("Indie", savedPetId);

  const cookie = await customerCookie(db, customerId);
  const start = new Date(Date.now() + 10 * 86_400_000);
  start.setUTCHours(6, 0, 0, 0);
  const scheduledStart = start.toISOString(), scheduledEnd = new Date(start.getTime() + 3_600_000).toISOString();
  const groupId = `PETDUP-${tag}`;

  const scheduled = await call("../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId, customerId, petIds: [savedPetId], serviceCode: "pet_sitting",
    cityId: "blr", zoneId: "blr-east", scheduledStart, scheduledEnd, occurrences: 1, careMode: "visit",
    serviceAddress: "42, Indiranagar Double Road, Stage 2, Bengaluru", servicePincode: "560038",
    preferredProviderId: "sit_sana",
  }, cookie);
  const provider = scheduled.body.data?.provider;
  assert.ok(provider, `sitter assignment failed: ${scheduled.status} ${JSON.stringify(scheduled.body)}`);

  const quoted = await call("../app/api/sitting-commercial/route.ts", "POST", "/api/sitting-commercial", {
    packageCode: "sitting-visit-60", petCount: 1, scheduledStart, scheduledEnd, paymentMode: "prepaid",
    cityId: "blr", zoneId: "blr-east",
  }, cookie);
  const quote = quoted.body.data;
  assert.ok(quote?.quoteId, `sitting quote failed: ${quoted.status} ${JSON.stringify(quoted.body)}`);

  const captured = await call("../app/api/sitting-payment-sandbox/route.ts", "POST", "/api/sitting-payment-sandbox",
    { quoteId: quote.quoteId, amount: quote.amountDueNow }, cookie, { "x-payment-capture-key": `petdup-${tag}` });
  assert.equal(captured.status, 201, `sandbox capture failed: ${JSON.stringify(captured.body)}`);

  const customer = { id: customerId, name: "Pet duplication customer", primaryPhone: "+919800001122" };
  return { sqlite, db, cookie, customer, customerId, savedPetId, provider, quote, groupId, scheduledStart, scheduledEnd };
}

const petsOf = (ctx) => ctx.sqlite
  .prepare("SELECT id,name,breed,vaccination_status,source_pet_id FROM canonical_pets WHERE customer_id=? ORDER BY created_at,id")
  .all(ctx.customerId);

test("a Pet Sitting booking leaves the customer with exactly ONE pet, not two", async () => {
  const ctx = await sittingWorld("A");
  assert.equal(petsOf(ctx).length, 1, "fixture: the customer owns exactly one pet before booking");

  const booked = await call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", {
    idempotencyKey: "petdup:sitting:A", scheduleGroupId: ctx.groupId, sittingQuoteId: ctx.quote.quoteId,
    customer: ctx.customer,
    // What the Stay flow sends for a saved pet: its source id and name, and no breed.
    pets: [{ sourceId: ctx.savedPetId, name: "Bruno", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east",
    packageCode: ctx.quote.packageCode, packageName: ctx.quote.packageName,
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: ctx.quote.totalAmount, amountDueNow: ctx.quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "pet duplication regression" },
  }, ctx.cookie);
  assert.equal(booked.status, 201, `the governed Sitting route must still book: ${JSON.stringify(booked.body)}`);

  const pets = petsOf(ctx);
  assert.equal(pets.length, 1,
    `booking duplicated the customer's one dog into ${pets.length} rows; grooming prices per pet, so ticking both copies quotes and charges the ${pets.length}-pet price: ${JSON.stringify(pets)}`);
  assert.equal(pets[0].id, ctx.savedPetId, "the saved row keeps its own id - the booking must not remint it");
  assert.deepEqual(booked.body.data.petIds, [ctx.savedPetId],
    "the booking must reference the customer's saved pet, not a stub of its own");

  // The preservation half of the same module must still hold through the resolved path.
  assert.equal(pets[0].breed, "Indie", "resolving to the saved row must not cost the customer their breed");
  assert.equal(pets[0].vaccination_status, "verified", "nor their vaccination status - boarding requires it");
});

test("a second Sitting booking for the same pet still leaves exactly ONE pet", async () => {
  /* The duplicate was permanent and cumulative: every booking re-inserted. One booking proves the mint
   * is gone; a second proves the resolved id is stable rather than drifting to a new row each time. */
  const ctx = await sittingWorld("B");
  const payload = (key) => ({
    idempotencyKey: key, scheduleGroupId: ctx.groupId, sittingQuoteId: ctx.quote.quoteId,
    customer: ctx.customer,
    pets: [{ sourceId: ctx.savedPetId, name: "Bruno", species: "dog", vaccinationStatus: "verified" }],
    cityId: "blr", zoneId: "blr-east",
    packageCode: ctx.quote.packageCode, packageName: ctx.quote.packageName,
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: ctx.quote.totalAmount, amountDueNow: ctx.quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "pet duplication regression" },
  });
  const first = await call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", payload("petdup:sitting:B1"), ctx.cookie);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // Same idempotency key replays; a different one meets the schedule-group guard. Either way the route
  // has now run its pet write twice, which is what the row count is being asked about.
  await call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", payload("petdup:sitting:B1"), ctx.cookie);

  const pets = petsOf(ctx);
  assert.equal(pets.length, 1, `repeat bookings over one dog produced ${pets.length} rows: ${JSON.stringify(pets)}`);
  assert.equal(pets[0].breed, "Indie");
  assert.equal(pets[0].vaccination_status, "verified");
});
