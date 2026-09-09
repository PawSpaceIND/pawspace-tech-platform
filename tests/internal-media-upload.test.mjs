import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installAiHooks, makeD1 } from "./helpers/ai-harness.mjs";
import { assertInternalMediaEnvironment, readVerifiedPhoto } from "../lib/internal-media-upload.ts";
installAiHooks();
const bytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), b => b.toString(16).padStart(2, "0")).join("");

test("internal media refuses production, missing flags, wrong sizes and bytes", async () => {
  const safe = { APP_ENV: "staging", PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_INTERNAL_MEDIA_ENABLED: "true" };
  assert.doesNotThrow(() => assertInternalMediaEnvironment(safe));
  for (const env of [{}, { ...safe, APP_ENV: "production" }, { ...safe, PAWSPACE_INTERNAL_MEDIA_ENABLED: "false" }]) assert.throws(() => assertInternalMediaEnvironment(env));
  const expected = { size: bytes.length, type: "image/jpeg", sha256: await hash(bytes) };
  const request = () => new Request("http://localhost/upload", { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes });
  assert.deepEqual(await readVerifiedPhoto(request(), expected), bytes);
  for (const altered of [{ ...expected, size: 1 }, { ...expected, size: 100 }, { ...expected, sha256: "a".repeat(64) }, { ...expected, type: "text/html" }]) await assert.rejects(readVerifiedPhoto(request(), altered));
});

test("private UAT upload persists bytes, rejects replay/self-review and permits a separate reviewer", async () => {
  const sqlite = new DatabaseSync(":memory:"), db = makeD1(sqlite), objects = new Map();
  globalThis.__AI_DB__ = db;
  globalThis.__PAWSPACE_TEST_ENV__ = {
    APP_ENV: "staging", PAWSPACE_MEDIA_ENV: "uat", PAWSPACE_INTERNAL_MEDIA_ENABLED: "true",
    PAWSPACE_MEDIA_BUCKET: {
      async put(key, data, options) { if (objects.has(key)) return null; objects.set(key, { data, options }); return { key }; },
      async head(key) { const item = objects.get(key); return item ? { size: item.data.length, httpMetadata: item.options.httpMetadata } : null; },
      async get(key) { const item = objects.get(key); return item ? { body: new Response(item.data).body } : null; },
    },
  };
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  for (const email of ["uploader@pawspace.test", "reviewer@pawspace.test"]) sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'manager','active',1,1)").run(email, email, email);
  const boundary = await import("../lib/media-upload-boundary.ts");
  await boundary.ensureMediaBoundaryTables(db);
  sqlite.exec("CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,service_code TEXT)");
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('wo','booking','provider','grooming')").run();
  const grant = await boundary.issueMediaUploadGrant(db, { bookingId: "booking", scopeType: "booking", scopeId: "booking", providerId: "provider", serviceCode: "grooming", cityId: "blr", category: "before_service", mimeType: "image/jpeg", sizeBytes: bytes.length, sha256: await hash(bytes), actorId: "uploader@pawspace.test" });
  const { PUT, POST, GET } = await import("../app/api/internal-service-media/route.ts");
  const upload = () => new Request("https://uat.pawspace.in/api/internal-service-media", { method: "PUT", headers: { "content-type": "image/jpeg", "x-media-upload-token": grant.token, "oai-authenticated-user-email": "uploader@pawspace.test" }, body: bytes });
  const response = await PUT(upload());
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data.stage, "pending_review");
  assert.equal(objects.size, 1);
  const crossSite = upload();
  crossSite.headers.set("origin", "https://untrusted.test");
  assert.equal((await PUT(crossSite)).status, 403);
  assert.equal((await PUT(upload())).status, 409);
  const review = email => new Request("https://uat.pawspace.in/api/internal-service-media", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify({ mediaId: grant.mediaId, decision: "approved", reason: "Checked internal-test photo" }) });
  assert.equal((await POST(review("uploader@pawspace.test"))).status, 403);
  const approved = await POST(review("reviewer@pawspace.test"));
  assert.equal(approved.status, 200, await approved.clone().text());
  const image = await GET(new Request(`https://uat.pawspace.in/api/internal-service-media?mediaId=${grant.mediaId}`, { headers: { "oai-authenticated-user-email": "reviewer@pawspace.test" } }));
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  const unsigned = await GET(new Request(`https://uat.pawspace.in/api/internal-service-media?mediaId=${grant.mediaId}`));
  assert.notEqual(unsigned.status, 200);
  sqlite.close();
});

test("verified internal photo bytes persist in local R2 with conditional writes", async () => {
  const { Miniflare } = await import("miniflare");
  const runtime = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('internal-test'); } }", compatibilityDate: "2026-01-01", r2Buckets: ["TEST_MEDIA"] });
  try {
    const bucket = await runtime.getR2Bucket("TEST_MEDIA");
    const sha256 = await hash(bytes);
    const verified = await readVerifiedPhoto(new Request("https://uat.pawspace.in/photo", { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes }), { size: bytes.length, type: "image/jpeg", sha256 });
    const options = { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "image/jpeg" }, sha256 };
    assert.ok(await bucket.put("internal/photo", verified, options));
    assert.equal(await bucket.put("internal/photo", verified, options), null);
    const stored = await bucket.get("internal/photo");
    assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), bytes);
    assert.equal((await bucket.head("internal/photo")).httpMetadata.contentType, "image/jpeg");
  } finally { await runtime.dispose(); }
});
