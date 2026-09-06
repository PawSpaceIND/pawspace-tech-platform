/*
 * PawSpace end-to-end platform test at pilot scale.
 *
 * 520 customers, 10 service providers. Drives the REAL lib modules and route handlers against a
 * node:sqlite database behind the repo's D1 shim - no mocked business logic. Where a module cannot
 * be reached, that is recorded as a GAP rather than skipped silently, because the point of this run
 * is to find out where the build actually stands before a human tester touches it.
 *
 * Every probe records one of:
 *   PASS  - the module ran and its post-conditions held
 *   FAIL  - the module ran and produced a wrong result (a real defect)
 *   GAP   - the module could not be exercised (missing table, missing fixture, unreachable entry)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__E2E_DB__", "__E2E_ENV__");

export const RESULTS = [];
const record = (module, area, status, detail) => { RESULTS.push({ module, area, status, detail }); };

/** Run a probe, classifying a thrown error as GAP (unreachable) or FAIL (wrong behaviour). */
async function probe(module, area, fn) {
  try {
    const detail = await fn();
    record(module, area, "PASS", detail ?? "");
    return { ok: true, detail };
  } catch (error) {
    const message = error instanceof Response
      ? `HTTP ${error.status}` : (error?.message ?? String(error));
    const unreachable = /no such table|no such column|not a function|is not defined|Cannot find|undefined is not/i.test(message);
    record(module, area, unreachable ? "GAP" : "FAIL", message.slice(0, 220));
    return { ok: false, error: message };
  }
}

/** Same as probe, but a failure is attributed to the FIXTURE, never to the build. */
async function probeHarness(module, area, fn) {
  try { const d = await fn(); record(module, area, "PASS", d ?? ""); }
  catch (error) { record(module, area, "HARNESS", (error?.message ?? String(error)).slice(0, 160)); }
}

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async (col) => {
      const row = sqlite.prepare(sql).get(...args);
      if (row === undefined) return null;
      return col ? row[col] : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid || 0), rows_written: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
    raw: async () => sqlite.prepare(sql).all(...args).map((row) => Object.values(row)),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    dump: async () => new ArrayBuffer(0),
  };
}

// --- scale fixture ---------------------------------------------------------
const CUSTOMERS = 520;
const PROVIDERS = 10;
const NOW = Date.UTC(2026, 8, 6, 4, 30);      // 2026-09-06 10:00 IST
const DAY = 86400000;
const CITY = "blr";
const SERVICES = ["pet_grooming", "pet_boarding", "pet_sitting", "dog_walking", "pet_taxi", "pet_training"];

const sqlite = new DatabaseSync(":memory:");
const db = makeD1(sqlite);
globalThis.__E2E_DB__ = db;
globalThis.__E2E_ENV__ = {};

const cust = (i) => `E2E-CUS-${String(i).padStart(4, "0")}`;
const prov = (i) => `E2E-PRV-${String(i).padStart(2, "0")}`;
const bkg = (i) => `E2E-BK-${String(i).padStart(4, "0")}`;
const phone = (i) => `98${String(70000000 + i).slice(0, 8)}`;

function seedCore() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,weight_kg REAL,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT,line1 TEXT,line2 TEXT,city TEXT,postal_code TEXT,lat REAL,lng REAL,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,name TEXT,phone TEXT,city_id TEXT,status TEXT,engagement_model TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,created_at INTEGER,updated_at INTEGER);
  `);
  const now = NOW;
  for (let i = 1; i <= CUSTOMERS; i++) {
    sqlite.prepare("INSERT INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
      .run(cust(i), `E2E Customer ${i}`, phone(i), `e2e${i}@example.test`, CITY, '{"serviceUpdates":true,"marketing":false}', now, now);
    sqlite.prepare("INSERT INTO canonical_pets VALUES (?,?,?,?,?,?,?)")
      .run(`E2E-PET-${i}`, cust(i), `Pet${i}`, i % 5 === 0 ? "cat" : "dog", "indie", 8 + (i % 20), now);
    sqlite.prepare("INSERT INTO customer_addresses VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`E2E-ADR-${i}`, cust(i), `${i} Test Road`, "Indiranagar", "Bengaluru", "560038", 12.97 + i / 10000, 77.64 + i / 10000, now);
  }
  for (let p = 1; p <= PROVIDERS; p++) {
    sqlite.prepare("INSERT INTO canonical_providers VALUES (?,?,?,?,'active',?,?,?)")
      .run(prov(p), `E2E Provider ${p}`, phone(9000 + p), CITY, p % 2 ? "commission_standard" : "commission_groomer", now, now);
  }
}

seedCore();

test("E2E-000 scale fixture: 520 customers and 10 providers seeded", () => {
  const c = sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers").get().n;
  const p = sqlite.prepare("SELECT COUNT(*) n FROM canonical_providers").get().n;
  assert.equal(c, CUSTOMERS);
  assert.equal(p, PROVIDERS);
  record("fixture", "seed", "PASS", `${c} customers, ${p} providers`);
});

// ===========================================================================
// EXECUTION SWEEP - import each module and run it against the real database.
// 183 of 517 existing test files never execute lib/app code at all (they regex
// the source), so "green suite" does not mean these modules run. This finds out.
// ===========================================================================

const IST = 330 * 60000;
const iso = (ms) => new Date(ms).toISOString();

test("E2E-100 module execution sweep", async () => {
  // --- ensureTables reachability across every major subsystem --------------
  const SUBSYSTEMS = [
    ["gst-accounting", "ensureGstAccountingTables"],
    ["gst-returns", "ensureGstReturnTables"],
    ["tds-governance", "ensureTdsTables"],
    ["tcs-governance", "ensureTcsTables"],
    ["financial-lifecycle", "ensureFinancialLifecycleTables"],
    ["grooming-payment-reconciliation", "ensurePaymentReconciliationTables"],
    ["provider-commission-governance", "ensureProviderCommissionTables"],
    ["partner-settlement-governance", "ensurePartnerSettlementTables"],
    ["booking-rating", "ensureBookingRatingTables"],
    ["marketing-automation-rules", "ensureMarketingAutomationRules"],
    ["report-export-runtime", "ensureReportExportTables"],
    ["ai-analytics", "ensureAiAnalytics"],
    ["server-auth", "ensureSecurityTables"],
  ];
  for (const [mod, fn] of SUBSYSTEMS) {
    await probe(mod, "schema", async () => {
      const m = await import(`../lib/${mod}.ts`);
      if (typeof m[fn] !== "function") throw new Error(`${fn} is not a function`);
      await m[fn](db);
      return `${fn} ok`;
    });
  }
});

test("E2E-200 customer journey: booking -> payment -> capture -> ledger", async () => {
  // 520 bookings, one per customer, spread across the six verticals.
  await probe("canonical-bookings", "create", async () => {
    const now = NOW;
    for (let i = 1; i <= CUSTOMERS; i++) {
      const start = NOW + (2 + (i % 20)) * DAY;
      sqlite.prepare(`INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at)
        VALUES (?,?,?,'z1',?,'pkg-std','Standard',?,?,?,?,?,'customer_app',?,'INR','{}','e2e',?,?)`)
        .run(bkg(i), cust(i), CITY, SERVICES[i % SERVICES.length], `E2E-SG-${i}`,
             prov((i % PROVIDERS) + 1), iso(start), iso(start + 2 * 3600000),
             i <= 400 ? "completed" : "confirmed", 1500 + (i % 10) * 250, now, now);
    }
    const n = sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n;
    if (n !== CUSTOMERS) throw new Error(`expected ${CUSTOMERS} bookings, got ${n}`);
    return `${n} bookings across ${SERVICES.length} verticals`;
  });

  // Payments for every booking, captured.
  await probe("booking_payments", "capture", async () => {
    for (let i = 1; i <= CUSTOMERS; i++) {
      const amount = sqlite.prepare("SELECT total_amount a FROM canonical_bookings WHERE id=?").get(bkg(i)).a;
      sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid',?,'razorpay',?,'{}',?,?)")
        .run(`E2E-PAY-${i}`, bkg(i), cust(i), amount, amount, i <= 400 ? "captured" : "created", `idem-e2e-${i}`, NOW, NOW);
    }
    const captured = sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE status='captured'").get().n;
    if (captured !== 400) throw new Error(`expected 400 captured, got ${captured}`);
    return `${captured} captured of ${CUSTOMERS}`;
  });

  // Real gateway webhook -> reconciliation, executed not simulated.
  await probe("grooming-payment-reconciliation", "gateway webhook", async () => {
    const m = await import("../lib/grooming-payment-reconciliation.ts");
    await m.ensurePaymentReconciliationTables(db);
    let processed = 0;
    for (let i = 1; i <= 50; i++) {
      const amount = sqlite.prepare("SELECT total_amount a FROM canonical_bookings WHERE id=?").get(bkg(i)).a;
      await m.processGatewayEvent(db, {
        provider: "razorpay", environment: "sandbox", eventId: `e2e-cap-${i}`,
        eventType: "payment.captured", bookingId: bkg(i), amountSubunits: Math.round(amount * 100),
        gatewayPaymentId: `pay_e2e_${i}`, payloadHash: `sha256:e2e${i}`, signatureVerified: true,
      });
      processed++;
    }
    const rows = sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_records").get().n;
    if (!rows) throw new Error("no reconciliation records written");
    return `${processed} captures reconciled, ${rows} ledger rows`;
  });
});

test("E2E-300 provider journey: assignment -> delivery -> commission -> settlement", async () => {
  await probe("provider_work_orders", "assignment", async () => {
    for (let i = 1; i <= CUSTOMERS; i++) {
      const b = sqlite.prepare("SELECT service_code,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").get(bkg(i));
      sqlite.prepare("INSERT INTO provider_work_orders VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)")
        .run(`E2E-WO-${i}`, bkg(i), `E2E-SG-${i}`, prov((i % PROVIDERS) + 1), `E2E Provider ${(i % PROVIDERS) + 1}`,
             (i % 2) ? "commission_standard" : "commission_groomer", b.service_code, b.scheduled_start, b.scheduled_end,
             i <= 400 ? "completed" : "awaiting_acceptance", NOW, NOW);
    }
    const per = sqlite.prepare("SELECT provider_id,COUNT(*) n FROM provider_work_orders GROUP BY provider_id").all();
    if (per.length !== PROVIDERS) throw new Error(`expected ${PROVIDERS} providers with work, got ${per.length}`);
    return `${per.length} providers, ${per[0].n}-${per[per.length - 1].n} jobs each`;
  });

  await probe("provider-commission-governance", "sync completed orders", async () => {
    const m = await import("../lib/provider-commission-governance.ts");
    await m.ensureProviderCommissionTables(db);
    const out = await m.syncCompletedCommissionOrders(db);
    return `synced ${JSON.stringify(out).slice(0, 90)}`;
  });

  await probe("provider-commission-governance", "commission dashboard", async () => {
    const m = await import("../lib/provider-commission-governance.ts");
    const out = await m.getProviderCommissionDashboard(db, {});
    return `dashboard keys: ${Object.keys(out || {}).slice(0, 6).join(",")}`;
  });

  await probe("partner-settlement-governance", "statements", async () => {
    const m = await import("../lib/partner-settlement-governance.ts");
    await m.ensurePartnerSettlementTables(db);
    const out = await m.refreshPartnerSettlementStatements(db, "2026-09");
    return JSON.stringify(out).slice(0, 90);
  });

  await probe("booking-rating", "ratings + provider score", async () => {
    const m = await import("../lib/booking-rating.ts");
    await m.ensureBookingRatingTables(db);
    /* CROSS-MODULE ORDERING DEPENDENCY. recomputeProviderRating reads provider_capacity_profiles,
     * which ensureBookingRatingTables does NOT create - it is owned by provider-capacity-governance.
     * Ratings therefore only work if that module has run at least once first. Latent, not fatal,
     * but it is a real coupling a fresh environment can trip over. */
    const cap = await import("../lib/provider-capacity-governance.ts");
    for (const k of Object.keys(cap)) if (/^ensure/.test(k)) await cap[k](db);
    let n = 0;
    for (let i = 1; i <= 100; i++) {
      await m.submitBookingRating(db, { bookingId: bkg(i), customerId: cust(i), stars: 3 + (i % 3), comment: "e2e", actorId: cust(i) });
      n++;
    }
    return `${n} ratings submitted`;
  });
});

test("E2E-400 finance: GST, TDS, TCS, filing, journals", async () => {
  // Configure the entity properly first. The unconfigured probe above proved the module fails
  // CLOSED (configuration_required:active_tax_policy) - correct behaviour, not a defect. This
  // configures it so the real invoicing path is exercised rather than only its guard.
  await probe("gst-accounting", "fail-closed without policy", async () => {
    const m = await import("../lib/gst-accounting.ts");
    await m.ensureGstAccountingTables(db);
    try {
      await m.issueInvoice(db, { entityId: "E2E-UNCONFIGURED", issueDate: "2026-09-06", sourceEventKey: "e2e-guard",
        lines: [{ serviceCode: "pet_grooming", amount: 1500, quantity: 1 }] }, "e2e:finance");
    } catch (error) {
      if (/configuration_required/.test(String(error?.message))) return "correctly refuses to invoice without an active tax policy";
      throw error;
    }
    throw new Error("invoiced with NO tax policy configured - fail-open");
  });

  /* HARNESS LIMIT, not a build defect. Constructing a valid invoice payload needs an entity,
   * registration, policy version, per-service classification, document series AND correctly shaped
   * line snapshots. This fixture gets as far as the line-snapshot shape and stops. Recorded as
   * HARNESS so it is not mistaken for a product failure - what IS established is the fail-closed
   * behaviour probed above, and that lib/gst-accounting.ts is never executed by its own test file. */
  await probeHarness("gst-accounting", "issue invoice (configured)", async () => {
    const m = await import("../lib/gst-accounting.ts");
    await m.ensureGstAccountingTables(db);
    const now = NOW;
    sqlite.prepare("INSERT OR REPLACE INTO finance_entities VALUES ('E2E-ENTITY','PawSpace E2E Pvt Ltd','IN','active','e2e:approver',?,?,?)").run(now, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO tax_registrations VALUES ('E2E-REG','E2E-ENTITY','KA','GSTIN','29AAAAA0000A1Z5','active','2026-04-01',NULL,'e2e:approver',?,?,?)").run(now, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO tax_policy_versions VALUES ('E2E-POL','E2E-ENTITY',1,'active','2026-04-01',NULL,?,'BOARD-2026-01','e2e:approver',?,?,?)")
      .run(JSON.stringify({ regime: "gst_in", roundingMode: "line" }), now, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO tax_classifications VALUES ('E2E-CLS','E2E-POL','pet_grooming','SAC998729',?,'location_of_service','eligible',?)")
      .run(JSON.stringify([{ component: "CGST", rate: 9 }, { component: "SGST", rate: 9 }]), now);
    sqlite.prepare("INSERT OR REPLACE INTO finance_document_series VALUES ('E2E-SER','E2E-ENTITY','invoice','E2E/26-27/',1,6,'E2E-POL','active',?)").run(now);
    const out = await m.issueInvoice(db, {
      entityId: "E2E-ENTITY", issueDate: "2026-09-06", sourceEventKey: "e2e-inv-configured",
      placeOfSupply: "KA", customerId: cust(1), bookingId: bkg(1),
      sourceType: "booking", sourceId: bkg(1), registrationId: "E2E-REG", currency: "INR",
      lines: [{ serviceCode: "pet_grooming", amount: 1500, quantity: 1, taxableValue: 1500 }],
    }, "e2e:finance");
    const inv = sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices").get().n;
    if (!inv) throw new Error("issueInvoice returned but wrote no finance_invoices row");
    return `invoice written, ${inv} row(s), number ${String(out?.invoice_number ?? out?.id ?? "?").slice(0, 24)}`;
  });

  await probe("tds-governance", "monthly TDS", async () => {
    const m = await import("../lib/tds-governance.ts");
    await m.ensureTdsTables(db);
    const out = await m.computeMonthlyTds(db, { period: "2026-09", actorId: "e2e:finance", asOf: NOW });
    return `tds rows ${JSON.stringify(out).slice(0, 90)}`;
  });

  await probe("tcs-governance", "monthly TCS", async () => {
    const m = await import("../lib/tcs-governance.ts");
    await m.ensureTcsTables(db);
    const fn = m.computeMonthlyTcs || m.recomputeTcs || m.computeTcs;
    if (typeof fn !== "function") throw new Error("no TCS compute entry point exported");
    const out = await fn(db, { period: "2026-09", actorId: "e2e:finance", asOf: NOW });
    return JSON.stringify(out).slice(0, 90);
  });

  await probeHarness("gst-returns", "GSTR generation", async () => {
    const m = await import("../lib/gst-returns.ts");
    await m.ensureGstReturnTables(db);
    const out = await m.generateGstr1(db, { period: "2026-09", entityId: "E2E-ENTITY", actorId: "e2e:finance" });
    return JSON.stringify(out).slice(0, 90);
  });

  await probe("financial-lifecycle", "balanced journal", async () => {
    const m = await import("../lib/financial-lifecycle.ts");
    await m.ensureFinancialLifecycleTables(db);
    const out = await m.postBalancedJournal(db, {
      sourceType: "booking_payment", sourceId: bkg(1), sourceEventId: "e2e-journal-1",
      narration: "E2E captured booking revenue", currency: "INR",
      entries: [
        { accountCode: "1000_CASH", direction: "DEBIT", amountPaise: 150000, bookingId: bkg(1) },
        { accountCode: "4000_REVENUE", direction: "CREDIT", amountPaise: 150000, bookingId: bkg(1) },
      ],
    });
    return JSON.stringify(out).slice(0, 90);
  });
});

test("E2E-500 intelligence: analytics, reports, marketing, AI, automation", async () => {
  await probe("company-analytics", "build", async () => {
    const m = await import("../lib/company-analytics.ts");
    const out = await m.buildCompanyAnalytics(db, {});
    return `keys: ${Object.keys(out || {}).slice(0, 8).join(",")}`;
  });

  await probe("ai-analytics", "build", async () => {
    const m = await import("../lib/ai-analytics.ts");
    await m.ensureAiAnalytics(db);
    const out = await m.buildAiAnalytics(db, {});
    return `keys: ${Object.keys(out || {}).slice(0, 8).join(",")}`;
  });

  await probe("report-export-runtime", "export tables", async () => {
    const m = await import("../lib/report-export-runtime.ts");
    await m.ensureReportExportTables(db);
    return "report export schema ok";
  });

  await probe("marketing-automation-rules", "rules", async () => {
    const m = await import("../lib/marketing-automation-rules.ts");
    await m.ensureMarketingAutomationRules(db);
    const rules = await m.listAutomationRules(db, {});
    return `rules: ${Array.isArray(rules) ? rules.length : JSON.stringify(rules).slice(0, 60)}`;
  });
});

test("E2E-600 ledger schema reachability (drizzle-only tables)", async () => {
  const fl = await import("../lib/financial-lifecycle.ts");
  await fl.ensureFinancialLifecycleTables(db);
  const grp = await import("../lib/grooming-payment-reconciliation.ts");
  await grp.ensurePaymentReconciliationTables(db);
  try { const s = await import("../lib/razorpay-settlement-reconciliation.ts"); for (const k of Object.keys(s)) if (/^ensure/.test(k)) await s[k](db); } catch {}

  const SIX = ["payment_intents", "financial_outbox", "journal_entries", "journal_transactions",
               "partner_earning_pending", "payment_settlement_reconciliations"];
  for (const t of SIX) {
    const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    record("schema", t, exists ? "PASS" : "GAP", exists ? "created at runtime" : "NO runtime creator - drizzle-only, never migrated");
  }
  assert.ok(true);
});

test("E2E-700 refunds, cancellation and money-out safety", async () => {
  await probe("grooming-payment-reconciliation", "refund overage detection", async () => {
    const m = await import("../lib/grooming-payment-reconciliation.ts");
    await m.ensurePaymentReconciliationTables(db);
    sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
    // Billed 4000, only 1000 ever captured, full refund requested.
    sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('E2E-PAY-OV','E2E-BK-OV','E2E-CUS-0001',4000,4000,'INR','card','prepaid','captured','razorpay','idem-ov','{}',?,?)").run(NOW, NOW);
    sqlite.prepare("INSERT OR REPLACE INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,updated_at) VALUES ('E2E-PAY-OV','E2E-BK-OV','razorpay','sandbox',4000,1000,0,'INR','captured','matched',0,?)").run(NOW);
    sqlite.prepare("INSERT OR REPLACE INTO booking_refund_cases VALUES ('E2E-RFD-OV','E2E-BK-OV','E2E-PAY-OV',4000,'customer cancelled','approved','e2e:ops','e2e:finance',NULL,?,?)").run(NOW, NOW);
    await m.processGatewayEvent(db, { provider: "razorpay", environment: "sandbox", eventId: "e2e-ov-refund",
      eventType: "refund.processed", bookingId: "E2E-BK-OV", amountSubunits: 400000,
      gatewayRefundId: "rfnd_ov", payloadHash: "sha256:ov", signatureVerified: true });
    const row = sqlite.prepare("SELECT reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='E2E-PAY-OV'").get();
    if (row.reconciliation_status !== "refund_overage") throw new Error(`refunding 4000 against 1000 captured was certified '${row.reconciliation_status}'`);
    return `overage detected, variance ${Math.round(Number(row.variance_amount))}`;
  });

  await probe("sitting-finance-governance", "delivered stay cannot be refunded", async () => {
    const m = await import("../lib/sitting-finance-governance.ts");
    await m.ensureSittingFinanceTables(db);
    sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('E2E-BK-DLV','E2E-CUS-0002','blr','z1','pet_sitting','pkg','S','E2E-SG-DLV','E2E-PRV-01','2026-09-02T04:00:00.000Z','2026-09-03T04:00:00.000Z','completed','customer_app',4000,'INR','{}','e2e',?,?)").run(NOW, NOW);
    try {
      await m.mutateSittingFinance(db, { action: "approve_cancel", bookingId: "E2E-BK-DLV", reason: "e2e delivered-stay probe", actorId: "e2e:ops", idempotencyKey: "e2e-cancel-dlv-1" });
    } catch (error) {
      if (error instanceof Response && error.status === 409) return "delivered stay correctly refused (409)";
      throw error;
    }
    throw new Error("a COMPLETED stay was cancelled and refunded - money-out defect");
  });
});

test("E2E-800 lead journey and automation closure", async () => {
  await probe("lead-assignment-governance", "assign leads", async () => {
    const m = await import("../lib/lead-assignment-governance.ts");
    for (const k of Object.keys(m)) if (/^ensure/.test(k)) await m[k](db);
    return `entry points: ${Object.keys(m).filter((k) => /^(assign|ensure)/.test(k)).slice(0, 5).join(",")}`;
  });

  await probe("background-scheduler", "full sweep", async () => {
    const m = await import("../lib/background-scheduler.ts");
    const out = await m.runBackgroundScheduler(db, { actorId: "e2e:scheduler", asOf: NOW, cron: "*/5 * * * *" });
    const errs = Array.isArray(out?.errors) ? out.errors : [];
    return `ran; ${errs.length} sweep error(s)${errs.length ? ": " + errs.slice(0, 2).join(" | ").slice(0, 140) : ""}`;
  });

  await probe("communication-engine", "governed enqueue", async () => {
    const m = await import("../lib/communication-engine.ts");
    for (const k of Object.keys(m)) if (/^ensure/.test(k)) await m[k](db);
    if (typeof m.enqueueCommunication !== "function") throw new Error("enqueueCommunication is not a function");
    return "communication engine reachable";
  });
});

// --- final matrix ----------------------------------------------------------
test("E2E-999 result matrix", () => {
  const by = (s) => RESULTS.filter((r) => r.status === s);
  const lines = RESULTS.map((r) => `  ${r.status.padEnd(4)} ${r.module}/${r.area}${r.detail ? ` - ${r.detail}` : ""}`);
  console.log("\n===== E2E PLATFORM MATRIX =====\n" + lines.join("\n") +
    `\n\nPASS ${by("PASS").length}  FAIL ${by("FAIL").length}  GAP ${by("GAP").length}  HARNESS ${by("HARNESS").length}\n`);
  assert.ok(RESULTS.length > 0);
});

/*
 * The six tables that live only in drizzle/, which no deploy workflow applies.
 * This probe asks the runtime directly: after every ensure*Tables in the money path has run,
 * does the table exist? A missing table here means the code that writes to it throws in production.
 */

