/*
 * Dog Training business rules decided by the founder on 26 Sep 2026, executed against real databases.
 *
 *  - Pro Training Plan validity is 120 days (was 93), so 16 weekly sessions fit. Existing databases are
 *    repaired once, open quotes on the old terms expire, and booked programmes keep what they were quoted.
 *  - Staging publishes the approved Training policies for Bengaluru: cancellation with no fee, no-show
 *    chargeable and unused sessions refunded pro-rata; tax at 18% GST included in the price. The seed never
 *    overwrites a policy Finance has already published, and its values pass the same validation Finance uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { freshWorld } from "./helpers/training-lifecycle-harness.mjs";

const commercial = await import("../lib/training-commercial-governance.ts");
const cancellation = await import("../lib/training-cancellation.ts");
const finance = await import("../lib/training-finance.ts");
const SEED = readFileSync(new URL("../scripts/uat-staging-training-policies.sql", import.meta.url), "utf8");

test("Pro is 120 days; an old 93-day founder seed is repaired once and its open quotes expire", async () => {
  const world = freshWorld();
  await commercial.ensureTrainingCommercialTables(world.db);
  const pro = () => world.sqlite.prepare("SELECT validity_days,version FROM training_commercial_packages WHERE package_code='training-16-pro'").get();
  assert.equal(pro().validity_days, 120, "a new database seeds 120 days");

  // An existing database still carrying the original seed, with a quote someone opened on it.
  world.sqlite.prepare("UPDATE training_commercial_packages SET validity_days=93,version=1,updated_by='founder_seed' WHERE package_code='training-16-pro'").run();
  world.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES ('TQ-OLD','training-16-pro',1,1,'2026-10-10T05:30:00.000Z','split',0,20000,10000,60,16,93,?,'open',?)").run(Date.now() + 600_000, Date.now());
  await commercial.ensureTrainingCommercialTables(world.db);
  assert.deepEqual({ ...pro() }, { validity_days: 120, version: 2 });
  assert.equal(world.sqlite.prepare("SELECT status FROM training_commercial_quotes WHERE id='TQ-OLD'").get().status, "expired", "a quote on the old terms can no longer be booked");

  // A quote on the repaired version survives later calls, and a Finance-edited package is never touched.
  world.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,status,created_at) VALUES ('TQ-NEW','training-16-pro',2,1,'2026-10-10T05:30:00.000Z','split',0,20000,10000,60,16,120,?,'open',?)").run(Date.now() + 600_000, Date.now());
  await commercial.ensureTrainingCommercialTables(world.db);
  assert.equal(world.sqlite.prepare("SELECT status FROM training_commercial_quotes WHERE id='TQ-NEW'").get().status, "open");
  world.sqlite.prepare("UPDATE training_commercial_packages SET validity_days=93,updated_by='finance@pawspace.in' WHERE package_code='training-16-pro'").run();
  await commercial.ensureTrainingCommercialTables(world.db);
  assert.equal(pro().validity_days, 93, "a package Finance changed is Finance's to change back");
});

test("the staging policy seed publishes the approved Training refund and GST policies, idempotently", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SEED);
  const refund = sqlite.prepare("SELECT * FROM training_cancellation_policies WHERE city_id='blr'").get();
  assert.equal(refund.status, "published");
  assert.equal(refund.refund_basis, "captured_less_pro_rata_used");
  assert.equal(refund.fee_type, "none");
  assert.equal(refund.fee_value, 0);
  assert.equal(refund.no_show_treatment, "chargeable");
  const tax = sqlite.prepare("SELECT * FROM training_tax_policies WHERE city_id='blr'").get();
  assert.deepEqual([tax.status, tax.tax_mode, tax.tax_rate], ["published", "inclusive", 18]);

  sqlite.exec(SEED);
  assert.equal(sqlite.prepare("SELECT version FROM training_cancellation_policies WHERE city_id='blr'").get().version, 1, "a second deploy changes nothing");
  assert.equal(sqlite.prepare("SELECT version FROM training_tax_policies WHERE city_id='blr'").get().version, 1);
});

test("the staging seed never overwrites a policy Finance published, but fills the unconfigured placeholders", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SEED.split("INSERT INTO")[0]);
  sqlite.prepare("INSERT INTO training_cancellation_policies (city_id,status,version,refund_basis,fee_type,fee_value,no_show_treatment,effective_from,updated_by,reason,updated_at) VALUES ('blr','published',4,'captured_less_pro_rata_used','none',0,'refundable','2026-09-01','finance@pawspace.in','Finance published policy',1)").run();
  sqlite.prepare("INSERT INTO training_tax_policies (city_id,tax_mode,tax_rate,status,version,updated_by,reason,updated_at) VALUES ('blr',NULL,NULL,'published',1,'system','placeholder',1)").run();
  sqlite.exec(SEED);
  const refund = sqlite.prepare("SELECT version,no_show_treatment,updated_by FROM training_cancellation_policies WHERE city_id='blr'").get();
  assert.deepEqual({ ...refund }, { version: 4, no_show_treatment: "refundable", updated_by: "finance@pawspace.in" });
  const tax = sqlite.prepare("SELECT version,tax_mode,tax_rate FROM training_tax_policies WHERE city_id='blr'").get();
  assert.deepEqual({ ...tax }, { version: 2, tax_mode: "inclusive", tax_rate: 18 });
});

test("the seeded values are ones Finance's own publishing validation accepts, and the tables match the app", async () => {
  const world = freshWorld();
  await cancellation.saveTrainingCancellationPolicy(world.db, { cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "chargeable", effectiveFrom: "2026-09-26", actorId: "finance@pawspace.in", reason: "Founder decision 26 Sep 2026" });
  await finance.saveTrainingTaxPolicy(world.db, { cityId: "blr", taxMode: "inclusive", taxRate: 18, effectiveFrom: "2026-09-26", actorId: "finance@pawspace.in", reason: "Founder decision 26 Sep 2026" });
  const columns = (table) => world.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(",");
  const seeded = new DatabaseSync(":memory:");
  seeded.exec(SEED);
  const seededColumns = (table) => seeded.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(",");
  assert.equal(seededColumns("training_cancellation_policies"), columns("training_cancellation_policies"));
  assert.equal(seededColumns("training_tax_policies"), columns("training_tax_policies"));
});

// --- multi-dog pricing (founder decision 26 Sep 2026) ---------------------------------------------

const { trainingPriceForPets } = await import("../lib/training-pricing.ts");

test("each extra dog adds 60% of the plan price; the quote, split and duration agree", async () => {
  assert.deepEqual([1, 2, 3, 4].map((dogs) => trainingPriceForPets(3500, dogs)), [3500, 5600, 7700, 9800]);
  assert.equal(trainingPriceForPets(3500, 3, 0), 3500, "a package configured at 0% stays flat");
  const world = freshWorld();
  const start = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const one = await commercial.createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 1, scheduledStart: start, paymentMode: "split" });
  const two = await commercial.createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 2, scheduledStart: start, paymentMode: "split" });
  const four = await commercial.createTrainingQuote(world.db, { packageCode: "training-2-starter", petCount: 4, scheduledStart: start, paymentMode: "prepaid" });
  assert.deepEqual([one.planPrice, one.basePrice, one.totalAmount, one.amountDueNow, one.minutesPerSession], [3500, 3500, 3500, 1750, 60]);
  assert.deepEqual([two.basePrice, two.totalAmount, two.amountDueNow, two.minutesPerSession, two.extraPetPercent], [5600, 5600, 2800, 120, 60]);
  assert.deepEqual([four.totalAmount, four.amountDueNow, four.minutesPerSession], [9800, 9800, 240]);
  const meet = await commercial.createTrainingQuote(world.db, { packageCode: "trainer-meet-greet", petCount: 2, scheduledStart: start, paymentMode: "prepaid" });
  assert.equal(meet.totalAmount, 800);
  world.sqlite.prepare("UPDATE training_commercial_packages SET extra_pet_percent=0 WHERE package_code='trainer-meet-greet'").run();
  assert.equal((await commercial.createTrainingQuote(world.db, { packageCode: "trainer-meet-greet", petCount: 2, scheduledStart: start, paymentMode: "prepaid" })).totalAmount, 500, "Finance can keep a package flat");
  const catalogue = await commercial.listTrainingPackages(world.db);
  assert.equal(catalogue.find((row) => row.package_code === "training-2-starter").extra_pet_percent, 60, "the catalogue tells the booking screens the rate");
});

test("a database created before multi-dog pricing gains the column with the 60% default", async () => {
  const world = freshWorld();
  world.sqlite.exec("CREATE TABLE training_commercial_packages (package_code TEXT PRIMARY KEY,name TEXT NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,base_price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',meet_and_greet INTEGER NOT NULL DEFAULT 0,max_pets INTEGER NOT NULL DEFAULT 4,direct_minutes_per_pet INTEGER NOT NULL DEFAULT 45,coaching_minutes_per_pet INTEGER NOT NULL DEFAULT 15,split_due_percent REAL NOT NULL DEFAULT 50,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  world.sqlite.prepare("INSERT INTO training_commercial_packages (package_code,name,sessions,validity_days,base_price,effective_from,updated_by,updated_at) VALUES ('training-2-starter','Starter Plan',2,31,3500,'2026-08-01','founder_seed',1)").run();
  await commercial.ensureTrainingCommercialTables(world.db);
  assert.equal(world.sqlite.prepare("SELECT extra_pet_percent FROM training_commercial_packages WHERE package_code='training-2-starter'").get().extra_pet_percent, 60);
});
