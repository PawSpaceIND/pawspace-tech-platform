/*
 * R3-G / F1: /api/operations-overview served unmasked customer names.
 *
 * The endpoint is gated at `dashboard.view`. auditor, finance, associate and manager all hold it and
 * NONE of them holds `customers.view`. auditor is defined in lib/platform-security.ts as "Read-only
 * compliance and audit access with masked personal data" and finance as "…without customer contact
 * exposure", yet the live-activity rows on /admin read back real names. Its siblings /api/crm and
 * /api/customer-360 mask the same customers for every role including founder, so this endpoint was
 * the outlier, not the policy.
 *
 * The assertion greps the WHOLE serialised payload, not one field: a mask applied to `customer`
 * while the raw value survives somewhere else in the JSON is not a fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__R3G_OPSOV_DB__", "__R3G_OPSOV_ENV__");

const ORIGIN = "https://app.pawspace.in";
const RAW_NAME = "E2E UI Customer";
const OTHER_RAW_NAME = "R3A Grooming D";
const ASOF = Date.UTC(2026, 7, 3, 12, 0, 0);
const at = (hour) => new Date(`2026-08-03T${String(hour).padStart(2, "0")}:00:00+05:30`).toISOString();

const route = await import("../app/api/operations-overview/route.ts");
const { maskName } = await import("../lib/platform-security.ts");

const ACTORS = [
  ["auditor", "r3g.opsov.auditor@pawspace.test"],
  ["finance", "r3g.opsov.finance@pawspace.test"],
  ["associate", "r3g.opsov.associate@pawspace.test"],
  ["manager", "r3g.opsov.manager@pawspace.test"],
  ["admin", "r3g.opsov.admin@pawspace.test"],
  ["founder", "r3g.opsov.founder@pawspace.test"],
];

async function seed() {
  const { sqlite, db } = world("__R3G_OPSOV_DB__", "__R3G_OPSOV_ENV__");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [role, email] of ACTORS) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(`U-${role}`, email, `R3G ${role}`, role, now, now);
  }
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  for (const [id, name] of [["CUS-1", RAW_NAME], ["CUS-2", OTHER_RAW_NAME]]) {
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, "blr", name, "+919000000021", null, "leak@example.test", "uat", "{}", now, now);
  }
  let n = 0;
  for (const customer of ["CUS-1", "CUS-2"]) {
    n += 1;
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','pkg','Full Groom',?,?,?,?, 'confirmed','customer_app',1000,'INR','{}','uat',?,?)")
      .run(`BK-${n}`, `ik-${n}`, customer, `grp-${n}`, "PRV-1", at(10), at(11), ASOF, ASOF);
  }
  return { sqlite, db };
}

const call = (email) => route.GET(new Request(`${ORIGIN}/api/operations-overview?asOf=${ASOF}`, {
  method: "GET", headers: { "oai-authenticated-user-email": email },
}));

test("F1: no role holding only dashboard.view gets an unmasked customer name anywhere in the payload", async () => {
  await seed();
  for (const [role, email] of ACTORS) {
    const response = await call(email);
    assert.equal(response.status, 200, `${role} must still be able to open the operations overview`);
    const body = await response.text();
    assert.ok(body.includes("BK-1"), `premise: ${role} really is reading today's activity rows`);
    for (const raw of [RAW_NAME, OTHER_RAW_NAME]) {
      assert.ok(!body.includes(raw), `${role} must not see the raw customer name "${raw}" anywhere in the payload: ${body.slice(0, 400)}`);
    }
    assert.ok(!body.includes("+919000000021"), `${role} must not see a raw phone`);
    assert.ok(!body.includes("leak@example.test"), `${role} must not see a raw email`);
  }
});

test("F1: the mask is the platform's own maskName, and the row is still identifiable", async () => {
  await seed();
  const payload = await (await call("r3g.opsov.auditor@pawspace.test")).json();
  const row = payload.data.activity.find((item) => item.bookingId === "BK-1");
  assert.ok(row, "the activity row must still be served - masking is not omission");
  assert.equal(row.customer, maskName(RAW_NAME), "the same mask the CRM and Customer 360 lists apply");
  assert.match(row.customer, /•/, "a masked value, not the raw name");
  assert.equal(row.service, "grooming", "everything an operator needs to work the row is untouched");
  assert.equal(row.scheduledTimeIst, "10:00");
});

test("F1: a booking whose customer row is missing still identifies itself by id, not by a masked blank", async () => {
  const { sqlite } = await seed();
  sqlite.prepare("DELETE FROM canonical_customers WHERE id='CUS-2'").run();
  const payload = await (await call("r3g.opsov.auditor@pawspace.test")).json();
  const row = payload.data.activity.find((item) => item.bookingId === "BK-2");
  assert.equal(row.customer, "CUS-2", "a customer id is not personal data and is what keeps the row findable");
});
