/**
 * Lead ownership references a real staff identity, or nobody. [PTJA-W3-CO]
 *
 * THE APPROVED RULE, supplied by the business:
 *   Replace roster first names with stable application user IDs. Ownership must reference a real
 *   app_users/staff identity. Do not guess that "Neha" corresponds to a particular login. Until
 *   Operations provides the mapping, leave those records unassigned and report the mapping exception.
 *   Do not weaken masking because the owner could not be resolved.
 *
 * WHAT WAS MEASURED BEFORE. Three separate lead-creation paths assign ownership from a hardcoded list
 * of first names - app/api/crm/route.ts and app/api/revenue-crm/route.ts both carry
 * ["Neha","Rahul","Priya","Sanjay"], and lib/app-to-revenue-funnel.ts carries the same four as
 * SALES_OWNERS and picks one by hashing the customer id. None of those strings is a login. Nothing can
 * tell which human "Neha" is, so the lead has no owner anybody can page, no owner whose permissions can
 * be checked, and no owner an assignment can be handed over from. The governed path
 * (lib/lead-assignment-governance.ts) already writes a real employee email or 'Unassigned' - these
 * three creation paths never went through it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CO_DB__", "__PTJA_CO_ENV__");

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

const ROSTER_NAMES = ["Neha", "Rahul", "Priya", "Sanjay"];

async function world({ withStaff = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CO_DB__ = db;
  globalThis.__PTJA_CO_ENV__ = {};
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const owner = await import("../lib/lead-owner-identity.ts");
  await owner.ensureLeadOwnerTables(db);
  const now = Date.now();
  if (withStaff) {
    // A real staff identity whose display name deliberately BEGINS with a roster first name, so a
    // fuzzy match would look like it worked.
    for (const [id, email, name] of [
      ["u-neha", "neha.verma@pawspace.test", "Neha Verma"],
      ["u-rahul", "rahul.iyer@pawspace.test", "Rahul Iyer"],
    ]) {
      sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'manager','active',?,?)").run(id, email, name, now, now);
    }
  }
  return { sqlite, db, owner, now };
}


const seedMembership = (sqlite, email, now) =>
  sqlite.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,created_by,created_at,updated_by,updated_at) VALUES (?,?,'sales','[]','[]','[]',1,'seed',?,'seed',?)")
    .run(`LAM-${email}`, email, now, now);

// ---------------------------------------------------------------------------------------------------
// Ownership is a real identity, or nobody
// ---------------------------------------------------------------------------------------------------

test("CO-01: a new lead is owned by a real staff identity", async () => {
  const { sqlite, db, owner, now } = await world();
  seedMembership(sqlite, "neha.verma@pawspace.test", now);
  const assigned = await owner.assignLeadOwner(db, { customerId: "CUS-1", service: "grooming" });
  assert.equal(assigned.owner, "neha.verma@pawspace.test", `an email, not a first name: ${JSON.stringify(assigned)}`);
  assert.equal(assigned.resolved, true, "and it resolved to a real identity");
});

test("CO-02: with no sales staff on the platform the lead is left Unassigned", async () => {
  // Never invented. An owner nobody can page is worse than an empty queue somebody has to look at.
  const { db, owner } = await world({ withStaff: false });
  const assigned = await owner.assignLeadOwner(db, { customerId: "CUS-1", service: "grooming" });
  assert.equal(assigned.owner, "Unassigned", `no owner is invented: ${JSON.stringify(assigned)}`);
  assert.equal(assigned.resolved, false, "and the module says so plainly");
  for (const name of ROSTER_NAMES) {
    assert.notEqual(assigned.owner, name, `${name} is a roster label, not a login`);
  }
});

test("CO-03: an unresolved assignment is reported as a mapping exception", async () => {
  const { sqlite, db, owner } = await world({ withStaff: false });
  await owner.assignLeadOwner(db, { customerId: "CUS-1", service: "grooming" });
  const exceptions = await owner.leadOwnerMappingExceptions(db);
  assert.ok(exceptions.unassignedAtCreation >= 1, `Operations is told there is a mapping to provide: ${JSON.stringify(exceptions)}`);
  assert.ok(Number(sqlite.prepare("SELECT COUNT(*) c FROM lead_owner_mapping_exceptions").get().c) >= 1,
    "and the exception is recorded, not just counted at read time");
});

test("CO-04: a roster first name is never guessed onto a staff member", async () => {
  // "Neha Verma" is a real, active staff identity whose name begins with the roster label. Matching on
  // that would be exactly the guess the rule forbids - it happens to be right here and would be wrong
  // the first time two Nehas exist.
  const { sqlite, db, owner, now } = await world();
  seedMembership(sqlite, "neha.verma@pawspace.test", now);
  const resolved = await owner.resolveLeadOwner(db, "Neha");
  assert.equal(resolved, null, `a first name resolves to nobody: ${JSON.stringify(resolved)}`);
  const byEmail = await owner.resolveLeadOwner(db, "neha.verma@pawspace.test");
  assert.equal(byEmail, "neha.verma@pawspace.test", "an exact identity still resolves");
});

test("CO-05: assignment spreads across the real identities rather than always picking one", async () => {
  const { sqlite, db, owner, now } = await world();
  seedMembership(sqlite, "neha.verma@pawspace.test", now);
  seedMembership(sqlite, "rahul.iyer@pawspace.test", now);
  const picked = new Set();
  for (let index = 0; index < 6; index += 1) {
    const assigned = await owner.assignLeadOwner(db, { customerId: `CUS-${index}`, service: "grooming" });
    picked.add(assigned.owner);
    sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,'Website','grooming',?,'Sales Manager','active','day_1',1,?,?,?,0,0,0,0,?,?)")
      .run(`LWI-${index}`, `CUS-${index}`, assigned.owner, now, now, now, now, now);
  }
  assert.equal(picked.size, 2, `both members take work: ${JSON.stringify([...picked])}`);
});

test("CO-06: an inactive staff member is not assigned new leads", async () => {
  const { sqlite, db, owner, now } = await world();
  seedMembership(sqlite, "neha.verma@pawspace.test", now);
  sqlite.prepare("UPDATE app_users SET status='disabled' WHERE email='neha.verma@pawspace.test'").run();
  const assigned = await owner.assignLeadOwner(db, { customerId: "CUS-1", service: "grooming" });
  assert.notEqual(assigned.owner, "neha.verma@pawspace.test", `a disabled login must not receive leads: ${JSON.stringify(assigned)}`);
  assert.equal(assigned.owner, "Unassigned", "and nobody else is invented in their place");
});

// ---------------------------------------------------------------------------------------------------
// Legacy rows are reported, not rewritten
// ---------------------------------------------------------------------------------------------------

test("CO-07: existing leads carrying roster names are reported, never silently reassigned", async () => {
  const { sqlite, db, owner, now } = await world();
  seedMembership(sqlite, "neha.verma@pawspace.test", now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LWI-OLD','CUS-OLD','Website','grooming','Neha','Sales Manager','active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run(now, now, now, now, now);

  const exceptions = await owner.leadOwnerMappingExceptions(db);
  assert.ok(exceptions.unresolvedOwners.includes("Neha"), `the legacy label is surfaced: ${JSON.stringify(exceptions)}`);
  assert.equal(String(sqlite.prepare("SELECT owner FROM lead_work_items WHERE id='LWI-OLD'").get().owner), "Neha",
    "and the row is NOT rewritten - guessing who Neha is would be the thing the rule forbids");
});

test("CO-08: a lead already owned by a real identity is not an exception", async () => {
  // Non-vacuity for CO-07. Reporting every lead would make the exception list useless.
  const { sqlite, db, owner, now } = await world();
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LWI-OK','CUS-OK','Website','grooming','neha.verma@pawspace.test','Sales Manager','active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run(now, now, now, now, now);
  const exceptions = await owner.leadOwnerMappingExceptions(db);
  assert.deepEqual(exceptions.unresolvedOwners, [], `a real identity is not an exception: ${JSON.stringify(exceptions)}`);
});

// ---------------------------------------------------------------------------------------------------
// The rule's last clause, and the creation paths
// ---------------------------------------------------------------------------------------------------

test("CO-09: an unresolved owner does not weaken CRM masking", async () => {
  const { sqlite, db, owner, now } = await world({ withStaff: false });
  await owner.assignLeadOwner(db, { customerId: "CUS-1", service: "grooming" });
  sqlite.exec("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,lifetime_value,created_at,updated_at) VALUES ('CUS-1','Ritu Malhotra','+919876543210','ritu@example.com','Indiranagar','New lead','Unassigned','Website',0,?,?)").run(now, now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-adm','admin@pawspace.test','Admin','founder','active',?,?)").run(now, now);

  const route = await import("../app/api/crm/route.ts");
  const response = await route.GET(new Request("https://uat.pawspace.in/api/crm", {
    headers: { "oai-authenticated-user-email": "admin@pawspace.test", "oai-authenticated-user-full-name": "Admin" },
  }));
  const body = await response.text();
  assert.equal(body.includes("+919876543210"), false, `an unassigned lead is still masked: ${body.slice(0, 300)}`);
  assert.equal(body.includes("ritu@example.com"), false, "email too");
});

test("CO-10: no lead-creation path carries a hardcoded sales roster any more", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = await readFile(new URL(`../${dir}/${entry.name}`, import.meta.url), "utf8");
      // The specific shape: a literal array of the roster first names used to pick an owner.
      if (/\[\s*"Neha"\s*,\s*"Rahul"\s*,\s*"Priya"\s*,\s*"Sanjay"\s*\]/.test(source)) offenders.push(`${dir}/${entry.name}`);
    }
  };
  for (const root of ["lib", "app/api"]) await walk(root);
  assert.deepEqual(offenders, [], "lead ownership must come from lib/lead-owner-identity, not a list of first names");
});
