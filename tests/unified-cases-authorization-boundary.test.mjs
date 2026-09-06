import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__UNIFIED_CASE_DB__", "__UNIFIED_CASE_ENV__");

const ORIGIN = "https://app.pawspace.in";
const MANAGER_EMAIL = "manager.unified-cases@pawspace.in";
const PROVIDER_EMAIL = "provider.unified-cases@pawspace.in";
const CASE_ID = "CASE-PRIVATE-FINANCE-1";
const EVENT_ID = "CASEE-PRIVATE-FINANCE-1";
const COMMENT_ID = "CASEC-PRIVATE-FINANCE-1";
const POLICY_ID = "CASEP-PRIVATE-FINANCE-1";
const BOOKING_ID = "BK-UNRELATED-PRIVATE-1";
const CUSTOMER_ID = "CUS-UNRELATED-PRIVATE-1";
const PROVIDER_ID = "PRO-UNRELATED-PRIVATE-1";
const PAYMENT_ID = "PAY-UNRELATED-PRIVATE-1";
const PRIVATE_PHONE = "+919999222233";
const PRIVATE_DESCRIPTION = `Customer ${PRIVATE_PHONE} disputed a private Rs 7600 settlement`;
const PRIVATE_COMMENT = "Finance confirms the customer's bank trace; do not disclose before callback";
const PRIVATE_APPROVAL = "CFO-UAT-PRIVATE-2026";

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
  globalThis.__UNIFIED_CASE_DB__ = db;
  globalThis.__UNIFIED_CASE_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureUnifiedCaseTables } = await import("../lib/unified-case-center.ts");
  await ensureSecurityTables(db);
  await ensureUnifiedCaseTables(db);

  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-UNIFIED-CASE-MANAGER", MANAGER_EMAIL, "manager"],
    ["USR-UNIFIED-CASE-PROVIDER", PROVIDER_EMAIL, "service_provider"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(id, email, role, role, now, now);
  }

  sqlite.prepare(`INSERT INTO case_policies
    (id,name,status,version,case_type,severity,first_response_minutes,resolution_minutes,manager_escalation_minutes,effective_from,effective_until,approval_reference,created_by,created_at,updated_by,updated_at)
    VALUES (?,?, 'active_uat',1,'reconciliation','critical',15,240,30,?,NULL,?,?,?, ?,?)`)
    .run(POLICY_ID, "Private finance reconciliation SLA", now - 60_000, PRIVATE_APPROVAL, MANAGER_EMAIL, now, MANAGER_EMAIL, now);

  sqlite.prepare(`INSERT INTO unified_cases
    (id,idempotency_key,case_type,severity,status,title,description,customer_id,booking_id,payment_id,provider_id,source_type,source_id,owner_team,owner_email,policy_id,policy_version,first_response_due_at,resolution_due_at,manager_escalation_due_at,created_by,created_at,updated_by,updated_at)
    VALUES (?,?, 'reconciliation','critical','open',?,?,?,?,?,?,'payment_reconciliation_exception',?,'finance',?,?,1,?,?,?,?,?,?,?)`)
    .run(
      CASE_ID,
      `private-reconciliation:${PAYMENT_ID}`,
      "Private payment reconciliation dispute",
      PRIVATE_DESCRIPTION,
      CUSTOMER_ID,
      BOOKING_ID,
      PAYMENT_ID,
      PROVIDER_ID,
      PAYMENT_ID,
      MANAGER_EMAIL,
      POLICY_ID,
      now + 15 * 60_000,
      now + 240 * 60_000,
      now + 30 * 60_000,
      MANAGER_EMAIL,
      now,
      MANAGER_EMAIL,
      now,
    );
  sqlite.prepare("INSERT INTO unified_case_events (id,idempotency_key,case_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(EVENT_ID, `created:${CASE_ID}`, CASE_ID, "created", MANAGER_EMAIL, JSON.stringify({ amount: 7600, paymentId: PAYMENT_ID }), now);
  sqlite.prepare("INSERT INTO unified_case_comments (id,case_id,actor_id,body,visibility,created_at) VALUES (?,?,?,?, 'internal',?)")
    .run(COMMENT_ID, CASE_ID, MANAGER_EMAIL, PRIVATE_COMMENT, now);

  return { sqlite, db };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__UNIFIED_CASE_DB__, ...globalThis.__UNIFIED_CASE_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

function requestFor(email, query = "") {
  return new Request(`${ORIGIN}/api/unified-cases${query}`, {
    method: "GET",
    headers: email ? { "oai-authenticated-user-email": email } : {},
  });
}

async function call(email, query = "") {
  const request = requestFor(email, query);
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/unified-cases/route.ts");
  return { reachedRoute: true, response: await route.GET(request) };
}

function businessCounts(sqlite) {
  return {
    cases: Number(sqlite.prepare("SELECT COUNT(*) count FROM unified_cases").get().count),
    events: Number(sqlite.prepare("SELECT COUNT(*) count FROM unified_case_events").get().count),
    comments: Number(sqlite.prepare("SELECT COUNT(*) count FROM unified_case_comments").get().count),
    policies: Number(sqlite.prepare("SELECT COUNT(*) count FROM case_policies").get().count),
  };
}

function auditCount(sqlite) {
  return Number(sqlite.prepare("SELECT COUNT(*) count FROM security_audit_events").get().count);
}

function assertNoPrivateData(serialized) {
  for (const secret of [
    CASE_ID,
    EVENT_ID,
    COMMENT_ID,
    POLICY_ID,
    BOOKING_ID,
    CUSTOMER_ID,
    PROVIDER_ID,
    PAYMENT_ID,
    PRIVATE_PHONE,
    PRIVATE_DESCRIPTION,
    PRIVATE_COMMENT,
    PRIVATE_APPROVAL,
    "7600",
  ]) {
    assert.ok(!serialized.includes(secret), `the refusal must not disclose ${secret}`);
  }
}

test("service_provider cannot list the platform-wide Unified Case Center", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const auditsBefore = auditCount(sqlite);
  const result = await call(PROVIDER_EMAIL);

  assert.equal(result.reachedRoute, false, "assigned-booking visibility must not open every internal case");
  assert.equal(result.response.status, 403);
  assertNoPrivateData(await result.response.text());
  assert.deepEqual(businessCounts(sqlite), before, "a denied case-directory read must not mutate cases, events, comments, or policies");
  assert.equal(auditCount(sqlite), auditsBefore + 1, "the gateway denial must be audited exactly once");
});

test("service_provider cannot read platform-wide case SLA coverage or proposed policy defaults", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const result = await call(PROVIDER_EMAIL, "?scope=sla_coverage");

  assert.equal(result.reachedRoute, false, "bookings.view must not expose internal case-governance configuration");
  assert.equal(result.response.status, 403);
  assertNoPrivateData(await result.response.text());
  assert.deepEqual(businessCounts(sqlite), before);
});

test("the route independently refuses service_provider access when gateway composition is bypassed", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const route = await import("../app/api/unified-cases/route.ts");
  const response = await route.GET(requestFor(PROVIDER_EMAIL));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertNoPrivateData(await response.text());
  assert.deepEqual(businessCounts(sqlite), before);
});

test("manager retains the complete case directory and SLA coverage views", async () => {
  const { sqlite } = await world();
  const directory = await call(MANAGER_EMAIL);
  assert.equal(directory.reachedRoute, true);
  assert.equal(directory.response.status, 200);
  assert.equal(directory.response.headers.get("cache-control"), "no-store");
  const body = await directory.response.json();
  assert.equal(body.directory.cases.length, 1);
  assert.equal(body.directory.cases[0].id, CASE_ID);
  assert.equal(body.directory.cases[0].links.customerId, CUSTOMER_ID);
  assert.equal(body.directory.cases[0].links.bookingId, BOOKING_ID);
  assert.equal(body.directory.cases[0].links.paymentId, PAYMENT_ID);
  assert.equal(body.directory.comments.length, 1);
  assert.equal(body.directory.comments[0].body, PRIVATE_COMMENT);
  assert.equal(body.directory.events.length, 1);
  assert.equal(body.directory.events[0].id, EVENT_ID);
  assert.equal(body.directory.policies.length, 1);
  assert.equal(body.directory.policies[0].approvalReference, PRIVATE_APPROVAL);

  const coverage = await call(MANAGER_EMAIL, "?scope=sla_coverage");
  assert.equal(coverage.reachedRoute, true);
  assert.equal(coverage.response.status, 200);
  const coverageBody = await coverage.response.json();
  assert.equal(coverageBody.data.coverage.covered, 1);
  assert.equal(coverageBody.data.proposedDefaults.length, 36, "the endpoint returns the complete default-policy matrix alongside current coverage");
  assert.deepEqual(businessCounts(sqlite), { cases: 1, events: 1, comments: 1, policies: 1 });
});
