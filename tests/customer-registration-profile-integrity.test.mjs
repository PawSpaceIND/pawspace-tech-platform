import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__T1_CUSTOMER_DB__", "__T1_CUSTOMER_ENV__");

const SECRET = "e2e100-t1-customer-identity-secret-000000000000000000";

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

async function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__T1_CUSTOMER_DB__ = db;
  globalThis.__T1_CUSTOMER_ENV__ = { PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: SECRET };
  const account = await import("../lib/customer-account.ts");
  await account.ensureCustomerAccountTables(db);
  return { sqlite, db, account };
}

async function register(db, phone, { name, cityId }) {
  const otp = await import("../lib/customer-otp.ts");
  const challenge = await otp.requestCustomerOtp(db, { phone });
  return otp.verifyCustomerOtp(db, {
    challengeId: challenge.challengeId,
    code: challenge.sandboxCode,
    name,
    cityId,
  });
}

test("concurrent OTP registrations for one phone bind to exactly one canonical customer", async () => {
  const { sqlite, db } = await fresh();
  const otp = await import("../lib/customer-otp.ts");
  const first = await otp.requestCustomerOtp(db, { phone: "+91 90000 01001" });
  const second = await otp.requestCustomerOtp(db, { phone: "9000001001" });

  const verified = await Promise.all([
    otp.verifyCustomerOtp(db, { challengeId: first.challengeId, code: first.sandboxCode, name: "First Request", cityId: "blr" }),
    otp.verifyCustomerOtp(db, { challengeId: second.challengeId, code: second.sandboxCode, name: "Second Request", cityId: "blr" }),
  ]);

  assert.equal(verified[0].customerId, verified[1].customerId, "both valid OTPs bind to the same canonical identity");
  const customers = sqlite.prepare("SELECT id,name,primary_phone FROM canonical_customers WHERE primary_phone=?").all("9000001001");
  assert.equal(customers.length, 1, "the registration race cannot create duplicate customer truth");
  assert.equal(verified[0].customerName, customers[0].name);
  assert.equal(verified[1].customerName, customers[0].name, "both responses describe the persisted customer");
});

test("registration, returning login, profile and address mutations round-trip through isolated D1", async () => {
  const { sqlite, db, account } = await fresh();
  const created = await register(db, "9000001002", { name: "Asha Rao", cityId: "blr" });

  await account.mutateCustomerAccount(db, {
    customerId: created.customerId,
    action: "update_profile",
    idempotencyKey: "E2E100-T1-001-profile",
    profile: {
      name: "Asha Rao",
      primaryPhone: "9000001002",
      secondaryPhone: "9000001099",
      email: "ASHA@EXAMPLE.COM",
      cityId: "mum",
    },
  });
  const address = await account.mutateCustomerAccount(db, {
    customerId: created.customerId,
    action: "upsert_address",
    idempotencyKey: "E2E100-T1-002-address",
    address: {
      label: "Home",
      line1: "12 Test Lane",
      area: "Andheri East",
      city: "Mumbai",
      postalCode: "400069",
      isDefault: true,
    },
  });

  const record = await account.readCustomerAccount(db, created.customerId);
  assert.deepEqual(
    { name: record.name, primaryPhone: record.primaryPhone, secondaryPhone: record.secondaryPhone, email: record.email, cityId: record.cityId },
    { name: "Asha Rao", primaryPhone: "9000001002", secondaryPhone: "9000001099", email: "asha@example.com", cityId: "mum" },
  );
  assert.deepEqual(
    { line1: record.addresses[0].line1, city: record.addresses[0].city, postalCode: record.addresses[0].postalCode, isDefault: record.addresses[0].isDefault },
    { line1: "12 Test Lane", city: "Mumbai", postalCode: "400069", isDefault: true },
  );

  const returning = await register(db, "+91-90000-01002", { name: "Should Not Replace Canonical Name", cityId: "hyd" });
  assert.equal(returning.customerId, created.customerId, "returning OTP login resolves the existing customer");
  assert.equal(returning.customerName, "Asha Rao", "login input cannot silently overwrite the customer profile");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM canonical_customers WHERE primary_phone=?").get("9000001002").count, 1);

  const other = await register(db, "9000001003", { name: "Other Customer", cityId: "blr" });
  await assert.rejects(
    account.mutateCustomerAccount(db, {
      customerId: other.customerId,
      action: "upsert_address",
      idempotencyKey: "E2E100-T1-002-cross-customer",
      address: { id: address.entityId, line1: "Tampered address", city: "Mumbai" },
    }),
    (error) => error instanceof Response && error.status === 403,
  );
});

test("customer profiles and addresses preserve all five UAT city identities", async () => {
  const { db, account } = await fresh();
  const cities = [
    ["blr", "Bengaluru", "560001"],
    ["mum", "Mumbai", "400001"],
    ["pnq", "Pune", "411001"],
    ["hyd", "Hyderabad", "500001"],
    ["maa", "Chennai", "600001"],
  ];

  for (const [index, [cityId, city, postalCode]] of cities.entries()) {
    const customer = await register(db, `90000011${String(index).padStart(2, "0")}`, { name: `${city} Customer`, cityId });
    await account.mutateCustomerAccount(db, {
      customerId: customer.customerId,
      action: "upsert_address",
      idempotencyKey: `E2E100-T1-city-${cityId}`,
      address: { line1: `${index + 1} UAT Street`, city, postalCode },
    });
    const record = await account.readCustomerAccount(db, customer.customerId);
    assert.equal(record.cityId, cityId);
    assert.equal(record.addresses[0].city, city);
    assert.equal(record.addresses[0].postalCode, postalCode);
  }
});

test("implemented Sitting visit and overnight packages are server-priced; unconfigured variants fail closed", async () => {
  const { db } = await fresh();
  const { createSittingQuote, listSittingPackages } = await import("../lib/sitting-governance.ts");
  const start = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const packages = await listSittingPackages(db, start.toISOString());
  assert.deepEqual(packages.map((item) => item.package_code), ["sitting-visit-60", "sitting-overnight"]);

  const visit = await createSittingQuote(db, {
    packageCode: "sitting-visit-60",
    petCount: 1,
    scheduledStart: start.toISOString(),
    scheduledEnd: new Date(start.getTime() + 60 * 60_000).toISOString(),
    paymentMode: "prepaid",
  });
  assert.equal(visit.mode, "visit");
  assert.equal(visit.billableUnits, 1);
  assert.equal(visit.amountDueNow, visit.totalAmount);

  const overnight = await createSittingQuote(db, {
    packageCode: "sitting-overnight",
    petCount: 1,
    scheduledStart: start.toISOString(),
    scheduledEnd: new Date(start.getTime() + 30 * 60 * 60_000).toISOString(),
    paymentMode: "prepaid",
  });
  assert.equal(overnight.mode, "overnight");
  assert.equal(overnight.billableUnits, 2);

  await assert.rejects(
    createSittingQuote(db, {
      packageCode: "sitting-daycare",
      petCount: 1,
      scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + 8 * 60 * 60_000).toISOString(),
      paymentMode: "prepaid",
    }),
    (error) => error instanceof Response && error.status === 404,
    "daycare remains an explicit catalogue/policy blocker instead of receiving an invented price",
  );
});
