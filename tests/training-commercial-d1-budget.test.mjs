/*
 * D1 round-trip budgets for the per-request schema and seed work on the Training booking path.
 *
 * Staging master E2E run 36243387701 (commit 7dd8f5c): the V2 Meet & Greet reserve and the mobile Basic
 * Obedience reserve both ended in the client's 20 s abort ("The request took too long. Please try again.").
 * A Training create is a fixed chain of 55-74 sequential D1 round trips, about 0.26 s each from the CI runner,
 * and ensureTrainingCommercialTables - run by every Training quote and every Training create - spent 13 of
 * them on idempotent work: a CREATE batch, two PRAGMA column checks, eight INSERT OR IGNORE seeds one by one
 * and two repair SELECTs. ensureControlRuntimeTables added 7 more to every non-GET /api request.
 *
 * Counted on an existing schema with the shared harness (a batch is one subrequest, as it is on D1):
 *
 *   ensureTrainingCommercialTables      13 -> 3     a Training quote          16 -> 6
 *   seedUatCoupons                       6 -> 3     a governed-coupon quote   19 -> 9
 *   ensureControlRuntimeTables           7 -> 1
 *
 * Fewer calls must not mean different results: the same catalogue rows, the same quote, and the founder-seed
 * repairs still run on every call (only the column checks are remembered per binding - a column never goes).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeCountingD1, freshCountingD1, assertWithinBudget, assertDoesNotScale } from "./helpers/d1-harness.mjs";

installWorkersHooks("__TRAINING_COMMERCIAL_D1_BUDGET_DB__");
const commercial = await import("../lib/training-commercial-governance.ts");
const coupons = await import("../lib/coupon-governance.ts");
const controls = await import("../lib/control-runtime-switches.ts");

const DAY = 86_400_000;
function futureStart(days) {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(5, 30, 0, 0);
  return start.toISOString();
}
/** A database whose Training schema already exists - every request after the first one in production. */
async function existingSchema() {
  const harness = freshCountingD1();
  await commercial.ensureTrainingCommercialTables(harness.db);
  return harness;
}
/** Every call through a NEW binding over the same database, so nothing is remembered between calls - the way the
 * column checks ran on every request before. The reference the remembered path has to match. */
function perCallBindings(sqlite) { return () => makeCountingD1(sqlite).db; }

const CATALOGUE = "SELECT package_code,name,sessions,validity_days,base_price,currency,meet_and_greet,max_pets,direct_minutes_per_pet,coaching_minutes_per_pet,split_due_percent,extra_pet_percent,active,version,effective_from,effective_to,updated_by FROM training_commercial_packages ORDER BY package_code";
const catalogue = (sqlite) => sqlite.prepare(CATALOGUE).all().map((row) => ({ ...row }));
/** The founder seed as it has always been written: code, name, sessions, validity, price, M&G, max pets, minutes, split %. */
const FOUNDER = [
  ["trainer-meet-greet", "Trainer Meet & Greet", 1, 7, 500, 1, 4, 45, 15, 0],
  ["training-12-advanced", "Advanced Obedience Plan", 12, 93, 16500, 0, 4, 45, 15, 50],
  ["training-12-leash", "Leash Obedience Plan · 12", 12, 93, 16500, 0, 4, 45, 15, 50],
  ["training-16-pro", "Pro Training Plan", 16, 120, 20000, 0, 4, 45, 15, 50],
  ["training-2-starter", "Starter Plan", 2, 31, 3500, 0, 4, 45, 15, 50],
  ["training-4-puppy", "Puppy Training Plan", 4, 31, 6000, 0, 4, 45, 15, 50],
  ["training-8-basic", "Basic Obedience Plan", 8, 62, 12000, 0, 4, 45, 15, 50],
  ["training-8-leash", "Leash Obedience Plan · 8", 8, 62, 12000, 0, 4, 45, 15, 50],
].map(([package_code, name, sessions, validity_days, base_price, meet_and_greet, max_pets, direct_minutes_per_pet, coaching_minutes_per_pet, split_due_percent]) => ({ package_code, name, sessions, validity_days, base_price, currency: "INR", meet_and_greet, max_pets, direct_minutes_per_pet, coaching_minutes_per_pet, split_due_percent, extra_pet_percent: 60, active: 1, version: 1, effective_from: "2026-08-01", effective_to: null, updated_by: "founder_seed" }));
/** A quote minus what is minted per request (its id and expiry). */
const terms = ({ quoteId, expiresAt, ...rest }) => (assert.match(quoteId, /^TQ-/), assert.ok(expiresAt > Date.now()), rest);
const storedQuote = (sqlite, id) => { const row = { ...sqlite.prepare("SELECT * FROM training_commercial_quotes WHERE id=?").get(id) }; for (const minted of ["id", "created_at", "expires_at"]) delete row[minted]; return row; };

test("ensureTrainingCommercialTables costs 3 D1 calls on an existing schema and seeds the same founder catalogue", async () => {
  const harness = freshCountingD1();
  // First sight of a binding: CREATE batch, both column checks, the seed batch and the repair read.
  await assertWithinBudget(harness, { max: 5, min: 5, label: "first ensureTrainingCommercialTables on a binding" }, () => commercial.ensureTrainingCommercialTables(harness.db));
  // Every later request: CREATE batch, seed batch, one read for both repair rows (was 13 calls, 39 rows).
  await assertWithinBudget(harness, { max: 3, min: 3, maxRows: 2, label: "ensureTrainingCommercialTables on an existing schema" }, () => commercial.ensureTrainingCommercialTables(harness.db));
  assert.deepEqual(catalogue(harness.sqlite), FOUNDER, "the batched seeds write exactly the founder catalogue");

  // The same calls with nothing remembered between them leave the same rows.
  const reference = new DatabaseSync(":memory:"), binding = perCallBindings(reference);
  for (let i = 0; i < 2; i += 1) await commercial.ensureTrainingCommercialTables(binding());
  assert.deepEqual(catalogue(reference), catalogue(harness.sqlite));

  // INSERT OR IGNORE: a package Finance edited is never re-seeded over, batched or not.
  harness.sqlite.prepare("UPDATE training_commercial_packages SET base_price=13000,version=2,updated_by='finance@pawspace.in' WHERE package_code='training-8-basic'").run();
  await commercial.ensureTrainingCommercialTables(harness.db);
  assert.deepEqual({ ...harness.sqlite.prepare("SELECT base_price,version,updated_by FROM training_commercial_packages WHERE package_code='training-8-basic'").get() }, { base_price: 13000, version: 2, updated_by: "finance@pawspace.in" });
});

test("the founder-seed repairs still run on every call of a binding that has already been seen", async () => {
  const harness = await existingSchema();
  await commercial.ensureTrainingCommercialTables(harness.db);
  const quote = (id, packageCode, version) => harness.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES (?,?,?,1,?,'prepaid',0,1,1,60,1,7,?,'open',?)").run(id, packageCode, version, futureStart(5), Date.now() + 600_000, Date.now());
  // Both original founder seeds come back, each with a quote opened on it.
  harness.sqlite.prepare("UPDATE training_commercial_packages SET validity_days=93,version=1 WHERE package_code='training-16-pro'").run();
  harness.sqlite.prepare("UPDATE training_commercial_packages SET direct_minutes_per_pet=30,coaching_minutes_per_pet=15,version=1 WHERE package_code='trainer-meet-greet'").run();
  quote("TQ-PRO-OLD", "training-16-pro", 1);
  quote("TQ-MEET-OLD", "trainer-meet-greet", 1);
  // 3 calls plus one batch per repair: the single repair read found both.
  await assertWithinBudget(harness, { max: 5, min: 5, label: "ensure with both repairs due" }, () => commercial.ensureTrainingCommercialTables(harness.db));
  const row = (code) => ({ ...harness.sqlite.prepare("SELECT validity_days,direct_minutes_per_pet,coaching_minutes_per_pet,version FROM training_commercial_packages WHERE package_code=?").get(code) });
  assert.deepEqual(row("training-16-pro"), { validity_days: 120, direct_minutes_per_pet: 45, coaching_minutes_per_pet: 15, version: 2 });
  assert.deepEqual(row("trainer-meet-greet"), { validity_days: 7, direct_minutes_per_pet: 45, coaching_minutes_per_pet: 15, version: 2 });
  for (const id of ["TQ-PRO-OLD", "TQ-MEET-OLD"]) assert.equal(harness.sqlite.prepare("SELECT status FROM training_commercial_quotes WHERE id=?").get(id).status, "expired", `${id} was opened on the old terms`);
  // Repaired, so nothing more to do.
  await assertWithinBudget(harness, { max: 3, min: 3, label: "ensure after the repairs" }, () => commercial.ensureTrainingCommercialTables(harness.db));
});

test("a legacy database gains both columns the first time a binding sees it", async () => {
  const harness = freshCountingD1();
  harness.sqlite.exec("CREATE TABLE training_commercial_packages (package_code TEXT PRIMARY KEY,name TEXT NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,base_price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',meet_and_greet INTEGER NOT NULL DEFAULT 0,max_pets INTEGER NOT NULL DEFAULT 4,direct_minutes_per_pet INTEGER NOT NULL DEFAULT 45,coaching_minutes_per_pet INTEGER NOT NULL DEFAULT 15,split_due_percent REAL NOT NULL DEFAULT 50,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  harness.sqlite.exec("CREATE TABLE training_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,coupon_code TEXT,discount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,minutes_per_session INTEGER NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)");
  // CREATE batch, PRAGMA + ALTER for each table, seed batch, repair read.
  await assertWithinBudget(harness, { max: 7, min: 7, label: "first ensure on a legacy database" }, () => commercial.ensureTrainingCommercialTables(harness.db));
  const columns = (table) => harness.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  assert.ok(columns("training_commercial_quotes").includes("coupon_quote_id"));
  assert.ok(columns("training_commercial_packages").includes("extra_pet_percent"));
  assert.deepEqual(catalogue(harness.sqlite), FOUNDER, "the legacy database ends with the same catalogue as a new one");
  await assertWithinBudget(harness, { max: 3, min: 3, label: "ensure once the columns exist" }, () => commercial.ensureTrainingCommercialTables(harness.db));
});

test("a Training quote costs 6 D1 calls on an existing schema, prices exactly as before and does not grow with quotes", async () => {
  const harness = await existingSchema();
  const input = { packageCode: "training-8-basic", petCount: 2, scheduledStart: futureStart(6), paymentMode: "split" };
  await commercial.createTrainingQuote(harness.db, input); // first quote on the binding seeds the pricing-control rows
  // ensure (3), the package, the live price, the INSERT - was 16.
  const quote = await assertWithinBudget(harness, { max: 6, min: 6, label: "a Training quote on an existing schema" }, () => commercial.createTrainingQuote(harness.db, input));
  assert.deepEqual(terms(quote), { packageCode: "training-8-basic", packageName: "Basic Obedience Plan", packageVersion: 1, sessions: 8, validityDays: 62, petCount: 2, minutesPerSession: 120, planPrice: 12000, extraPetPercent: 60, basePrice: 19200, discount: 0, totalAmount: 19200, amountDueNow: 9600, paymentMode: "split", meetAndGreet: false, couponCode: null, couponQuoteId: null });

  // The same quote with nothing remembered between calls is the same quote, stored the same way.
  const reference = new DatabaseSync(":memory:"), binding = perCallBindings(reference);
  await commercial.ensureTrainingCommercialTables(binding());
  const expected = await commercial.createTrainingQuote(binding(), input);
  assert.deepEqual(terms(quote), terms(expected));
  assert.deepEqual(storedQuote(harness.sqlite, quote.quoteId), storedQuote(reference, expected.quoteId));

  const meet = await assertWithinBudget(harness, { max: 6, min: 6, label: "a Meet & Greet quote on an existing schema" }, () => commercial.createTrainingQuote(harness.db, { packageCode: "trainer-meet-greet", petCount: 1, scheduledStart: futureStart(3), paymentMode: "prepaid" }));
  assert.deepEqual([meet.totalAmount, meet.amountDueNow, meet.minutesPerSession, meet.meetAndGreet], [500, 500, 60, true]);

  // Quotes pile up in production (one per review-step refresh); the quote's cost must not.
  const insert = harness.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES (?,'training-8-basic',1,1,?,'split',0,12000,6000,60,8,62,?,'open',?)");
  await assertDoesNotScale(harness, { label: "Training quote vs accumulated quotes" }, () => commercial.createTrainingQuote(harness.db, input), () => { for (let i = 0; i < 2000; i += 1) insert.run(`TQ-VOLUME-${i}`, futureStart(6), Date.now() + 600_000, Date.now()); });
});

test("the review step's coupon chain: seeds in one call, and the governed Training quote costs 9 instead of 19", async () => {
  const harness = await existingSchema();
  await coupons.seedUatCoupons(harness.db);
  // ensureCouponTables (batch + PRAGMA) and one batch for every UAT and sales seed - was 2 + one per seed.
  await assertWithinBudget(harness, { max: 3, min: 3, label: "seedUatCoupons on an existing schema" }, () => coupons.seedUatCoupons(harness.db));
  const campaigns = harness.sqlite.prepare("SELECT id,code,status,discount_value FROM coupon_campaigns ORDER BY id").all().map((row) => ({ ...row }));
  const reference = new DatabaseSync(":memory:"), binding = perCallBindings(reference);
  await coupons.seedUatCoupons(binding());
  assert.deepEqual(reference.prepare("SELECT id,code,status,discount_value FROM coupon_campaigns ORDER BY id").all().map((row) => ({ ...row })), campaigns);
  assert.ok(campaigns.some((row) => row.code === "UATCARE100" && row.discount_value === 100));

  // Exactly what CouponField, then TrainingFlow, send for Basic Obedience at 100% with UATCARE100.
  const scheduledStart = futureStart(5);
  await commercial.createTrainingQuote(harness.db, { packageCode: "training-8-basic", petCount: 1, scheduledStart, paymentMode: "prepaid" });
  const coupon = await assertWithinBudget(harness, { max: 10, label: "coupon quote" }, () => coupons.quoteCoupon(harness.db, { code: "UATCARE100", customerId: "CUST-D1-BUDGET", serviceCode: "dog_training", cityId: "blr", channel: "customer_app", packageCode: "training-8-basic", orderValue: 12000, paymentMode: "full", isSubscription: false }));
  assert.equal(coupon.valid, true, coupon.error);
  const quote = await assertWithinBudget(harness, { max: 9, min: 9, label: "governed-coupon Training quote" }, () => commercial.createTrainingQuote(harness.db, { packageCode: "training-8-basic", petCount: 1, scheduledStart, paymentMode: "prepaid", couponCode: "UATCARE100", couponQuoteId: coupon.quoteId }));
  assert.deepEqual([quote.discount, quote.totalAmount, quote.amountDueNow, quote.couponCode, quote.couponQuoteId], [100, 11900, 11900, "UATCARE100", coupon.quoteId]);
});

test("ensureControlRuntimeTables runs once per binding (CREATE + one seed batch) and never resets a stop", async () => {
  const harness = freshCountingD1();
  // #1105 memoizes the switch table per D1 binding: the CREATE and one batch of the six defaults, then nothing.
  await assertWithinBudget(harness, { max: 2, min: 2, label: "ensureControlRuntimeTables on a new database" }, () => controls.ensureControlRuntimeTables(harness.db));
  await assertWithinBudget(harness, { max: 0, min: 0, label: "ensureControlRuntimeTables again on the same binding" }, () => controls.ensureControlRuntimeTables(harness.db));
  const rows = () => harness.sqlite.prepare("SELECT code,enabled,reason,updated_by FROM control_runtime_switches ORDER BY code").all().map((row) => ({ ...row }));
  assert.deepEqual(rows(), controls.CONTROL_SWITCHES.map((item) => ({ code: item.code, enabled: 1, reason: "default enabled", updated_by: "system" })).sort((a, b) => a.code.localeCompare(b.code)));
  await controls.setControlRuntimeSwitch(harness.db, { code: "payment_writes", enabled: false, reason: "Founder emergency stop", actor: "founder@pawspace.test" });
  await controls.ensureControlRuntimeTables(harness.db);
  assert.deepEqual(rows().find((row) => row.code === "payment_writes"), { code: "payment_writes", enabled: 0, reason: "Founder emergency stop", updated_by: "founder@pawspace.test" });
  // The gateway's whole check for a write on a warm binding: only the matching switch.
  const blocked = await assertWithinBudget(harness, { max: 1, min: 1, label: "runtimeControlBlock for a payment write" }, () => controls.runtimeControlBlock(harness.db, new Request("https://uat.pawspace.in/api/customer-checkout", { method: "POST" })));
  assert.equal(blocked.status, 503);
});
