/*
 * Two money-adjacent partner defects in the same module, both about proof.
 *
 * (A) THE SETTLEMENT-HELD LIE.  providerWorkspace().pendingProof - the source of "Service proof still
 *     outstanding ... A completed job without its required proof holds up the settlement for that
 *     booking" on /partner-app -> Earnings, and of "PROOF PENDING (CUSTOMERS ARE REMINDED UNTIL YOU
 *     POST IT)" on /partner/workspace - counted only provider_job_proofs rows. The Partner app's real
 *     proof path is /api/grooming-lifecycle action=add_proof, which writes grooming_service_proof (and
 *     the media assets behind it). Two stores for one fact, never reconciled: a grooming job completed
 *     the normal way, with Ops-approved before and after photos and an invoice issued, still told the
 *     partner their settlement was held for proof they had already posted.
 *
 * (B) SUBMIT_PROOF COULD NOT ACCEPT A PHOTO.  requireStoredMedia carried a private copy of the release
 *     predicate that still demanded scan_status='clean'. reviewMedia deliberately stopped writing that
 *     on a human approval - a person's decision is not a scan result - and lib/service-media-security's
 *     serviceProofRefusal is the single authority (approved review + a release_basis + access ready).
 *     So a fully approved, released asset was refused, and the refusal arrived as a 500
 *     "Provider workspace update failed" with no reason in it.
 *
 * Everything below EXECUTES the shipped code: real lib modules over a real SQLite database, and the
 * real /api/provider-workspace route for the status-code half.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PARTNER_PROOF_TRUTH_DB__");

const PROVIDER = "prv_groom_1", CUSTOMER = "cust_1", BOOKING = "E2E-BK-UI-001";
const PARTNER_EMAIL = "partner.groomer@pawspace.test";
const NOW = Date.now();
const PAST = new Date(NOW - 3 * 86_400_000).toISOString();
const PAST_END = new Date(NOW - 3 * 86_400_000 + 3_600_000).toISOString();

/** A completed grooming booking for one provider, with the two proof stores present and empty. */
async function fixture({ serviceCode = "grooming", status = "completed" } = {}) {
  const { sqlite, db } = world("__PARTNER_PROOF_TRUTH_DB__", "__PARTNER_PROOF_TRUTH_DB___ENV", {});
  const workspace = await import("../lib/provider-workspace.ts");
  const media = await import("../lib/service-media-security.ts");
  await workspace.ensureProviderWorkspaceTables(db);
  await media.ensureServiceMediaTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,package_name TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (booking_id TEXT PRIMARY KEY,status TEXT,amount_due_now REAL,method TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(BOOKING, CUSTOMER, PROVIDER, serviceCode, "Full groom", PAST, PAST_END, status, 1500, NOW);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?)").run(BOOKING, "captured", 0, "upi");

  /** Register one asset in whatever state the case under test needs. Defaults to RELEASED as reviewMedia leaves it. */
  const asset = (id, over = {}) => {
    const row = {
      booking_id: BOOKING, provider_id: PROVIDER, purpose: "before_service",
      // The shape reviewMedia writes on a human approval with no scanner: pending scan, approved
      // review, released by the boundary, upload ready. This is the row the old predicate refused.
      scan_status: "pending", access_status: "ready", retention_status: "active", synthetic: 0,
      review_status: "approved", release_basis: "permitted_environment", ...over,
    };
    sqlite.prepare("INSERT OR REPLACE INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at,review_status,release_basis) VALUES (?,?,?,?,'k','image/jpeg',1024,'sha',?,?,?,?,'ops',?,?,?,?)")
      .run(row.id ?? id, row.booking_id, row.provider_id, row.purpose, row.scan_status, row.access_status, row.retention_status, row.synthetic, NOW, NOW, row.review_status, row.release_basis);
    return `media://asset/${id}`;
  };
  const postLifecycleProof = (before, after) =>
    sqlite.prepare("INSERT OR REPLACE INTO grooming_service_proof (booking_id,before_photo_ref,after_photo_ref,checklist_json,completion_notes,created_at,updated_at) VALUES (?,?,?,'[]',NULL,?,?)")
      .run(BOOKING, before, after, NOW, NOW);
  return { sqlite, db, workspace, asset, postLifecycleProof };
}

// --- (A) the two proof stores ---------------------------------------------------------------------

test("PROOF-STORE-1 a grooming job whose proof went through the lifecycle path is not reported as outstanding", async () => {
  // The reported defect, exactly: grooming_service_proof carries both approved refs and
  // provider_job_proofs is empty, which is what the Partner app's own flow produces.
  const { db, sqlite, workspace, asset, postLifecycleProof } = await fixture();
  postLifecycleProof(asset("MEDIA-BEFORE"), asset("MEDIA-AFTER", { purpose: "after_service" }));
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM provider_job_proofs").get().c, 0,
    "the fixture must reproduce the real shape: nothing in the workspace store");

  const outstanding = await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "grooming" }]);
  assert.deepEqual(outstanding, [],
    "the partner posted both photos through /api/grooming-lifecycle; nothing may still be 'missing'");
});

test("PROOF-STORE-2 a job with no proof in EITHER store is still reported, with both stages named", async () => {
  // Non-vacuity. The fix must not be "report nothing".
  const { db, workspace } = await fixture();
  const outstanding = await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "grooming" }]);
  assert.deepEqual(outstanding, [{ bookingId: BOOKING, serviceCode: "grooming", missing: ["before_photo", "after_photo"] }]);
});

test("PROOF-STORE-3 a half-posted proof reports only the stage that is actually missing", async () => {
  const { db, workspace, asset, postLifecycleProof } = await fixture();
  postLifecycleProof(asset("MEDIA-BEFORE"), null);
  const outstanding = await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "grooming" }]);
  assert.deepEqual(outstanding, [{ bookingId: BOOKING, serviceCode: "grooming", missing: ["after_photo"] }]);
});

test("PROOF-STORE-4 the workspace store still clears a stage on its own", async () => {
  // The original reader must keep working: submitJobProof writes provider_job_proofs and nothing else.
  const { db, workspace, asset } = await fixture();
  await workspace.submitJobProof(db, { providerId: PROVIDER, bookingId: BOOKING, proofType: "before_photo", objectId: asset("MEDIA-BEFORE") });
  const outstanding = await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "grooming" }]);
  assert.deepEqual(outstanding, [{ bookingId: BOOKING, serviceCode: "grooming", missing: ["after_photo"] }]);
});

test("PROOF-STORE-5 an empty lifecycle row is not proof", async () => {
  // grooming_service_proof rows also exist for checklist-only saves. A NULL or blank ref is not a photo.
  const { db, workspace, postLifecycleProof } = await fixture();
  postLifecycleProof("", null);
  const outstanding = await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "grooming" }]);
  assert.deepEqual(outstanding, [{ bookingId: BOOKING, serviceCode: "grooming", missing: ["before_photo", "after_photo"] }]);
});

test("PROOF-STORE-6 a service with no required stages, and a cold database, are both quiet", async () => {
  const { db, workspace } = await fixture();
  assert.deepEqual(await workspace.outstandingProof(db, [{ bookingId: BOOKING, serviceCode: "funeral" }]), [],
    "a service with no PROOF_REQUIREMENTS entry has nothing to owe");
  assert.deepEqual(await workspace.outstandingProof(db, []), []);
});

test("PROOF-STORE-7 the full workspace payload the two earnings screens read is clear of the false reminder", async () => {
  // End to end through providerWorkspace(), which is what /api/provider-workspace returns and what
  // both /partner-app -> Earnings and /partner/workspace render.
  const { db, workspace, asset, postLifecycleProof } = await fixture();
  const before = await workspace.providerWorkspace(db, { providerId: PROVIDER });
  assert.deepEqual(before.pendingProof, [{ bookingId: BOOKING, serviceCode: "grooming", missing: ["before_photo", "after_photo"] }],
    "with no proof anywhere the reminder must still appear");

  postLifecycleProof(asset("MEDIA-BEFORE"), asset("MEDIA-AFTER", { purpose: "after_service" }));
  const after = await workspace.providerWorkspace(db, { providerId: PROVIDER });
  assert.deepEqual(after.pendingProof, [],
    "once the proof exists in the store the Partner app actually writes to, the settlement-held copy must stop");
});

test("PROOF-STORE-8 a long history stays inside D1's bound-parameter cap", async () => {
  // Reading the two stores per booking would be an N+1; reading them in ONE statement per store is a
  // statement that gets wider as the history grows. D1 refuses past ~100 bound parameters, so the id
  // list is paged - and this harness enforces that cap the way D1 does.
  const { freshCountingD1 } = await import("./helpers/d1-harness.mjs");
  const { db, sqlite } = freshCountingD1();
  const workspace = await import("../lib/provider-workspace.ts");
  await workspace.ensureProviderWorkspaceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS grooming_service_proof (booking_id TEXT PRIMARY KEY,before_photo_ref TEXT,after_photo_ref TEXT,checklist_json TEXT NOT NULL DEFAULT '[]',completion_notes TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const jobs = Array.from({ length: 250 }, (_, index) => ({ bookingId: `BK-${index}`, serviceCode: "grooming" }));
  for (const job of jobs.slice(0, 100)) {
    sqlite.prepare("INSERT INTO grooming_service_proof (booking_id,before_photo_ref,after_photo_ref,checklist_json,completion_notes,created_at,updated_at) VALUES (?,?,?,'[]',NULL,?,?)")
      .run(job.bookingId, "media://asset/A", "media://asset/B", NOW, NOW);
  }
  const outstanding = await workspace.outstandingProof(db, jobs);
  assert.equal(outstanding.length, 150, "the 100 jobs whose proof is posted must drop out, the other 150 must remain");
  assert.equal(outstanding[0].bookingId, "BK-100");
});

// --- (B) the release predicate --------------------------------------------------------------------

test("RELEASE-1 submit_proof accepts an Ops-approved, released asset that no scanner has marked clean", async () => {
  // The exact DB state from the report: scan_status=pending, access ready, review approved,
  // release_basis set. serviceProofReleased() says yes; the old private copy said no, every time.
  const { db, workspace, asset } = await fixture();
  const result = await workspace.submitJobProof(db, {
    providerId: PROVIDER, bookingId: BOOKING, proofType: "before_photo", objectId: asset("MEDIA-RELEASED"),
  });
  assert.equal(result.mirroredToCustomer, true);
});

test("RELEASE-2 the gate is still a gate: every state the single authority refuses is refused here", async () => {
  for (const [label, over] of [
    ["never released by the boundary", { release_basis: null }],
    ["review still pending", { review_status: "pending_review" }],
    ["review rejected", { review_status: "rejected" }],
    ["condemned by a scanner", { scan_status: "infected" }],
    ["upload not ready", { access_status: "quarantined" }],
    ["outside active retention", { retention_status: "expired" }],
    ["a synthetic placeholder", { synthetic: 1 }],
    ["another booking's asset", { booking_id: "BK-OTHER" }],
    ["another provider's asset", { provider_id: "prv_other" }],
    ["an after-service photo passed off as a before", { purpose: "after_service" }],
  ]) {
    const { db, workspace, asset } = await fixture();
    await assert.rejects(
      () => workspace.submitJobProof(db, { providerId: PROVIDER, bookingId: BOOKING, proofType: "before_photo", objectId: asset("MEDIA-BAD", over) }),
      (error) => error instanceof Error && /storage-confirmed and scan-approved/i.test(error.message),
      `a ${label} asset was accepted as grooming proof`,
    );
  }
});

test("RELEASE-3 the refusal reaches the partner as a readable 4xx, not a 500", async () => {
  // POST /api/provider-workspace {"action":"submit_proof",...} answered 500 "Provider workspace update
  // failed" for every refusal, which is both the wrong class - the request was fine, the asset was not
  // - and unreadable: the partner could not tell an unapproved photo from a broken server.
  const { sqlite, db, asset } = await fixture();
  await seedActors(sqlite, db, [{ id: "U-PARTNER", email: PARTNER_EMAIL, role: "service_provider" }]);
  sqlite.prepare("INSERT OR REPLACE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run(PARTNER_EMAIL, PROVIDER, NOW, NOW);
  const { POST } = await import("../app/api/provider-workspace/route.ts");
  const submit = async (objectId) => POST(asActor(PARTNER_EMAIL, "/api/provider-workspace", {
    method: "POST", body: JSON.stringify({ action: "submit_proof", bookingId: BOOKING, proofType: "before_photo", objectId }),
  }));

  const refused = await submit(asset("MEDIA-UNREVIEWED", { review_status: "pending_review", release_basis: null }));
  const refusedBody = await refused.json();
  assert.ok(refused.status >= 400 && refused.status < 500, `an unreleased asset must be a client error, got ${refused.status}`);
  assert.match(String(refusedBody.error ?? ""), /storage-confirmed and scan-approved/i,
    `the reason must reach the partner, got ${JSON.stringify(refusedBody)}`);
  assert.notEqual(refusedBody.error, "Provider workspace update failed", "the blanket 500 body must not survive");

  const accepted = await submit(asset("MEDIA-OK"));
  assert.equal(accepted.status, 200, `a released asset must be accepted through the route: ${await accepted.clone().text()}`);
});

test("RELEASE-4 a proof carrying no media reference at all is a 400, still readable", async () => {
  const { db, workspace } = await fixture();
  await assert.rejects(
    () => workspace.submitJobProof(db, { providerId: PROVIDER, bookingId: BOOKING, proofType: "before_photo" }),
    (error) => error instanceof Error && error.statusCode === 400 && /registered private media reference/.test(error.message),
  );
});

test("RELEASE-5 the module holds no second copy of the release predicate", async () => {
  // The defect was a duplicated rule drifting from its authority. A source check is the only way to
  // say "and there is not another one": behaviour cannot prove the absence of a future copy.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/provider-workspace.ts", import.meta.url), "utf8");
  assert.ok(source.includes("serviceProofRefusal"), "the single authority must be the one that is called");
  assert.ok(!/scan_status\s*\)\s*!==\s*"clean"/.test(source) && !source.includes('scan_status)!=="clean"'),
    "a private copy of the release predicate is back in lib/provider-workspace.ts");
});
