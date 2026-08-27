/**
 * The staff PII reveal control. [PTJA-W3-RU]
 *
 * THE APPROVED RULE, supplied by the business:
 *   The reveal control is required for the audited API to be operationally usable and is in scope. It
 *   must include: role-authorized users only; a mandatory reveal reason; a short-lived reveal;
 *   automatic remasking; audit of actor, subject, reason, timestamp and fields revealed; and masked
 *   list, search and export views by default.
 *
 * WHAT WAS MEASURED BEFORE. app/api/customer-data-reveal exists and is audited, and every staff list
 * surface serves masked values - but nothing calls the reveal. A staff member looking at
 * "+91 ••••••3210" on the Customer 360 screen has no way to get the number they need to do their job,
 * so the control is not "safe by default", it is unusable, and the predictable outcome is a
 * spreadsheet somebody keeps outside the platform. Two halves of the rule were also not implemented at
 * all server-side: the reveal never expired, and the audit recorded a coarse data_class rather than
 * which FIELDS were revealed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_RU_DB__", "__PTJA_RU_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
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

const RAW_PHONE = "+919876543210";
const RAW_EMAIL = "ritu@example.com";

async function world(role = "founder") {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_RU_DB__ = db;
  globalThis.__PTJA_RU_ENV__ = {};
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  const email = `${role}@pawspace.test`;
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`u-${role}`, email, role, role, now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES ('CUST-1','blr','Ritu Malhotra',?,?,?,?)").run(RAW_PHONE, RAW_EMAIL, now, now);
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email, "oai-authenticated-user-full-name": role };
  const reveal = async (body) => {
    const route = await import("../app/api/customer-data-reveal/route.ts");
    const response = await route.POST(new Request("https://uat.pawspace.in/api/customer-data-reveal", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const peek = async () => {
    const route = await import("../app/api/customer-data-reveal/route.ts");
    const response = await route.GET(new Request("https://uat.pawspace.in/api/customer-data-reveal?customerId=CUST-1", { headers }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { sqlite, db, headers, reveal, peek };
}

// ---------------------------------------------------------------------------------------------------
// Short-lived, and what the audit records
// ---------------------------------------------------------------------------------------------------

test("RU-01: a reveal is short-lived and says when it stops being valid", async () => {
  const { reveal } = await world();
  const result = await reveal({ customerId: "CUST-1", purpose: "operations", reason: "Customer called about today's visit" });
  assert.equal(result.status, 200, `the reveal succeeds: ${JSON.stringify(result).slice(0, 250)}`);
  const expiresAt = Number(result.body?.data?.revealExpiresAt);
  assert.ok(Number.isFinite(expiresAt), `an expiry is published: ${JSON.stringify(result.body?.data).slice(0, 300)}`);
  assert.ok(expiresAt > Date.now(), "which is in the future");
  assert.ok(expiresAt - Date.now() <= 15 * 60_000, `and short: ${Math.round((expiresAt - Date.now()) / 1000)}s`);
});

test("RU-02: the audit records WHICH fields were revealed, not just that something was", async () => {
  const { sqlite, reveal } = await world();
  await reveal({ customerId: "CUST-1", purpose: "operations", reason: "Customer called about today's visit" });
  const row = sqlite.prepare("SELECT actor_id,subject_id,reason,data_class,created_at FROM customer_data_reveals WHERE subject_id='CUST-1'").get();
  assert.ok(row, "a reveal row exists");
  assert.equal(String(row.actor_id), "founder@pawspace.test", "the actor");
  assert.equal(String(row.subject_id), "CUST-1", "the subject");
  assert.match(String(row.reason), /today's visit/, "the reason");
  assert.ok(Number(row.created_at) > 0, "the timestamp");
  assert.match(String(row.data_class), /phone/, `and the fields: ${String(row.data_class)}`);
});

test("RU-03: revealing only the address records only the address", async () => {
  // Non-vacuity for RU-02. A data_class that always says the same thing records nothing.
  const { sqlite, reveal } = await world();
  await reveal({ customerId: "CUST-1", purpose: "operations", reason: "Confirming the doorstep for tomorrow", fields: ["address"] });
  const row = sqlite.prepare("SELECT data_class FROM customer_data_reveals WHERE subject_id='CUST-1'").get();
  assert.equal(String(row.data_class).includes("phone"), false, `a phone that was not revealed must not be logged as revealed: ${String(row.data_class)}`);
  assert.match(String(row.data_class), /address/, "and the address that was is");
});

test("RU-04: a field the caller did not ask for is not returned", async () => {
  const { reveal } = await world();
  const result = await reveal({ customerId: "CUST-1", purpose: "operations", reason: "Confirming the doorstep for tomorrow", fields: ["address"] });
  assert.equal(JSON.stringify(result.body).includes(RAW_PHONE), false,
    `asking for the address must not hand over the phone: ${JSON.stringify(result.body).slice(0, 300)}`);
});

test("RU-05: asking for the phone still returns the phone", async () => {
  // Non-vacuity for RU-04.
  const { reveal } = await world();
  const result = await reveal({ customerId: "CUST-1", purpose: "operations", reason: "Customer called about today's visit", fields: ["phone"] });
  assert.ok(JSON.stringify(result.body).includes(RAW_PHONE), `the number the work needs still arrives: ${JSON.stringify(result.body).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------------------------------
// What the screen is allowed to know before anybody asks
// ---------------------------------------------------------------------------------------------------

test("RU-06: the masked read tells the screen whether a reveal is even available", async () => {
  // A button that is always shown and always fails is worse than no button.
  const { peek } = await world();
  const result = await peek();
  assert.equal(result.status, 200, `the masked view loads: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(result.body?.data?.revealAvailable, true, "a founder may reveal");
  assert.equal(JSON.stringify(result.body).includes(RAW_PHONE), false, "and the masked view carries no raw value");
});

test("RU-07: a role that may not reveal is told so, rather than shown a button that fails", async () => {
  const { peek } = await world("associate");
  const result = await peek();
  assert.equal(result.body?.data?.revealAvailable, false, `an associate with no assignment cannot reveal: ${JSON.stringify(result.body).slice(0, 250)}`);
});

// ---------------------------------------------------------------------------------------------------
// The control itself
// ---------------------------------------------------------------------------------------------------

const revealComponent = () => fs.readFileSync(new URL("../app/control/customer-reveal.tsx", import.meta.url), "utf8");

test("RU-08: the reveal control exists and refuses to submit without a reason", async () => {
  const source = revealComponent();
  assert.match(source, /reason/i, "it collects a reason");
  assert.match(source, /disabled=\{[^}]*reason/,
    "and the submit control is disabled until one is typed, rather than failing server-side after the click");
});

test("RU-09: the control remasks itself automatically", async () => {
  const source = revealComponent();
  assert.match(source, /setTimeout|revealExpiresAt/, "it schedules its own remask");
  assert.match(source, /clearTimeout/, "and clears the timer when it unmounts, so a stale reveal cannot resurface");
  assert.match(source, /revealExpiresAt/, "driven by the server's expiry, not a number the screen invents");
});

test("RU-10: the control never renders a raw value it was not given", async () => {
  const source = revealComponent();
  assert.equal(/primary_phone|primaryPhone/.test(source) && !/revealed/.test(source), false,
    "it renders the revealed value from the reveal response, not a field off the list row");
  assert.match(source, /revealAvailable/, "and it only offers itself where the server said a reveal is possible");
});

test("RU-11: the customer worklist uses the control instead of printing the contact", async () => {
  const panel = fs.readFileSync(new URL("../app/control/customer-data-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /CustomerReveal/, "the panel mounts the reveal control");
  assert.doesNotMatch(panel, /<strong>\{c\.primary_phone\}<\/strong>/,
    "and no longer prints the contact field straight onto the screen");
});
