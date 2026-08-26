/**
 * PTJA W2-B2-R01 / C01 / C07 — the read surfaces move onto the purpose-based access authority.
 *
 * WHAT WAS LEFT OPEN. lib/purpose-based-access.ts was built to the approved rule - who you are, why you
 * are looking, whether the record is assigned to you - and then NOTHING imported it. Four staff read
 * surfaces kept making their own masking decision from a single boolean:
 *
 *     const reveal = hasPermission(actor.permissions,"customers.view_full_phone")
 *
 * That boolean masks the NAME and the PHONE and nothing else, so on every one of those surfaces:
 *   - email was served in full to every actor who could open the screen;
 *   - Customer 360 served the full home address, line 1 and postcode included;
 *   - anyone holding customers.view_full_phone got a hundred raw numbers in one list read, with no
 *     reason asked and no record kept - which is precisely what "every reveal is logged with the user,
 *     the reason, the record and the time" exists to stop.
 *
 * The reveal is not removed. It moves to where the approved rule puts it: an explicit, per-record,
 * reason-carrying request that writes a customer_data_reveals row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_PBA_DB__", "__PTJA_PBA_ENV__");

const RAW_PHONE = "+919876543210";
const RAW_EMAIL = "ritu@example.com";
const RAW_LINE1 = "42 Kasturba Cross Road";
const RAW_PIN = "560001";

function makeD1(sqlite, counters) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { counters.count(sql); return sqlite.prepare(sql).get(...args) ?? null; },
    run: async () => { counters.count(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => { counters.count(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
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

const ROLE_PERMISSIONS = {
  associate: ["customers.view", "communications.manage", "bookings.view"],
  admin: ["customers.view", "customers.manage", "customers.view_full_phone", "communications.manage", "bookings.view", "bookings.manage", "launch.view"],
};

async function staffWorld(role) {
  const counters = { policyReads: 0, count(sql) { if (/FROM\s+service_policy_configs/i.test(String(sql))) this.policyReads += 1; } };
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, counters);
  globalThis.__PTJA_PBA_DB__ = db;
  globalThis.__PTJA_PBA_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  const email = `${role}@pawspace.test`;
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .bind(`USR-${role.toUpperCase()}`, email, role, role, now, now).run();
  const headers = {
    "content-type": "application/json",
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": role,
  };
  return { sqlite, db, headers, now, counters, email };
}

function seedCustomer(sqlite, now) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUST-1','blr','Ritu Malhotra',?,?,?,?)").run(RAW_PHONE, RAW_EMAIL, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-1','CUST-1','Home',?,'Indiranagar','Bengaluru',?,1,?,?)").run(RAW_LINE1, RAW_PIN, now, now);
}

function seedCrmContact(sqlite, now) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,stage,owner,source,lifetime_value,created_at,updated_at) VALUES ('CUST-1','Ritu Malhotra',?,?,?,'Indiranagar','New lead','Neha','Website',0,?,?)")
    .run(RAW_PHONE, RAW_PHONE, RAW_EMAIL, now, now);
}

const callRoute = async (modulePath, method, url, headers, body) => {
  const route = await import(modulePath);
  const response = await route[method](new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

const exposes = (payload, value) => JSON.stringify(payload ?? {}).includes(value);

// ---------------------------------------------------------------------------------------------------
// The four read surfaces
// ---------------------------------------------------------------------------------------------------

test("PBA-01: Customer 360 does not serve the email or the doorstep address to an associate", async () => {
  const { sqlite, headers, now } = await staffWorld("associate");
  seedCustomer(sqlite, now);
  const result = await callRoute("../app/api/customer-360/route.ts", "GET", "https://uat.pawspace.in/api/customer-360?customerId=CUST-1", headers);
  assert.equal(result.status, 200, `an associate may still open Customer 360: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, `the raw phone must not be served: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_EMAIL), false, `nor the email: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_LINE1), false, `nor line 1 of the home address: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_PIN), false, "nor the postcode");
  assert.ok(exposes(result.body, "Indiranagar"), "the area is still served, so the work stays possible");
});

test("PBA-02: a hundred raw numbers do not arrive in one list read for holding a permission", async () => {
  // The whole point of "every reveal is logged with the user, the reason, the record and the time".
  // A list read carries no reason and identifies no record, so it cannot be a reveal.
  const { sqlite, headers, now } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  const result = await callRoute("../app/api/customer-360/route.ts", "GET", "https://uat.pawspace.in/api/customer-360?customerId=CUST-1", headers);
  assert.equal(result.status, 200, `an admin may open Customer 360: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false,
    `customers.view_full_phone must not turn a list read into an unlogged bulk reveal: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_EMAIL), false, "and the email travels with it");
});

test("PBA-03: the CRM list masks the phone, the second phone and the email", async () => {
  const { sqlite, headers, now } = await staffWorld("admin");
  seedCrmContact(sqlite, now);
  const result = await callRoute("../app/api/crm/route.ts", "GET", "https://uat.pawspace.in/api/crm", headers);
  assert.equal(result.status, 200, `the CRM opens: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, `no raw phone: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_EMAIL), false, `no raw email: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.ok(exposes(result.body, "•"), "the values are masked, not removed");
});

test("PBA-04: the subscription customer list does not publish the doorstep address and coordinates", async () => {
  // subscription_customers carries no email, but its enrichment join carries service_address, pincode,
  // a Google Maps link and latitude/longitude - none of which the single reveal boolean ever touched.
  const { sqlite, db, headers, now } = await staffWorld("admin");
  await db.prepare("SELECT 1").first();
  sqlite.exec("CREATE TABLE IF NOT EXISTS subscription_customers (customer_key TEXT PRIMARY KEY, customer_name TEXT NOT NULL, primary_phone TEXT, secondary_phone TEXT, segment TEXT NOT NULL, outbound_priority TEXT NOT NULL, next_best_action TEXT NOT NULL, first_service_date TEXT NOT NULL, last_service_date TEXT NOT NULL, days_since_last_service INTEGER NOT NULL, dormancy_bucket TEXT NOT NULL, orders INTEGER NOT NULL, gross_sales REAL NOT NULL, aov REAL NOT NULL, services_used TEXT NOT NULL, primary_service TEXT NOT NULL, grooming_orders INTEGER NOT NULL, grooming_subscription_orders INTEGER NOT NULL, training_orders INTEGER NOT NULL, boarding_orders INTEGER NOT NULL, pet_sitting_orders INTEGER NOT NULL, subscription_target_score REAL NOT NULL, import_batch_id TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_demo_enrichment (customer_key TEXT PRIMARY KEY,data_as_of TEXT NOT NULL DEFAULT '',contactable INTEGER NOT NULL DEFAULT 0,current_orders INTEGER NOT NULL DEFAULT 0,current_customer_type TEXT NOT NULL DEFAULT '',current_last_service_date TEXT NOT NULL DEFAULT '',july_grooming_orders INTEGER NOT NULL DEFAULT 0,latest_grooming_order_date TEXT NOT NULL DEFAULT '',latest_grooming_package TEXT NOT NULL DEFAULT '',latest_pet_breed TEXT NOT NULL DEFAULT '',latest_grooming_payment_status TEXT NOT NULL DEFAULT '',latest_groomer_team TEXT NOT NULL DEFAULT '',latest_package_cost REAL,has_address INTEGER NOT NULL DEFAULT 0,service_address TEXT NOT NULL DEFAULT '',pincode TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',sub_area TEXT NOT NULL DEFAULT '',google_map_link TEXT NOT NULL DEFAULT '',latitude TEXT NOT NULL DEFAULT '',longitude TEXT NOT NULL DEFAULT '',historical_subscription_customer INTEGER NOT NULL DEFAULT 0,legacy_subscription_state TEXT NOT NULL DEFAULT 'no_legacy_subscription_history',subscription_followup_state TEXT NOT NULL DEFAULT 'no_subscription_action',import_batch_id TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO subscription_customers VALUES ('CUST-1','Ritu Malhotra',?,?,'Repeat','High','Call','2025-01-01','2026-08-01',25,'0-30 days Active',4,12000,3000,'grooming','grooming',4,2,0,0,0,88,'BATCH-1',?)").run(RAW_PHONE, RAW_PHONE, now);
  sqlite.prepare("INSERT INTO customer_demo_enrichment (customer_key,service_address,pincode,city,sub_area,google_map_link,latitude,longitude,has_address,import_batch_id,updated_at) VALUES ('CUST-1',?,?,'Bengaluru','Indiranagar','https://maps.google.com/?q=12.97,77.64','12.9716','77.6412',1,'BATCH-1',?)").run(RAW_LINE1, RAW_PIN, now);
  const result = await callRoute("../app/api/subscription-customers/route.ts", "GET", "https://uat.pawspace.in/api/subscription-customers", headers);
  assert.equal(result.status, 200, `the route answers: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(result.body.customers.length, 1, "the seeded customer is served");
  assert.equal(exposes(result.body, RAW_PHONE), false, `no raw phone: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, RAW_LINE1), false, `no doorstep address: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.equal(exposes(result.body, "12.9716"), false, `no coordinates: ${JSON.stringify(result.body).slice(0, 400)}`);
  assert.ok(exposes(result.body, "Indiranagar"), "the area is still served");
});

test("PBA-05: a conversation thread listing does not carry the raw phone", async () => {
  const { sqlite, db, headers, now } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  const governance = await import("../lib/conversation-governance.ts");
  await governance.ensureConversationGovernance(db);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-1','CUST-1',NULL,NULL,NULL,'open','someone.else@pawspace.test',NULL,?,?)").run(now, now);
  const result = await callRoute("../app/api/conversations/route.ts", "GET", "https://uat.pawspace.in/api/conversations", headers);
  assert.equal(result.status, 200, `the route answers: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(result.body.data.threads.length, 1, "the seeded thread is served");
  assert.equal(exposes(result.body, RAW_PHONE), false, `no raw phone in a thread listing: ${JSON.stringify(result.body).slice(0, 400)}`);
});

// ---------------------------------------------------------------------------------------------------
// The reveal, where the approved rule puts it
// ---------------------------------------------------------------------------------------------------

const reveal = (headers, body) => callRoute("../app/api/customer-data-reveal/route.ts", "POST", "https://uat.pawspace.in/api/customer-data-reveal", headers, body);

test("PBA-06: a reveal without a reason is refused", async () => {
  // The control that enforces this is requireReasonForReveal inside lib/purpose-based-access.ts, not
  // the route's own early check - sabotage of the route line alone leaves this green, because the
  // authority refuses first. Recorded here so the test names what is actually holding the line.
  const { sqlite, db, headers, now } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  // The table is created up front so "nothing is logged" is measured against a real empty table rather
  // than against a table that does not exist - an absent table would satisfy the assertion for the
  // wrong reason.
  const { ensureDataAccessTables } = await import("../lib/purpose-based-access.ts");
  await ensureDataAccessTables(db);
  const result = await reveal(headers, { customerId: "CUST-1", purpose: "operations" });
  assert.notEqual(result.status, 200, `an unexplained reveal must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  const logged = sqlite.prepare("SELECT COUNT(*) c FROM customer_data_reveals").get();
  assert.equal(Number(logged.c), 0, "and nothing is logged, because nothing was revealed");
});

test("PBA-06b: a reason too short to mean anything is refused", async () => {
  // "A reason is required" is worth nothing if "x" satisfies it. This is the route's own floor, and it
  // is stricter than the authority's non-empty check - which is why the route keeps it.
  const { sqlite, headers, now } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-1", purpose: "operations", reason: "x" });
  assert.notEqual(result.status, 200, `a one-character reason must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(exposes(result.body, RAW_PHONE), false, "and no number comes back with it");
});

test("PBA-07: a reveal with a reason returns the contact and writes an audit row", async () => {
  // Non-vacuity for PBA-02 and PBA-03. Masking everything unconditionally would satisfy them and blind
  // the roles whose job needs the number; this is the path that keeps the work possible.
  const { sqlite, headers, now, email } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-1", purpose: "operations", reason: "Customer called asking to move tomorrow's visit" });
  assert.equal(result.status, 200, `the reveal succeeds: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(exposes(result.body, RAW_PHONE), `and returns the number: ${JSON.stringify(result.body).slice(0, 300)}`);
  const row = sqlite.prepare("SELECT actor_id,subject_id,reason,purpose FROM customer_data_reveals WHERE subject_id='CUST-1'").get();
  assert.ok(row, "a reveal row is written");
  assert.equal(String(row.actor_id), email, "naming the actor");
  assert.match(String(row.reason), /move tomorrow's visit/, "and the reason they gave");
});

test("PBA-08: an actor without the permission cannot reveal", async () => {
  const { sqlite, headers, now } = await staffWorld("associate");
  seedCustomer(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-1", purpose: "operations", reason: "I would like to see the number" });
  assert.equal(exposes(result.body, RAW_PHONE), false,
    `an associate with no assignment and no grant must not reveal: ${JSON.stringify(result).slice(0, 300)}`);
});

test("PBA-09: a reveal of a customer who does not exist is refused, not answered empty", async () => {
  const { sqlite, headers, now } = await staffWorld("admin");
  seedCustomer(sqlite, now);
  const result = await reveal(headers, { customerId: "CUST-NOPE", purpose: "operations", reason: "Checking a number from a voicemail" });
  assert.notEqual(result.status, 200, `an unknown subject must refuse: ${JSON.stringify(result).slice(0, 300)}`);
});

test("PBA-10: the reveal route is permission mapped in the gateway", async () => {
  const { readFile } = await import("node:fs/promises");
  const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /\/api\/customer-data-reveal/, "the reveal surface must be mapped like every other guarded route");
});

// ---------------------------------------------------------------------------------------------------
// The migration must not turn one list read into N policy reads
// ---------------------------------------------------------------------------------------------------

test("PBA-11: a list read resolves the access policy once, not once per row", async () => {
  const { sqlite, headers, now, counters } = await staffWorld("admin");
  seedCrmContact(sqlite, now);
  for (let index = 2; index <= 12; index += 1) {
    sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,lifetime_value,created_at,updated_at) VALUES (?,?,?,?,'Indiranagar','New lead','Neha','Website',0,?,?)")
      .run(`CUST-${index}`, `Customer ${index}`, `+9198765432${String(index).padStart(2, "0")}`, `c${index}@example.com`, now, now);
  }
  counters.policyReads = 0;
  const result = await callRoute("../app/api/crm/route.ts", "GET", "https://uat.pawspace.in/api/crm", headers);
  assert.equal(result.status, 200, `the CRM opens with twelve contacts: ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(result.body.contacts.length, 12, "all twelve are served");
  assert.ok(counters.policyReads <= 2,
    `twelve contacts must not cost twelve policy reads, measured ${counters.policyReads}`);
});
