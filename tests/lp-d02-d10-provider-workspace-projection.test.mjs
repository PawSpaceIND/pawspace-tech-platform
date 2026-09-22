/**
 * LP-D02 and LP-D10 - two GET /api/provider-workspace projection defects.
 *
 * LP-D02: Earnings kept saying "Service proof still outstanding ... missing before photo, after photo"
 * for a grooming job whose two photos were approved and recorded, because pendingProof read the generic
 * provider_job_proofs staging table instead of grooming_service_proof, which is what grooming's
 * "Add service proof" (grooming-lifecycle add_proof) actually writes to.
 *
 * LP-D10: "PAYMENT PENDING" listed captured payments, because paymentPending's filter OR'd in ANY row
 * with paymentDueNow > 0 regardless of paymentStatus, even when the status was already 'captured'.
 *
 * Both live in the same providerWorkspace() projection (lib/provider-workspace.ts), run here against
 * real SQLite with the exact table DDL their real writers use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
import { DatabaseSync } from "node:sqlite";

installWorkersHooks("__LPD02_DB__", "__LPD02_ENV__");

const PROVIDER = "PRV-GROOM-LPD02";
const now = Date.now();

function baseTables(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_name TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,provider_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,status TEXT,amount_due_now REAL,method TEXT)");
  // Exact DDL grooming-lifecycle's add_proof writes to (app/api/grooming-lifecycle/route.ts).
  sqlite.exec("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  globalThis.__LPD02_DB__ = db;
  globalThis.__LPD02_ENV__ = {};
  baseTables(sqlite);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  const commission = await import("../lib/provider-commission-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(PROVIDER, "blr", "Groomer", "contract", JSON.stringify(["grooming"]), JSON.stringify(["koramangala"]), "2026-01-01", "ops.one@pawspace.in", now);
  const workspaceLib = await import("../lib/provider-workspace.ts");
  return { sqlite, db, workspaceLib };
}

function seedGroomingBooking(sqlite, { id, paymentStatus, dueNow, proof }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,scheduled_start,scheduled_end,status,total_amount,provider_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "CUS-1", "grooming", "Full Groom", "2026-08-01T04:00:00.000Z", "2026-08-01T05:00:00.000Z", "completed", 1299, PROVIDER);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,status,amount_due_now,method) VALUES (?,?,?,?,?)")
    .run(`PAY-${id}`, id, paymentStatus, dueNow, "upi");
  if (proof) {
    sqlite.prepare("INSERT INTO grooming_service_proof (booking_id,before_photo_ref,after_photo_ref,checklist_json,completion_notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, proof.before ?? null, proof.after ?? null, "[]", null, now, now);
  }
}

test("LP-D02: a grooming job with both photos approved in grooming_service_proof is not reported as missing proof", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-MUBBSUG2-A32D", paymentStatus: "captured", dueNow: 0,
    proof: { before: "media://asset/MEDIA-BEFORE-1", after: "media://asset/MEDIA-AFTER-1" },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  assert.deepEqual(workspace.pendingProof, [], "both photos are recorded, so nothing should be outstanding");
});

test("LP-D02: a grooming job with only one photo recorded still reports the other as missing", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-ONE-PHOTO", paymentStatus: "captured", dueNow: 0,
    proof: { before: "media://asset/MEDIA-BEFORE-2", after: null },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const entry = workspace.pendingProof.find(item => item.bookingId === "PS-UAT-ONE-PHOTO");
  assert.ok(entry, "the incomplete booking must still be flagged");
  assert.deepEqual(entry.missing, ["after_photo"]);
});

test("LP-D02: a grooming job with no service-proof row at all reports both photos missing", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, { id: "PS-UAT-NO-PROOF", paymentStatus: "captured", dueNow: 0, proof: null });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const entry = workspace.pendingProof.find(item => item.bookingId === "PS-UAT-NO-PROOF");
  assert.ok(entry);
  assert.deepEqual(entry.missing.sort(), ["after_photo", "before_photo"]);
});

test("LP-D10: a captured payment does not appear in paymentPending even though amount_due_now still carries the booking's original amount", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, {
    id: "PS-UAT-CAPTURED-1", paymentStatus: "captured", dueNow: 1299,
    proof: { before: "media://asset/A", after: "media://asset/B" },
  });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  assert.ok(!workspace.bookings.paymentPending.some(item => item.bookingId === "PS-UAT-CAPTURED-1"),
    "a captured payment must never be listed as pending, regardless of paymentDueNow");
});

test("LP-D10: an actually pending/partial/failed payment still appears in paymentPending", async () => {
  const { sqlite, db, workspaceLib } = await world();
  seedGroomingBooking(sqlite, { id: "PS-UAT-PARTIAL-1", paymentStatus: "partial", dueNow: 500, proof: null });
  seedGroomingBooking(sqlite, { id: "PS-UAT-PENDING-1", paymentStatus: "pending", dueNow: 1299, proof: null });
  const workspace = await workspaceLib.providerWorkspace(db, { providerId: PROVIDER });
  const pendingIds = workspace.bookings.paymentPending.map(item => item.bookingId).sort();
  assert.deepEqual(pendingIds, ["PS-UAT-PARTIAL-1", "PS-UAT-PENDING-1"]);
});
