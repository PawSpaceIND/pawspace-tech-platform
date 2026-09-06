import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__OPS_QUEUE_DB__", "__OPS_QUEUE_ENV__");

const ORIGIN = "https://app.pawspace.in";
const MANAGER_EMAIL = "manager.ops-queue@pawspace.in";
const PROVIDER_EMAIL = "provider.ops-queue@pawspace.in";
const TASK_ID = "WQT-PRIVATE-PAYMENT-1";
const EVENT_ID = "WQE-PRIVATE-PAYMENT-1";
const BOOKING_ID = "BK-OPS-PRIVATE-1";
const CUSTOMER_ID = "CUS-OPS-PRIVATE-1";
const PROVIDER_ID = "PRO-OTHER-PRIVATE-1";
const PAYMENT_ID = "PAY-OPS-PRIVATE-1";
const PRIVATE_PHONE = "+919999111122";
const PRIVATE_NOTE = "Customer disputed a private Rs 4200 payment; Finance callback required";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      const results = [];
      for (const item of items) results.push(await item.run());
      return results;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__OPS_QUEUE_DB__ = db;
  globalThis.__OPS_QUEUE_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureWorkQueueTables } = await import("../lib/ops-work-queue.ts");
  await ensureSecurityTables(db);
  await ensureWorkQueueTables(db);

  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-OPS-QUEUE-MANAGER", MANAGER_EMAIL, "manager"],
    ["USR-OPS-QUEUE-PROVIDER", PROVIDER_EMAIL, "service_provider"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(id, email, role, role, now, now);
  }

  sqlite.prepare(`INSERT INTO ops_work_queue_tasks
    (id,rule,queue,priority,title,detail_json,booking_id,customer_id,provider_id,entity_type,entity_id,source_key,status,owner,sla_minutes,due_at,escalated,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'open',NULL,?,?,0,?,?)`)
    .run(
      TASK_ID,
      "payment_exception",
      "finance",
      "critical",
      "Private payment reconciliation exception",
      JSON.stringify({ paymentId: PAYMENT_ID, customerPhone: PRIVATE_PHONE, amount: 4200, reason: "private mismatch" }),
      BOOKING_ID,
      CUSTOMER_ID,
      PROVIDER_ID,
      "payment_exception",
      PAYMENT_ID,
      `payment_exception:${PAYMENT_ID}`,
      120,
      now + 120 * 60_000,
      now,
      now,
    );
  sqlite.prepare("INSERT INTO ops_work_queue_events (id,task_id,event_type,actor_id,note,created_at) VALUES (?,?,?,?,?,?)")
    .run(EVENT_ID, TASK_ID, "note", MANAGER_EMAIL, PRIVATE_NOTE, now);

  return { sqlite, db };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__OPS_QUEUE_DB__, ...globalThis.__OPS_QUEUE_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

function requestFor(email, query = "") {
  return new Request(`${ORIGIN}/api/ops-work-queue${query}`, {
    method: "GET",
    headers: email ? { "oai-authenticated-user-email": email } : {},
  });
}

async function call(email, query = "") {
  const request = requestFor(email, query);
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/ops-work-queue/route.ts");
  return { reachedRoute: true, response: await route.GET(request) };
}

function businessCounts(sqlite) {
  return {
    tasks: Number(sqlite.prepare("SELECT COUNT(*) count FROM ops_work_queue_tasks").get().count),
    events: Number(sqlite.prepare("SELECT COUNT(*) count FROM ops_work_queue_events").get().count),
  };
}

function auditCount(sqlite) {
  return Number(sqlite.prepare("SELECT COUNT(*) count FROM security_audit_events").get().count);
}

function assertNoPrivateData(serialized) {
  for (const secret of [TASK_ID, EVENT_ID, BOOKING_ID, CUSTOMER_ID, PROVIDER_ID, PAYMENT_ID, PRIVATE_PHONE, PRIVATE_NOTE, "4200"]) {
    assert.ok(!serialized.includes(secret), `the refusal must not disclose ${secret}`);
  }
}

test("service_provider cannot list the platform-wide Operations work queue", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const auditsBefore = auditCount(sqlite);
  const result = await call(PROVIDER_EMAIL);

  assert.equal(result.reachedRoute, false, "assigned-job visibility must not open the platform-wide Operations queue");
  assert.equal(result.response.status, 403);
  assertNoPrivateData(await result.response.text());
  assert.deepEqual(businessCounts(sqlite), before, "a denied queue read must not mutate work items or events");
  assert.equal(auditCount(sqlite), auditsBefore + 1, "the gateway denial must be audited exactly once");
});

test("service_provider cannot open a platform-wide Operations task detail or its event notes", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const result = await call(PROVIDER_EMAIL, `?taskId=${encodeURIComponent(TASK_ID)}`);

  assert.equal(result.reachedRoute, false, "a provider must not reach task detail through bookings.view");
  assert.equal(result.response.status, 403);
  assertNoPrivateData(await result.response.text());
  assert.deepEqual(businessCounts(sqlite), before);
});

test("the route independently refuses service_provider access when gateway composition is bypassed", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const route = await import("../app/api/ops-work-queue/route.ts");
  const response = await route.GET(requestFor(PROVIDER_EMAIL, `?taskId=${encodeURIComponent(TASK_ID)}`));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertNoPrivateData(await response.text());
  assert.deepEqual(businessCounts(sqlite), before);
});

test("manager retains the complete Operations queue and task-detail views", async () => {
  const { sqlite } = await world();
  const list = await call(MANAGER_EMAIL);
  assert.equal(list.reachedRoute, true);
  assert.equal(list.response.status, 200);
  const listBody = await list.response.json();
  assert.equal(listBody.data.queues.finance.tasks.length, 1);
  assert.equal(listBody.data.queues.finance.tasks[0].id, TASK_ID);
  assert.equal(listBody.data.queues.finance.tasks[0].customer_id, CUSTOMER_ID);

  const detail = await call(MANAGER_EMAIL, `?taskId=${encodeURIComponent(TASK_ID)}`);
  assert.equal(detail.reachedRoute, true);
  assert.equal(detail.response.status, 200);
  const detailBody = await detail.response.json();
  assert.equal(detailBody.data.task.id, TASK_ID);
  assert.equal(detailBody.data.events.length, 1);
  assert.equal(detailBody.data.events[0].note, PRIVATE_NOTE);
  assert.deepEqual(businessCounts(sqlite), { tasks: 1, events: 1 });
});
