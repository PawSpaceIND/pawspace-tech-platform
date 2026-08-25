import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__COMMS_BOUNDARY_DB__", "__COMMS_BOUNDARY_ENV__");

const ORIGIN = "https://app.pawspace.in";
const PROVIDER_EMAIL = "provider.comms@pawspace.in";
const ASSOCIATE_EMAIL = "associate.comms@pawspace.in";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__COMMS_BOUNDARY_DB__ = db;
  globalThis.__COMMS_BOUNDARY_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCommunicationTables } = await import("../lib/communication-engine.ts");
  const { ensureConversationGovernance } = await import("../lib/conversation-governance.ts");
  await ensureSecurityTables(db);
  await ensureCommunicationTables(db);
  await ensureConversationGovernance(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run("CUS-COMMS-VICTIM", "blr", "Victim Customer", "+919999111122", now, now);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,assigned_to,created_at,updated_at) VALUES (?,?, 'open','cx-owner@pawspace.in',?,?)")
    .run("THREAD-COMMS-VICTIM", "CUS-COMMS-VICTIM", now, now);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,'inbound','whatsapp','transactional','inbound',?,'delivered',?,'{}','customer',?,?)")
    .run("MSG-COMMS-VICTIM", "THREAD-COMMS-VICTIM", "CUS-COMMS-VICTIM", JSON.stringify({ text: "private customer message", customerPhone: "+919999111122", internalNote: "refund dispute" }), "victim-message-1", now, now);

  for (const [id, email, role] of [
    ["USR-PROVIDER-COMMS", PROVIDER_EMAIL, "service_provider"],
    ["USR-ASSOCIATE-COMMS", ASSOCIATE_EMAIL, "associate"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(id, email, role, role, now, now);
  }
  return { sqlite, db };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__COMMS_BOUNDARY_DB__, ...globalThis.__COMMS_BOUNDARY_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

async function call(path, method, email, body) {
  const headers = { "oai-authenticated-user-email": email };
  if (body !== undefined) {
    headers.origin = ORIGIN;
    headers["content-type"] = "application/json";
  }
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const modulePath = path.startsWith("/api/conversations")
    ? "../app/api/conversations/route.ts"
    : "../app/api/communications/route.ts";
  const route = await import(modulePath);
  return { reachedRoute: true, response: await route[method](request) };
}

function count(sqlite, table) {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

test("service providers cannot list the platform-wide conversation queue or full customer contact data", async () => {
  await world();
  const result = await call("/api/conversations?status=open", "GET", PROVIDER_EMAIL);
  assert.equal(result.reachedRoute, false, "service_provider reached the staff conversation queue");
  assert.equal(result.response.status, 403);
});

test("service providers cannot reassign or close an unrelated customer conversation, and refusal leaves it unchanged", async () => {
  const { sqlite } = await world();
  const before = sqlite.prepare("SELECT status,assigned_to FROM communication_threads WHERE id=?").get("THREAD-COMMS-VICTIM");
  const result = await call("/api/conversations", "POST", PROVIDER_EMAIL, {
    action: "status",
    threadId: "THREAD-COMMS-VICTIM",
    status: "closed",
    reason: "provider should not control CX",
  });
  assert.equal(result.reachedRoute, false, "service_provider reached a staff conversation mutation");
  assert.equal(result.response.status, 403);
  assert.deepEqual(sqlite.prepare("SELECT status,assigned_to FROM communication_threads WHERE id=?").get("THREAD-COMMS-VICTIM"), before);
  assert.equal(count(sqlite, "conversation_audit_events"), 0);
});

test("service providers cannot read the platform-wide communications ledger, payloads, outbox, dead letters, policies or adapters", async () => {
  await world();
  const result = await call("/api/communications", "GET", PROVIDER_EMAIL);
  assert.equal(result.reachedRoute, false, "service_provider reached the system communications ledger");
  assert.equal(result.response.status, 403);
});

test("service providers cannot enqueue an arbitrary outbound message for an unrelated customer, and refusal creates no side effect", async () => {
  const { sqlite } = await world();
  const before = {
    messages: count(sqlite, "communication_messages"),
    threads: count(sqlite, "communication_threads"),
    outbox: count(sqlite, "communication_outbox"),
    audits: count(sqlite, "security_audit_events"),
  };
  const result = await call("/api/communications", "POST", PROVIDER_EMAIL, {
    action: "enqueue",
    customerId: "CUS-COMMS-VICTIM",
    cityId: "blr",
    channel: "sms",
    purpose: "auth",
    idempotencyKey: "provider-unrelated-message",
    templateKey: "otp",
    payload: { text: "provider-controlled message" },
  });
  assert.equal(result.reachedRoute, false, "service_provider reached arbitrary communications enqueue");
  assert.equal(result.response.status, 403);
  assert.deepEqual({
    messages: count(sqlite, "communication_messages"),
    threads: count(sqlite, "communication_threads"),
    outbox: count(sqlite, "communication_outbox"),
    audits: count(sqlite, "security_audit_events"),
  }, { ...before, audits: before.audits + 1 }, "only the gateway denial audit may be written");
});

test("a provisioned CX associate retains access to the staff conversation queue", async () => {
  await world();
  const result = await call("/api/conversations?status=open", "GET", ASSOCIATE_EMAIL);
  assert.equal(result.reachedRoute, true);
  assert.equal(result.response.status, 200);
});
