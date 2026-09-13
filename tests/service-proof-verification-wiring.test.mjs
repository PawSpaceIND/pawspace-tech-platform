/**
 * Partner job completion was blocked in UAT by three gaps in one pipeline: the Partner app registered a
 * proof photo but never confirmed the upload, the media listing computed "ready" from a column the
 * review step deliberately no longer writes, and no screen could record the second-person approval
 * the API requires. These cases pin the wiring of all three so a refactor cannot quietly reopen one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serviceProofRefusal, serviceProofReleased, serviceProofState } from "../lib/service-media-security.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("service proof state follows the gate's release rule, not the scanner column", () => {
  const base = { scan_status: "pending", access_status: "ready", retention_status: "active", synthetic: 0, review_status: "approved", release_basis: "permitted_environment" };
  assert.equal(serviceProofRefusal(base), null, "a human-approved, released, unscanned asset is proof in a permitted environment");
  assert.equal(serviceProofReleased(base), true);
  assert.equal(serviceProofState(base), "released");
  assert.equal(serviceProofState({ ...base, scan_status: "clean" }), "released");
  assert.equal(serviceProofState({ ...base, scan_status: "infected" }), "rejected", "a scanner verdict outranks everything else");
  assert.equal(serviceProofState({ ...base, review_status: "rejected", access_status: "quarantined", release_basis: null }), "rejected");
  assert.equal(serviceProofState({ ...base, review_status: null, access_status: "pending_upload", release_basis: null }), "awaiting_upload_confirmation");
  assert.equal(serviceProofState({ ...base, review_status: "pending_review", access_status: "quarantined", release_basis: null }), "awaiting_verification");
  assert.equal(serviceProofState({ ...base, access_status: "quarantined", release_basis: null }), "blocked", "approved but withheld by the scan boundary is not 'awaiting verification'");
  assert.equal(serviceProofState({ ...base, retention_status: "superseded", access_status: "revoked" }), "withdrawn");
  assert.equal(serviceProofState({ ...base, synthetic: 1 }), "blocked");
  assert.match(String(serviceProofRefusal({ ...base, release_basis: "" })), /not been released/);
  assert.match(String(serviceProofRefusal({ ...base, access_status: "quarantined" })), /not ready/);
});

test("the media listing answers with the gate's rule and the Partner app confirms what it registers", () => {
  const route = read("app/api/service-media/route.ts");
  assert.match(route, /function isProofReady\(row:Row\)\{return serviceProofReleased\(row\);\}/, "the listing must not re-derive readiness locally");
  assert.match(route, /proofState:serviceProofState\(row\),blockedReason:serviceProofRefusal\(row\)/, "callers are told why a slot is not ready");
  assert.doesNotMatch(route, /proofReady:String\(row\.scan_status\)==="clean"/, "the stale scan-column formula must not come back");
  const partner = read("app/partner-app/page.tsx");
  assert.match(partner, /boundedFetch\("\/api\/service-media\/upload", \{ method: "PUT"/, "registration must be followed by the upload that confirms it (server-side, after the bytes are verified)");
  assert.match(partner, /"x-pawspace-upload-token": grant\.token/, "the upload presents the grant registration issued");
  assert.match(read("app/api/service-media/upload/route.ts"), /redeemMediaUploadGrant\(db,\{token,objectKey:grant\.objectKey,observed:\{sizeBytes:bytes\.byteLength,sha256,mimeType:grant\.mimeType\}/, "confirmation is made from what the server measured, never from the uploader's claim");
  assert.match(partner, /describeProof\(/, "the partner is told the state of each proof slot from the server's own answer");
  const queue = read("lib/provider-proof-offline-queue.ts");
  assert.match(queue, /export async function discardProviderProof/, "a permanently refused proof is dropped instead of re-registered for ever");
  assert.match(queue, /isPermanentProofError/);
});

test("a founder can verify service proof from the Booking Command Center", () => {
  const page = read("app/booking-command-center/page.tsx");
  assert.match(page, /import ServiceProofReview from "\.\/service-proof-review"/);
  assert.match(page, /<ServiceProofReview bookingId=\{String\(selected\.id\)\} \/>/);
  const panel = read("app/booking-command-center/service-proof-review.tsx");
  assert.match(panel, /action: "record_scan"/, "approval is the API's own record_scan decision");
  assert.match(panel, /scanResult, reason: reason\.trim\(\)/);
  assert.match(panel, /reason\.trim\(\)\.length < 5/, "a decision without a reason cannot be submitted");
  assert.match(panel, /fetch\(`\/api\/service-media\?bookingId=\$\{encodeURIComponent\(bookingId\)\}`/);
  assert.match(panel, /proofState === "awaiting_verification" &&/, "only quarantined, unreviewed media offers a decision");
  assert.match(panel, /uploader can never approve their own file/);
});
