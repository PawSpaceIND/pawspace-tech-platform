import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { actorCanAccessConversation, ensureConversationAccessTables } from "../lib/conversation-access.ts";

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
  };
}

const actor = { email: "agent@pawspace.in", roleCode: "agent", permissions: ["communications.manage"], developmentPreview: false };
const now = Date.now();

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  sqlite.exec("CREATE TABLE communication_threads (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,lead_id TEXT,status TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  await ensureConversationAccessTables(db);
  sqlite.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,workload_cap_override,created_by,created_at,updated_by,updated_at) VALUES ('MEM-1',?,'cx','[\"grooming\"]','[\"bengaluru\"]','[]',1,NULL,'test',?,'test',?)").run(actor.email, now, now);
  sqlite.prepare("INSERT INTO lead_assignment_policies (id,name,status,version,team_code,service_codes_json,city_ids_json,language_codes_json,max_active_workload,continuity_enabled,require_shift,fallback_queue,effective_from,effective_until,approval_reference,created_by,created_at,updated_by,updated_at) VALUES ('POL-1','CX grooming','active_uat',1,'cx','[\"grooming\"]','[\"bengaluru\"]','[]',20,1,0,'cx-default',?,NULL,'UAT','test',?,'test',?)").run(now - 1000, now, now);
  return { sqlite, db };
}

function seedCustomer(sqlite, customerId, area = "Bengaluru") {
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,area,created_at,updated_at) VALUES (?,?,?, ?,?,?)").run(customerId, customerId, `9${customerId.padEnd(9,"0").slice(0,9)}`, area, now, now);
}

function seedLead(sqlite, id, customerId, service = "grooming", status = "active") {
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?, 'website',?,'agent','manager',?,'day_1',1,?,?,?, ?,?)")
    .run(id, customerId, service, status, now, now, now, now, now);
}

test("leadless conversation uses the only active canonical lead for scoped staff access", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS1");
  seedLead(sqlite, "LEAD1", "CUS1");
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,lead_id,status,updated_at) VALUES ('THREAD1','CUS1',NULL,'open',?)").run(now);
  assert.equal(await actorCanAccessConversation(db, actor, "THREAD1"), true);
});

test("leadless conversation stays fail-closed when multiple active leads make linkage ambiguous", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS2");
  seedLead(sqlite, "LEAD2A", "CUS2");
  seedLead(sqlite, "LEAD2B", "CUS2");
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,lead_id,status,updated_at) VALUES ('THREAD2','CUS2',NULL,'open',?)").run(now);
  assert.equal(await actorCanAccessConversation(db, actor, "THREAD2"), false);
});

test("a linked conversation cannot borrow access from a different lead for the same customer", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS3");
  seedLead(sqlite, "LEAD3-BOARDING", "CUS3", "boarding");
  seedLead(sqlite, "LEAD3-GROOMING", "CUS3", "grooming");
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,lead_id,status,updated_at) VALUES ('THREAD3','CUS3','LEAD3-BOARDING','open',?)").run(now);
  assert.equal(await actorCanAccessConversation(db, actor, "THREAD3"), false);
});
