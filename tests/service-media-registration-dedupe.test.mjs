/*
 * Duplicate proof registrations, executed through the real routes and boundary on an in-memory D1. Seen on
 * staging: the Partner app registered the same photo twice (a flush racing the direct upload), one of the
 * registrations never received its bytes, and the Ops review queue listed it as "awaiting your decision"
 * while approval could only answer "upload incomplete". Two server-side guarantees close that gap
 * whatever the client does: re-registering the same bytes supersedes a registration still waiting for them,
 * is refused once they have arrived, and the review queue only ever lists assets whose bytes have arrived.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PROOF_DEDUPE_DB__", "__PROOF_DEDUPE_ENV__");

function makeD1(sqlite, hooks = {}) {
  const statement = (sql, args = []) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => { await hooks.beforeAll?.(sql); return { results: sqlite.prepare(sql).all(...args) }; },
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
  const hooks = {};
  const db = makeD1(sqlite, hooks);
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
  return { sqlite, db, hooks, call, put, register };
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

test("bytes that already arrived are never registered again: the repeat is refused as a permanent 409 and the queue keeps one entry", async () => {
  const { sqlite, call, put, register } = await world();
  const before = file();
  const uploaded = await register("before_service", before);
  const up = await put({ id: uploaded.id, token: uploaded.upload.token, bytes: before.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  // The Partner app's queue row outlived its upload (its IndexedDB delete failed, or another tab read the
  // queue late): the flush registers the same bytes again.
  const again = await call("POST", { bookingId: BOOKING, purpose: "before_service", mimeType: "image/jpeg", sizeBytes: before.size, sha256: before.sha256, fileName: "before_service.jpg" });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, "media_already_registered", "a 4xx the flush treats as permanent, so the row is discarded rather than retried for ever");
  assert.equal(again.body.mediaId, uploaded.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM service_media_assets WHERE booking_id=? AND sha256=?").get(BOOKING, before.sha256).n, 1, "no second asset was opened for bytes the server already holds");
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const first = listing.body.assets.find(asset => asset.id === uploaded.id);
  assert.equal(first.retention_status, "active");
  assert.equal(first.access_status, "quarantined");
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.deepEqual(queue.body.pending.map(asset => asset.id), [uploaded.id], "one photo, one review-queue entry");
  // The same photo for the OTHER purpose is another registration: the guard is keyed by purpose too.
  const other = await register("after_service", before);
  assert.notEqual(other.id, uploaded.id);
  // A rejected photo does not block a re-registration of the same bytes: rejection asks for another attempt.
  sqlite.prepare("UPDATE service_media_assets SET review_status='rejected' WHERE id=?").run(uploaded.id);
  const retry = await register("before_service", before);
  assert.notEqual(retry.id, uploaded.id, "after rejection the same bytes may be registered again");
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

test("two registrations of the same bytes that overlap in flight settle on exactly one live registration", async () => {
  const { sqlite, hooks, call, put, register } = await world();
  const before = file();
  // Hold each request at its search for a stale twin until BOTH have searched. A design that searches, retires
  // and only then inserts sees nothing to retire in either request and leaves two live rows; one that retires
  // every pending twin it can see, without bounding itself to rows older than its own, retires its rival and
  // leaves none. Time-boxed so a request that never searches fails the assertions instead of hanging.
  let searched = 0; const bothSearched = new Promise(resolve => { hooks.beforeAll = async (sql) => {
    if (!sql.startsWith("SELECT") || !sql.includes("FROM service_media_assets") || !sql.includes("access_status='pending_upload'")) return;
    if (++searched === 2) resolve(); await Promise.race([bothSearched, new Promise(done => setTimeout(done, 2000))]);
  }; });
  const [one, two] = await Promise.all([register("before_service", before), register("before_service", before)]);
  hooks.beforeAll = undefined;
  assert.notEqual(one.id, two.id);
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const live = listing.body.assets.filter(asset => asset.access_status === "pending_upload" && asset.retention_status === "active");
  assert.equal(live.length, 1, `exactly one registration survives, got ${JSON.stringify(listing.body.assets.map(a => [a.id, a.access_status, a.retention_status]))}`);
  const retired = listing.body.assets.find(asset => asset.id !== live[0].id);
  assert.equal(retired.retention_status, "superseded");
  assert.equal(retired.access_status, "revoked");
  const link = sqlite.prepare("SELECT supersedes FROM service_media_assets WHERE id=?").get(live[0].id);
  assert.equal(link.supersedes, retired.id, "the survivor is linked to the registration it retired");
  const events = sqlite.prepare("SELECT media_id FROM service_media_events WHERE event_type='media_registration_superseded'").all();
  assert.deepEqual(events.map(row => row.media_id), [retired.id], "one retirement, recorded once");

  const grants = Object.fromEntries([one, two].map(entry => [entry.id, entry.upload.token]));
  const late = await put({ id: retired.id, token: grants[retired.id], bytes: before.bytes });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.equal(late.body.code, "upload_token_superseded");
  const up = await put({ id: live[0].id, token: grants[live[0].id], bytes: before.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.deepEqual(queue.body.pending.map(asset => asset.id), [live[0].id], "the review queue holds exactly one entry for one photo");
});
