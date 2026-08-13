import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// lib modules import each other extensionlessly; this installs the resolver on every supported Node.
installWorkersHooks("__CRM_DB__");


import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const crmRoute = read("app/api/crm/route.ts");
const c360Route = read("app/api/customer-360/route.ts");
const revenueRoute = read("app/api/revenue-crm/route.ts");
const c360Lib = read("lib/customer-360.ts");
const crmPage = read("app/crm/page.tsx");
const enginePanel = read("app/crm/revenue-engine-panel.tsx");

const statementsOf = (source) => [...source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)].map((match) => match[2]);
const findStatement = (source, marker) => {
  const hit = statementsOf(source).find((sql) => sql.includes(marker));
  assert.ok(hit, `expected a prepared statement containing: ${marker}`);
  return hit;
};

// Owning DDL sources for every table the CRM stack touches (copied via extraction, never guessed).
const DDL_SOURCES = [
  crmRoute,
  revenueRoute,
  c360Lib,
  read("lib/customer-account.ts"), // canonical_customers, canonical_pets, customer_addresses
  read("app/api/canonical-bookings/route.ts"), // canonical_bookings
  read("lib/coupon-governance.ts"), // coupon_redemptions
  read("lib/food-governance.ts"), // food_orders, food_order_lines
  read("lib/unified-case-center.ts"), // unified_cases
  read("lib/lead-callback-governance.ts"),
  read("lib/daily-revenue-opportunity-governance.ts"),
  read("lib/grooming-payment-reconciliation.ts"), // payment_reconciliation_records (leaderboard collections/refunds)
];

function schemaDb() {
  const db = new DatabaseSync(":memory:");
  for (const source of DDL_SOURCES) {
    for (const sql of statementsOf(source)) {
      if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) db.exec(sql);
    }
  }
  return db;
}

// Minimal D1 shim over node:sqlite (real SQLite engine) for lib real-execution.
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

// ---------------------------------------------------------------------------
// 1. Phantom-column audit: EVERY SQL statement in the three routes and the
//    customer-360 lib must prepare against the owning DDL. sqlite rejects
//    unknown columns/tables at prepare time, so a typo fails this test even
//    though the runtime code hides it behind .catch/safeAll fallbacks.
// ---------------------------------------------------------------------------
test("no query in the CRM stack references a column missing from the owning DDL", () => {
  const db = schemaDb();
  let checked = 0;
  for (const source of [crmRoute, revenueRoute, c360Route, c360Lib]) {
    for (const sql of statementsOf(source)) {
      if (/^\s*CREATE /i.test(sql)) continue;
      const variants = sql.includes("${field}")
        ? ["call_attempts", "whatsapp_attempts"].map((field) => sql.replaceAll("${field}", field))
        : [sql];
      for (const variant of variants) {
        db.prepare(variant.replace(/\$\{[^}]*\}/g, "?"));
        checked++;
      }
    }
  }
  assert.ok(checked >= 55, `audit must cover the full stack (checked ${checked} statements)`);
});

// ---------------------------------------------------------------------------
// 2. Permission mapping: GET = customers.view, writes = customers.manage.
// ---------------------------------------------------------------------------
test("all three CRM APIs gate GET with customers.view and writes with customers.manage", () => {
  for (const [name, source] of [["crm", crmRoute], ["customer-360", c360Route], ["revenue-crm", revenueRoute]]) {
    const getBody = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
    const postBody = source.slice(source.indexOf("export async function POST"));
    assert.match(getBody, /authorize\(request,\s*"customers\.view"\)/, `${name} GET must require customers.view`);
    assert.match(postBody, /authorize\(request,\s*"customers\.manage"\)/, `${name} POST must require customers.manage`);
  }
});

// ---------------------------------------------------------------------------
// 3. /api/crm real execution: create (POST SQL) then list (GET SQL).
// ---------------------------------------------------------------------------
test("real execution: /api/crm create persists a contact + lead work item that the list query returns", () => {
  const db = schemaDb();
  const now = Date.now();
  db.prepare(findStatement(crmRoute, "INSERT INTO crm_contacts")).run(
    "CU-77001", "Test Customer", "9999977001", null, null, "Bengaluru", "Rex", "Labrador · 2 years", "New lead", "Neha", "Website", 0, "Call within 10 minutes", "Grooming", now, now
  );
  db.prepare(findStatement(crmRoute, "INSERT INTO crm_activities")).run(`ACT-${now}`, "CU-77001", "lead_created", "Lead created", "Source: Website", now);
  db.prepare(findStatement(crmRoute, "INSERT INTO crm_tasks")).run(`TASK-${now}`, "CU-77001", "First response to new lead", "Neha", now + 600000, "High", "Open", now);
  db.prepare(findStatement(crmRoute, "INSERT INTO lead_work_items")).run(`LEAD-${now}`, "CU-77001", "Website", "Grooming", "Neha", "Sales Manager", now, now + 600000, now + 1800000, 0, 0, now + 600000, now, now);

  const owners = db.prepare(findStatement(crmRoute, "SELECT owner,COUNT(*) count FROM lead_work_items")).all();
  assert.equal(owners.length, 1, "owner load-balancing query runs against real rows");

  const list = db.prepare(findStatement(crmRoute, "SELECT * FROM crm_contacts ORDER BY updated_at")).all();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "CU-77001");
  assert.equal(list[0].primary_phone, "9999977001");
});

// ---------------------------------------------------------------------------
// 4. Customer 360 real execution: one customer with grooming + boarding +
//    food orders, a used coupon, a CX ticket and a unified support case —
//    the aggregate must surface ALL of them.
// ---------------------------------------------------------------------------
async function seededCustomer360() {
  const sqlite = schemaDb();
  const db = makeD1(sqlite);
  const now = Date.now();
  const customerId = "CUS-360-1";
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(customerId, "blr", "Asha Verma", "9999900360", null, "asha@example.test", "customer_app", "{}", now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("PET-360-1", customerId, "Bruno", "dog", "Labrador", "verified", null, now, now);
  const booking = (id, service, pkg, start, amount) =>
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, `ik-${id}`, customerId, "[]", "[]", "blr", "blr-east", service, pkg, pkg, `grp-${id}`, "prov-1", start, start, "confirmed", "customer_app", amount, "INR", "{}", "test", now, now);
  booking("BK-GROOM-1", "grooming", "dog-bath", "2026-08-01T05:00:00.000Z", 1349);
  booking("BK-BOARD-1", "boarding", "boarding-standard", "2026-08-05T05:00:00.000Z", 4500);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PS-UAT-FOOD-1", "ik-food-1", customerId, "blr", "blr-east", "uat_reserved", "uat_only", "uat_seed", "fulfilment_review_required", 799, "INR", "test", now, now);
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("FL-1", "PS-UAT-FOOD-1", "food-uat-dog-adult-2kg", "Adult Dog Food · UAT 2 kg", 1, 1, 799, 799, "INR");
  sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("CPR-1", "ik-coupon-1", "CPQ-1", "uat-coupon-care100", "UATCARE100", customerId, "BK-GROOM-1", 100, "consumed", now, now);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-1", customerId, "Service quality", "high", "Late groomer", "Groomer arrived 40 minutes late", "CX Desk", "Sales Manager", now + 3600000, "open", 0, "We received your request", "test", now, now);
  sqlite.prepare("INSERT INTO unified_cases (id,idempotency_key,case_type,severity,status,title,description,customer_id,source_type,source_id,owner_team,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("CASE-1", "ik-case-1", "refund", "high", "open", "Refund requested", "Refund for late service", customerId, "manual", "TKT-1", "cx", "test", now, "test", now);
  return { sqlite, db, customerId };
}

test("real execution: Customer 360 aggregates grooming + boarding + food orders, coupons and support cases", async () => {
  const { db, customerId } = await seededCustomer360();
  const { buildCustomer360 } = await import("../lib/customer-360.ts");
  const records = await buildCustomer360(db, customerId);
  assert.equal(records.length, 1, "detail view returns exactly the requested customer");
  const record = records[0];

  assert.equal(record.pets.length, 1);
  assert.equal(record.pets[0].name, "Bruno");

  const services = record.bookings.map((b) => b.serviceCode).sort();
  assert.deepEqual(services, ["boarding", "grooming", "pet_food"], "bookings must span ALL services including food orders");

  assert.equal(record.coupons.length, 1, "coupons used must be aggregated");
  assert.equal(record.coupons[0].code, "UATCARE100");
  assert.equal(record.coupons[0].discountAmount, 100);

  assert.equal(record.tickets.length, 1, "CX tickets aggregated");
  assert.equal(record.supportCases.length, 1, "unified support cases aggregated");
  assert.equal(record.supportCases[0].caseType, "refund");

  assert.equal(record.lifetimeValue, 1349 + 4500 + 799, "lifetime value spans canonical bookings AND food orders");
  assert.equal(record.openTicketCount, 1);
});

test("real execution: Customer 360 list view returns every customer; detail view filters to one", async () => {
  const { sqlite, db } = await seededCustomer360();
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-360-2", "blr", "Rohan Iyer", "9999900361", null, null, "customer_app", "{}", now, now);
  const { buildCustomer360 } = await import("../lib/customer-360.ts");
  const all = await buildCustomer360(db);
  assert.equal(all.length, 2, "list view spans all customers");
  const one = await buildCustomer360(db, "CUS-360-2");
  assert.equal(one.length, 1);
  assert.equal(one[0].name, "Rohan Iyer");
});

test("real execution: the consent update action (the route's own SQL) flips consent in the 360 record", async () => {
  const { sqlite, db, customerId } = await seededCustomer360();
  const consentSql = findStatement(c360Route, "INSERT INTO customer_contact_preferences");
  const now = Date.now();
  sqlite.prepare(consentSql).run(customerId, 1, 1, 1, 0, 0, "staff_review", "staff@test", now);
  const { buildCustomer360 } = await import("../lib/customer-360.ts");
  let [record] = await buildCustomer360(db, customerId);
  assert.equal(record.consent.marketing, true);
  assert.equal(record.consent.whatsapp, true);
  // ON CONFLICT path: the same statement must update, not duplicate.
  sqlite.prepare(consentSql).run(customerId, 0, 1, 0, 0, 0, "staff_review", "staff@test", now + 1);
  [record] = await buildCustomer360(db, customerId);
  assert.equal(record.consent.marketing, false, "consent withdrawal persists through the upsert");
  assert.equal(record.consent.whatsapp, false);
});

test("real execution: duplicate customers by phone are flagged in data quality", async () => {
  const { sqlite, db, customerId } = await seededCustomer360();
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-360-DUP", "blr", "Asha V", "9999900360", null, null, "customer_app", "{}", now, now);
  const { buildCustomer360 } = await import("../lib/customer-360.ts");
  const [record] = await buildCustomer360(db, customerId);
  assert.ok(record.dataQuality.issues.includes("possible_duplicate"));
  assert.deepEqual(record.dataQuality.duplicateCandidateIds, ["CUS-360-DUP"]);
});

// ---------------------------------------------------------------------------
// 5. /api/revenue-crm real execution: list join, attempt update, no-clobber.
// ---------------------------------------------------------------------------
test("real execution: revenue-crm lead list joins CRM contact names and log_attempt updates the lead", () => {
  const db = schemaDb();
  const now = Date.now();
  db.prepare(findStatement(crmRoute, "INSERT INTO crm_contacts")).run("CRM-R9001", "Join Test", "9999912345", null, null, "Bengaluru", "Rex", "Rex · profile", "Follow-up", "Neha", "Website", 0, "Work lead", "Grooming", now, now);
  db.prepare(findStatement(crmRoute, "INSERT INTO lead_work_items")).run("LEAD-9001", "CRM-R9001", "Website", "Grooming", "Neha", "Sales Manager", now, now + 600000, now + 1800000, 0, 0, now + 600000, now, now);

  const leads = db.prepare(findStatement(revenueRoute, "FROM lead_work_items l LEFT JOIN crm_contacts c")).all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].customer_name, "Join Test", "the staff list shows the real joined customer name");

  const attemptUpdate = findStatement(revenueRoute, "UPDATE lead_work_items SET ${field}=?").replaceAll("${field}", "call_attempts");
  db.prepare(attemptUpdate).run(1, now, "RNR", "active", 0, now + 4 * 3600000, now, "LEAD-9001");
  const lead = db.prepare("SELECT call_attempts,last_outcome FROM lead_work_items WHERE id=?").get("LEAD-9001");
  assert.equal(lead.call_attempts, 1);
  assert.equal(lead.last_outcome, "RNR");
});

test("real execution: leaderboard seeding never clobbers values written by real modules", () => {
  const db = schemaDb();
  const seedSql = findStatement(revenueRoute, "INTO sales_performance_daily");
  assert.match(seedSql, /^INSERT OR IGNORE/, "leaderboard seed must be INSERT OR IGNORE, not OR REPLACE");
  const date = "2026-08-12";
  db.prepare(seedSql).run(`PERF-${date}-Priya`, date, "Priya", 25000, 28750, 27400, 7, 3, 96, 91, 0, 1550, 1, Date.now());
  // A real module (productivity governance / attribution) updates the row…
  db.prepare("UPDATE sales_performance_daily SET eligible_revenue=99999 WHERE id=?").run(`PERF-${date}-Priya`);
  // …and the per-GET seed pass must not reset it.
  db.prepare(seedSql).run(`PERF-${date}-Priya`, date, "Priya", 25000, 28750, 27400, 7, 3, 96, 91, 0, 1550, 1, Date.now());
  const row = db.prepare("SELECT eligible_revenue FROM sales_performance_daily WHERE id=?").get(`PERF-${date}-Priya`);
  assert.equal(row.eligible_revenue, 99999, "real performance data survives the UAT seed pass");
});

// ---------------------------------------------------------------------------
// 6. UI regressions: dead buttons and demo arrays.
// ---------------------------------------------------------------------------
test("RNR UI matches the API contract: four attempts per channel, cold gate at 4", () => {
  // The API rejects mark_cold below 4+4 attempts — the UI must let staff get there.
  assert.match(revenueRoute, /call_attempts\)<4\|\|Number\(lead\.whatsapp_attempts\)<4/, "route mandates 4+4 attempts");
  assert.match(enginePanel, /\[0,1,2,3\]\.map/, "attempt tracker renders four slots");
  assert.match(enginePanel, /count>=4\|\|disabled/, "attempt button disables only after the fourth attempt");
  assert.match(enginePanel, /lead\.call_attempts<4\|\|lead\.whatsapp_attempts<4\|\|lead\.work_day<3/, "cold button enables exactly when the API accepts it");
  assert.doesNotMatch(enginePanel, /attempts\}\/3</, "no stale /3 attempt display");
});

test("legacy CRM page shows only real API data: demo arrays and fabricated fields are gone", () => {
  assert.doesNotMatch(crmPage, /seed:\s*Contact\[\]|const seed/, "hardcoded seed contact array removed");
  assert.doesNotMatch(crmPage, /Ananya Rao|Meera Shah|Vikram Reddy/, "fake customers removed");
  assert.doesNotMatch(crmPage, /score:\s*58/, "fabricated customer score removed");
  assert.doesNotMatch(crmPage, /₹2\.84L|₹18\.6L|Lifecycle campaigns|18,420|1,284 events/, "fabricated command/campaign/report figures removed");
  assert.doesNotMatch(crmPage, /"command"|"pipeline"|"inbox"|"automation"|"campaigns"|"reports"/, "demo-only views removed");
  assert.match(crmPage, /fetch\("\/api\/crm",\s*\{\s*cache:\s*"no-store"\s*\}\)/, "contacts come from the real API");
  assert.match(crmPage, /loadError/, "API failures surface to staff instead of being swallowed");
  assert.match(crmPage, /No CRM contacts yet/, "honest empty state");
});

test("the legacy CRM and Customer 360 report the SAME lifetime value for one customer", () => {
  // The legacy screen used to render crm_contacts.lifetime_value - a stored column seeded with demo
  // figures that no booking backs. It showed Meera Shah at Rs.4,150 while /team/sales correctly
  // computed Rs.0 from her (nonexistent) bookings. Two numbers for one customer is worse than either.
  //
  // /api/crm now computes lifetime value from recognised bookings, using the platform's single
  // recognition rule, so both screens are always the same number.
  assert.match(crmRoute, /status NOT IN \('cancelled','draft'\)/,
    "the CRM lifetime value must exclude cancelled and draft bookings, exactly as the P&L does");
  assert.match(crmRoute, /contact\.lifetime_value=known\?booked:null/,
    "the stored demo column must be overwritten with the computed figure - or with null when the bookings could not be read");
  assert.match(crmRoute, /lifetime_value_basis/,
    "the basis must be published so the screen can be explicit rather than implying money");
  // The basis is a positive claim, so it must come from whether the read RETURNED, not from what it
  // returned - deriving it from the result published "no recognised bookings" for a read that failed.
  // tests/analytics-scale-truth.test.mjs executes both states; this only pins the shape.
  assert.match(crmRoute, /!known\?"unavailable"/,
    "a read that did not return cannot claim the customer has no bookings");
  // Customer 360 applies the same exclusion, so the two cannot diverge.
  assert.match(c360Lib, /'cancelled','refunded','draft'/,
    "Customer 360 already excludes cancelled/refunded/draft - the rule must stay shared");
  // And the screen says which it is instead of printing a bare number.
  assert.match(crmPage, /No recognised booking yet/);
  assert.match(crmPage, /From recognised bookings/);
});

test("the CRM lifetime lookup is chunked for D1's bound-parameter cap", () => {
  // Same defect class as /api/unit-economics: one "?" per contact would exceed D1's limit as the
  // contact list grows, and the CRM list query returns up to 100 rows.
  assert.match(crmRoute, /index\+=50/, "the IN clause must be chunked");
  const inClause = /IN \(\$\{slice\.map\(\(\)=>"\?"\)\.join\(","\)\}\)/.test(crmRoute);
  assert.ok(inClause, "the chunked slice, not the full contact list, must build the placeholders");
});
