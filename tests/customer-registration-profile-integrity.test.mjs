import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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
      address: { id: address.entityId, line1: "Tampered address", city: "Mumbai", postalCode: "400069" },
    }),
    (error) => error instanceof Response && error.status === 403,
  );
  // Without a PIN the same tamper is refused as invalid input before the ownership lookup (the order
  // upsert_pet already uses). Either refusal leaves the victim's address exactly as it was.
  await assert.rejects(
    account.mutateCustomerAccount(db, {
      customerId: other.customerId,
      action: "upsert_address",
      idempotencyKey: "E2E100-T1-002-cross-customer-no-pin",
      address: { id: address.entityId, line1: "Tampered address", city: "Mumbai" },
    }),
    (error) => error instanceof Response && error.status === 400,
  );
  const victim = await account.readCustomerAccount(db, created.customerId);
  assert.deepEqual(
    victim.addresses.map((a) => ({ id: a.id, line1: a.line1, city: a.city, postalCode: a.postalCode, isDefault: a.isDefault })),
    [{ id: address.entityId, line1: "12 Test Lane", city: "Mumbai", postalCode: "400069", isDefault: true }],
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM customer_addresses WHERE customer_id=?").get(other.customerId).count, 0);
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


test("malformed optional email cannot mutate a profile or consume its retry key", async () => {
  const {sqlite, db, account} = await fresh();
  const created = await register(db, "9000001090", {name:"Email QA", cityId:"blr"});
  const input = {customerId:created.customerId, action:"update_profile", idempotencyKey:"email-correction"};
  for (const email of ["invalid-email", "a@@example.com", "a b@example.com", "a@.com", "a@example..com", {}, 17, "a".repeat(250)+"@example.com"]) {
    let rejected;
    try { await account.mutateCustomerAccount(db, {...input, profile:{name:"Must not save",email}}); }
    catch(error) { rejected=error; }
    assert.equal(rejected?.status,400);
    assert.deepEqual(await rejected.json(),{error:"Enter a valid email address.",code:"invalid_email"});
    const record=await account.readCustomerAccount(db,created.customerId);
    assert.equal(record.name,"Email QA"); assert.equal(record.email,null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_account_mutations").get().n,0);
  }
  await account.mutateCustomerAccount(db,{...input,profile:{email:"  QA+Test@Example.COM "}});
  assert.equal((await account.readCustomerAccount(db,created.customerId)).email,"qa+test@example.com");
  await account.mutateCustomerAccount(db,{...input,idempotencyKey:"email-omitted",profile:{name:"Email QA Updated"}});
  assert.equal((await account.readCustomerAccount(db,created.customerId)).email,"qa+test@example.com");
  await account.mutateCustomerAccount(db,{...input,idempotencyKey:"email-clear",profile:{email:null}});
  assert.equal((await account.readCustomerAccount(db,created.customerId)).email,null);
});

// A saved address is the default that Training, stays, Assisted Orders and the AI concierge book from,
// by its PIN. upsert_address therefore requires a valid PIN from every caller, not just the forms.
const PIN_REFUSAL = {error:"Enter a 6-digit PIN code", code:"invalid_postal_code"};
const BAD_PINS = [undefined, null, "", "  ", "56003", "5600381", "056003", "560 038", "56OO38", {}, []];

test("an address without a valid PIN cannot be saved or consume its retry key", async () => {
  const {sqlite, db, account} = await fresh();
  const {isGovernedHttpError} = await import("../lib/governed-http-error.ts");
  const created = await register(db, "9000001091", {name:"PIN QA", cityId:"blr"});
  const input = {customerId:created.customerId, action:"upsert_address", idempotencyKey:"address-pin-correction"};
  const address = {label:"Home", line1:"42 Indiranagar Double Road", area:"Indiranagar", city:"Bengaluru", isDefault:true};
  for (const postalCode of BAD_PINS) {
    let rejected;
    try { await account.mutateCustomerAccount(db, {...input, address:{...address, postalCode}}); }
    catch(error) { rejected=error; }
    assert.ok(rejected instanceof Response && isGovernedHttpError(rejected), `${JSON.stringify(postalCode)} is refused with a caller-safe body`);
    assert.equal(rejected.status,400);
    assert.deepEqual(await rejected.json(),PIN_REFUSAL);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses").get().n,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_account_mutations").get().n,0);
  }
  const saved = await account.mutateCustomerAccount(db,{...input,address:{...address,postalCode:"560038"}});
  assert.equal(saved.duplicatePrevented,false,"the refused attempts did not consume the retry key");
  const record = await account.readCustomerAccount(db,created.customerId);
  assert.deepEqual(record.addresses.map(a=>({line1:a.line1,postalCode:a.postalCode,isDefault:a.isDefault})),[{line1:"42 Indiranagar Double Road",postalCode:"560038",isDefault:true}]);
});

test("a numeric or padded PIN is stored as the validated six digits", async () => {
  const {sqlite, db, account} = await fresh();
  const created = await register(db, "9000001092", {name:"PIN Format QA", cityId:"blr"});
  for (const [idempotencyKey, line1, postalCode] of [["pin-number","1 Numeric Road",560038],["pin-padded","2 Padded Road"," 560038 "]]) {
    await account.mutateCustomerAccount(db,{customerId:created.customerId,action:"upsert_address",idempotencyKey,address:{line1,city:"Bengaluru",postalCode}});
    assert.equal(sqlite.prepare("SELECT postal_code FROM customer_addresses WHERE line1=?").get(line1).postal_code,"560038",line1);
  }
  const record = await account.readCustomerAccount(db,created.customerId);
  assert.deepEqual(record.addresses.map(a=>a.postalCode),["560038","560038"]);
});

test("a PIN-less save cannot displace a working default or wipe a stored PIN by id", async () => {
  const {sqlite, db, account} = await fresh();
  const created = await register(db, "9000001093", {name:"Default QA", cityId:"blr"});
  const save = (idempotencyKey, address) => account.mutateCustomerAccount(db,{customerId:created.customerId,action:"upsert_address",idempotencyKey,address});
  const home = await save("default-home",{label:"Home",line1:"42 Indiranagar Double Road",area:"Indiranagar",city:"Bengaluru",postalCode:"560038",isDefault:true});
  const row = () => ({...sqlite.prepare("SELECT label,line1,area,postal_code,is_default,updated_at FROM customer_addresses WHERE id=?").get(home.entityId)});
  const before = row();
  assert.deepEqual({...before,updated_at:0},{label:"Home",line1:"42 Indiranagar Double Road",area:"Indiranagar",postal_code:"560038",is_default:1,updated_at:0});
  const refused = (error) => error instanceof Response && error.status === 400;
  // A new default clears is_default on every other row first; a PIN-less one must not get that far.
  await assert.rejects(save("default-office",{label:"Office",line1:"1 MG Road",city:"Bengaluru",isDefault:true}),refused);
  // An update by id writes postal_code=excluded.postal_code; without a PIN that would store NULL.
  await assert.rejects(save("default-edit",{id:home.entityId,label:"Home",line1:"42 Indiranagar Double Road, Stage 2",city:"Bengaluru",postalCode:"",isDefault:true}),refused);
  await assert.rejects(save("default-edit-absent",{id:home.entityId,label:"Home",line1:"42 Indiranagar Double Road, Stage 2",city:"Bengaluru"}),refused);
  assert.deepEqual(row(),before,"the default keeps its PIN, its flag and its timestamp");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_addresses").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM customer_account_mutations WHERE idempotency_key LIKE 'default-%'").get().n,1);
  // The same id with its PIN is the supported in-place edit, and it stays the only default.
  await save("default-edit-with-pin",{id:home.entityId,label:"Home",line1:"42 Indiranagar Double Road, Stage 2",area:"Indiranagar",city:"Bengaluru",postalCode:"560038",isDefault:true});
  const record = await account.readCustomerAccount(db,created.customerId);
  assert.deepEqual(record.addresses.map(a=>({id:a.id,line1:a.line1,postalCode:a.postalCode,isDefault:a.isDefault})),[{id:home.entityId,line1:"42 Indiranagar Double Road, Stage 2",postalCode:"560038",isDefault:true}]);
});

test("the account form and upsert_address share one pure address rule", async () => {
  const {customerAddressIssue} = await import("../lib/customer-account.ts");
  for (const line1 of [undefined, null, "", "   "]) assert.deepEqual(customerAddressIssue({line1,postalCode:"560038"}),{error:"Address line 1 is required",code:"invalid_address"},String(line1));
  for (const postalCode of BAD_PINS) assert.deepEqual(customerAddressIssue({line1:"12 Test Lane",postalCode}),PIN_REFUSAL,JSON.stringify(postalCode));
  for (const postalCode of ["560038"," 560038 ",560038,"400069"]) assert.equal(customerAddressIssue({line1:"12 Test Lane",postalCode}),null,String(postalCode));
  assert.deepEqual(customerAddressIssue({}),{error:"Address line 1 is required",code:"invalid_address"},"line1 is reported before the PIN");
  // Under Node the extensionless import resolves to the lib/pincode-validation ESM shim, which coerces
  // with String(). lib/pincode-validation.ts does not: it calls .trim() and throws on a number. So the
  // coercion must happen in customerAddressIssue itself, whichever file the runtime picks.
  const {validateIndianPincode} = await import("../lib/pincode-validation.ts");
  assert.throws(() => validateIndianPincode(560038), TypeError);
  assert.match(readFileSync(new URL("../lib/customer-account.ts", import.meta.url), "utf8"), /validateIndianPincode\(safe\(a\.postalCode\)\)/);
});
