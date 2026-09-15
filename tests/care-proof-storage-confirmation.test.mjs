/*
 * A proof is a message to the customer, so it may not claim a photo that does not exist.
 *
 * submitJobProof mirrors every accepted proof into customer_job_updates, and CUSTOMER_MESSAGE turns
 * the proof type into a sentence the customer reads: "A new daily photo of your pet is available."
 * Only grooming's before_photo/after_photo were ever checked against stored media. Boarding's
 * daily_photo and Sitting's visit_photo were not, so a provider could submit either with a made-up
 * objectId, or none at all, and the customer was told a photo of their pet was waiting.
 *
 * On this deployment no such photo could exist by any route: lib/media-storage-adapter.ts reports
 * connected:false because no PAWSPACE_MEDIA_BUCKET binding is configured, so nothing is stored at
 * all. The customer-facing claim was therefore false every single time it was made.
 *
 * Nothing exercised those two paths. Searching the suite for "daily_photo" or "visit_photo" before
 * this file returned no test at all, which is how a gate covering one of three verticals looked
 * finished. These tests EXECUTE submitJobProof against a real database rather than matching source
 * text, because the property is what the function accepts, not what it appears to check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const { submitJobProof, ensureProviderWorkspaceTables } = await importLibModule("provider-workspace");
const { PHOTO_PROOF_PURPOSE } = await importLibModule("care-proof-photo-claims");

const PROVIDER = "PRV-1", CUSTOMER = "CUST-1";

async function bookingFixture(serviceCode) {
  const { db, sqlite } = freshCountingD1();
  await ensureProviderWorkspaceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_media_assets (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,purpose TEXT,scan_status TEXT,access_status TEXT,retention_status TEXT,synthetic INTEGER DEFAULT 0,review_status TEXT,release_basis TEXT)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,?,?)").run("BK-1", CUSTOMER, PROVIDER, serviceCode);
  const storeAsset = (id, overrides = {}) => {
    /* The release boundary records a decision, not a scan verdict: lib/media-upload-boundary.ts stopped
     * writing scan_status='clean' on a human approve and now writes review_status/release_basis, which
     * lib/service-media-security.ts treats as the single release authority. A fixture with a clean scan
     * and no review is a shape the platform never produces. */
    const a = { booking_id: "BK-1", provider_id: PROVIDER, purpose: "stay_update", scan_status: "clean", access_status: "ready", retention_status: "active", synthetic: 0, review_status: "approved", release_basis: "scanner_clean", ...overrides };
    sqlite.prepare("INSERT INTO service_media_assets VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, a.booking_id, a.provider_id, a.purpose, a.scan_status, a.access_status, a.retention_status, a.synthetic, a.review_status, a.release_basis);
    return `media://asset/${id}`;
  };
  const customerUpdates = () => sqlite.prepare("SELECT update_type,message FROM customer_job_updates WHERE booking_id='BK-1'").all();
  return { db, storeAsset, customerUpdates };
}

const rejects = (promise, why) => assert.rejects(promise, (e) => e instanceof Error, why);

test("PROOF-1: boarding daily_photo with no media reference is refused", async () => {
  const { db, customerUpdates } = await bookingFixture("boarding");
  await rejects(submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "daily_photo" }),
    "a daily photo proof carrying no media was accepted");
  assert.deepEqual(customerUpdates(), [],
    "the customer was told 'A new daily photo of your pet is available' with nothing stored");
});

test("PROOF-2: sitting visit_photo with a made-up reference is refused", async () => {
  const { db, customerUpdates } = await bookingFixture("pet_sitting");
  await rejects(submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "visit_photo", objectId: "media://asset/INVENTED" }),
    "a visit photo proof naming an asset that does not exist was accepted");
  assert.deepEqual(customerUpdates(), []);
});

test("PROOF-3: grooming photo proof stays gated", async () => {
  const { db } = await bookingFixture("grooming");
  await rejects(submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "before_photo" }),
    "the original grooming gate regressed");
});

test("PROOF-4: a photo proof backed by stored, scanned media is accepted and reaches the customer", async () => {
  const { db, storeAsset, customerUpdates } = await bookingFixture("boarding");
  const ref = storeAsset("MED-OK", { purpose: "stay_update" });
  const result = await submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "daily_photo", objectId: ref });
  assert.equal(result.mirroredToCustomer, true);
  assert.deepEqual(customerUpdates().map((r) => r.update_type), ["daily_photo"],
    "a genuine photo proof must still reach the customer - the gate must not block real care");
});

test("PROOF-5: media belonging to another booking, another provider, unscanned or synthetic is refused", async () => {
  for (const [label, overrides] of [
    ["another booking", { booking_id: "BK-OTHER" }],
    ["another provider", { provider_id: "PRV-2" }],
    ["the wrong purpose", { purpose: "boarding_incident" }],
    ["an object the release boundary never released", { scan_status: "pending", review_status: null, release_basis: null }],
    ["a revoked object", { access_status: "revoked" }],
    ["a synthetic placeholder", { synthetic: 1 }],
  ]) {
    const { db, storeAsset, customerUpdates } = await bookingFixture("boarding");
    const ref = storeAsset("MED-BAD", overrides);
    await rejects(submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "daily_photo", objectId: ref }),
      `a daily photo proof backed by ${label} was accepted`);
    assert.deepEqual(customerUpdates(), [], `${label}: nothing may reach the customer`);
  }
});

test("PROOF-6: proofs that make no photo claim still need no media", async () => {
  const { db, customerUpdates } = await bookingFixture("pet_taxi");
  await submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "reached" });
  assert.deepEqual(customerUpdates().map((r) => r.update_type), ["reached"],
    "gating photo claims must not break note-based proofs like 'reached' and 'completed'");
});

test("PROOF-7: a media reference riding along on a note-based proof is still verified", async () => {
  const { db, customerUpdates } = await bookingFixture("pet_taxi");
  await rejects(submitJobProof(db, { providerId: PROVIDER, bookingId: "BK-1", proofType: "reached", objectId: "media://asset/INVENTED" }),
    "the customer update copies objectId verbatim, so an unverified reference is a second way to point at nothing");
  assert.deepEqual(customerUpdates(), []);
});

test("PROOF-8: every proof whose customer message claims a photo is gated", () => {
  /* The table and the message map must agree. A new photo proof type added to one and not the other
   * is exactly how boarding and sitting came to be ungated in the first place. */
  const gated = new Set(Object.values(PHOTO_PROOF_PURPOSE).flatMap((byType) => Object.keys(byType)));
  const claimsPhoto = ["before_photo", "after_photo", "daily_photo", "visit_photo"];
  assert.deepEqual(claimsPhoto.filter((t) => !gated.has(t)), [],
    "these proof types tell the customer a photo exists but are not checked against stored media");
});
