import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Phase 2 remediation D5 (P1) — OTP code disclosure must be production-gated.
//
// DEFECT: lib/customer-otp.ts:requestCustomerOtp and lib/partner-otp.ts:requestPartnerOtp generate a
// 6-digit OTP and the route handlers returned it verbatim in the response as `sandboxCode`. In
// production that lets ANY caller do: POST {action:"request"} → read the leaked code → POST
// {action:"verify"} → obtain a real session for ANY phone number = account takeover.
//
// FIX (per approved spec): the code must NEVER appear in the API response by default. It is disclosed
// ONLY when the UAT switch is explicitly ON — the repo's established PAWSPACE_UAT_LOGIN==="on" gate.
// Fail-closed: unset OR any-other-value ⇒ no disclosure. The code is still generated + persisted so
// `verify` keeps working; it is only removed from the response payload.
//
// This suite drives the REAL route handlers over a real SQLite-backed D1 shim, on a NON-localhost host
// (https://app.pawspace.in/...) so nothing short-circuits to a dev-preview superuser.
// ---------------------------------------------------------------------------
installWorkersHooks("__OTPD_DB__", "__OTPD_ENV__");

// A >=32-char secret so verifyIdentityAssertion / getAssertionSecret are satisfied in the round-trip.
const SECRET = "phase2-d5-assertion-secret-0123456789abcdef";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// env is empty by default (no PAWSPACE_UAT_LOGIN) => production-like / fail-closed.
function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__OTPD_DB__ = makeD1(sqlite);
  globalThis.__OTPD_ENV__ = { PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: SECRET, ...env };
  // verifyCustomerOtp upserts into canonical_customers (its own ensure* only creates the challenge
  // table), so create the table the customer verify path reads/writes.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  return sqlite;
}

const customerRoute = await import("../app/api/customer-otp/route.ts");
const partnerRoute = await import("../app/api/partner-otp/route.ts");

const CUSTOMER_URL = "https://app.pawspace.in/api/customer-otp";
const PARTNER_URL = "https://app.pawspace.in/api/partner-otp";

const post = (url, body) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function call(handler, url, body) {
  const res = await handler(post(url, body));
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed, setCookie: res.headers.get("set-cookie") };
}

// Each flavor's request handler + phone + the persisted-challenge table, driven identically.
const FLAVORS = [
  { name: "customer", handler: customerRoute.POST, url: CUSTOMER_URL, phone: "9812345670", table: "customer_otp_challenges" },
  { name: "partner", handler: partnerRoute.POST, url: PARTNER_URL, phone: "9812345671", table: "partner_otp_challenges" },
];

// The persisted 6-digit code for the single most-recent challenge of a phone.
const persistedCode = (sqlite, table, phone) =>
  sqlite.prepare(`SELECT code FROM ${table} WHERE phone=? ORDER BY created_at DESC LIMIT 1`).get(phone)?.code;
const challengeRows = (sqlite, table, phone) =>
  sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE phone=?`).get(phone).c;

// ---------------------------------------------------------------------------
// 1 + 2. Production-like / fail-closed: UNSET and "off" must both disclose NOTHING.
// ---------------------------------------------------------------------------
for (const envDesc of [
  { label: "PAWSPACE_UAT_LOGIN UNSET", env: {} },
  { label: 'PAWSPACE_UAT_LOGIN="off"', env: { PAWSPACE_UAT_LOGIN: "off" } },
  { label: 'PAWSPACE_UAT_LOGIN="ON" (wrong case — must fail closed)', env: { PAWSPACE_UAT_LOGIN: "ON" } },
]) {
  for (const f of FLAVORS) {
    test(`FAIL-CLOSED [${envDesc.label}] /api/${f.name}-otp request returns 200 but NO OTP code in the body`, async () => {
      const sqlite = freshDb(envDesc.env);
      const { status, body } = await call(f.handler, f.url, { action: "request", phone: f.phone });

      assert.equal(status, 200, `request must still succeed: ${JSON.stringify(body)}`);
      const data = body?.data ?? {};
      // No code-bearing field of any spelling.
      assert.equal(data.sandboxCode, undefined, "sandboxCode must be absent from the response");
      assert.equal(data.code, undefined, "no `code` field either");
      // The non-secret fields the client legitimately needs are still present.
      assert.ok(data.challengeId, "challengeId is still returned so the client can verify");
      assert.equal(data.expiresInSeconds, 300, "expiry metadata preserved");

      // 4. The server still GENERATED + PERSISTED the code — the challenge row exists with a real
      //    6-digit code — even though it was withheld from the response.
      assert.equal(challengeRows(sqlite, f.table, f.phone), 1, "exactly one challenge persisted server-side");
      const code = persistedCode(sqlite, f.table, f.phone);
      assert.match(String(code), /^\d{6}$/, "a real 6-digit OTP was persisted");

      // 2. Account-takeover path is closed: the exact persisted code appears NOWHERE in the response.
      const dump = JSON.stringify(body);
      assert.ok(!dump.includes(String(code)), `the persisted OTP (${code}) must not leak anywhere in the response body: ${dump}`);
    });
  }
}

// ---------------------------------------------------------------------------
// 2 (cont). Attacker who only knows the phone cannot obtain the code, so cannot verify.
// ---------------------------------------------------------------------------
for (const f of FLAVORS) {
  test(`ATTACK CLOSED — /api/${f.name}-otp: request leaks nothing usable, so a phone-only attacker cannot verify`, async () => {
    freshDb(); // production-like, no UAT flag
    const requested = await call(f.handler, f.url, { action: "request", phone: f.phone });
    const challengeId = requested.body?.data?.challengeId;
    assert.ok(challengeId, "the attacker does learn the (non-secret) challengeId");
    assert.equal(requested.body?.data?.sandboxCode, undefined, "but not the code");

    // Best case for the attacker: guess. A single wrong guess is rejected — no session issued.
    const guess = await call(f.handler, f.url, { action: "verify", challengeId, code: "000000" });
    assert.equal(guess.status, 500, "a wrong code is rejected (route surfaces the thrown error), not a session");
    assert.equal(guess.setCookie, null, "no session cookie is ever set for an unverified attacker");
    assert.match(String(guess.body?.error || ""), /Incorrect OTP/, "verify fails on the wrong code");
  });
}

// ---------------------------------------------------------------------------
// 3. UAT affordance still works when explicitly enabled — the gate is a switch, not a removal.
//    request → code IS returned → verify round-trip yields a real session.
// ---------------------------------------------------------------------------
for (const f of FLAVORS) {
  test(`UAT ON — /api/${f.name}-otp: code IS returned and a request→verify round-trip yields a session`, async () => {
    const sqlite = freshDb({ PAWSPACE_UAT_LOGIN: "on" });
    const requested = await call(f.handler, f.url, { action: "request", phone: f.phone });
    assert.equal(requested.status, 200);
    const data = requested.body.data;
    assert.match(String(data.sandboxCode), /^\d{6}$/, "with the UAT switch ON the code is disclosed for testing");
    assert.equal(data.sandboxCode, persistedCode(sqlite, f.table, f.phone), "disclosed code matches the persisted one");

    const verified = await call(f.handler, f.url, { action: "verify", challengeId: data.challengeId, code: data.sandboxCode, name: "UAT Tester" });
    assert.equal(verified.status, 200, `verify must succeed with the disclosed code: ${JSON.stringify(verified.body)}`);
    assert.ok(verified.setCookie, "a real platform session cookie is issued on the round-trip");
    const id = verified.body?.data?.customerId ?? verified.body?.data?.providerId;
    assert.ok(id, "verify returns the resolved subject id — a genuine session was minted");
  });
}
