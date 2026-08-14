/**
 * LEAK-1 — internal exception handling on the 500 path.
 *
 * Behavioural finding: this codebase DELIBERATELY surfaces a thrown Error's message as the operator-
 * facing reason on many routes (validation/business rules — "Maker cannot approve their own transaction",
 * "Coupon quote is no longer open", "Incorrect OTP" — each asserted elsewhere in the suite). So the fix
 * is NOT to blanket-genericise every 500 (that regresses intended UX). Instead:
 *   1. authError now LOGS every unhandled error server-side (previously nothing was logged), so internal
 *      detail is captured for operators even though the client-facing body is unchanged.
 *   2. Deliberate domain Responses (4xx) still pass through unchanged.
 *   3. PURE-READ handlers that can only 500 on an internal fault (no domain Error to surface) return their
 *      own generic body, so raw DB/exception text never leaks there. service-zone and service-availability
 *      are the confirmed pure-read cases fixed here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LEAK_DB__", "__LEAK_ENV__");

const SECRET = "no such column: pawspace_internal_secret_column_9f3";
// A D1 shim that fails every access with a recognizable internal error, as a broken/migrating DB would.
// (batch is attached after construction so this fault-injector is not mistaken for a real batch() shim.)
function throwingDb() {
  const boom = () => { throw new Error(`SQLITE_ERROR: ${SECRET}`); };
  const stmt = { bind: () => stmt, first: boom, all: boom, run: boom };
  const db = { prepare: () => stmt, exec: boom, dump: boom };
  db.batch = boom;
  return db;
}

const { authError } = await import("../lib/server-auth.ts");

test("authError logs every unhandled internal exception server-side (previously nothing was logged)", () => {
  const original = console.error;
  let logged = null;
  console.error = (...args) => { logged = args; };
  try { authError(new Error(`boom ${SECRET}`), "Unable to do the thing"); }
  finally { console.error = original; }
  assert.ok(logged, "authError writes to the server log");
  assert.match(String(logged.map(String).join(" ")), new RegExp(SECRET), "the full internal detail is captured in the log, not dropped");
});

test("authError passes a deliberate domain Response (4xx) through unchanged", () => {
  const domain = new Response(JSON.stringify({ error: "Customer ownership denied" }), { status: 403 });
  const out = authError(domain, "fallback");
  assert.equal(out, domain, "a thrown Response is returned verbatim — its 4xx and body are preserved");
});

test("PURE-READ route (message-var path): service-zone GET on a broken DB returns a generic 500, no internal leak", async () => {
  globalThis.__LEAK_DB__ = throwingDb();
  globalThis.__LEAK_ENV__ = {};
  const { GET } = await import("../app/api/service-zone/route.ts");
  const res = await GET(new Request("https://app.pawspace.in/api/service-zone?pincode=560102"));
  assert.equal(res.status, 500, "an internal DB failure surfaces as 500");
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET), "the SQLite error text must not reach the client");
  assert.equal(body.error, "Unable to resolve the service zone", "the client sees the generic fallback");
});

test("PURE-READ route (inline json path): service-availability GET on a broken DB returns a generic 500, no internal leak", async () => {
  globalThis.__LEAK_DB__ = throwingDb();
  globalThis.__LEAK_ENV__ = {};
  const { GET } = await import("../app/api/service-availability/route.ts");
  const res = await GET(new Request("https://app.pawspace.in/api/service-availability"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET), "the SQLite error text must not reach the client");
  assert.equal(body.error, "Unable to load service availability", "the client sees the generic fallback");
});
