/**
 * Partner service-proof upload, end to end against the real routes and the real boundary on an in-memory
 * D1: register (grant) -> upload bytes (server-verified against the grant, then confirmed) -> a DIFFERENT
 * person approves in the reviewer queue -> the grooming completion gate accepts the reference.
 *
 * Before the upload route existed the Partner app registered proof and stopped, so every asset stayed at
 * pending_upload, nobody could review it, "Add service proof" refused, and grooming could not complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PROOF_UPLOAD_DB__", "__PROOF_UPLOAD_ENV__");

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
  globalThis.__PROOF_UPLOAD_DB__ = db;
  globalThis.__PROOF_UPLOAD_ENV__ = env;
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

test("register -> upload -> second-person approval -> accepted as grooming proof (no bucket bound)", async () => {
  const { db, call, put, register } = await world();
  const before = file(), after = file(3072);
  const b = await register("before_service", before), a = await register("after_service", after);
  assert.equal(b.accessStatus, "pending_upload");
  assert.equal(b.upload.singleUse, true);

  const up = await put({ id: b.id, token: b.upload.token, bytes: before.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.data.accessStatus, "quarantined", "the verified object is quarantined, not ready");
  assert.equal(up.body.data.reviewStatus, "pending_review");
  assert.equal(up.body.data.proofReady, false, "an upload alone is never proof");
  assert.equal(up.body.data.adapterConnected, false, "no bucket is bound in this world, and the response says so");
  assert.equal(up.body.data.objectStored, false);
  assert.equal(up.body.data.sha256, before.sha256, "the server reports the digest it computed itself");
  const up2 = await put({ id: a.id, token: a.upload.token, bytes: after.bytes });
  assert.equal(up2.status, 200, JSON.stringify(up2.body));

  // The Ops review queue lists both uploads without needing the booking id.
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  const queued = queue.body.pending.map(asset => asset.id).sort();
  assert.deepEqual(queued, [a.id, b.id].sort());
  const stranger = await call("GET", null, { ...STAFF, "oai-authenticated-user-email": "nobody@pawspace.test" }, "?pending=1");
  assert.notEqual(stranger.status, 200, "an unknown identity cannot read the review queue");

  // Rule 7: the uploader cannot approve their own media.
  const self = await call("PATCH", { id: b.id, action: "record_scan", scanResult: "clean", reason: "Looks fine to me" }, STAFF);
  assert.equal(self.status, 403, JSON.stringify(self.body));

  for (const id of [b.id, a.id]) {
    const decided = await call("PATCH", { id, action: "record_scan", scanResult: "clean", reason: "Clear before/after grooming photo, pet identifiable" }, CHECKER);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.data.proofReady, true, "UAT permits release of unscanned media once a second person approves");
    assert.equal(decided.body.data.accessStatus, "ready");
  }
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  assert.ok(listing.body.assets.every(asset => asset.proofReady === true), JSON.stringify(listing.body));
  assert.ok(listing.body.assets.every(asset => asset.review_status === "approved" && asset.reviewed_by === "quality.lead@pawspace.test"));
  const drained = await call("GET", null, CHECKER, "?pending=1");
  assert.equal(drained.body.pending.length, 0, "nothing is left in the review queue");

  // The grooming completion gate accepts the references.
  const { assertServiceProofRef } = await import("../lib/service-media-security.ts");
  await assertServiceProofRef(db, { ref: b.ref, bookingId: BOOKING, providerId: PROVIDER, purpose: "before_service" });
  await assertServiceProofRef(db, { ref: a.ref, bookingId: BOOKING, providerId: PROVIDER, purpose: "after_service" });
});

test("bytes that do not match the grant are refused before anything is stored, and the grant survives", async () => {
  const { db, put, register } = await world();
  const promised = file(), other = file();
  const b = await register("before_service", promised);
  const wrong = await put({ id: b.id, token: b.upload.token, bytes: other.bytes });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  assert.equal(wrong.body.code, "object_checksum_mismatch");
  const short = await put({ id: b.id, token: b.upload.token, bytes: promised.bytes.subarray(0, 100) });
  assert.equal(short.status, 409);
  assert.equal(short.body.code, "object_size_mismatch");
  const type = await put({ id: b.id, token: b.upload.token, bytes: promised.bytes, mimeType: "image/png" });
  assert.equal(type.status, 409);
  assert.equal(type.body.code, "object_type_mismatch");
  const row = await db.prepare("SELECT access_status FROM service_media_assets WHERE id=?").bind(b.id).first();
  assert.equal(row.access_status, "pending_upload", "nothing was confirmed by a refused upload");
  const grant = await db.prepare("SELECT status FROM media_upload_grants WHERE media_id=?").bind(b.id).first();
  assert.equal(grant.status, "issued", "the grant is still usable for the right bytes");
  const right = await put({ id: b.id, token: b.upload.token, bytes: promised.bytes });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  const again = await put({ id: b.id, token: b.upload.token, bytes: promised.bytes });
  assert.equal(again.status, 409, "a consumed token cannot upload a second time");
  assert.equal(again.body.code, "upload_token_consumed");
});

test("a token cannot be used for another asset, and headers are required", async () => {
  const { put, register } = await world();
  const one = file(), two = file();
  const b = await register("before_service", one), a = await register("after_service", two);
  const swapped = await put({ id: a.id, token: b.upload.token, bytes: two.bytes });
  assert.equal(swapped.status, 403, JSON.stringify(swapped.body));
  assert.equal(swapped.body.code, "upload_token_mismatch");
  const missing = await put({ id: b.id, token: "", bytes: one.bytes });
  assert.equal(missing.status, 400);
  const empty = await put({ id: b.id, token: b.upload.token, bytes: new Uint8Array(0) });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
});

test("with a private bucket bound the object is stored under the grant's key and verified by storage", async () => {
  const objects = new Map();
  const bucket = {
    async head(key) { const object = objects.get(key); return object ? { size: object.body.byteLength, httpMetadata: { contentType: object.contentType } } : null; },
    async put(key, body, options) { objects.set(key, { body: new Uint8Array(body), contentType: options?.httpMetadata?.contentType ?? null }); },
    async get(key) { const object = objects.get(key); return object ? { size: object.body.byteLength, httpMetadata: { contentType: object.contentType }, arrayBuffer: async () => object.body.buffer } : null; },
  };
  const { put, register, call } = await world({ PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_MEDIA_BUCKET: bucket });
  const f = file(4096);
  const b = await register("before_service", f);
  const up = await put({ id: b.id, token: b.upload.token, bytes: f.bytes });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.data.adapterConnected, true);
  assert.equal(up.body.data.objectStored, true);
  assert.equal(up.body.data.accessStatus, "quarantined");
  assert.equal(objects.size, 1, "exactly one object was written");
  const [key, stored] = [...objects.entries()][0];
  assert.equal(key, b.upload.objectKey, "under the grant's own key");
  assert.equal(stored.body.byteLength, f.size);
  assert.equal(stored.contentType, "image/jpeg");
  assert.doesNotMatch(JSON.stringify(up.body), /https?:\/\//, "no URL to the object is ever returned");
  const decided = await call("PATCH", { id: b.id, action: "record_scan", scanResult: "clean", reason: "Verified against the stored object" }, CHECKER);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.data.proofReady, true);
});

test("a rejected review keeps the asset out of proof and the partner sees why", async () => {
  const { db, put, register, call } = await world();
  const f = file();
  const b = await register("after_service", f);
  await put({ id: b.id, token: b.upload.token, bytes: f.bytes });
  const rejected = await call("PATCH", { id: b.id, action: "record_scan", scanResult: "rejected", reason: "Photo is blurred, pet not identifiable" }, CHECKER);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.data.proofReady, false);
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const asset = listing.body.assets.find(item => item.id === b.id);
  assert.equal(asset.proofReady, false);
  assert.equal(asset.review_status, "rejected");
  const { assertServiceProofRef } = await import("../lib/service-media-security.ts");
  await assert.rejects(assertServiceProofRef(db, { ref: b.ref, bookingId: BOOKING, providerId: PROVIDER, purpose: "after_service" }));
});
