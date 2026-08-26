/**
 * WAVE 3 TIER A - adversarial verification of W2-B4-M-R02. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "a proof asset from one walking booking is NOT accepted as proof for
 * another, nor in another purpose slot, and a provider cannot read a booking they are not assigned to".
 *
 * Why it matters: service proof is what the customer is shown and what a dispute is settled on. If one
 * booking's photo can be submitted as another's, a provider can evidence a walk that never happened -
 * and be paid for it. The check is a FOUR-CORNER binding: the asset row AND a separate session-binding
 * row must both agree on booking and provider, and the session and the purpose slot must match too.
 *
 * Each corner is attacked independently, so a partial binding cannot pass by satisfying the others.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_MEDIA_DB__", "__W3A_MEDIA_ENV__");

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

const NOW = Date.now();
const DAY = 86_400_000;
const A = { booking: "WBK-A", provider: "PRV-A", customer: "CUST-A", session: "WS-A", media: "WMEDIA-A" };
const B = { booking: "WBK-B", provider: "PRV-B", customer: "CUST-B", session: "WS-B", media: "WMEDIA-B" };

let sqlite;

async function mediaWorld() {
  sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3A_MEDIA_DB__ = db;
  globalThis.__W3A_MEDIA_ENV__ = {};

  const { ensureWalkingProofTables } = await import("../lib/walking-proof-governance.ts");
  const { ensureCanonicalBookingReadModel } = await import("../lib/canonical-booking-read-model.ts");
  await ensureCanonicalBookingReadModel(db);
  await ensureWalkingProofTables(db);
  // walking_sessions lives in the ops governance module, not the proof one.
  const { ensureWalkingOpsTables } = await import("../lib/walking-ops-governance.ts");
  await ensureWalkingOpsTables(db);
  // Created inside a route file rather than a shared lib, so copied verbatim from its owning source
  // app/api/canonical-bookings/route.ts - the walking booking loader LEFT JOINs it.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");

  for (const w of [A, B]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','dog_walking','pkg','Pkg',?,?,?,?,'confirmed','customer_app',600,'INR','{}','w3a',?,?)")
      .run(w.booking, `k-${w.booking}`, w.customer, `g-${w.booking}`, w.provider,
           new Date(NOW + DAY).toISOString(), new Date(NOW + DAY + 1_800_000).toISOString(), NOW, NOW);
    sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,'in_progress',?,?)")
      .run(w.session, w.booking, `g-${w.booking}`, `RES-${w.booking}`, w.provider,
           new Date(NOW + DAY).toISOString(), new Date(NOW + DAY + 1_800_000).toISOString(), NOW, NOW);
    // A genuinely clean, ready, non-synthetic asset, bound to its own booking/session/provider.
    sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,'walking_update',?,'image/jpeg',2048,?, 'clean','ready','active',0,?,?,?)")
      .run(w.media, w.booking, w.provider, `walking/${w.booking}/${w.media}.jpg`, `sha-${w.media}`, `provider-${w.provider}@pawspace.test`, NOW, NOW);
    sqlite.prepare("INSERT INTO walking_media_session_bindings (media_id,booking_id,session_id,provider_id,created_at) VALUES (?,?,?,?,?)")
      .run(w.media, w.booking, w.session, w.provider, NOW);
  }
  return db;
}

async function photoUpdate(db, { bookingId, sessionId, mediaId, actorId, key }) {
  const { mutateWalkingProof } = await import("../lib/walking-proof-governance.ts");
  try {
    const result = await mutateWalkingProof(db, {
      bookingId, action: "record_photo_update", actorId, sessionId,
      mediaRef: `media://asset/${mediaId}`, note: "Proof photo for this walk", idempotencyKey: key,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof Response) return { ok: false, status: error.status, message: await error.clone().text() };
    throw error;
  }
}

test("MR02-00 (non-vacuity): a provider's OWN clean asset IS accepted on its own booking and slot", async () => {
  // First. Every refusal below is meaningless if the happy path does not work.
  const db = await mediaWorld();
  const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: A.session, mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: "k-ok" });
  assert.equal(outcome.ok, true, `the legitimate case must succeed: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.result.status, "recorded");
});

test("MR02-01: booking A's asset is REFUSED as proof on booking B", async () => {
  const db = await mediaWorld();
  const outcome = await photoUpdate(db, { bookingId: B.booking, sessionId: B.session, mediaId: A.media, actorId: `provider-${B.provider}@pawspace.test`, key: "k-cross" });
  assert.equal(outcome.ok, false, "another booking's photo must not become this booking's proof");
  assert.equal(outcome.status, 403);
  assert.match(outcome.message, /ownership does not match/i);
});

test("MR02-02: an asset is REFUSED in a purpose slot it was not captured for", async () => {
  const db = await mediaWorld();
  sqlite.prepare("UPDATE service_media_assets SET purpose='walking_handover' WHERE id=?").run(A.media);
  const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: A.session, mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: "k-purpose" });
  assert.equal(outcome.ok, false, "a handover photo must not be reusable as a walk update");
  assert.equal(outcome.status, 409);
  assert.match(outcome.message, /purpose does not match/i);
});

test("MR02-03: an asset bound to a DIFFERENT session of the same booking is refused", async () => {
  const db = await mediaWorld();
  sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WS-A2',?,?,'RES-WBK-A2',?,2,?,?,'in_progress',?,?)")
    .run(A.booking, `g-${A.booking}`, A.provider, new Date(NOW + 2 * DAY).toISOString(), new Date(NOW + 2 * DAY + 1_800_000).toISOString(), NOW, NOW);
  const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: "WS-A2", mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: "k-session" });
  assert.equal(outcome.ok, false, "yesterday's walk photo must not evidence today's walk");
  assert.equal(outcome.status, 403);
  assert.match(outcome.message, /another session/i);
});

test("MR02-04: the SEPARATE session-binding row is checked, not just the asset row", async () => {
  // The four-corner binding exists because either row alone is forgeable by a partial write. Point the
  // binding at booking B while the asset row still says A: satisfying one corner must not be enough.
  const db = await mediaWorld();
  sqlite.prepare("UPDATE walking_media_session_bindings SET booking_id=?, provider_id=? WHERE media_id=?").run(B.booking, B.provider, A.media);
  const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: A.session, mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: "k-binding" });
  assert.equal(outcome.ok, false, "the binding row disagreeing with the asset row must refuse");
  assert.equal(outcome.status, 403);
});

test("MR02-05: an asset with no session binding at all is refused, not treated as unbound-therefore-fine", async () => {
  // The audit's defect class: absent treated as satisfied.
  const db = await mediaWorld();
  sqlite.prepare("DELETE FROM walking_media_session_bindings WHERE media_id=?").run(A.media);
  const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: A.session, mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: "k-nobinding" });
  assert.equal(outcome.ok, false, "an unbound asset must refuse rather than pass");
  assert.equal(outcome.status, 409);
});

test("MR02-06: an unscanned, quarantined or non-ready asset is refused even on its own booking", async () => {
  for (const [column, value] of [["scan_status", "pending"], ["scan_status", "infected"], ["access_status", "pending_upload"], ["retention_status", "purged"], ["synthetic", 1]]) {
    const db = await mediaWorld();
    sqlite.prepare(`UPDATE service_media_assets SET ${column}=? WHERE id=?`).run(value, A.media);
    const outcome = await photoUpdate(db, { bookingId: A.booking, sessionId: A.session, mediaId: A.media, actorId: `provider-${A.provider}@pawspace.test`, key: `k-${column}-${value}` });
    assert.equal(outcome.ok, false, `${column}=${value} must not be usable as proof`);
    assert.equal(outcome.status, 409, `${column}=${value} must be refused as not-clean-private-active proof`);
  }
});
