/**
 * The ₹0-collected incident in one sentence: a read failed, a `catch` swallowed it, zero rows became
 * zero rupees, and the screen printed a number nobody could tell apart from the truth.
 *
 * Swallowing stays - one absent module must not take a dashboard down - but it is now recorded, so a
 * report that could not read its payments says so instead of publishing a confident zero. These tests
 * hold that: a healthy database reports nothing degraded, a failing read is named, and the screen
 * renders the notice rather than the zero.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__DEGRADED_DB__", "__DEGRADED_ENV__");

function makeD1(sqlite, { failOn } = {}) {
  function statement(sql, args) {
    const guard = () => {
      if (failOn && failOn.test(sql)) throw new Error("D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR");
    };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { guard(); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { guard(); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { guard(); return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const item of statements) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// Verbatim from drizzle/0011_serious_shaman.sql and scripts/staging-seed.sql.
const BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id text PRIMARY KEY NOT NULL, idempotency_key text NOT NULL, customer_id text NOT NULL, pet_ids_json text NOT NULL, source_pet_ids_json text NOT NULL, city_id text NOT NULL, zone_id text NOT NULL, service_code text NOT NULL, package_code text NOT NULL, package_name text NOT NULL, schedule_group_id text NOT NULL, provider_id text NOT NULL, scheduled_start text NOT NULL, scheduled_end text NOT NULL, status text DEFAULT 'confirmed' NOT NULL, channel text DEFAULT 'customer_app' NOT NULL, total_amount real NOT NULL, currency text DEFAULT 'INR' NOT NULL, pricing_json text DEFAULT '{}' NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)";
const PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

function seed({ failOn } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(BOOKINGS);
  sqlite.exec(PAYMENTS);
  const now = Date.now();
  for (let index = 0; index < 12; index += 1) {
    const id = `BK${String(index).padStart(5, "0")}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','zone-1','grooming','pkg','Full groom',?,'PRV-1','2026-07-01T09:00:00.000Z','2026-07-01T10:00:00.000Z','completed','customer_app',1000,'INR','{}','seed',?,?)")
      .run(id, `${id}-idem`, `CUS${index}`, `SG-${id}`, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1000,1000,'INR','card','prepaid','captured','uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${id}`, id, `CUS${index}`, `pidem-${id}`, now, now);
  }
  globalThis.__DEGRADED_DB__ = makeD1(sqlite, { failOn });
  globalThis.__DEGRADED_ENV__ = {};
  return globalThis.__DEGRADED_DB__;
}

test("a database missing other modules names them rather than reporting their absence as zero", async () => {
  // This fixture has bookings and payments but no CX or provider tables - the cold-database shape that
  // has produced blank screens and confident zeros on staging all week.
  const db = seed();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(db);

  assert.equal(analytics.money.gmv, 12000, "the reads that worked report the truth");
  assert.equal(analytics.money.collected, 12000, "including the money, which is the number that was wrong");
  assert.ok(analytics.degraded, "and the modules it could not read are named");
  assert.deepEqual(analytics.degraded.sources.sort(), ["customer experience tickets", "providers", "refunds", "split payment schedules"]);
  assert.match(analytics.degraded.entries[0].reason, /no such table/);
});

test("a payments read that fails is named, not rendered as zero", async () => {
  // Exactly the staging shape: bookings read fine, payments do not.
  const db = seed({ failOn: /FROM booking_payments/ });
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(db);

  assert.equal(analytics.money.gmv, 12000, "the reads that worked still report");
  assert.ok(analytics.degraded, "the report must say it could not read payments");
  assert.ok(analytics.degraded.sources.includes("payments"), `payments must be named, got ${analytics.degraded.sources.join(", ")}`);
  assert.match(analytics.degraded.headline, /could not be read/);
  assert.match(analytics.degraded.entries.find((entry) => entry.source === "payments").reason, /too many SQL variables/);
  // The zero is still in the payload - the point is that it now arrives labelled.
  assert.equal(analytics.money.collected, 0);
});

test("a source that fails on every chunk is one degraded source, not one per chunk", async () => {
  const db = seed({ failOn: /FROM booking_payments/ });
  const { createDegradationLog } = await import("../lib/degraded-reads.ts");
  const log = createDegradationLog();
  for (let index = 0; index < 8; index += 1) log.note("payments", new Error("D1_ERROR: no such table"), []);
  assert.equal(log.entries().length, 1, "eight failed chunks are one broken source");
  assert.equal(log.degraded(), true);
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const analytics = await buildCompanyAnalytics(db);
  assert.equal(analytics.degraded.entries.filter((entry) => entry.source === "payments").length, 1, "one entry for payments however many chunks failed");
});

test("the notice never leaks bound values or SQL onto an operator's screen", async () => {
  const { createDegradationLog, degradationNotice } = await import("../lib/degraded-reads.ts");
  const log = createDegradationLog();
  const long = `D1_ERROR: ${"x".repeat(500)} 9876543210`;
  log.note("payments", new Error(long), []);
  const notice = degradationNotice(log.entries());
  assert.ok(notice.entries[0].reason.length <= 160, "the reason is trimmed for a screen");
  assert.equal(degradationNotice([]), null, "a healthy report has no notice at all");
});

test("the analytics screen renders the notice instead of only the zero", async () => {
  const page = await readFile(new URL("../app/team/analytics/page.tsx", import.meta.url), "utf8");
  assert.match(page, /degraded/, "the page reads the degraded field");
  assert.match(page, /data\.degraded\.headline/, "and renders what could not be read");
  assert.match(page, /entry\.source/, "naming the source, so an operator knows which figure to distrust");
});

test("the module says why swallowing without recording is the dangerous shape", async () => {
  const source = await readFile(new URL("../lib/degraded-reads.ts", import.meta.url), "utf8");
  assert.match(source, /Collected Rs 0|Rs 3,24,472/, "the incident that motivated it stays in the file");
  assert.match(source, /catch/);
});

test("real execution: the finance view names the ledger it could not read", async () => {
  // A swallowed read here becomes a receivable or a payable that is quietly short - the same failure
  // as the analytics zero, on the numbers finance acts on.
  const db = seed({ failOn: /FROM booking_payments/ });
  const { buildAccountsBusinessView } = await import("../lib/accounts-business-view.ts");
  const view = await buildAccountsBusinessView(db);

  assert.ok(view.degraded, "an incomplete ledger must not present itself as complete");
  assert.ok(view.degraded.sources.includes("payments"), `payments must be named, got ${view.degraded.sources.join(", ")}`);
  assert.match(view.degraded.headline, /missing rather than zero/);
});

test("a new swallowing read cannot be added without recording what it lost", async () => {
  // The rest of lib/ still swallows silently. Baselined by name so the debt is visible and finite,
  // and so a NEW file cannot quietly join the list - which is how this class kept coming back.
  const KNOWN_SILENT = [
    "coupon-governance.ts", "customer-360.ts", "customer-account.ts", "lead-assignment-governance.ts",
    "lead-sla-governance.ts", "live-leaderboard.ts", "partner-job-feed.ts", "partner-settlement-governance.ts",
    "payroll-engine.ts", "platform-security.ts", "referral-governance.ts", "sales-productivity-governance.ts",
    "host-badges.ts", "host-reviews.ts", "tds-governance.ts",
    // Fail-closed statutory helpers (not yet live): cold-tenant reads of the TCS/TDS ledgers degrade to an
    // empty set the same way tds-governance.ts does. Baselined by name so the debt stays visible and finite.
    "tcs-governance.ts", "tds-tcs-reconciliation.ts",
  ];
  const { readdir } = await import("node:fs/promises");
  const dir = new URL("../lib/", import.meta.url);
  const swallowing = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = await readFile(new URL(name, dir), "utf8");
    if (!/catch\s*(\([^)]*\))?\s*\{\s*return\s*\[\s*\]/.test(source.replace(/\s+/g, " "))) continue;
    if (source.includes("degraded-reads")) continue;
    swallowing.push(name);
  }
  const added = swallowing.filter((name) => !KNOWN_SILENT.includes(name));
  assert.deepEqual(added, [], "these modules swallow a failed read without recording it - use lib/degraded-reads.ts");

  const fixed = KNOWN_SILENT.filter((name) => !swallowing.includes(name));
  if (fixed.length) console.log(`  (${fixed.length} module(s) now record: ${fixed.join(", ")} - trim them from KNOWN_SILENT)`);
});
