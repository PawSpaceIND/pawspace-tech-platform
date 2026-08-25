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
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-1','BK-GROOM-1','SG-1','PRV-GROOMER-1','Groomer','full_time','grooming','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z','assigned',?,?)").run(now, now);

  const route = await import("../app/api/service-media/route.ts");
  const call = async (method, body) => {
    const response = await route[method](new Request("https://uat.pawspace.in/api/service-media", {
      method, headers: STAFF, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
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
  await call("PATCH", { id, action: "record_scan", scanResult: "clean" });
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
