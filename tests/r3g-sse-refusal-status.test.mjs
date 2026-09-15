/*
 * R3-G / F5: two SSE endpoints reported a permission refusal as a 500.
 *
 * lib/server-auth.ts's authorize() and lib/organizational-scope.ts's requireManagerDomain() refuse by
 * THROWING a governed Response. Both stream routes called them outside any try/catch, so the refusal
 * escaped the handler as an unhandled error: signed out answered 401 (the gateway refuses before the
 * handler runs), while associate, manager, finance and auditor each got 500 with Content-Length 0 and
 * an empty body - a server fault logged every time someone who is simply not allowed in opened a
 * screen that subscribes to the stream.
 *
 * Executed, not grepped: the real GET handlers are called with a real Request for a real seeded role.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__R3G_SSE_DB__", "__R3G_SSE_ENV__");

const ORIGIN = "https://app.pawspace.in";
const ROLES = [
  ["associate", "r3g.sse.associate@pawspace.test"],
  ["manager", "r3g.sse.manager@pawspace.test"],
  ["finance", "r3g.sse.finance@pawspace.test"],
  ["auditor", "r3g.sse.auditor@pawspace.test"],
  ["founder", "r3g.sse.founder@pawspace.test"],
];

const bookingStream = await import("../app/api/booking-command-center/stream/route.ts");
const conversationStream = await import("../app/api/conversations/stream/route.ts");

async function seed() {
  const { sqlite, db } = world("__R3G_SSE_DB__", "__R3G_SSE_ENV__");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [role, email] of ROLES) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(`U-SSE-${role}`, email, `R3G ${role}`, role, now, now);
  }
  // The conversations stream reads these two on entry; a missing table would be a 500 for a reason
  // that has nothing to do with authorization, and would hide the defect under test.
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_threads (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_messages (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL DEFAULT 0)");
  return { sqlite, db };
}

/*
 * A stream handler that IS allowed in returns a live SSE body driven by a setInterval, which would
 * keep the test runner alive. The handlers close on the request's abort signal, which is also how a
 * real client disconnect reaches them, so each request carries its own controller and every opened
 * stream is aborted and cancelled before the test moves on.
 */
function request(path, email) {
  const controller = new AbortController();
  const value = new Request(`${ORIGIN}${path}`, { method: "GET", headers: email ? { "oai-authenticated-user-email": email } : {}, signal: controller.signal });
  return { value, abort: () => controller.abort() };
}

async function closeIfStreaming(response, handle) {
  handle.abort();
  if (response.body) await response.body.cancel().catch(() => {});
}

/*
 * Written out by hand, role by role, from lib/platform-security.ts - not recomputed with
 * hasPermission(), which would agree with any bug in the gate it is meant to check.
 *   /api/booking-command-center/stream  bookings.manage      -> manager, founder
 *   /api/conversations/stream           communications.manage -> associate, manager, founder
 * manager opens the booking stream because R3-G/F3 replaced the unprovisioned-scope 403 with a
 * degraded scope; what it may then SEE is asserted in tests/r3g-manager-organizational-scope.
 */
const ALLOWED = {
  "/api/booking-command-center/stream": new Set(["manager", "founder"]),
  "/api/conversations/stream": new Set(["associate", "manager", "founder"]),
};

test("F5: an authenticated-but-unauthorised actor gets the refusal's real status, never a 500", async () => {
  await seed();
  for (const [route, handler] of [
    ["/api/booking-command-center/stream", bookingStream.GET],
    ["/api/conversations/stream", conversationStream.GET],
  ]) {
    const allowedRoles = ALLOWED[route];
    for (const [role, email] of ROLES) {
      const allowed = allowedRoles.has(role) ? role : null;
      const handle = request(route, email);
      const response = await handler(handle.value);
      if (role === allowed) {
        await closeIfStreaming(response, handle);
        assert.equal(response.status, 200, `${route}: ${role} must still open the stream`);
        assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
        continue;
      }
      assert.notEqual(response.status, 500, `${route}: a refusal for ${role} must not be reported as a server fault`);
      assert.ok(response.status === 401 || response.status === 403, `${route}: ${role} expected 401/403, got ${response.status}`);
      const body = await response.text();
      assert.ok(body.length > 0, `${route}: the refusal for ${role} must have a body, not Content-Length 0`);
      assert.match(JSON.parse(body).error, /\S/, `${route}: the refusal for ${role} must say something`);
    }
  }
});

test("F5: a signed-out caller is still refused, and still not with a 500", async () => {
  await seed();
  for (const [route, handler] of [
    ["/api/booking-command-center/stream", bookingStream.GET],
    ["/api/conversations/stream", conversationStream.GET],
  ]) {
    const handle = request(route, null);
    const response = await handler(handle.value);
    await closeIfStreaming(response, handle);
    assert.ok(response.status === 401 || response.status === 403, `${route}: signed out expected 401/403, got ${response.status}`);
    assert.notEqual(response.status, 500);
  }
});
