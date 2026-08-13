import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Regression for the staging outage: /team/sales died with Cloudflare's "Too many API requests by
// single Worker invocation" because buildCustomer360 ran 8 queries PER CUSTOMER (up to ~4000 D1
// subrequests in one GET). The shim COUNTS every D1 call so the fix is pinned by an actual query
// budget, not by inspection.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__C360_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

let queryCount = 0;
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { queryCount++; const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { queryCount++; const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { queryCount++; const rows = sqlite.prepare(sql).all(...args); return { results: rows }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    // Real D1 counts a batch as ONE request; mirror that so the budget models production.
    batch: async (statements) => { queryCount++; const results = []; for (const stmt of statements) { const info = sqlite.prepare(stmt.__sql ?? "SELECT 1").run(); void info; results.push({ success: true }); } return results; },
    exec: async (sql) => { queryCount++; sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
// batch needs the real statements — rebuild with closures that carry sql+args
function makeCountingD1(sqlite) {
  function statement(sql, args) {
    return {
      sql, args,
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { queryCount++; const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { queryCount++; const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { queryCount++; const rows = sqlite.prepare(sql).all(...args); return { results: rows }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { queryCount++; const results = []; for (const stmt of statements) { const info = sqlite.prepare(stmt.sql).run(...stmt.args); results.push({ success: true, meta: { changes: Number(info.changes) } }); } return results; },
    exec: async (sql) => { queryCount++; sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
void makeD1;

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__C360_DB__ = makeCountingD1(sqlite); queryCount = 0; }

const { buildCustomer360 } = await import("../lib/customer-360.ts");
const customer360Route = await import("../app/api/customer-360/route.ts");

const NOW = Date.now();
const DAY = 86_400_000;
// Exact DDL copied verbatim from the owning sources (canonical tables from
// app/api/canonical-bookings/route.ts, addresses/coupons/cases/tickets/food from their surfaces).
function seedTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS coupon_redemptions (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,quote_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,code TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL UNIQUE,discount_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'consumed',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'x', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_orders (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,status TEXT NOT NULL,commercial_status TEXT NOT NULL DEFAULT 'uat_only',inventory_mode TEXT NOT NULL DEFAULT 'uat_seed',delivery_status TEXT NOT NULL DEFAULT 'fulfilment_review_required',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS food_order_lines (id TEXT PRIMARY KEY,order_id TEXT NOT NULL,sku TEXT NOT NULL,item_name TEXT NOT NULL,item_version INTEGER NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL,line_total REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR')");
}
function seedCustomers(count) {
  const customer = sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  const pet = sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,created_at,updated_at) VALUES (?,?,?,?,?,?)");
  const booking = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','pkg','Pkg',?,'p1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)");
  for (let index = 0; index < count; index++) {
    const id = `cus_${String(index).padStart(4, "0")}`;
    customer.run(id, "blr", `Customer ${index}`, `+9190${String(index).padStart(8, "0")}`, `c${index}@example.in`, NOW - index, NOW - index);
    pet.run(`pet_${index}`, id, `Pet ${index}`, "dog", NOW, NOW);
    booking.run(`B_${index}_a`, `k_${index}_a`, id, `g_${index}_a`, new Date(NOW - 3 * DAY).toISOString(), new Date(NOW - 3 * DAY + 3_600_000).toISOString(), "completed", 1000 + index, NOW, NOW);
    booking.run(`B_${index}_b`, `k_${index}_b`, id, `g_${index}_b`, new Date(NOW + 2 * DAY).toISOString(), new Date(NOW + 2 * DAY + 3_600_000).toISOString(), "confirmed", 500, NOW, NOW);
  }
}

// ---- 1. The subrequest budget: the whole point of the fix --------------------------------------

test("REGRESSION lib/customer-360.ts: 300 customers cost a bounded number of D1 calls, not 8 per customer", async () => {
  freshDb(); seedTables(); seedCustomers(300);
  queryCount = 0;
  const records = await buildCustomer360(globalThis.__C360_DB__);
  assert.equal(records.length, 300, "every customer is still returned");
  // Pre-fix: 2 base + 300 x 8 = ~2402 calls — past Cloudflare's per-invocation cap, /team/sales 500s.
  // Post-fix: 1 ensure batch + 2 base + 8 tables x ceil(300/80)=4 chunks = 35.
  assert.ok(queryCount <= 50, `expected a bounded query budget, got ${queryCount} D1 calls`);
  assert.ok(queryCount >= 8, `sanity: the batched reads actually ran (got ${queryCount})`);
});

test("real execution: the customer-360 route itself stays inside the Worker budget with a full book of customers", async () => {
  freshDb(); seedTables(); seedCustomers(500);
  queryCount = 0;
  const response = await customer360Route.GET(new Request("http://localhost/api/customer-360"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.records.length, 500);
  assert.ok(queryCount <= 70, `route + auth + build must stay far under the ~1000 subrequest cap, got ${queryCount}`);
});

// ---- 2. The output is byte-identical in shape and semantics -------------------------------------

test("real execution: batched rebuild preserves ordering, per-customer limits, food-order merge, consent and dedup exactly", async () => {
  freshDb(); seedTables();
  const now = NOW;
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('cus_a','blr','Asha','+919000000001','asha@example.in',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('cus_b','blr','Asha Dup','+919000000001','other@example.in',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,created_at,updated_at) VALUES ('pet_1','cus_a','Simba','dog',?,?)").run(now, now);
  // Two addresses: the default one must come first even though it was created later
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,city,is_default,created_at,updated_at) VALUES ('adr_old','cus_a','Old','1 Old St','Bengaluru',0,?,?)").run(now - DAY, now);
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,city,is_default,created_at,updated_at) VALUES ('adr_home','cus_a','Home','2 New St','Bengaluru',1,?,?)").run(now, now);
  // Bookings out of order; newest scheduled_start must be first; cancelled excluded from LTV
  const booking = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,'p1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)");
  booking.run("B_old", "k1", "cus_a", "grooming", "g1", "2026-07-01T10:00:00.000Z", "2026-07-01T11:00:00.000Z", "completed", 1200, now, now);
  booking.run("B_new", "k2", "cus_a", "boarding", "g2", "2026-08-01T10:00:00.000Z", "2026-08-02T10:00:00.000Z", "confirmed", 4000, now, now);
  booking.run("B_cxl", "k3", "cus_a", "grooming", "g3", "2026-07-15T10:00:00.000Z", "2026-07-15T11:00:00.000Z", "cancelled", 900, now, now);
  // Food order lands in the same timeline as a pet_food entry
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,total_amount,created_by,created_at,updated_at) VALUES ('FO1','fk1','cus_a','blr','blr-east','delivered',799,'uat',?,?)").run(Date.parse("2026-07-20T10:00:00.000Z"), now);
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total) VALUES ('FL1','FO1','sku1','Adult Dog Food',1,2,399.5,799)").run();
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,created_by,created_at,updated_at) VALUES ('T1','cus_a','complaint','high','Late arrival','d','o','m',?, 'open','uat',?,?)").run(now, now, now);
  const db = globalThis.__C360_DB__;
  // Consent flows from customer_contact_preferences
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY, marketing_consent INTEGER NOT NULL DEFAULT 0, service_consent INTEGER NOT NULL DEFAULT 1, whatsapp_consent INTEGER NOT NULL DEFAULT 0, sms_consent INTEGER NOT NULL DEFAULT 0, email_consent INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'customer', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,whatsapp_consent,updated_by,updated_at) VALUES ('cus_a',1,1,'uat',?)").run(now);
  const records = await buildCustomer360(db, "cus_a");
  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(record.addresses.map(a => a.id), ["adr_home", "adr_old"], "default address first, then by created_at");
  assert.equal(record.addresses[0].isDefault, true);
  assert.deepEqual(record.bookings.map(b => b.id), ["B_new", "FO1", "B_cxl", "B_old"], "bookings + food orders merge into one timeline, newest first");
  assert.equal(record.bookings[1].serviceCode, "pet_food");
  assert.match(record.bookings[1].packageName, /Adult Dog Food × 2/);
  assert.equal(record.lifetimeValue, 1200 + 4000 + 799, "cancelled bookings never count toward LTV");
  assert.equal(record.consent.marketing, true);
  assert.equal(record.consent.whatsapp, true);
  assert.equal(record.consent.service, true, "no explicit service opt-out defaults to true");
  assert.equal(record.openTicketCount, 1);
  assert.deepEqual(record.dataQuality.duplicateCandidateIds, ["cus_b"], "shared-phone dedup detection survives the batching");
  assert.ok(record.dataQuality.issues.includes("possible_duplicate"));
  // Per-customer LIMIT semantics: 120 coupons stored, exactly 50 newest returned
  const coupon = sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'consumed',?,?)");
  for (let index = 0; index < 120; index++) coupon.run(`CR${index}`, `ik${index}`, `Q${index}`, "C1", "CODE", "cus_a", `BK${index}`, 10, now - index * 1000, now);
  const limited = (await buildCustomer360(db, "cus_a"))[0];
  assert.equal(limited.coupons.length, 50, "the old per-query LIMIT 50 is preserved per customer");
  assert.equal(limited.coupons[0].id, "CR0", "newest coupon first, same as the old ORDER BY created_at DESC");
});

// ---- 3. Cold DB: missing section tables still degrade to empty, never crash ---------------------

test("real execution: customers with no section tables at all still build (guarded batched reads)", async () => {
  freshDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('cus_1','blr','Solo','+919000000009',?,?)").run(NOW, NOW);
  const records = await buildCustomer360(globalThis.__C360_DB__);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].bookings, []);
  assert.deepEqual(records[0].addresses, []);
  assert.equal(records[0].lifetimeValue, 0);
  assert.ok(records[0].dataQuality.issues.includes("no_canonical_pet"));
});
