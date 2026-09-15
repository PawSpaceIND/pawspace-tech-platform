/**
 * Partner service-proof chain — the P0 that blocked human UAT on 2026-09-13.
 *
 * The Partner app registered a photo (POST /api/service-media) and then stopped: it never redeemed the
 * upload grant (PATCH confirm_upload), so every asset stayed pending_upload, nothing was ever reviewable,
 * and "Complete job" always failed with "approved before and after images are required". There was also
 * no staff surface at all that called record_scan, so even a confirmed asset could never be approved.
 *
 * These cases pin the whole chain the way the real handlers run it, on an in-memory D1: register ->
 * confirm -> (GET shows pending_review, and the Ops queue lists it) -> a SECOND person approves ->
 * GET shows proofReady:true (the flag the Partner app's "Add service proof" reads) -> a rejection is
 * reported with its reason so the partner can replace the photo. Plus source contracts for the two
 * screens, and the optional alternative-phone rule on grooming checkout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const UPLOADER = {
  "content-type": "application/json",
  "oai-authenticated-user-email": "ops.manager@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20manager",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};
const CHECKER = { ...UPLOADER, "oai-authenticated-user-email": "quality.lead@pawspace.test", "oai-authenticated-user-full-name": "Quality%20lead" };

async function world() {
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
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('WO-1','BK-GROOM-1','SG-1','PRV-GROOMER-1','Groomer','full_time','grooming','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z','in_service',?,?)").run(now, now);
  const route = await import("../app/api/service-media/route.ts");
  const call = async (method, body, as = UPLOADER, query = "") => {
    const response = await route[method](new Request(`https://uat.pawspace.in/api/service-media${query}`, { method, headers: as, body: method === "GET" ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /** Exactly what the Partner app now does for one chosen file: register, then confirm against the grant. */
  const partnerUpload = async (purpose, sha) => {
    const declared = { bookingId: "BK-GROOM-1", purpose, mimeType: "image/jpeg", sizeBytes: 4096, sha256: sha.repeat(64), fileName: `${purpose}.jpg` };
    const created = await call("POST", declared);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { id, upload } = created.body.data;
    const confirmed = await call("PATCH", { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: declared.sizeBytes, observedSha256: declared.sha256, observedMimeType: declared.mimeType });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    return id;
  };
  return { sqlite, db, call, partnerUpload };
}

test("register + confirm leaves the photo pending_review, visible to the partner and in the Ops queue", async () => {
  const { call, partnerUpload } = await world();
  const id = await partnerUpload("before_service", "a");
  const listing = await call("GET", null, UPLOADER, "?bookingId=BK-GROOM-1");
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const asset = listing.body.assets.find(item => item.id === id);
  assert.equal(asset.review_status, "pending_review", "the partner listing must expose the review state");
  assert.equal(asset.access_status, "quarantined");
  assert.equal(asset.proofReady, false, "nothing is proof until a second person approves it");
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.ok(queue.body.pending.some(item => item.id === id && item.booking_id === "BK-GROOM-1" && item.provider_name === "Groomer"), "the Ops queue lists the confirmed asset with its booking and provider");
});

test("the Ops queue needs bookings.manage, and the uploader cannot approve their own photo", async () => {
  const { call, partnerUpload } = await world();
  const id = await partnerUpload("before_service", "b");
  const self = await call("PATCH", { id, action: "record_scan", scanResult: "clean", reason: "Looks fine to me" }, UPLOADER);
  assert.equal(self.status, 403, `maker/checker: ${JSON.stringify(self.body)}`);
  const anonymous = await call("GET", null, { "content-type": "application/json" }, "?pending=1");
  assert.notEqual(anonymous.status, 200, "an anonymous caller must not read the review queue");
});

test("a second person's approval releases the photo: GET then reports proofReady:true, which is what Add service proof reads", async () => {
  const { call, partnerUpload } = await world();
  const before = await partnerUpload("before_service", "c");
  const after = await partnerUpload("after_service", "d");
  for (const id of [before, after]) {
    const decision = await call("PATCH", { id, action: "record_scan", scanResult: "clean", reason: "Clear photo of the pet, matches the booking" }, CHECKER);
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    assert.equal(decision.body.data.proofReady, true, "UAT releases unscanned media on the permitted-environment basis");
  }
  const listing = await call("GET", null, UPLOADER, "?bookingId=BK-GROOM-1");
  const ready = listing.body.assets.filter(item => item.proofReady).map(item => item.purpose).sort();
  assert.deepEqual(ready, ["after_service", "before_service"], `both approved photos must read proofReady from the listing: ${JSON.stringify(listing.body.assets)}`);
  // This is the gate grooming `complete` enforces; the listing flag must agree with it.
  const { assertServiceProofRef } = await import("../lib/service-media-security.ts");
  await assertServiceProofRef(globalThis.__PTJA_MEDIA_DB__, { ref: `media://asset/${before}`, bookingId: "BK-GROOM-1", providerId: "PRV-GROOMER-1", purpose: "before_service" });
  const queue = await call("GET", null, CHECKER, "?pending=1");
  assert.equal(queue.body.pending.length, 0, "approved assets leave the queue");
});

test("a rejection is reported with its reason so the partner replaces the photo instead of waiting", async () => {
  const { call, partnerUpload } = await world();
  const id = await partnerUpload("after_service", "e");
  const decision = await call("PATCH", { id, action: "record_scan", scanResult: "rejected", reason: "Photo is blurred and does not show the pet" }, CHECKER);
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  const listing = await call("GET", null, UPLOADER, "?bookingId=BK-GROOM-1");
  const asset = listing.body.assets.find(item => item.id === id);
  assert.equal(asset.proofReady, false);
  assert.equal(asset.review_status, "rejected");
  assert.match(String(asset.review_reason), /blurred/);
});

test("source contract: the Partner app confirms the upload it registers, and Ops has a review surface", async () => {
  const [partner, review, panel, queue] = await Promise.all([
    "app/partner-app/page.tsx", "app/control/service-proof-review.tsx", "app/control/booking-lifecycle-panel.tsx", "lib/provider-proof-offline-queue.ts",
  ].map(path => readFile(new URL("../" + path, import.meta.url), "utf8")));
  assert.match(partner, /boundedFetch\("\/api\/service-media\/upload", \{ method: "PUT", headers: \{ "content-type": item\.mimeType, "x-pawspace-media-id": mediaId, "x-pawspace-upload-token": grant\.token \}, body: item\.file \}/, "the bytes themselves are carried to the server, which verifies them against the grant before confirming");
  assert.doesNotMatch(partner, /observedSha256: item\.sha256/, "the confirmation is never made from the uploader's own claim about bytes the server never saw");
  assert.match(partner, /await dispatchQueuedProof\(queued, registerQueuedProof\)/, "a directly registered item is dispatched under its in-flight lock, or a concurrent flush registers it twice");
  assert.doesNotMatch(partner, /await registerQueuedProof\(queued\)/, "the page never bypasses the lock to register a queued item directly");
  assert.match(partner, /review_status === "rejected"/, "a rejected photo must be surfaced so it can be replaced");
  assert.match(review, /action: "record_scan", scanResult, reason/);
  assert.match(panel, /<ServiceProofReview bookingId=\{selected\.id\}/);
  assert.match(panel, /<ServiceProofReview title="Service proof awaiting review" \/>/);
  assert.match(queue, /isPermanentProofError\(error\)/, "a permanent 4xx must not re-register a fresh asset every cycle");
});

test("grooming checkout: the alternative phone is optional and never a silent dead end", async () => {
  const { groomingCheckoutSchema } = await import("../lib/grooming-checkout-schema.ts");
  const base = { customerName: "Karthik Test", customerPhone: "9591887878", addressLine1: "12, 16th Main Road, BTM Layout" };
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, alternativePhone: "" }).success, true, "blank alternative phone must pass");
  assert.equal(groomingCheckoutSchema.safeParse({ ...base }).success, true, "absent alternative phone must pass");
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, alternativePhone: "9686706690" }).success, true);
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, alternativePhone: "12345" }).success, false, "a typed value still has to be a real number");
  const flow = await readFile(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /Alternative Phone Number <span>\(optional\)<\/span><input aria-label="Alternative Phone Number" inputMode="tel"/, "the field is labelled optional and carries no required attribute");
  assert.match(flow, /To confirm: \{checkoutValidation\.error\.issues\[0\]\?\.message/, "when Confirm is held back, the first reason is shown inline");
});
