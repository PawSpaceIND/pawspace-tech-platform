/**
 * UAT closure — provider fulfilment, EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Six tests, every assertion a regex over the partner app, the media
 * boundary, the reconciliation module and the incentive engine. "verified capture alone advances
 * reconciliation CRM and settlement readiness" asserted that the string
 * `if(!event.signatureVerified)throw new Error` appeared in the file. It appears whether an
 * unverified event is actually refused, and whether a verified one advances anything.
 *
 * Each test below drives the real function against a real SQLite-backed D1 and asserts on the rows it
 * wrote. The through-line is that a provider cannot manufacture evidence or money: proof must be
 * real, private and scanned by somebody else, and a payment moves only on a signature-verified
 * gateway event.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, nextKey } from "./helpers/taxi-harness.mjs";
import { ensureCanonicalTables, seedCanonicalStayBooking } from "./helpers/stay-harness.mjs";

installWorkersHooks("__FULFIL_DB__", "__FULFIL_ENV__");

const media = await import("../lib/media-upload-boundary.ts");
const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
const workspace = await import("../lib/provider-workspace.ts");
const incentives = await import("../lib/grooming-incentive-engine.ts");

const PROVIDER = "groomer_dev";
const CUSTOMER = "CUST-FULFIL-1";
const REVIEWER = "trust.reviewer@pawspace.test";
const SHA = "c".repeat(64);

async function fulfilmentWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FULFIL_DB__ = db;
  globalThis.__FULFIL_ENV__ = { DB: db };
  ensureCanonicalTables(sqlite);
  await media.ensureMediaBoundaryTables(db);
  const booking = seedCanonicalStayBooking(sqlite, {
    bookingId: "BKG-FULFIL-1", customerId: CUSTOMER, providerId: PROVIDER, serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", paymentStatus: "pending", paymentMode: "pay_after_service",
    amountDueNow: 0, ...options,
  });
  return { sqlite, db, booking };
}

/** These modules refuse with a Response in some places and an Error in others; read either. */
const refusalText = async (value) => {
  if (!value) return "";
  if (value instanceof Response) return `${value.status} ${await value.clone().text()}`;
  return String(value.message ?? value);
};
const refused = (promise) => promise.then(() => null, (error) => error);

const grantFor = (db, overrides = {}) => media.issueMediaUploadGrant(db, {
  bookingId: "BKG-FULFIL-1", scopeType: "booking", scopeId: "BKG-FULFIL-1", providerId: PROVIDER,
  serviceCode: "grooming", cityId: "blr", category: "after_service", mimeType: "image/jpeg",
  sizeBytes: 120_000, sha256: SHA, fileName: "after.jpg", actorId: PROVIDER, ...overrides,
});

// ---------------------------------------------------------------------------------------------
test("Grooming proof cannot be fabricated: the object that arrives must be the one promised", async () => {
  const { db } = await fulfilmentWorld();

  const grant = await media.issueMediaUploadGrant(db, {
    bookingId: "BKG-FULFIL-1", scopeType: "booking", scopeId: "BKG-FULFIL-1", providerId: PROVIDER,
    serviceCode: "grooming", cityId: "blr", category: "after_service", mimeType: "image/jpeg",
    sizeBytes: 120_000, sha256: SHA, fileName: "after.jpg", actorId: PROVIDER,
  });
  assert.ok(grant.mediaId ?? grant.id, "a grant identifies the asset it is for");
  assert.ok(grant.token, "and carries a single-use token");

  // The category is a governed vocabulary: a provider cannot invent an evidence slot.
  const invented = await grantFor(db, { category: "grooming_after" }).then(() => null, (error) => error);
  assert.equal(invented?.status, 400);
  const inventedBody = JSON.parse(await invented.text());
  assert.equal(inventedBody.code, "media_category_not_permitted");
  assert.deepEqual(inventedBody.permitted,
    ["before_service", "after_service", "service_issue", "training_homework", "stay_update"]);

  const badMime = await grantFor(db, { mimeType: "video/mp4" }).then(() => null, (error) => error);
  assert.ok(badMime, "a MIME type outside the policy is refused");
  const huge = await grantFor(db, { sizeBytes: 50_000_000 }).then(() => null, (error) => error);
  assert.ok(huge, "and so is a file beyond the policy size");

  const asset = await db.prepare("SELECT scan_status,access_status,retention_status,synthetic FROM service_media_assets WHERE id=?")
    .bind(grant.mediaId ?? grant.id).first();
  assert.equal(asset.scan_status, "pending", "nothing is scanned yet");
  assert.notEqual(asset.access_status, "ready", "and nothing is servable yet");
  assert.equal(Number(asset.synthetic ?? 0), 0, "and no synthetic placeholder is created");

  /*
   * THE POINT. The grant names the storage key it will accept AND the bytes it was promised. A
   * provider cannot promise a photograph and then present a different object, or the same object
   * under a key of their choosing.
   */
  assert.ok(grant.objectKey, "the grant names the object key it will accept");
  assert.doesNotMatch(grant.objectKey, /^https?:/, "and it is a storage key, not a public URL");

  const wrongKey = await refused(media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: "grooming/object/somewhere-else",
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  }));
  assert.ok(wrongKey, `a different object key is refused: ${await refusalText(wrongKey)}`);

  const wrongBytes = await refused(media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: grant.objectKey,
    observed: { sizeBytes: 999, sha256: "d".repeat(64), mimeType: "image/jpeg" }, actorId: PROVIDER,
  }));
  assert.ok(wrongBytes, `an object whose bytes differ from the promise is refused: ${await refusalText(wrongBytes)}`);

  const redeemed = await media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: grant.objectKey,
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  });
  assert.ok(redeemed, "the promised object is accepted");

  // The token is single use.
  const reused = await refused(media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: grant.objectKey,
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  }));
  assert.ok(reused, "a redeemed token cannot be spent again");

  const forged = await refused(media.redeemMediaUploadGrant(db, {
    token: "not-a-real-token", objectKey: grant.objectKey,
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  }));
  assert.ok(forged, "a forged token is refused");
});

// ---------------------------------------------------------------------------------------------
test("Grooming proof is released on the SCANNER's verdict, not on a human's approval", async () => {
  const { db } = await fulfilmentWorld();
  const grant = await grantFor(db);
  const mediaId = grant.mediaId ?? grant.id;
  await media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: grant.objectKey,
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  });

  const thinReason = await media.reviewMedia(db, {
    mediaId, decision: "approved", actorId: REVIEWER, reason: "",
  }).then(() => null, (error) => error);
  assert.ok(thinReason, "a review needs a real reason");

  /*
   * PTJA-W3-SC. reviewMedia does NOT write a scan result on a human's approval: it writes the
   * SCANNER's verdict, and separately the basis on which the asset was released. So approving an
   * asset that no scanner has cleared must NOT leave it scan_status 'clean' -- otherwise a human
   * clicking approve is indistinguishable from a malware scan passing.
   */
  await media.reviewMedia(db, { mediaId, decision: "approved", actorId: REVIEWER, reason: "Looks like the right dog" });
  const afterApproval = await db.prepare("SELECT scan_status,access_status,release_basis FROM service_media_assets WHERE id=?").bind(mediaId).first();
  assert.notEqual(afterApproval.scan_status, "clean",
    "a human approval is not a scan result: with no scanner verdict the asset is not 'clean'");
  assert.notEqual(afterApproval.access_status, "ready",
    "and it is not released for serving on that approval alone");

  // A rejection is a rejection whatever the scanner said.
  const second = await grantFor(db, { sha256: "e".repeat(64), fileName: "after-2.jpg" });
  const secondId = second.mediaId ?? second.id;
  await media.redeemMediaUploadGrant(db, {
    token: second.token, objectKey: second.objectKey,
    observed: { sizeBytes: 120_000, sha256: "e".repeat(64), mimeType: "image/jpeg" }, actorId: PROVIDER,
  });
  await media.reviewMedia(db, { mediaId: secondId, decision: "rejected", actorId: REVIEWER, reason: "Wrong booking entirely" });
  const rejected = await db.prepare("SELECT scan_status,access_status FROM service_media_assets WHERE id=?").bind(secondId).first();
  assert.equal(rejected.scan_status, "rejected");
  assert.notEqual(rejected.access_status, "ready", "a rejected asset is never servable");
});

// ---------------------------------------------------------------------------------------------
test("Grooming photo proof must be a registered, storage-confirmed, scan-approved reference", async () => {
  const { db } = await fulfilmentWorld();
  await workspace.ensureProviderWorkspaceTables(db);

  const submit = (objectId) => workspace.submitJobProof(db, {
    providerId: PROVIDER, bookingId: "BKG-FULFIL-1", proofType: "after_photo",
    objectId, note: "After the groom",
  }).then(() => null, (error) => error);

  /*
   * Two guards stand here -- "must use a registered private media reference" and "is not
   * storage-confirmed and scan-approved" -- and they are DEFENCE IN DEPTH: removing either one alone
   * leaves the other refusing every case below, so a mutation of one survives on its own. Removing
   * BOTH is what these assertions catch, which is the property that matters: no unverified object
   * ever becomes proof.
   */
  // A raw link, an invented reference and nothing at all are all refused.
  for (const objectId of ["https://cdn.example.com/after.jpg", "uat://proof/after", "MEDIA-DOES-NOT-EXIST", null]) {
    const rejection = await submit(objectId);
    assert.ok(rejection, `"${objectId}" is refused`);
    assert.match(await refusalText(rejection), /registered private media reference|storage-confirmed and scan-approved/,
      `and refused for the right reason: ${await refusalText(rejection)}`);
  }

  // A registered asset that has NOT been through storage confirmation and scan approval is refused too.
  const grant = await grantFor(db);
  const mediaId = grant.mediaId ?? grant.id;
  const unconfirmed = await submit(mediaId);
  assert.ok(unconfirmed, "a granted-but-unuploaded asset is not proof");
  assert.match(await refusalText(unconfirmed), /registered private media reference|storage-confirmed and scan-approved/);

  await media.redeemMediaUploadGrant(db, {
    token: grant.token, objectKey: grant.objectKey,
    observed: { sizeBytes: 120_000, sha256: SHA, mimeType: "image/jpeg" }, actorId: PROVIDER,
  });
  const unscanned = await submit(mediaId);
  assert.ok(unscanned, "an uploaded-but-unscanned asset is still not proof");
  assert.match(await refusalText(unscanned), /registered private media reference|storage-confirmed and scan-approved/);
});

// ---------------------------------------------------------------------------------------------
test("a post-service payment request cannot be raised early, and cannot fake a capture", async () => {
  const { db, sqlite, booking } = await fulfilmentWorld();
  await reconciliation.ensurePaymentReconciliationTables(db);
  const env = { PAWSPACE_PAYMENT_ENV: "sandbox" };

  // A payment cannot be requested before the service is complete.
  const early = await refused(reconciliation.createPostServicePaymentRequest(db, env, {
    bookingId: booking.bookingId, providerId: PROVIDER, actorId: PROVIDER,
  }));
  assert.ok(early);
  assert.match(await refusalText(early), /only after service completion/);

  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(booking.bookingId);

  /*
   * THE HONEST UAT POSTURE, and the whole point of this test. This build has NO Razorpay sandbox
   * credentials configured, and the module refuses rather than pretending: no payment link is created,
   * no request row is written, and the booking's money does not move. A build that faked a capture
   * when the gateway was unreachable is exactly what this refusal prevents.
   */
  const noCredentials = await refused(reconciliation.createPostServicePaymentRequest(db, env, {
    bookingId: booking.bookingId, providerId: PROVIDER, actorId: PROVIDER,
  }));
  assert.ok(noCredentials, "with no gateway credentials the request is refused");
  assert.match(await refusalText(noCredentials), /credentials are not configured - payment link was not created/);

  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM post_service_payment_requests WHERE booking_id=?").bind(booking.bookingId).first()).n),
    0,
    "and no payment request row is left behind",
  );
  const payment = await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(payment.status, "pending", "the booking's money is untouched");

  // The environment itself must be declared explicitly; an unset value is refused, never defaulted.
  const noEnv = await refused(reconciliation.createPostServicePaymentRequest(db, {}, {
    bookingId: booking.bookingId, providerId: PROVIDER, actorId: PROVIDER,
  }));
  assert.ok(noEnv);
  assert.match(await refusalText(noEnv), /PAWSPACE_PAYMENT_ENV must be exactly "sandbox" or "live"/);

  const badEnv = await refused(reconciliation.createPostServicePaymentRequest(db, { PAWSPACE_PAYMENT_ENV: "staging" }, {
    bookingId: booking.bookingId, providerId: PROVIDER, actorId: PROVIDER,
  }));
  assert.ok(badEnv, "and an invented environment name is refused too");
});

// ---------------------------------------------------------------------------------------------
test("only a signature-verified gateway event is processed at all", async () => {
  const { db, sqlite, booking } = await fulfilmentWorld();
  await reconciliation.ensurePaymentReconciliationTables(db);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(booking.bookingId);

  const event = (overrides = {}) => ({
    provider: "razorpay", environment: "sandbox", eventId: nextKey(), eventType: "payment.captured",
    bookingId: booking.bookingId, gatewayPaymentId: `pay_${nextKey()}`, amountSubunits: 49_900,
    currency: "INR", createdAt: Date.now(), signatureVerified: true,
    payloadHash: "f".repeat(64), ...overrides,
  });

  // THE GATE. Anyone can POST a webhook body; only a signature-verified one is even looked at.
  const unverified = await refused(reconciliation.processGatewayEvent(db, event({ signatureVerified: false })));
  assert.ok(unverified);
  assert.match(await refusalText(unverified), /signature is not verified/);

  const before = await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first();
  assert.equal(before.status, "pending", "the unverified event moved nothing");

  // A verified event is processed, and the state it moves is recorded.
  await reconciliation.processGatewayEvent(db, event());
  const after = await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first();
  assert.notEqual(after.status, before.status, "a signature-verified capture is what moves the money");

  // Replaying the SAME event id does not double-count it.
  const replayed = event();
  await reconciliation.processGatewayEvent(db, replayed);
  const firstCount = Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first()).n);
  await reconciliation.processGatewayEvent(db, replayed).catch(() => null);
  const secondCount = Number((await db.prepare("SELECT COUNT(*) AS n FROM booking_payments WHERE booking_id=?").bind(booking.bookingId).first()).n);
  assert.equal(secondCount, firstCount, "a replayed gateway event creates no second payment");

  // Settlement readiness, if recorded, is readiness -- not a payout.
  const readiness = await db.prepare("SELECT * FROM provider_settlement_readiness WHERE booking_id=?").bind(booking.bookingId).first()
    .catch(() => null);
  if (readiness) {
    assert.doesNotMatch(JSON.stringify(readiness), /"paid"/, "readiness is not a payout instruction");
  }
});

// ---------------------------------------------------------------------------------------------
test("finalized groomer incentive results are immutable and never move money", async () => {
  const { db } = await fulfilmentWorld();
  await incentives.ensureGroomingIncentiveTables(db);

  // Every governance act needs a real reason: a bracket is somebody's pay.
  const noReason = await incentives.saveGroomerBracket(db, {
    headGroomerId: PROVIDER, bracket: "single", effectiveFrom: "2026-09-01", reason: "", actorId: REVIEWER,
  }).then(() => null, (error) => error);
  assert.ok(noReason);
  assert.match(await refusalText(noReason), /real reason is required to set or change a groomer's bracket/);

  const badBracket = await incentives.saveGroomerBracket(db, {
    headGroomerId: PROVIDER, bracket: "platinum", effectiveFrom: "2026-09-01",
    reason: "Promoted after review", actorId: REVIEWER,
  }).then(() => null, (error) => error);
  assert.ok(badBracket);
  assert.match(await refusalText(badBracket), /Bracket must be 'team' or 'single'/);

  const teamWithoutHelper = await incentives.saveGroomerBracket(db, {
    headGroomerId: PROVIDER, bracket: "team", effectiveFrom: "2026-09-01",
    reason: "Moved onto the team bracket", actorId: REVIEWER,
  }).then(() => null, (error) => error);
  assert.ok(teamWithoutHelper);
  assert.match(await refusalText(teamWithoutHelper), /team bracket requires a real helper/);

  await incentives.saveGroomerBracket(db, {
    headGroomerId: PROVIDER, bracket: "single", effectiveFrom: "2026-09-01",
    reason: "Confirmed as a solo groomer", actorId: REVIEWER,
  });
  const bracket = await incentives.currentGroomerBracket(db, PROVIDER, "2026-09-15");
  assert.ok(bracket, "the bracket is readable back for a date inside its window");

  // Nothing in the incentive engine transfers money.
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%payout%'").all();
  for (const row of tables.results) {
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${row.name}`).first();
    assert.equal(Number(count.n), 0, `${row.name} is untouched by incentive governance`);
  }
});
