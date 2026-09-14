/*
 * Duplicate proof registrations, executed through the real routes and boundary on an in-memory D1. Seen on
 * staging: the Partner app registered the same photo twice (a flush racing the direct upload), one of the
 * registrations never received its bytes, and the Ops review queue listed it as "awaiting your decision"
 * while approval could only answer "upload incomplete". Two server-side guarantees close that gap
 * whatever the client does: re-registering the same bytes supersedes a registration still waiting for them,
 * and the review queue only ever lists assets whose bytes have arrived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PROOF_DEDUPE_DB__", "__PROOF_DEDUPE_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const STAFF = {
  "content-type": "application/json",
  "oai-authenticated-user-email": "ops.manager@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20manager",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const CHECKER = { ...STAFF, "oai-authenticated-user-email": "quality.lead@pawspace.test", "oai-authenticated-user-full-name": "Quality%20lead" };
const BOOKING = "BK-GROOM-1", PROVIDER = "PRV-GROOMER-1";

async function world(env = { PAWSPACE_MEDIA_ENV: "uat" }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PROOF_DEDUPE_DB__ = db;
  globalThis.__PROOF_DEDUPE_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MGR','ops.manager@pawspace.test','Ops manager','manager','active',?,?)").bind(now, now).run();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-QA','quality.lead@pawspace.test','Quality lead','manager','active',?,?)").bind(now, now).run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-1',?,'SG-1',?,'Groomer','full_time','grooming','2026-09-14T04:30:00.000Z','2026-09-14T06:30:00.000Z','in_service',?,?)").run(BOOKING, PROVIDER, now, now);

  const media = await import("../app/api/service-media/route.ts");
  const uploadRoute = await import("../app/api/service-media/upload/route.ts");
  const call = async (method, body, as = STAFF, query = "") => {
    const response = await media[method](new Request(`https://uat.pawspace.in/api/service-media${query}`, { method, headers: as, body: method === "GET" ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const put = async ({ id, token, bytes, mimeType = "image/jpeg", as = STAFF, headers = {} }) => {
    const response = await uploadRoute.PUT(new Request("https://uat.pawspace.in/api/service-media/upload", {
      method: "PUT", headers: { ...as, "content-type": mimeType, "x-pawspace-media-id": id ?? "", "x-pawspace-upload-token": token ?? "", ...headers }, body: bytes,
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const register = async (purpose, f, as = STAFF) => {
    const created = await call("POST", { bookingId: BOOKING, purpose, mimeType: "image/jpeg", sizeBytes: f.size, sha256: f.sha256, fileName: `${purpose}.jpg` }, as);
    assert.equal(created.status, 201, `register ${purpose}: ${JSON.stringify(created.body).slice(0, 300)}`);
    return created.body.data;
  };
  return { sqlite, db, call, put, register };
}

const file = (size = 2048) => { const bytes = randomBytes(size); return { bytes, size, sha256: createHash("sha256").update(bytes).digest("hex") }; };

test("re-registering the same bytes before they arrive supersedes the stale registration, and its token is refused as superseded", async () => {
  const { call, put, register } = await world();
  const before = file();
  const stale = await register("before_service", before);
  const fresh = await register("before_service", before);
  assert.notEqual(fresh.id, stale.id);
  assert.equal(fresh.supersedes, stale.id, "the new registration is linked to the one it retires");

  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const byId = Object.fromEntries(listing.body.assets.map(asset => [asset.id, asset]));
  assert.equal(byId[stale.id].retention_status, "superseded");
  assert.equal(byId[stale.id].access_status, "revoked");
  assert.equal(byId[fresh.id].access_status, "pending_upload");

  const late = await put({ id: stale.id, token: stale.upload.token, bytes: before.bytes });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.code, "upload_token_superseded", "a late upload for the retired grant says why, never 'already used'");

  const up = await put({ id: fresh.id, token: fresh.upload.token, bytes: before.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.deepEqual(queue.body.pending.map(asset => asset.id), [fresh.id], "the review queue holds exactly one entry for one photo");
});

test("the Ops review queue lists only assets whose bytes have arrived", async () => {
  const { call, put, register } = await world();
  const after = file(3072);
  const registered = await register("after_service", after);
  const empty = await call("GET", null, CHECKER, "?pending=1");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.pending, [], "a registration with no bytes cannot be reviewed, so it is not offered for review");
  const up = await put({ id: registered.id, token: registered.upload.token, bytes: after.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const listed = await call("GET", null, CHECKER, "?pending=1");
  assert.deepEqual(listed.body.pending.map(asset => asset.id), [registered.id]);
  const decided = await call("PATCH", { id: registered.id, action: "record_scan", scanResult: "clean", reason: "Clear after-service photo, pet identifiable" }, CHECKER);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.data.proofReady, true);
});

test("a registration whose bytes already arrived is never superseded by a later registration of the same photo", async () => {
  const { call, put, register } = await world();
  const before = file();
  const uploaded = await register("before_service", before);
  const up = await put({ id: uploaded.id, token: uploaded.upload.token, bytes: before.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const again = await register("before_service", before);
  assert.equal(again.supersedes, undefined, "only registrations still waiting for bytes are retired");
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const first = listing.body.assets.find(asset => asset.id === uploaded.id);
  assert.equal(first.retention_status, "active");
  assert.equal(first.access_status, "quarantined");
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.deepEqual(queue.body.pending.map(asset => asset.id), [uploaded.id], "the unuploaded repeat stays out of the queue until its bytes arrive");
});

test("supersession is scoped to the same booking, provider, purpose and bytes", async () => {
  const { call, register } = await world();
  const before = file(), after = file(3072);
  const b = await register("before_service", before);
  const a = await register("after_service", after);
  const b2 = await register("before_service", before);
  assert.equal(b2.supersedes, b.id);
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const byId = Object.fromEntries(listing.body.assets.map(asset => [asset.id, asset]));
  assert.equal(byId[a.id].retention_status, "active", "a different purpose is untouched");
  assert.equal(byId[a.id].access_status, "pending_upload");
});
