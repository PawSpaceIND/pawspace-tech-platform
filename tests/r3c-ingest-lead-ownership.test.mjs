/*
 * R3-C / F10 (P3) — CSV-ingested leads were created owner='Unassigned' and never routed through
 * assignLeadOwner.
 *
 * MEASURED: an import through POST /api/admin/data-ingest wrote 'Unassigned' onto BOTH crm_contacts
 * and lead_work_items for every row. lib/lead-owner-identity.ts decides ownership by comparing an
 * owner to an ACTOR'S EMAIL, so a lead owned by the literal string "Unassigned" is owned by nobody: it
 * never enters a rep's worklist and is never chased. A lead a rep types into /crm goes through
 * assignLeadOwner; an imported one did not.
 *
 * Real route, real CSV stream, real SQLite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";

installWorkersHooks("__R3C_INGEST_DB__", "__R3C_INGEST_ENV__");

const ORIGIN = "https://uat.pawspace.in";
const ADMIN = "ops.admin@pawspace.test";
const REP = "neha.rep@pawspace.test";
const CSV = "name,primary_phone,email,city,service\nAnil Kumar,9845011001,anil@example.in,Bengaluru,Grooming\nSneha Rao,9845011002,sneha@example.in,Bengaluru,Grooming\n";

async function world({ withMember }) {
  const harness = freshCountingD1();
  enterWorkersDbScope(harness.db);
  globalThis.__R3C_INGEST_DB__ = harness.db;
  globalThis.__R3C_INGEST_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-ADMIN',?,?,'admin','active',?,?)").bind(ADMIN, "Ops Admin", now, now).run();
  if (withMember) {
    await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-REP',?,?,'associate','active',?,?)").bind(REP, "Neha Rep", now, now).run();
    const { ensureLeadOwnerTables } = await import("../lib/lead-owner-identity.ts");
    await ensureLeadOwnerTables(harness.db);
    await harness.db.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,workload_cap_override,created_by,created_at,updated_by,updated_at) VALUES ('LAM-1',?,'sales','[]','[]','[]',1,NULL,?,?,?,?)")
      .bind(REP, ADMIN, now, ADMIN, now).run();
  }
  return harness;
}

async function ingest() {
  const route = await import("../app/api/admin/data-ingest/route.ts");
  return route.POST(new Request(`${ORIGIN}/api/admin/data-ingest`, {
    method: "POST",
    headers: { "content-type": "text/csv", "oai-authenticated-user-email": ADMIN, "x-file-name": "prospects.csv" },
    body: CSV,
  }));
}

test("INGEST-01: an imported lead is assigned to a real person, on both tables", async () => {
  const harness = await world({ withMember: true });
  const response = await ingest();
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body).slice(0, 300));
  assert.equal(body.acceptedRows, 2, "both rows imported");
  assert.equal(body.leadOwner, REP, "the import reports who it assigned these leads to");
  assert.equal(body.leadOwnerResolved, true);

  const leads = harness.sqlite.prepare("SELECT owner FROM lead_work_items").all();
  assert.equal(leads.length, 2);
  for (const lead of leads) assert.equal(lead.owner, REP, "a lead owned by 'Unassigned' is owned by nobody and is never chased");
  const contacts = harness.sqlite.prepare("SELECT owner FROM crm_contacts").all();
  for (const contact of contacts) assert.equal(contact.owner, REP, "the CRM board shows the same owner");
});

test("INGEST-02: with no assignment member configured the import still succeeds and SAYS it landed unowned", async () => {
  // NON-VACUITY, and the honest half: the fix must not invent an owner where the platform has none.
  const harness = await world({ withMember: false });
  const response = await ingest();
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body).slice(0, 300));
  assert.equal(body.acceptedRows, 2, "the import is not blocked by an unconfigured assignment policy");
  assert.equal(body.leadOwnerResolved, false);
  assert.match(String(body.leadOwnerNote), /imported unowned/, "the operator is told, instead of it reading as success");
  for (const lead of harness.sqlite.prepare("SELECT owner FROM lead_work_items").all()) assert.equal(lead.owner, "Unassigned");
  assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM lead_owner_mapping_exceptions").get().c, 0,
    "and one unconfigured policy does not mint one exception row per imported prospect");
});

test("INGEST-03: re-importing the same file does not steal a lead a rep already owns", async () => {
  const harness = await world({ withMember: true });
  assert.equal((await ingest()).status, 201);
  const leadId = harness.sqlite.prepare("SELECT id,customer_id FROM lead_work_items LIMIT 1").get();
  harness.sqlite.prepare("UPDATE lead_work_items SET owner='someone.else@pawspace.test' WHERE id=?").run(leadId.id);
  harness.sqlite.prepare("UPDATE crm_contacts SET owner='someone.else@pawspace.test' WHERE id=?").run(leadId.customer_id);
  assert.equal((await ingest()).status, 201);
  assert.equal(harness.sqlite.prepare("SELECT owner FROM lead_work_items WHERE id=?").get(leadId.id).owner, "someone.else@pawspace.test",
    "an import may fill an empty owner, never overwrite a real one");
  assert.equal(harness.sqlite.prepare("SELECT owner FROM crm_contacts WHERE id=?").get(leadId.customer_id).owner, "someone.else@pawspace.test");
});
