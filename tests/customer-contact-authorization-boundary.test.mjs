import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CUSTOMER_CONTACT_DB__", "__CUSTOMER_CONTACT_ENV__");

const ORIGIN = "https://app.pawspace.in";
const PROVIDER_EMAIL = "provider.customer-contact@pawspace.in";
const ASSOCIATE_EMAIL = "associate.customer-contact@pawspace.in";
const CUSTOMER_KEY = "SUB-CUSTOMER-CONTACT-VICTIM";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
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
  globalThis.__CUSTOMER_CONTACT_DB__ = db;
  globalThis.__CUSTOMER_CONTACT_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCommunicationTables } = await import("../lib/communication-engine.ts");
  await ensureSecurityTables(db);
  await ensureCommunicationTables(db);

  sqlite.exec("CREATE TABLE subscription_customers (customer_key TEXT PRIMARY KEY, primary_phone TEXT, secondary_phone TEXT)");
  sqlite.prepare("INSERT INTO subscription_customers (customer_key,primary_phone,secondary_phone) VALUES (?,?,?)")
    .run(CUSTOMER_KEY, "+919999111122", "+919999333344");

  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-PROVIDER-CUSTOMER-CONTACT", PROVIDER_EMAIL, "service_provider"],
    ["USR-ASSOCIATE-CUSTOMER-CONTACT", ASSOCIATE_EMAIL, "associate"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(id, email, role, role, now, now);
  }

  return { sqlite, db };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__CUSTOMER_CONTACT_DB__, ...globalThis.__CUSTOMER_CONTACT_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

async function call(email, body) {
  const request = new Request(`${ORIGIN}/api/customer-contact`, {
    method: "POST",
    headers: {
      "oai-authenticated-user-email": email,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/customer-contact/route.ts");
  return { reachedRoute: true, response: await route.POST(request) };
}

function count(sqlite, table) {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function persistence(sqlite) {
  return {
    threads: count(sqlite, "communication_threads"),
    participants: count(sqlite, "communication_participants"),
    messages: count(sqlite, "communication_messages"),
    outbox: count(sqlite, "communication_outbox"),
    audits: count(sqlite, "security_audit_events"),
  };
}

for (const channel of ["call", "message"]) {
  test(`service providers cannot use broad Customer 360 ${channel} contact against an arbitrary customer`, async () => {
    const { sqlite } = await world();
    const before = persistence(sqlite);
    const result = await call(PROVIDER_EMAIL, {
      channel,
      customerKey: CUSTOMER_KEY,
      target: "primary",
      cityId: "blr",
      purpose: "marketing",
      idempotencyKey: `provider-arbitrary-${channel}`,
    });

    assert.equal(result.reachedRoute, false, "service_provider reached the broad Customer 360 contact route");
    assert.equal(result.response.status, 403);
    assert.deepEqual(
      persistence(sqlite),
      { ...before, audits: before.audits + 1 },
      "only the gateway denial audit may be written",
    );
  });
}

test("a provisioned Customer Experience associate retains the broad Customer 360 contact action", async () => {
  const { sqlite } = await world();
  const result = await call(ASSOCIATE_EMAIL, {
    channel: "message",
    customerKey: CUSTOMER_KEY,
    target: "primary",
    cityId: "blr",
    purpose: "marketing",
    idempotencyKey: "associate-authorized-message",
  });

  assert.equal(result.reachedRoute, true);
  assert.equal(result.response.status, 200);
  assert.equal(count(sqlite, "communication_messages"), 1);
});
