/*
 * The PARTNER side, executed end to end - from how a provider is engaged, through what they are
 * paid, to which section their tax is deducted under and what reaches the filing.
 *
 * The platform engages providers three ways, and each is paid and taxed differently:
 *
 *   commission_groomer    Grooming partners. 70% share, GST mode "none", cash allowed.   -> TDS 194H
 *   commission_standard   Trainers, boarders, sitters, walkers, drivers. 70% share,
 *                         provider GST collected on their behalf, no cash.               -> TDS 194H
 *   direct_employee       Salaried delivery (provider_model "full_time"). 0% share.      -> s192, NOT provider TDS
 *
 *   ...and a CONTRACT-engaged professional is promoted from 194H to 194J by their workforce type.
 *
 * The chain under test is: engagement model -> payout share -> GST treatment -> TDS section ->
 * what the monthly filing shows. Every test drives the REAL module against a real database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PRV_DB__", "__PRV_ENV__");

const CITY = "blr";
const PERIOD = "2026-09";
const FY_DATE = "2026-09-15";

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });
/* Two environments, because the platform behaves differently in each and BOTH matter.
 *
 * lib/service-completion-finance.ts derives an engagement model automatically only when
 * PAWSPACE_SCHEDULING_ENV is "uat", or NODE_ENV is "test" AND PAWSPACE_LOCAL_PREVIEW is on. In
 * PRODUCTION neither holds, so nothing is derived and completion refuses until Finance has
 * explicitly configured a commercial term. That refusal is a feature - the platform must never
 * guess how to pay a partner - and it is pinned as such below. */
const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const UAT_ENV = { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on" };
const prvWorld = (env = PROD_ENV) => world("__PRV_DB__", "__PRV_ENV__", env);

/** Canonical rows a completed booking needs, so completion finance can price it. */
function seedBooking(sqlite, { bookingId, providerId, serviceCode, amount, customerId = "PRV-CUS-1" }) {
  const now = Date.now();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(customerId, "Provider Journey Customer", "9800000777", "prv@example.test", CITY, '{}', now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,'blr-east',?,'pkg','Package','PRV-SG-1',?,?,?,'completed','customer_app',?,'INR','{}','["PRV-PET-1"]','test',?,?)`)
    .run(bookingId, customerId, CITY, serviceCode, providerId, `${FY_DATE}T06:00:00.000Z`, `${FY_DATE}T08:00:00.000Z`, amount, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid','captured','razorpay',?,'{}',?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, amount, `idem-${bookingId}`, now, now);
}

/** How the platform records what KIND of partner someone is - in each of the places that decide it. */
async function seedProvider(db, sqlite, { providerId, capacityModel, engagementType, compensationModel }) {
  const cap = await import("../lib/provider-capacity-governance.ts");
  await cap.seedProviderCapacityDefaults(db).catch(() => {});
  const now = Date.now();
  /* provider_capacity_profiles is created by seedProviderCapacityDefaults with NOT NULL city_id,
   * services_json, zones_json, effective_from and updated_by - a CREATE TABLE IF NOT EXISTS of my
   * own is silently ignored once it exists, so the real column list is used here.
   *
   * service_providers is READ by lib/tds-governance.ts (engagement_type) but created by no runtime
   * module at all, so a missing table degrades to the capacity/compensation fallback rather than
   * failing. This fixture stands in for the real table. */
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS service_providers (id TEXT PRIMARY KEY,name TEXT,engagement_type TEXT,status TEXT DEFAULT 'active',created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_compensation_profiles (provider_id TEXT PRIMARY KEY,engagement_model TEXT,updated_at INTEGER);
  `);
  if (capacityModel) {
    sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,'[]','[]',1,4.5,80,3,30,6,3,'active',1,'2026-01-01',NULL,'test',?)")
      .run(providerId, CITY, providerId, capacityModel, now);
  }
  if (engagementType) {
    sqlite.prepare("INSERT OR REPLACE INTO service_providers (id,name,engagement_type,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)")
      .run(providerId, providerId, engagementType, now, now);
  }
  if (compensationModel) {
    sqlite.prepare("INSERT OR REPLACE INTO provider_compensation_profiles (provider_id,engagement_model,updated_at) VALUES (?,?,?)")
      .run(providerId, compensationModel, now);
  }
}

/** Complete a booking through the real finance path and return what the provider was priced at. */
async function completeAndPrice(db, { bookingId, providerId, serviceCode, amount }) {
  const finance = await import("../lib/service-completion-finance.ts");
  return attempt(() => finance.resolveServiceCompletionFinance(db, {
    bookingId, actorId: "ops@pawspace.test", completedAt: Date.parse(`${FY_DATE}T09:00:00.000Z`),
  }));
}

// --- 1. HOW A PARTNER IS ENGAGED ---------------------------------------------
test("PRV-00 production never guesses how to pay a partner", async () => {
  const { db, sqlite } = prvWorld(PROD_ENV);
  await seedProvider(db, sqlite, { providerId: "PRV-UNCONFIGURED", capacityModel: "commission" });
  seedBooking(sqlite, { bookingId: "BK-UNCONFIGURED", providerId: "PRV-UNCONFIGURED", serviceCode: "grooming", amount: 1000 });
  const priced = await completeAndPrice(db, { bookingId: "BK-UNCONFIGURED" });
  assert.equal(priced.ok, false, "with no configured commercial term, production must refuse to price a partner");
  assert.match(String(priced.body ?? ""), /no active commercial term for service grooming/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_commercial_terms").get().n, 0,
    "production must not invent a commercial term on the partner's behalf");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get("BK-UNCONFIGURED").n, 0,
    "no payout may be accrued against a partner nobody has agreed terms with");
  stage("Production term discipline", "PASS", "no configured term means no payout and no invented term - the platform refuses rather than guessing");
});

test("PRV-01 engagement: each partner type resolves to its own model, share and GST treatment", async () => {
  /* Driven under the UAT env, where the derivation actually runs. */
  const cases = [
    ["a grooming commission partner", "PRV-GROOM-COMM", "grooming", "commission", "commission_groomer", 0.70, "none", 1],
    ["a training commission partner", "PRV-TRAIN-COMM", "training", "commission", "commission_standard", 0.70, "provider_gst_on_behalf", 0],
    ["a boarding commission host", "PRV-BOARD-COMM", "boarding", "commission", "commission_standard", 0.70, "provider_gst_on_behalf", 0],
    ["a sitting commission partner", "PRV-SIT-COMM", "pet_sitting", "commission", "commission_standard", 0.70, "provider_gst_on_behalf", 0],
    ["a walking commission partner", "PRV-WALK-COMM", "dog_walking", "commission", "commission_standard", 0.70, "provider_gst_on_behalf", 0],
    ["a taxi commission driver", "PRV-TAXI-COMM", "pet_taxi", "commission", "commission_standard", 0.70, "provider_gst_on_behalf", 0],
    ["a salaried full-time deliverer", "PRV-SALARIED", "grooming", "full_time", "direct_employee", 0, "none", 0],
  ];

  for (const [label, providerId, serviceCode, capacityModel, model, share, gstMode, cashAllowed] of cases) {
    const { db, sqlite } = prvWorld(UAT_ENV);
    const bookingId = `BK-${providerId}`;
    await seedProvider(db, sqlite, { providerId, capacityModel });
    seedBooking(sqlite, { bookingId, providerId, serviceCode, amount: 1000 });
    const priced = await completeAndPrice(db, { bookingId });
    assert.equal(priced.ok, true, `${label} must price: ${String(priced.body ?? "").slice(0, 200)}`);

    const term = sqlite.prepare("SELECT engagement_model,provider_share_pct,gst_mode,cash_allowed FROM provider_commercial_terms WHERE service_code=? AND provider_id=? ORDER BY created_at DESC LIMIT 1").get(serviceCode, providerId);
    assert.ok(term, `${label} must have a commercial term derived for them`);
    assert.equal(term.engagement_model, model, `${label} must be engaged as ${model}`);
    assert.equal(Number(term.provider_share_pct), share, `${label} must carry a ${share * 100}% share`);
    assert.equal(term.gst_mode, gstMode, `${label} must be treated as GST ${gstMode}`);
    assert.equal(Number(term.cash_allowed), cashAllowed, `${label} cash handling must be ${cashAllowed ? "allowed" : "refused"}`);

    /* And the partner is actually paid that share of the order - but the two commission classes
     * pay DIFFERENTLY, which is the whole reason there are two of them.
     *
     * commission_groomer carries no provider GST, so the groomer receives the full 70%.
     * commission_standard has PawSpace collect the provider's GST on their behalf, so the same 70%
     * share nets the partner LESS: 700 inclusive of 18% GST is 593.22 to them and 106.78 of their
     * GST handled by the platform. Asserting a flat 70% here would have been wrong, and would have
     * reported correct behaviour as a shortfall. */
    const gross = Number(priced.value.providerGrossPayout);
    if (model === "direct_employee") {
      assert.equal(gross, 0, "a salaried deliverer is paid by payroll, not by a per-order share");
    } else if (gstMode === "none") {
      assert.equal(Math.round(gross), 700, `${label} must receive the full 70% of a Rs 1000 order`);
    } else {
      assert.equal(Math.round(gross), 593,
        `${label} must receive 70% net of the provider GST the platform collects for them`);
      assert.ok(Math.abs(gross * 1.18 - 700) < 1,
        `${label}: the partner's net plus their GST must reconcile to the 70% share, got ${gross}`);
    }
  }

  /* The two commission classes are genuinely different, and that is the point of having both: only
   * a groomer takes cash, and only a groomer carries no provider GST. */
  stage("Engagement model", "PASS",
    "grooming -> commission_groomer 70% cash-allowed GST none; training/boarding/sitting/walking/taxi -> commission_standard 70% no-cash provider-GST; full_time -> direct_employee 0%");
});

// --- 2. FROM PAYOUT TO FILING -------------------------------------------------
/** Run a partner's completed work through the real TDS engine for the period. */
async function runTds(db, over = {}) {
  const tds = await import("../lib/tds-governance.ts");
  await tds.ensureTdsTables(db);
  return { tds, result: await attempt(() => tds.computeMonthlyTds(db, {
    period: PERIOD, actorId: "finance@pawspace.test", asOf: Date.parse(`${FY_DATE}T10:00:00.000Z`), ...over,
  })) };
}

/** A partner who has been paid, so the filing has something to classify. */
async function payPartner(db, sqlite, { providerId, serviceCode, engagementModel, amount, engagementType, compensationModel, capacityModel }) {
  await seedProvider(db, sqlite, { providerId, capacityModel, engagementType, compensationModel });
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES (?,?,?,1,'active',?,0.70,'none',0.18,0,0,0,12,'2026-04-01','partner journey audit','ops','finance','APR-1',?,?)")
    .bind(`TERM-${providerId}`, serviceCode, providerId, engagementModel, now, now).run();
  await db.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES (?,?,?,?,?,0,0,0,0,'{}',?,'test',?)")
    .bind(`BK-PAID-${providerId}`, providerId, serviceCode, amount, amount, `TERM-${providerId}`, Date.parse(`${FY_DATE}T09:00:00.000Z`)).run();
}

test("PRV-02 filing: a commission partner is deducted under 194H at 2%, above a Rs 20,000 FY floor", async () => {
  const { db, sqlite } = prvWorld(UAT_ENV);
  const provider = "PRV-COMM-194H";
  await payPartner(db, sqlite, {
    providerId: provider, serviceCode: "grooming", engagementModel: "commission_groomer",
    amount: 15000, capacityModel: "commission", engagementType: "commission",
  });

  const below = await runTds(db);
  assert.equal(below.result.ok, true, `TDS must compute: ${String(below.result.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tds_deductions WHERE period=?").get(PERIOD).n, 0,
    "no tax may be deducted from a partner below the FY commission floor");

  /* Cross the floor. */
  await db.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES (?,?,?,?,?,0,0,0,0,'{}',?,'test',?)")
    .bind(`BK-PAID2-${provider}`, provider, "grooming", 10000, 10000, `TERM-${provider}`, Date.parse(`${FY_DATE}T09:30:00.000Z`)).run();
  const over = await runTds(db);
  assert.equal(over.result.ok, true);

  const rows = sqlite.prepare("SELECT section,deductee_type,deductee_id,base_amount,rate_pct,tds_amount FROM tds_deductions WHERE period=?").all(PERIOD);
  assert.equal(rows.length, 1, "one deduction row for this partner");
  assert.equal(rows[0].section, "194H", "a commission partner is deducted under 194H, not 194J or 192");
  assert.equal(rows[0].deductee_type, "provider");
  assert.equal(rows[0].deductee_id, provider);
  assert.equal(Number(rows[0].base_amount), 25000, "the base is the full untaxed FY cumulative at first crossing");
  assert.equal(Number(rows[0].rate_pct), 2, "194H is 2%");
  assert.equal(Number(rows[0].tds_amount), 500, "2% of 25,000 is 500");
  assert.equal(over.tds.TDS_THRESHOLDS_FY.commission194H, 20000);
  assert.equal(over.tds.TDS_RATES.commission194H, 0.02);
  stage("Commission partner tax", "PASS", "nil below the Rs 20,000 FY floor; Rs 500 deducted under 194H at 2% on Rs 25,000 once crossed");
});

test("PRV-03 filing: a CONTRACT-engaged professional is promoted to 194J at 10%, with its own Rs 50,000 floor", async () => {
  /* This is the trainer case specifically: the same commission_standard payout terms, but a
   * contract workforce engagement, which the filing must recognise as professional fees. */
  const { db, sqlite } = prvWorld(UAT_ENV);
  const provider = "PRV-TRAINER-CONTRACT";
  await payPartner(db, sqlite, {
    providerId: provider, serviceCode: "training", engagementModel: "commission_standard",
    amount: 30000, capacityModel: "commission", engagementType: "contract",
  });

  /* Rs 30,000 clears the 194H floor but NOT the 194J one - a contract professional must not be
   * deducted just because a commission partner would have been. */
  const below = await runTds(db);
  assert.equal(below.result.ok, true, `TDS must compute: ${String(below.result.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tds_deductions WHERE period=?").get(PERIOD).n, 0,
    "Rs 30,000 is above the commission floor but below the professional one - nothing may be deducted");

  await db.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES (?,?,?,?,?,0,0,0,0,'{}',?,'test',?)")
    .bind(`BK-PAID2-${provider}`, provider, "training", 25000, 25000, `TERM-${provider}`, Date.parse(`${FY_DATE}T09:30:00.000Z`)).run();
  const over = await runTds(db);
  assert.equal(over.result.ok, true);

  const rows = sqlite.prepare("SELECT section,deductee_id,base_amount,rate_pct,tds_amount FROM tds_deductions WHERE period=?").all(PERIOD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, "194J", "a contract-engaged trainer is professional fees, not commission");
  assert.equal(Number(rows[0].base_amount), 55000);
  assert.equal(Number(rows[0].rate_pct), 10, "194J is 10%, five times the commission rate");
  assert.equal(Number(rows[0].tds_amount), 5500, "10% of 55,000 is 5,500");
  assert.equal(over.tds.TDS_THRESHOLDS_FY.professional194J, 50000);
  assert.equal(over.tds.TDS_RATES.professional194J, 0.10);
  stage("Contract professional tax", "PASS", "Rs 30,000 correctly untaxed below the Rs 50,000 professional floor; Rs 5,500 under 194J at 10% on Rs 55,000 once crossed");
});

test("PRV-04 filing: a salaried deliverer is taxed by payroll, never as a provider", async () => {
  const { db, sqlite } = prvWorld(UAT_ENV);
  const provider = "PRV-SALARIED-DELIVERER";
  await payPartner(db, sqlite, {
    providerId: provider, serviceCode: "grooming", engagementModel: "direct_employee",
    amount: 90000, capacityModel: "full_time", engagementType: "full_time",
  });

  const run = await runTds(db);
  assert.equal(run.result.ok, true, `TDS must compute: ${String(run.result.body ?? "").slice(0, 200)}`);
  const rows = sqlite.prepare("SELECT section,deductee_id FROM tds_deductions WHERE period=? AND deductee_id=?").all(PERIOD, provider);
  assert.equal(rows.length, 0,
    "a salaried deliverer must NOT appear as a provider deductee - their tax is s192 payroll, and deducting again would tax them twice");
  stage("Salaried deliverer tax", "PASS", "Rs 90,000 of salaried delivery raises no provider TDS row - payroll s192 handles it, so nobody is taxed twice");
});

test("PRV-05 filing: two tables disagree about a partner, and the money still decides", async () => {
  /* The platform records what KIND of partner someone is in more than one place:
   *   provider_capacity_profiles.provider_model  - what lib/service-completion-finance.ts PAYS from
   *   service_providers.engagement_type          - what lib/tds-governance.ts classifies from FIRST
   *
   * I expected that split to be exploitable: a partner PAID a commission share while a second table
   * called them salaried would be excluded from provider TDS, and the platform would under-deduct.
   * It is not, and the reason is worth pinning so a future refactor does not remove it.
   *
   * The exclusion from provider TDS is driven by the COMMERCIAL TERM's engagement_model - the same
   * record that decides whether they are paid a share at all - not by the secondary table. The
   * workforce type can only PROMOTE commission to professional (194H -> 194J, a higher rate); it can
   * never demote someone out of being taxed. The failure direction is safe by construction. */
  const { db, sqlite } = prvWorld(UAT_ENV);
  const provider = "PRV-DISAGREEING-TABLES";
  await payPartner(db, sqlite, {
    providerId: provider, serviceCode: "grooming", engagementModel: "commission_groomer",
    amount: 500000,
    capacityModel: "commission",   // paid as a commission partner
    engagementType: "direct",      // ...while this table calls them salaried
  });

  const run = await runTds(db);
  assert.equal(run.result.ok, true, `TDS must compute: ${String(run.result.body ?? "").slice(0, 200)}`);
  const rows = sqlite.prepare("SELECT section,base_amount,tds_amount FROM tds_deductions WHERE period=? AND deductee_id=?").all(PERIOD, provider);
  assert.equal(rows.length, 1,
    "a partner PAID a commission share must be deducted, whatever a second table calls them");
  assert.equal(rows[0].section, "194H");
  assert.equal(Number(rows[0].tds_amount), 10000, "2% of Rs 5,00,000 - the deduction is not skipped");

  /* And the promotion direction still works from that same secondary table: contract raises the
   * rate rather than lowering it. */
  const { db: db2, sqlite: sqlite2 } = prvWorld(UAT_ENV);
  const promoted = "PRV-PROMOTED";
  await payPartner(db2, sqlite2, {
    providerId: promoted, serviceCode: "training", engagementModel: "commission_standard",
    amount: 500000, capacityModel: "commission", engagementType: "contract",
  });
  const run2 = await runTds(db2);
  assert.equal(run2.result.ok, true);
  const promotedRows = sqlite2.prepare("SELECT section,rate_pct FROM tds_deductions WHERE period=? AND deductee_id=?").all(PERIOD, promoted);
  assert.equal(promotedRows[0].section, "194J", "a contract workforce type must PROMOTE the section");
  assert.equal(Number(promotedRows[0].rate_pct), 10, "and promotion raises the rate, never lowers it");
  stage("Disagreeing sources", "PASS",
    "a partner paid commission but recorded 'direct' elsewhere is still deducted Rs 10,000 under 194H; the secondary table can only promote 194H->194J, never demote out of tax");
});

// --- SCOPE REPORT -------------------------------------------------------------
test("PRV-99 partner journey scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== PARTNER JOURNEY (engagement -> payout -> tax -> filing) =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
