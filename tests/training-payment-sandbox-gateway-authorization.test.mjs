import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAINING_CAPTURE_DB__", "__TRAINING_CAPTURE_ENV__");

const ORIGIN = "https://app.pawspace.in";
const ENDPOINT = `${ORIGIN}/api/training-payment-sandbox`;

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
  globalThis.__TRAINING_CAPTURE_DB__ = db;
  globalThis.__TRAINING_CAPTURE_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const { createTrainingQuote } = await import("../lib/training-commercial-governance.ts");
  const quote = await createTrainingQuote(db, {
    packageCode: "training-4-puppy",
    petCount: 1,
    scheduledStart: "2026-11-10T09:00:00.000Z",
    paymentMode: "prepaid",
  });
  return { sqlite, db, quote };
}

async function customerCookie(db, customerId = "CUS-TRAINING-CAPTURE") {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: "+919000001234",
    subjectType: "customer",
    subjectId: customerId,
    cityId: "blr",
    verificationState: "verified",
    expiresAt: null,
    metadata: {},
    actorId: "test",
    reason: "training capture gateway regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: "customer_app",
    principalType: "phone",
    principalKey: String(binding.principal_key),
    subjectType: "customer",
    subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function throughGateway(request) {
  const env = { DB: globalThis.__TRAINING_CAPTURE_DB__, ...globalThis.__TRAINING_CAPTURE_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

async function callEndpoint(request) {
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const { POST } = await import("../app/api/training-payment-sandbox/route.ts");
  return { reachedRoute: true, response: await POST(request) };
}

function captureRequest(quote, headers = {}) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "x-payment-capture-key": `capture-${quote.quoteId}`,
      ...headers,
    },
    body: JSON.stringify({ quoteId: quote.quoteId, amount: quote.amountDueNow }),
  });
}

function attestationCount(sqlite) {
  return Number(sqlite.prepare("SELECT COUNT(*) AS count FROM training_quote_payment_attestations").get().count);
}

test("a verified customer session can perform its training sandbox capture through the real Worker authorization composition", async () => {
  const { sqlite, db, quote } = await world();
  const cookie = await customerCookie(db);
  const result = await callEndpoint(captureRequest(quote, { cookie }));
  assert.equal(result.reachedRoute, true, `customer session was stopped at gateway with ${result.response.status}`);
  assert.equal(result.response.status, 201);
  assert.equal(attestationCount(sqlite), 1);
});

test("finance cannot use dashboard.view to create a training payment attestation, and refusal leaves persistence unchanged", async () => {
  const { sqlite, quote } = await world();
  const email = "finance.capture@pawspace.in";
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,0,0)")
    .run("finance-capture", email, "Finance capture", "finance", "active");
  const before = attestationCount(sqlite);
  const result = await callEndpoint(captureRequest(quote, { "oai-authenticated-user-email": email }));
  assert.equal(result.reachedRoute, false, "a dashboard-only role reached the payment-capture route");
  assert.equal(result.response.status, 403);
  assert.equal(attestationCount(sqlite), before, "gateway refusal must create no payment attestation");
});

test("anonymous training capture is refused before the route and creates no attestation", async () => {
  const { sqlite, quote } = await world();
  const result = await callEndpoint(captureRequest(quote));
  assert.equal(result.reachedRoute, false);
  assert.equal(result.response.status, 401);
  assert.equal(attestationCount(sqlite), 0);
});
