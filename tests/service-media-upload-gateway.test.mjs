import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__MEDIA_UPLOAD_GATEWAY_DB__", "__MEDIA_UPLOAD_GATEWAY_ENV__");

/*
 * The worker authorizes every /api/* request by path (lib/api-gateway.ts) BEFORE the route runs; an
 * unlisted path needs the default "dashboard.view", which the service_provider role does not hold. On
 * staging that made every partner proof upload fail closed at the gateway:
 *   POST /api/service-media         -> 201 (grant issued; the path is mapped to bookings.view)
 *   PUT  /api/service-media/upload  -> 403 "Permission denied" (unmapped -> dashboard.view)
 * so no photo could ever be verified and "Add service proof" stayed refused. These tests EXECUTE the
 * gateway with a real service_provider identity: the mapped paths must pass with bookings.view and an
 * unmapped sibling path must still be refused, which is what proves the mapping is the difference.
 */
const ORIGIN = "https://app.pawspace.in";
const PARTNER_EMAIL = "partner.media-upload@pawspace.in";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
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
  globalThis.__MEDIA_UPLOAD_GATEWAY_DB__ = db;
  globalThis.__MEDIA_UPLOAD_GATEWAY_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
    .run("USR-MEDIA-UPLOAD-PARTNER", PARTNER_EMAIL, "UAT partner", "service_provider", now, now);
  return { sqlite, db };
}

async function throughGateway(method, path, body) {
  const env = { DB: globalThis.__MEDIA_UPLOAD_GATEWAY_DB__, ...globalThis.__MEDIA_UPLOAD_GATEWAY_ENV__ };
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const headers = { "oai-authenticated-user-email": PARTNER_EMAIL };
  if (body) headers["content-type"] = "application/json";
  return authorizeApiRequest(new Request(`${ORIGIN}${path}`, { method, headers, body }), env);
}

test("a partner identity passes the gateway for the proof byte-upload PUT with bookings.view", async () => {
  await world();
  const access = await throughGateway("PUT", "/api/service-media/upload");
  assert.ok(!(access instanceof Response), `gateway refused the upload path: ${access instanceof Response ? await access.text() : ""}`);
  assert.equal(access.permission, "bookings.view");
  assert.equal(access.actor.roleCode, "service_provider");
});

test("the same identity passes the register POST with the same permission (both halves of one flow)", async () => {
  await world();
  const access = await throughGateway("POST", "/api/service-media", JSON.stringify({ bookingId: "PS-UAT-1", purpose: "before_service" }));
  assert.ok(!(access instanceof Response));
  assert.equal(access.permission, "bookings.view");
});

test("an unmapped sibling path still falls to dashboard.view and is refused for a partner (the gate is real)", async () => {
  const { sqlite } = await world();
  const access = await throughGateway("PUT", "/api/service-media/uploads");
  assert.ok(access instanceof Response, "an unmapped /api path must be refused for a service_provider");
  assert.equal(access.status, 403);
  assert.deepEqual(await access.json(), { error: "Permission denied" });
  const denied = sqlite.prepare("SELECT outcome, detail_json FROM security_audit_events WHERE actor_email=?").all(PARTNER_EMAIL);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].outcome, "denied");
  assert.equal(JSON.parse(denied[0].detail_json).permission, "dashboard.view");
});

test("the upload route keeps its own gates behind the gateway: permission, then ownership of the grant's provider", () => {
  const uploadRoute = fs.readFileSync("app/api/service-media/upload/route.ts", "utf8");
  assert.match(uploadRoute, /requirePermission\(actor,"bookings\.view"\)/);
  assert.match(uploadRoute, /requireProviderOwnership\(db,actor,grant\.providerId\)/);
});
