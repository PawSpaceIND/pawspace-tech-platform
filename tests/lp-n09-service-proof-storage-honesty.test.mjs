/**
 * LP-N09 — service-proof photos were shown as "uploaded and verified · awaiting Ops approval" and got
 * approved/released as service proof while the media adapter was not connected (security_audit detail
 * objectStored:false, adapterConnected:false; the bytes were hashed and the object was never written).
 *
 * redeemMediaUploadGrant now persists what it actually verified (service_media_assets.object_stored),
 * both GET /api/service-media and GET /api/training-session-media expose it as `objectStored`, and the
 * three surfaces that show a photo's state - the Partner app, the trainer session-evidence panel and
 * /control's "Service proof awaiting review" - say so honestly instead of claiming "uploaded and
 * verified" for bytes nobody kept. Approval itself stays a reviewer decision: these cases pin that the
 * flag is surfaced, never that it silently blocks anyone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LPN09_DB__", "__LPN09_ENV__");

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
const BOOKING = "BK-GROOM-LPN09", PROVIDER = "PRV-GROOMER-LPN09";
const file = (size = 2048) => { const bytes = randomBytes(size); return { bytes, size, sha256: createHash("sha256").update(bytes).digest("hex") }; };

async function groomingWorld(env = { PAWSPACE_MEDIA_ENV: "uat" }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__LPN09_DB__ = db;
  globalThis.__LPN09_ENV__ = env;
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
  const put = async ({ id, token, bytes, mimeType = "image/jpeg", as = STAFF }) => {
    const response = await uploadRoute.PUT(new Request("https://uat.pawspace.in/api/service-media/upload", {
      method: "PUT", headers: { ...as, "content-type": mimeType, "x-pawspace-media-id": id ?? "", "x-pawspace-upload-token": token ?? "" }, body: bytes,
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const register = async (purpose, f, as = STAFF) => {
    const created = await call("POST", { bookingId: BOOKING, purpose, mimeType: "image/jpeg", sizeBytes: f.size, sha256: f.sha256, fileName: `${purpose}.jpg` }, as);
    assert.equal(created.status, 201, `register ${purpose}: ${JSON.stringify(created.body).slice(0, 300)}`);
    return created.body.data;
  };
  return { db, call, put, register };
}

test("LP-N09: with no bucket bound, a confirmed upload is honestly objectStored:false in both the partner listing and the Ops queue, approved or not", async () => {
  const { call, put, register } = await groomingWorld();
  const before = file();
  const b = await register("before_service", before);
  const uploaded = await put({ id: b.id, token: b.upload.token, bytes: before.bytes });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.data.objectStored, false, "the upload response itself says the bytes were not kept");

  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const pendingAsset = listing.body.assets.find(item => item.id === b.id);
  assert.equal(pendingAsset.objectStored, false, "the booking-scoped listing must carry the same honest fact");

  const queue = await call("GET", null, CHECKER, "?pending=1");
  const queued = queue.body.pending.find(item => item.id === b.id);
  assert.equal(queued.objectStored, false, "the Ops review queue must surface the flag before a decision is made");

  // Approval is still the reviewer's call - the flag is surfaced, not enforced.
  const decided = await call("PATCH", { id: b.id, action: "record_scan", scanResult: "clean", reason: "Reviewed the hash; approving per current policy" }, CHECKER);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.data.proofReady, true, "the owner-decision default in this environment still allows release");

  const after = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const approved = after.body.assets.find(item => item.id === b.id);
  assert.equal(approved.proofReady, true);
  assert.equal(approved.objectStored, false, "an approved asset must still report honestly that no file exists");
});

test("LP-N09: with a private bucket bound, the same fields report objectStored:true", async () => {
  const objects = new Map();
  const bucket = {
    async head(key) { const object = objects.get(key); return object ? { size: object.body.byteLength, httpMetadata: { contentType: object.contentType } } : null; },
    async put(key, body, options) { objects.set(key, { body: new Uint8Array(body), contentType: options?.httpMetadata?.contentType ?? null }); },
  };
  const { call, put, register } = await groomingWorld({ PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_MEDIA_BUCKET: bucket });
  const f = file(4096);
  const b = await register("before_service", f);
  const uploaded = await put({ id: b.id, token: b.upload.token, bytes: f.bytes });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.data.objectStored, true);
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  assert.equal(listing.body.assets.find(item => item.id === b.id).objectStored, true);
});

test("LP-N09: an asset registered but never confirmed reports objectStored:null, not false or true", async () => {
  const { call, register } = await groomingWorld();
  const f = file();
  const b = await register("after_service", f);
  const listing = await call("GET", null, STAFF, `?bookingId=${BOOKING}`);
  const asset = listing.body.assets.find(item => item.id === b.id);
  assert.equal(asset.access_status, "pending_upload");
  assert.equal(asset.objectStored, null, "nothing has been verified yet, so the flag must not claim either way");
});

async function trainingWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__LPN09_DB__ = db;
  globalThis.__LPN09_ENV__ = { PAWSPACE_MEDIA_ENV: "uat" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MGR','ops.manager@pawspace.test','Ops manager','manager','active',?,?)").bind(now, now).run();
  // Real schema, not a hand-rolled stand-in: ensureTrainingSessionLifecycleTables owns training_sessions
  // and training_programmes (sequence_no, schedule_reservation_id and the programme join getTrainingSession
  // requires), so it is created the same way the route itself creates it.
  const { ensureTrainingSessionLifecycleTables } = await import("../lib/training-session-lifecycle.ts");
  await ensureTrainingSessionLifecycleTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('CUS-1','blr','Trisha Kumar','+91-9000000001',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,total_sessions,created_at,updated_at) VALUES ('PRG-1','BK-TRAIN-1','CUS-1','PRV-TRAINER-1','blr','blr-east','obedience-starter','Obedience Starter','[\"pet_1\"]',1,?,?)").run(now, now);
  sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TS-1','PRG-1','BK-TRAIN-1','RES-1',1,'PRV-TRAINER-1','2026-09-14T05:30:00.000Z','2026-09-14T06:30:00.000Z','in_session',?,?)").run(now, now);
  const route = await import("../app/api/training-session-media/route.ts");
  const call = async (method, body, query = "") => {
    const response = await route[method](new Request(`https://uat.pawspace.in/api/training-session-media${query}`, { method, headers: STAFF, body: method === "GET" ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { call };
}

test("LP-N09: training-session-media GET also carries the honest objectStored flag", async () => {
  const { call } = await trainingWorld();
  const f = file();
  const created = await call("POST", { sessionId: "TS-1", mimeType: "image/jpeg", sizeBytes: f.size, sha256: f.sha256 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, upload } = created.body.data;
  const confirmed = await call("PATCH", { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: f.size, observedSha256: f.sha256, observedMimeType: "image/jpeg" });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const listing = await call("GET", null, "?sessionId=TS-1");
  const asset = listing.body.data.assets.find(item => item.id === id);
  assert.equal(asset.objectStored, false, "no bucket is bound, so training evidence must not claim a kept file either");
});

test("LP-N09 source contract: none of the three surfaces claims \"uploaded and verified\" or a ready state when objectStored is false", async () => {
  // On this branch the trainer evidence type lives in the shared client and the copy in the extracted
  // controls component, so the same guarantees are asserted against the files that actually carry them.
  const [partner, control, trainerClient, trainerControls] = await Promise.all([
    "app/partner-app/page.tsx", "app/control/service-proof-review.tsx", "lib/training-session-client.ts", "app/trainer/session-proof.tsx",
  ].map(path => readFile(new URL("../" + path, import.meta.url), "utf8")));

  // Partner app: describeProof branches on objectStored before ever saying "uploaded and verified".
  assert.match(partner, /objectStored\?: boolean \| null/, "MediaAsset carries the honest flag");
  assert.match(partner, /latest\.objectStored === false \? \{ state: "pending", text: `\$\{NOT_STORED_TEXT\}/, "the pending branch checks the flag before choosing its copy");
  assert.match(partner, /file storage is not connected in this environment; the image was not kept/i);
  assert.match(partner, /released\.objectStored === false \? \{ state: "approved"/, "even an approved photo must not be called ready when nothing was kept");
  assert.match(partner, /lastUploadObjectStoredRef\.current === false/, "the immediate post-upload toast is also conditioned on what was actually verified");

  // /control Service proof awaiting review: the reviewer sees the flag, and it never silently disables approval.
  assert.match(control, /objectStored\?: boolean \| null/);
  assert.match(control, /const notStored = asset\.objectStored === false;/);
  assert.match(control, /no file was ever kept \(storage not connected\)/);
  assert.match(control, /hash recorded only, no file kept/);
  assert.match(control, /asset\.objectStored === false && <p role="alert"/, "the reviewer gets an explicit banner, not just a changed label");
  assert.doesNotMatch(control, /disabled=\{busyId === asset\.id \|\| asset\.objectStored === false\}/, "the flag must not disable Approve - that stays the reviewer's decision");

  // Trainer session evidence: the same honesty, not silence.
  assert.match(trainerClient, /objectStored\?:boolean\|null/, "the shared evidence type carries the honest flag");
  assert.match(trainerControls, /matching\.some\(asset=>asset\.objectStored===false\)/, "the controls branch on what was actually verified");
  assert.match(trainerControls, /file storage is not connected in this environment; the image was not kept/i);
});
