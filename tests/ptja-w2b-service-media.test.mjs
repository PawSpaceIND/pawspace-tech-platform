/**
 * PawSpace Total Journey Audit, Wave 2 Batch B — the service-proof storage reference.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_MEDIA_DB__", "__PTJA_MEDIA_ENV__");

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

async function mediaWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_MEDIA_DB__ = db;
  globalThis.__PTJA_MEDIA_ENV__ = { PAWSPACE_MEDIA_ENV: "uat" };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-MGR','ops.manager@pawspace.test','Ops manager','manager','active',?,?)").bind(now, now).run();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-QA','quality.lead@pawspace.test','Quality lead','manager','active',?,?)").bind(now, now).run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-1','BK-GROOM-1','SG-1','PRV-GROOMER-1','Groomer','full_time','grooming','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z','assigned',?,?)").run(now, now);

  const route = await import("../app/api/service-media/route.ts");
  const CHECKER = { ...STAFF, "oai-authenticated-user-email": "quality.lead@pawspace.test", "oai-authenticated-user-full-name": "Quality%20lead" };
  const call = async (method, body, as = STAFF) => {
    const response = await route[method](new Request("https://uat.pawspace.in/api/service-media", {
      method, headers: as, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  call.checker = CHECKER;
  return { sqlite, db, call };
}

// =====================================================================================================
// PTJA-W2B-M04 — a service-proof asset whose storage reference is a public URL the writer controls
//
// MEASURED, one staff identity, no second person, no bytes, no scanner:
//   POST  {bookingId, purpose:"after_service", ...}                      -> 201, ref media://asset/MEDIA-…
//   PATCH {action:"confirm_upload",
//          storageReference:"https://attacker.example.test/not-a-storage-object.jpg"} -> 200, accepted
//                                                                           VERBATIM as the storage key
//   PATCH {action:"record_scan", scanResult:"clean"}                     -> 200, proofReady:true
// and then assertServiceProofRef - the mandatory before/after photo gate on grooming completion -
// ACCEPTED it. The "proof" anyone later opens is a URL controlled by the person who wrote the record.
//
// The only validation on the storage reference was non-empty. The sibling proof libraries -
// lib/walking-proof-governance.ts and lib/food-proof-governance.ts - both refuse exactly this:
//   objectId.includes("://") || !/^[A-Za-z0-9._\/-]{8,256}$/.test(objectId)
//     -> "Storage confirmation must use an opaque object ID, not a public URL"
// That rule is applied here verbatim.
//
// Recorded and NOT closed here, because it is an architectural difference rather than a missing check:
// this route issues no upload grant at all (its POST returns storage:{mode:"not_connected"}), where the
// sibling libraries mint an HMAC'd single-use token and verify it on confirmation. Building that flow
// is a design decision about how this route obtains storage, not a defect fix. It is carried in the
// ledger with the sibling named as the reference implementation.
// =====================================================================================================

test("W2B-M04: a public URL cannot become a service-proof storage reference", async () => {
  const { call } = await mediaWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "c".repeat(64) });
  assert.equal(created.status, 201, `the asset record is created: ${JSON.stringify(created).slice(0, 250)}`);
  const id = created.body.data.id;

  const confirmed = await call("PATCH", { id, action: "confirm_upload", storageReference: "https://attacker.example.test/not-a-storage-object.jpg" });
  assert.notEqual(confirmed.status, 200,
    `a public URL must not be accepted as a storage reference: ${JSON.stringify(confirmed).slice(0, 250)}`);
});

test("W2B-M04: an opaque storage object id is still accepted", async () => {
  // Non-vacuity. Refusing every confirmation would satisfy the case above and break proof upload.
  const { call } = await mediaWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "d".repeat(64) });
  const id = created.body.data.id;

  const confirmed = await call("PATCH", { id, action: "confirm_upload", storageReference: "uat/grooming/BK-GROOM-1/after-service-01.jpg" });
  assert.equal(confirmed.status, 200,
    `an opaque object id must still confirm: ${JSON.stringify(confirmed).slice(0, 250)}`);
});

// =====================================================================================================
// PTJA-W2B-M05 — an unrecognised PATCH action falls through to REVOKE
//
// The PATCH handler dispatches with two `if` blocks and then an unguarded tail: after
// if(action==="confirm_upload"){...} and if(action==="record_scan"){...} the very next statement is the
// revoke UPDATE, with no if(action==="revoke") and no final "unsupported action" refusal. The declared
// type says action is "confirm_upload"|"record_scan"|"revoke" - a compile-time claim with no runtime
// enforcement.
//
// MEASURED: against an approved before_service proof asset, PATCH {"action":"record_scann"} - one letter
// different from the real action - returned 200 {"accessStatus":"revoked","retentionStatus":"revoked"}
// with no error and no mention that the action was not understood. Both attempts to restore it through
// the same route were refused 409, the proof gate then rejected the asset, and service_media_events
// gained a media_revoked row reading "Revoked by authorized operator" - an audit trail asserting a
// deliberate revocation the operator never requested.
//
// The correction enforces the declared contract at runtime: revoke happens only when revoke is asked
// for, and anything else is refused. Nothing about revocation itself changes.
// =====================================================================================================

test("W2B-M05: a misspelled action does not revoke the asset", async () => {
  const { sqlite, call } = await mediaWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "before_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "e".repeat(64) });
  const id = created.body.data.id;
  await call("PATCH", { id, action: "confirm_upload", storageReference: "uat/grooming/BK-GROOM-1/before-01.jpg" });
  await call("PATCH", { id, action: "record_scan", scanResult: "clean" }, call.checker);
  const approved = sqlite.prepare("SELECT access_status FROM service_media_assets WHERE id=?").get(id);
  assert.equal(String(approved.access_status), "ready", "the asset is approved before the probe");

  const typo = await call("PATCH", { id, action: "record_scann", scanResult: "clean" });
  assert.notEqual(typo.status, 200,
    `an action the handler does not understand must be refused, not treated as revoke: ${JSON.stringify(typo).slice(0, 250)}`);
  const after = sqlite.prepare("SELECT access_status,retention_status FROM service_media_assets WHERE id=?").get(id);
  assert.equal(String(after.access_status), "ready", "and the approved proof must survive it");
  assert.notEqual(String(after.retention_status), "revoked", "with its retention intact");
});

test("W2B-M05: an explicit revoke still revokes", async () => {
  // Non-vacuity. Refusing the tail outright would satisfy the case above and remove revocation.
  const { sqlite, call } = await mediaWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "before_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "f".repeat(64) });
  const id = created.body.data.id;

  const revoked = await call("PATCH", { id, action: "revoke", reason: "Customer asked for the photo to be removed" });
  assert.equal(revoked.status, 200, `an explicit revoke still works: ${JSON.stringify(revoked).slice(0, 250)}`);
  const after = sqlite.prepare("SELECT access_status,retention_status FROM service_media_assets WHERE id=?").get(id);
  assert.equal(String(after.access_status), "revoked", "and takes effect");
  assert.equal(String(after.retention_status), "revoked", "on both columns");
});

// =====================================================================================================
// PTJA-W2B-M02 — food-proof is the only proof library missing the scan maker/checker separation
//
// All four siblings carry the identical line in their record_media_scan branch:
//   if(String(media.created_by)===input.actorId)
//     throw new Response("<service> proof cannot be scan-approved by the actor who submitted it",403)
// lib/food-proof-governance.ts does not, so one staff identity walks the whole chain alone: prepare the
// media, finalize the upload, mark its own asset clean, and record the delivery proof.
//
// MEASURED: four POSTs to /api/food-proof with the SAME staff headers - prepare_media,
// sandbox_finalize_media, record_media_scan clean, record_proof - all 200, ending
// {"status":"recorded","proofReady":true}. The executed control on the sibling walking library, same
// actor and same four steps, was refused 403 at step three.
//
// This also CORRECTS an earlier note of mine. When closing W2-B4-M04 I grepped the sibling's scan
// branch, saw truncated output, and concluded the siblings do not enforce actor separation either -
// using that to justify leaving service-media's self-approval alone. They do enforce it, all four of
// them. That line is applied here to food-proof and to app/api/service-media, and the M04 ledger note
// is corrected.
// =====================================================================================================

test("W2B-M02: the actor who submitted food proof cannot scan-approve it", async () => {
  const { sqlite, db } = await mediaWorld();
  const now = Date.now();
  const food = await import("../lib/food-proof-governance.ts");
  const fulfilment = await import("../lib/food-fulfilment-governance.ts");
  await fulfilment.ensureFoodFulfilmentTables(db);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES ('FOOD-SELF-1','idem-s1','CUS-1','blr','blr-east','confirmed','uat_only','uat_seed','out_for_delivery',1497,'INR','CUS-1',?,?)").run(now, now);
  // context() JOINs food_order_lines, so an order without a line is invisible to the proof module.
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES ('FL-S1','FOOD-SELF-1','food-uat-cat-adult-1kg','Adult Cat Food 1kg',1,3,499,1497,'INR')").run();
  sqlite.prepare("INSERT INTO food_order_fulfilment (order_id,status,lot_id,dispatch_reference,delivery_adapter_status,handover_status,updated_by,created_at,updated_at) VALUES ('FOOD-SELF-1','dispatched',NULL,NULL,'pending','pending','ops',?,?)").run(now, now);

  const prepared = await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "prepare_media", idempotencyKey: "k1", purpose: "food_delivery",
    mimeType: "image/jpeg", sizeBytes: 1024, sha256: "a".repeat(64), actorId: "ops.manager@pawspace.test",
  }).then((value) => ({ ok: true, value }), async (error) => ({ ok: false, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }));
  assert.equal(prepared.ok, true, `the media record is prepared: ${JSON.stringify(prepared).slice(0, 250)}`);

  await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "sandbox_finalize_media", idempotencyKey: "k2",
    uploadToken: prepared.value.upload.token, storageObjectId: "uat/food/FOOD-SELF-1/delivery-01.jpg",
    actorId: "ops.manager@pawspace.test",
  });

  const selfScan = await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "record_media_scan", idempotencyKey: "k3",
    mediaRef: prepared.value.mediaRef, scanResult: "clean", actorId: "ops.manager@pawspace.test",
  }).then((value) => ({ ok: true, value }), async (error) => ({
    ok: false, status: error instanceof Response ? error.status : 0,
    message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
  }));
  assert.equal(selfScan.ok, false,
    `the submitter must not scan-approve their own food proof: ${JSON.stringify(selfScan)}`);
  assert.equal(selfScan.status, 403, "with the same 403 the four sibling libraries return");
});

test("W2B-M02: a second actor can still scan-approve it", async () => {
  // Non-vacuity. Refusing every scan would satisfy the case above and break the proof chain.
  const { sqlite, db } = await mediaWorld();
  const now = Date.now();
  const food = await import("../lib/food-proof-governance.ts");
  const fulfilment = await import("../lib/food-fulfilment-governance.ts");
  await fulfilment.ensureFoodFulfilmentTables(db);
  sqlite.prepare("INSERT INTO food_orders (id,idempotency_key,customer_id,city_id,zone_id,status,commercial_status,inventory_mode,delivery_status,total_amount,currency,created_by,created_at,updated_at) VALUES ('FOOD-SELF-1','idem-s1','CUS-1','blr','blr-east','confirmed','uat_only','uat_seed','out_for_delivery',1497,'INR','CUS-1',?,?)").run(now, now);
  // context() JOINs food_order_lines, so an order without a line is invisible to the proof module.
  sqlite.prepare("INSERT INTO food_order_lines (id,order_id,sku,item_name,item_version,quantity,unit_price,line_total,currency) VALUES ('FL-S1','FOOD-SELF-1','food-uat-cat-adult-1kg','Adult Cat Food 1kg',1,3,499,1497,'INR')").run();
  sqlite.prepare("INSERT INTO food_order_fulfilment (order_id,status,lot_id,dispatch_reference,delivery_adapter_status,handover_status,updated_by,created_at,updated_at) VALUES ('FOOD-SELF-1','dispatched',NULL,NULL,'pending','pending','ops',?,?)").run(now, now);

  const prepared = await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "prepare_media", idempotencyKey: "k1", purpose: "food_delivery",
    mimeType: "image/jpeg", sizeBytes: 1024, sha256: "b".repeat(64), actorId: "ops.manager@pawspace.test",
  });
  await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "sandbox_finalize_media", idempotencyKey: "k2",
    uploadToken: prepared.upload.token, storageObjectId: "uat/food/FOOD-SELF-1/delivery-02.jpg",
    actorId: "ops.manager@pawspace.test",
  });

  const checker = await food.mutateFoodProof(db, {
    orderId: "FOOD-SELF-1", action: "record_media_scan", idempotencyKey: "k3",
    mediaRef: prepared.mediaRef, scanResult: "clean", actorId: "quality.lead@pawspace.test",
  }).then((value) => ({ ok: true, value }), async (error) => ({ ok: false, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }));
  assert.equal(checker.ok, true, `a second actor still approves it: ${JSON.stringify(checker).slice(0, 250)}`);
  assert.equal(String(checker.value.scanStatus), "clean", "and the proof becomes usable");
});

test("W2B-M04: the actor who created a service-media asset cannot scan-approve it either", async () => {
  // The half of M04 I wrongly left open. All four sibling proof libraries refuse this; service-media
  // did not, so one identity could POST the record, confirm the upload and mark its own asset clean -
  // the chain assertServiceProofRef then accepts as the before/after photo gate on completion.
  const { call } = await mediaWorld();
  const created = await call("POST", { bookingId: "BK-GROOM-1", purpose: "after_service", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "1".repeat(64) });
  const id = created.body.data.id;
  await call("PATCH", { id, action: "confirm_upload", storageReference: "uat/grooming/BK-GROOM-1/after-02.jpg" });

  const selfScan = await call("PATCH", { id, action: "record_scan", scanResult: "clean" });
  assert.equal(selfScan.status, 403,
    `the submitter must not scan-approve their own asset: ${JSON.stringify(selfScan).slice(0, 250)}`);
});
