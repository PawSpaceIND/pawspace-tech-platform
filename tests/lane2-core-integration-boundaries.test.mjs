import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Lane 2 - booking / provider / Maps / GPS / media / KYC boundaries, EXECUTED.
//
// The existing GPS suite (tests/universal-gps-lateness-recovery.test.mjs) asserts that the strings
// "stale", "low_accuracy" and "invalid_coordinates" appear in lib/universal-location-recovery.ts. Every
// one of those assertions passes today and passed before this branch. None of them runs the function.
//
// They could not run it. `export class LocationConfigurationRequired extends Error {
// constructor(public key: string) {...} }` is a TypeScript parameter property, which Node's
// --experimental-strip-types - the mode every suite in this repo runs under - refuses at parse time with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. One token made the whole module unimportable from a test, so the
// only available evidence was reading the source. That token is now an explicit field assignment and
// this file executes the module.
//
// Executing it found two gates that never fired for the inputs that matter, and both are now fixed:
//   - a capture timestamp in the FUTURE scored as the freshest possible evidence (age was clamped to 0);
//   - an OMITTED accuracy skipped the accuracy policy entirely (NaN > allowed is false).
// Both produced trust_state "accepted", which is exactly the state recordEtaSnapshot demands before a
// position may drive a customer-facing ETA.
//
// PROVIDER EVIDENCE BOUNDARY. Nothing here is provider-verified. There is no Google Maps UAT key, no
// IDfy account, no private object store and no malware scanner in this environment, and none was
// simulated to turn a row green. Where a test drives an adapter it does so against a controlled local
// transport and says so; that proves OUR contract, not the provider's.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...env };
  return { sqlite, db };
}

// One anchor for the whole file. Two separate Date.now() calls inside a freshness assertion is how a
// boundary test becomes intermittently red.
const BASE = Date.now();

// =====================================================================================================
// GPS EVIDENCE TRUST - the module that could not previously be executed at all
// =====================================================================================================

const FRESHNESS_SECONDS = 60, ALLOWED_ACCURACY_M = 50;

async function gpsWorld() {
  const { sqlite, db } = world();
  const location = await import("../lib/universal-location-recovery.ts");
  await location.ensureUniversalLocationTables(db);
  sqlite.prepare("INSERT INTO booking_punctuality_policies (id,service_code,city_id,provider_model,tracking_enabled,eta_freshness_seconds,allowed_accuracy_meters,grace_minutes,customer_alert_minutes,ops_escalation_minutes,reassignment_minutes,evidence_requirements_json,excluded_reasons_json,raw_gps_retention_days,approval_state,effective_from,effective_to,approved_by,updated_at) VALUES ('POL-1','grooming',NULL,NULL,1,?,?,0,10,20,30,'[]','[]',7,'approved','2000-01-01',NULL,'ops',?)")
    .run(FRESHNESS_SECONDS, ALLOWED_ACCURACY_M, BASE);
  sqlite.prepare("INSERT INTO provider_location_sessions (id,booking_id,provider_id,service_code,tracking_purpose,status,policy_version_id,starts_at,created_by,created_at) VALUES ('SES-1','BKG-1','PRV-1','grooming','booking_travel','active','POL-1',?,'ops',?)")
    .run(BASE, BASE);
  const point = (extra = {}) => location.recordLocationEvidence(db, { sessionId: "SES-1", providerId: "PRV-1", lat: 12.97, lng: 77.59, accuracyMeters: 10, clientCapturedAt: Date.now(), ...extra });
  return { sqlite, db, location, point };
}

test("the location module can be imported and executed at all", async () => {
  // Guards every assertion below: while the parameter property was present this import threw
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX and no GPS behaviour in this file could have been observed.
  const location = await import("../lib/universal-location-recovery.ts");
  assert.equal(typeof location.recordLocationEvidence, "function");
  const error = new location.LocationConfigurationRequired("punctuality_policy:grooming");
  assert.equal(error.key, "punctuality_policy:grooming", "the field assignment must behave like the parameter property it replaced");
  assert.match(error.message, /^configuration_required:/);
});

test("an honest, fresh, accurate point is accepted", async () => {
  const { point } = await gpsWorld();
  assert.equal((await point()).trustState, "accepted");
});

test("a genuinely stale point is marked stale", async () => {
  const { point } = await gpsWorld();
  const result = await point({ clientCapturedAt: Date.now() - (FRESHNESS_SECONDS + 60) * 1000 });
  assert.equal(result.trustState, "stale");
});

test("a genuinely low-accuracy point is marked low_accuracy", async () => {
  const { point } = await gpsWorld();
  assert.equal((await point({ accuracyMeters: ALLOWED_ACCURACY_M * 100 })).trustState, "low_accuracy");
});

test("DEFECT: a capture timestamp in the FUTURE is not treated as fresh evidence", async () => {
  // Math.max(0, received - captured) clamped a future capture to age 0, so a client clock running fast -
  // or a forged capture time - was the freshest evidence the system could see. Skew is now measured in
  // both directions against the SAME operator-approved freshness window; no new tolerance was invented.
  const { sqlite, point } = await gpsWorld();
  const result = await point({ clientCapturedAt: Date.now() + 3_600_000 });
  assert.equal(result.trustState, "stale", "a point captured an hour in the future must not be trusted");
  const row = sqlite.prepare("SELECT trust_state,rejection_reason FROM universal_provider_location_events WHERE id=?").get(result.id);
  assert.equal(row.trust_state, "stale");
  assert.equal(row.rejection_reason, "client_capture_ahead_of_server_time", "the reason must name the actual problem, not generic lag");
});

test("clock skew inside the approved window is still accepted, in both directions", async () => {
  // The fix must not turn ordinary device clock drift into a rejection.
  const { point } = await gpsWorld();
  const half = (FRESHNESS_SECONDS / 2) * 1000;
  assert.equal((await point({ clientCapturedAt: Date.now() + half })).trustState, "accepted", "modest fast clock");
  assert.equal((await point({ clientCapturedAt: Date.now() - half })).trustState, "accepted", "modest lag");
});

test("DEFECT: an OMITTED accuracy is not treated as acceptable accuracy", async () => {
  // The route passes Number(body.accuracyMeters), which is NaN when the field is absent. `??` does not
  // catch NaN, and NaN > allowed is false, so the low-accuracy branch was skipped and the row was stored
  // with accuracy_meters NULL and trust "accepted". The `?? 99999` sentinel already showed the intended
  // behaviour; it just never applied to the value the route actually sends.
  const { sqlite, point } = await gpsWorld();
  const result = await point({ accuracyMeters: Number(undefined) });
  assert.equal(result.trustState, "low_accuracy", "unknown accuracy must fail the accuracy policy, not skip it");
  const row = sqlite.prepare("SELECT trust_state,rejection_reason,accuracy_meters FROM universal_provider_location_events WHERE id=?").get(result.id);
  assert.equal(row.rejection_reason, "accuracy_not_reported_by_device");
  assert.ok(Number(row.accuracy_meters) > ALLOWED_ACCURACY_M, "the stored accuracy must record the fail-closed sentinel, not NULL");
});

test("an omitted accuracy on a forged-future capture is still refused", async () => {
  const { point } = await gpsWorld();
  assert.notEqual((await point({ accuracyMeters: Number(undefined), clientCapturedAt: Date.now() + 3_600_000 })).trustState, "accepted");
});

test("out-of-range and non-finite coordinates are refused before anything is stored", async () => {
  const { sqlite, location, db } = await gpsWorld();
  for (const bad of [{ lat: 91, lng: 77 }, { lat: 12, lng: 181 }, { lat: Number.NaN, lng: 77 }, { lat: 12, lng: Number.POSITIVE_INFINITY }]) {
    await assert.rejects(
      () => location.recordLocationEvidence(db, { sessionId: "SES-1", providerId: "PRV-1", accuracyMeters: 10, clientCapturedAt: Date.now(), ...bad }),
      /invalid_coordinates/);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events").get().n, 0, "a refused point must leave no evidence row");
});

test("another provider cannot post evidence into this provider's session", async () => {
  const { sqlite, location, db } = await gpsWorld();
  await assert.rejects(
    () => location.recordLocationEvidence(db, { sessionId: "SES-1", providerId: "PRV-INTRUDER", lat: 12.97, lng: 77.59, accuracyMeters: 10, clientCapturedAt: Date.now() }),
    /provider_ownership_denied/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events").get().n, 0);
});

test("the GPS kill switch stops ingestion entirely", async () => {
  const { sqlite, point } = await gpsWorld();
  sqlite.prepare("UPDATE location_control_settings SET gps_ingestion_enabled=0 WHERE id='global'").run();
  await assert.rejects(() => point(), /gps_kill_switch_active/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM universal_provider_location_events").get().n, 0);
});

test("untrusted evidence cannot drive a customer-facing ETA", async () => {
  // The consequence that makes the two trust defects matter: an "accepted" point is the ONLY thing
  // recordEtaSnapshot will build a configured ETA from.
  const { location, db, point } = await gpsWorld();
  const forged = await point({ clientCapturedAt: Date.now() + 3_600_000 });
  await assert.rejects(
    () => location.recordEtaSnapshot(db, { bookingId: "BKG-1", providerId: "PRV-1", originEventId: forged.id, destination: { address: "somewhere" }, distanceMeters: 1000, durationSeconds: 600, providerStatus: "configured" }),
    /untrusted_location_cannot_drive_eta/);
});

test("an ETA snapshot is always a forecast, never a guarantee", async () => {
  const { sqlite, location, db, point } = await gpsWorld();
  const good = await point();
  const snapshot = await location.recordEtaSnapshot(db, { bookingId: "BKG-1", providerId: "PRV-1", originEventId: good.id, destination: { address: "somewhere" }, distanceMeters: 1000, durationSeconds: 600, providerStatus: "configured" });
  assert.equal(snapshot.forecast, true);
  const row = sqlite.prepare("SELECT detail_json FROM route_eta_snapshots WHERE id=?").get(snapshot.id);
  assert.equal(JSON.parse(row.detail_json).guaranteedArrival, false);
});

// =====================================================================================================
// MAPS ADAPTER - fail-closed without a provider account
// =====================================================================================================

test("the maps adapter refuses when no UAT key is configured", async () => {
  world({});
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
  assert.equal(result.status, "configuration_required");
  assert.match(result.error, /GOOGLE_MAPS_SERVER_API_KEY_UAT/);
});

test("the maps adapter stays locked to sandbox", async () => {
  world({ PAWSPACE_MAPS_ENV: "production", GOOGLE_MAPS_SERVER_API_KEY_UAT: "unused-in-this-path" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
  assert.equal(result.status, "configuration_required");
  assert.match(result.error, /locked to sandbox/);
});

test("DEFECT: malformed coordinates are refused by the adapter, not forwarded to the provider", async () => {
  // Validation existed only in the grooming-route handler. The location-recovery ETA action is a second
  // caller that reads coordinates back out of the database, so adapter-level validation is what actually
  // prevents a malformed pair reaching a third party - NaN serialises to `null` in the request body.
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute, validRoutePoint } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response("{}", { status: 200 }); };
  try {
    for (const bad of [{ lat: 91, lng: 77 }, { lat: 12, lng: 181 }, { lat: Number.NaN, lng: 77 }, { lat: 12, lng: Number.NaN }]) {
      assert.equal(validRoutePoint(bad), false, `${JSON.stringify(bad)} must not be a valid route point`);
      const result = await computeGoogleRoute(bad, "1 Example Road, Bengaluru");
      assert.equal(result.status, "route_unavailable");
      assert.match(result.error, /out of range|missing/);
    }
    assert.equal(called, 0, "not one provider call may be made for a malformed coordinate");
  } finally { globalThis.fetch = original; }
});

test("provider 4xx, 5xx, malformed body and network failure all degrade, never fabricate a route", async () => {
  // Drives the real adapter against a controlled local transport. This is OUR contract under provider
  // failure; it is NOT evidence that Google Routes was called.
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  const cases = [
    ["4xx", async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })],
    ["5xx", async () => new Response(JSON.stringify({ error: { message: "backend error" } }), { status: 503 })],
    ["200 with no routes", async () => new Response(JSON.stringify({ routes: [] }), { status: 200 })],
    ["200 with unparseable body", async () => new Response("<html>not json</html>", { status: 200 })],
    ["network failure", async () => { throw new TypeError("network error"); }],
  ];
  try {
    for (const [label, impl] of cases) {
      globalThis.fetch = impl;
      const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
      assert.equal(result.status, "route_unavailable", `${label} must degrade`);
      assert.equal(result.distanceMeters, undefined, `${label} must not invent a distance`);
      assert.equal(result.durationSeconds, undefined, `${label} must not invent a duration`);
    }
  } finally { globalThis.fetch = original; }
});

test("DEFECT: a provider that never answers is abandoned rather than held open", async () => {
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute, MAPS_REQUEST_TIMEOUT_MS } = await import("../lib/grooming-maps.ts");
  assert.ok(MAPS_REQUEST_TIMEOUT_MS > 0, "the adapter must declare a timeout ceiling");
  const original = globalThis.fetch;
  // Honour the abort signal the way a real fetch does, then assert we surface it as a degraded route.
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (!signal) { reject(new Error("the adapter passed no abort signal, so a hung provider could never be abandoned")); return; }
    signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); });
  });
  try {
    const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
    assert.equal(result.status, "route_unavailable");
    assert.match(result.error, /did not respond within/);
  } finally { globalThis.fetch = original; }
});

// =====================================================================================================
// SERVICE MEDIA PROOF BOUNDARY
// =====================================================================================================

const SHA = "a".repeat(64);
async function mediaWorld(env = {}) {
  const { sqlite, db } = world(env);
  const media = await import("../lib/service-media-security.ts");
  await media.ensureServiceMediaTable(db);
  const asset = (over = {}) => {
    const row = { id: "MEDIA-1", booking_id: "BKG-1", provider_id: "PRV-1", purpose: "after_service", storage_key: "k", mime_type: "image/jpeg", size_bytes: 1000, sha256: SHA, scan_status: "clean", access_status: "ready", retention_status: "active", synthetic: 0, ...over };
    sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ops',?,?)")
      .run(row.id, row.booking_id, row.provider_id, row.purpose, row.storage_key, row.mime_type, row.size_bytes, row.sha256, row.scan_status, row.access_status, row.retention_status, row.synthetic, BASE, BASE);
    return row.id;
  };
  const check = (over = {}) => media.assertServiceProofRef(db, { ref: "media://asset/MEDIA-1", bookingId: "BKG-1", providerId: "PRV-1", purpose: "after_service", ...over });
  return { sqlite, db, media, asset, check };
}

test("registered, scanned, provider-owned media is accepted as service proof", async () => {
  const { asset, check } = await mediaWorld();
  asset();
  await check();
});

test("DEFECT: a fabricated uat:// proof reference is refused when the UAT flag is absent", async () => {
  // With no media asset in the database at all, both halves of a grooming completion mandate were
  // satisfiable by two strings the caller composes from the booking id - no upload, no checksum, no
  // scan, no object store - and completion issues an invoice and sets settlement readiness.
  const { sqlite, check } = await mediaWorld();
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM service_media_assets").get().n, 0, "nothing was ever uploaded");
  for (const purpose of ["before_service", "after_service"]) {
    const ref = `uat://proof/BKG-1/${purpose === "before_service" ? "before" : "after"}`;
    const refusal = await check({ ref, purpose }).then(() => null, (error) => error);
    assert.ok(refusal instanceof Response, "must refuse with a governed HTTP response");
    assert.equal(refusal.status, 403);
  }
});

test("the synthetic proof path stays available in an explicitly declared UAT environment", async () => {
  // The flag exists so staff UAT can still run without a live object store - it is a declared
  // environment, not a default.
  const { check } = await mediaWorld({ PAWSPACE_MEDIA_ENV: "uat" });
  await check({ ref: "uat://proof/BKG-1/after" });
  const wrongBooking = await check({ ref: "uat://proof/BKG-OTHER/after" }).then(() => null, (e) => e);
  assert.equal(wrongBooking.status, 409, "even in UAT a synthetic ref must belong to this booking");
});

test("proof belonging to another booking or another provider is refused", async () => {
  const { asset, check } = await mediaWorld();
  asset();
  assert.equal((await check({ bookingId: "BKG-OTHER" }).then(() => null, (e) => e)).status, 403);
  assert.equal((await check({ providerId: "PRV-OTHER" }).then(() => null, (e) => e)).status, 403);
});

test("unscanned, quarantined, revoked and still-synthetic media are all refused as proof", async () => {
  for (const [label, over] of [
    ["never scanned", { scan_status: "pending" }],
    ["scan rejected", { scan_status: "rejected" }],
    ["still quarantined", { access_status: "quarantined" }],
    ["upload never confirmed", { access_status: "pending_upload" }],
    ["retention revoked", { retention_status: "revoked" }],
    ["still marked synthetic", { synthetic: 1 }],
  ]) {
    const { asset, check } = await mediaWorld();
    asset(over);
    const refusal = await check().then(() => null, (error) => error);
    assert.ok(refusal instanceof Response, `${label} must be refused`);
    assert.equal(refusal.status, 409, label);
  }
});

test("the purpose slot cannot be reused across before and after", async () => {
  const { asset, check } = await mediaWorld();
  asset({ purpose: "before_service" });
  assert.equal((await check({ purpose: "after_service" }).then(() => null, (e) => e)).status, 409);
});

test("a reference that is not a PawSpace media reference is refused", async () => {
  const { check } = await mediaWorld();
  for (const ref of ["https://example.com/photo.jpg", "media://asset/", "media://asset/../other", "media://asset/x?y", "file:///etc/passwd"]) {
    const refusal = await check({ ref }).then(() => null, (error) => error);
    assert.ok(refusal instanceof Response, `${ref} must be refused`);
    assert.ok(refusal.status === 400 || refusal.status === 409, `${ref} -> ${refusal.status}`);
  }
});

test("a media reference for an asset that does not exist is refused", async () => {
  const { check } = await mediaWorld();
  assert.equal((await check({ ref: "media://asset/MEDIA-GHOST" }).then(() => null, (e) => e)).status, 409);
});

test("grooming completion refuses a missing proof reference before the assertion is ever reached", async () => {
  // assertServiceProofRef returns quietly for an absent ref by design - it validates a ref that was
  // supplied. This pins the caller-side mandate that makes that safe, so the quiet return can never be
  // mistaken for a bypass.
  const fs = await import("node:fs");
  const route = fs.readFileSync(new URL("../app/api/grooming-lifecycle/route.ts", import.meta.url), "utf8");
  const complete = route.slice(route.indexOf('if(input.action==="complete")'));
  assert.match(complete.slice(0, 600), /!proof\?\.before_photo_ref\|\|!proof\?\.after_photo_ref\|\|checklist\.length===0/,
    "completion must refuse absent proof before calling the assertion");
});

// =====================================================================================================
// IDFY / KYC CALLBACK BOUNDARY
// =====================================================================================================

const WEBHOOK_SECRET = "uat-callback-secret-placeholder";

async function kycWorld(env = { IDFY_WEBHOOK_SECRET: WEBHOOK_SECRET }) {
  const { sqlite, db } = world(env);
  const boundary = await import("../lib/idfy-callback-boundary.ts");
  const mandate = await import("../lib/provider-verification-mandate.ts");
  await mandate.ensureVerificationMandateTables(db);
  await boundary.ensureIdfyCallbackTables(db);
  // A submission that really happened: automated, with the provider reference IDfy handed back.
  const submit = (over = {}) => {
    const row = { id: "PVER-1", application_id: "APP-1", category: "groomer", verification_type: "aadhaar", status: "manual_review", automated: 1, provider_ref: "IDFY-REQ-1", ...over };
    sqlite.prepare("INSERT INTO provider_verifications (id,application_id,category,verification_type,status,automated,provider_ref,detail_json,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?, '{}','ops',?,?)")
      .run(row.id, row.application_id, row.category, row.verification_type, row.status, row.automated, row.provider_ref, BASE, BASE);
    return row;
  };
  const post = async (payload, over = {}) => {
    const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
    const stamp = String(over.stamp ?? Date.now());
    // `in`, not `??`: passing signature:null means OMIT the header. With `??` a null fell through to a
    // freshly computed valid signature, so the "no signature at all" case silently tested the opposite
    // of what it claimed - and said so by failing.
    const signature = "signature" in over ? over.signature : await boundary.idfyHmacHex(over.secret ?? WEBHOOK_SECRET, `${stamp}.${rawBody}`);
    const headers = new Headers();
    if (signature !== null) headers.set(boundary.IDFY_SIGNATURE_HEADER, signature);
    if (over.stamp !== null) headers.set(boundary.IDFY_TIMESTAMP_HEADER, stamp);
    return boundary.applyIdfyCallback(db, globalThis.__PAWSPACE_TEST_ENV, { rawBody, headers });
  };
  const statusOf = (id = "PVER-1") => sqlite.prepare("SELECT status,updated_by FROM provider_verifications WHERE id=?").get(id);
  return { sqlite, db, boundary, mandate, submit, post, statusOf };
}

test("a correctly signed callback settles the check it correlates to", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit();
  const result = await post({ event_id: "EVT-1", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.applicationId, "APP-1");
  const row = statusOf();
  assert.equal(row.status, "verified");
  assert.equal(row.updated_by, "idfy_callback", "the audit trail must name the channel that settled it");
});

test("a rejected outcome is recorded as failed, not quietly left pending", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit();
  const result = await post({ event_id: "EVT-2", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "not_verified" } });
  assert.equal(result.outcome, "failed");
  assert.equal(statusOf().status, "failed");
});

test("an ambiguous outcome routes to human review, never to a silent approval", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit();
  await post({ event_id: "EVT-3", request_id: "IDFY-REQ-1", status: "in_progress" });
  assert.equal(statusOf().status, "manual_review");
});

test("DEFECT CLASS: a client cannot forge a verified status without the signing secret", async () => {
  // The whole point of the boundary. Every one of these is the same forged approval with a different
  // credential story, and none of them may move the record.
  const { submit, post, statusOf } = await kycWorld();
  submit();
  const forged = { event_id: "EVT-F", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } };
  const attempts = [
    ["no signature at all", { signature: null }],
    ["a wrong signature", { signature: "00".repeat(32) }],
    ["a signature from the wrong secret", { secret: "attacker-guess" }],
    ["a signature over a different timestamp", { signature: await (await import("../lib/idfy-callback-boundary.ts")).idfyHmacHex(WEBHOOK_SECRET, `1.${JSON.stringify(forged)}`) }],
  ];
  for (const [label, over] of attempts) {
    const result = await post(forged, over);
    assert.equal(result.accepted, false, label);
    assert.equal(result.status, 401, label);
    assert.equal(statusOf().status, "manual_review", `${label} must leave the record untouched`);
  }
});

test("with no signing secret configured nothing is accepted at all", async () => {
  const { submit, post, statusOf } = await kycWorld({});
  submit();
  const result = await post({ event_id: "EVT-X", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 503, "not connected is not the same as unauthorised");
  assert.equal(statusOf().status, "manual_review");
});

test("a stale or future-dated signature is refused even though it verifies", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit();
  const payload = { event_id: "EVT-S", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } };
  for (const stamp of [Date.now() - 3_600_000, Date.now() + 3_600_000]) {
    const result = await post(payload, { stamp });
    assert.equal(result.accepted, false);
    assert.equal(result.status, 401);
  }
  assert.equal(statusOf().status, "manual_review");
});

test("an unknown provider reference is refused and recorded rather than dropped", async () => {
  const { sqlite, submit, post } = await kycWorld();
  submit();
  const result = await post({ event_id: "EVT-U", request_id: "IDFY-REQ-NOT-OURS", status: "completed", result: { verification_status: "verified" } });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 404);
  const row = sqlite.prepare("SELECT outcome,accepted,rejection_reason FROM provider_verification_callbacks WHERE provider_event_id='EVT-U'").get();
  assert.equal(row.outcome, "unmatched");
  assert.equal(row.accepted, 0);
  assert.equal(row.rejection_reason, "no_verification_for_provider_reference");
});

test("with IDfy switched off there is no in-flight reference for a callback to correlate to", async () => {
  // runProviderVerification leaves provider_ref NULL when IDfy is not connected, so the fail-closed
  // submission path and the callback path cannot be played off against each other.
  const { db, mandate, post } = await kycWorld();
  const submitted = await mandate.runProviderVerification(db, {}, { applicationId: "APP-2", category: "groomer", verificationType: "aadhaar", actorId: "ops" });
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.providerRef, null, "nothing was submitted, so there is no provider reference");
  const result = await post({ event_id: "EVT-OFF", request_id: "IDFY-REQ-ANY", status: "completed", result: { verification_status: "verified" } });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 404);
});

test("a replayed callback changes nothing and still answers 200", async () => {
  const { sqlite, submit, post, statusOf } = await kycWorld();
  submit();
  const payload = { event_id: "EVT-R", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } };
  const first = await post(payload);
  assert.equal(first.duplicate, false);
  // Move the record underneath, so a second application of the event would be visible.
  sqlite.prepare("UPDATE provider_verifications SET status='failed' WHERE id='PVER-1'").run();
  const second = await post(payload);
  assert.equal(second.accepted, true);
  assert.equal(second.status, 200, "a redelivery must be answered 200 so the provider stops retrying");
  assert.equal(second.duplicate, true);
  assert.equal(statusOf().status, "failed", "the replay must not re-apply the outcome");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_verification_callbacks WHERE provider_event_id='EVT-R'").get().n, 1);
});

test("manual and automated verification authority stay separate", async () => {
  // A police / house / pet-proofing outcome is a human's recorded judgement. A provider callback must
  // not be able to write one, or the two channels collapse into a single forgeable one.
  const { submit, post, statusOf } = await kycWorld();
  submit({ verification_type: "police_verification", automated: 0, provider_ref: "IDFY-REQ-MANUAL" });
  const result = await post({ event_id: "EVT-M", request_id: "IDFY-REQ-MANUAL", status: "completed", result: { verification_status: "verified" } });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 409);
  assert.equal(statusOf().status, "manual_review");
});

test("the reverse separation also holds: an automatable check cannot be hand-recorded", async () => {
  const { db, mandate } = await kycWorld();
  await assert.rejects(
    () => mandate.recordManualVerification(db, { applicationId: "APP-1", verificationType: "aadhaar", status: "verified", actorId: "ops" }),
    /automatable check/);
});

test("a malformed callback body is refused after the signature, not before", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit();
  const result = await post("{not json");
  assert.equal(result.accepted, false);
  assert.equal(result.status, 400, "a correctly signed but unparseable body is a 400, not a 401");
  assert.equal(statusOf().status, "manual_review");
});

test("a callback missing its event id or provider reference is refused", async () => {
  const { submit, post } = await kycWorld();
  submit();
  assert.equal((await post({ request_id: "IDFY-REQ-1", status: "completed" })).status, 400);
  assert.equal((await post({ event_id: "EVT-N", status: "completed" })).status, 400);
});

// =====================================================================================================
// ASSIGNMENT REMAINS BLOCKED UNTIL EVERY MANDATE IS VERIFIED
// =====================================================================================================

test("one verified check out of a category's mandate does not make a provider assignable", async () => {
  const { db, mandate, submit, post } = await kycWorld();
  submit();
  await post({ event_id: "EVT-A", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  const status = await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" });
  assert.deepEqual(status.verified, ["aadhaar"]);
  assert.ok(status.pending.includes("pan"), "the rest of the mandate is still outstanding");
  assert.equal(status.canTakeAssignments, false);
});

test("a provider becomes assignable only when every mandated check is verified", async () => {
  const { sqlite, db, mandate, submit, post } = await kycWorld();
  submit();
  submit({ id: "PVER-2", verification_type: "pan", provider_ref: "IDFY-REQ-2" });
  await post({ event_id: "EVT-B1", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  let status = await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" });
  assert.equal(status.canTakeAssignments, false);
  await post({ event_id: "EVT-B2", request_id: "IDFY-REQ-2", status: "completed", result: { verification_status: "verified" } });
  status = await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" });
  assert.equal(status.canTakeAssignments, true);
  assert.deepEqual(status.pending, []);
  // And a later failure takes it away again rather than leaving a stale grant.
  sqlite.prepare("UPDATE provider_verifications SET status='failed' WHERE id='PVER-2'").run();
  status = await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" });
  assert.equal(status.canTakeAssignments, false);
});

test("a host mandate is not satisfiable by automated checks alone", async () => {
  // The category with physical checks. If every IDfy check passes, a host is still not assignable,
  // because house verification and the pet-proofing photo are human judgements.
  const { db, mandate, submit, post } = await kycWorld();
  submit({ application_id: "APP-H", category: "host" });
  submit({ id: "PVER-H2", application_id: "APP-H", category: "host", verification_type: "pan", provider_ref: "IDFY-REQ-H2" });
  await post({ event_id: "EVT-H1", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  await post({ event_id: "EVT-H2", request_id: "IDFY-REQ-H2", status: "completed", result: { verification_status: "verified" } });
  const status = await mandate.verificationMandateStatus(db, { applicationId: "APP-H", category: "host" });
  assert.equal(status.canTakeAssignments, false);
  assert.deepEqual(status.pending.sort(), ["house_verification", "pet_proofing_photo"]);
});

test("an empty mandate never reads as satisfied", async () => {
  // "No checks required" must not be the same answer as "all checks passed" - the defect class this
  // repository keeps finding is unknown-or-absent being treated as satisfied.
  const { db, mandate } = await kycWorld();
  const status = await mandate.verificationMandateStatus(db, { applicationId: "APP-EMPTY", category: "not_a_category" });
  assert.deepEqual(status.required, []);
  assert.equal(status.canTakeAssignments, false);
});

// =====================================================================================================
// LOCATION RECOVERY AUTHORIZES BEFORE IT ACTS
// =====================================================================================================

test("every location-recovery action is bound to a permission before any work happens", async () => {
  // Asserted against the exported object the handler actually indexes, not against the spelling of a
  // call site. The regex this replaces broke the moment the binding moved, while the property it cared
  // about was still true - which is the whole reason this lane prefers execution to source matching.
  const { LOCATION_ACTION_PERMISSION } = await import("../app/api/location-recovery/route.ts");
  assert.equal(LOCATION_ACTION_PERMISSION.create_financial_adjustment, "finance.manage",
    "money movement must need the finance permission, never a booking one");
  for (const action of ["start_session", "record_location", "calculate_eta"])
    assert.equal(LOCATION_ACTION_PERMISSION[action], "bookings.view", action);
  // Anything not named falls through to the strictest permission, so a new action cannot arrive
  // unguarded and an unknown action cannot be probed by an anonymous caller.
  assert.equal(LOCATION_ACTION_PERMISSION.save_policy, undefined);
  assert.equal(LOCATION_ACTION_PERMISSION.select_replacement, undefined);
  const fs = await import("node:fs");
  const route = fs.readFileSync(new URL("../app/api/location-recovery/route.ts", import.meta.url), "utf8");
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(post.indexOf("requirePermission") < post.indexOf("ensureUniversalLocationTables"),
    "authorization must be resolved before any table is created");
});

// =====================================================================================================
// PR #305 REVIEW REMEDIATION - each finding validated by execution before it was fixed
// =====================================================================================================

// --- callback body is bounded by BYTES, while streaming ------------------------------------------------

async function callbackRoute() {
  globalThis.__PAWSPACE_TEST_ENV = { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }) }), batch: async () => [] } };
  return (await import("../app/api/provider-verification-callback/route.ts")).POST;
}
const CALLBACK_LIMIT = 65_536;
const callbackRequest = (body, init = {}) => new Request("https://pawspace.test/api/provider-verification-callback", { method: "POST", body, ...init });

test("REVIEW: a chunked body with no content-length is cut off mid-stream, not buffered whole", async () => {
  // The first version checked content-length and then called request.text(). A chunked body carries no
  // content-length at all, so 40 MiB was buffered in full before the limit was consulted, and the stream
  // was never cancelled. Measured: 40 MiB delivered, cancelled=false, then 413.
  const POST = await callbackRoute();
  const megabyte = new Uint8Array(1024 * 1024).fill(65);
  let delivered = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { if (delivered >= 40) { controller.close(); return; } delivered += 1; controller.enqueue(megabyte); },
    cancel() { cancelled = true; },
  });
  const response = await POST(callbackRequest(body, { duplex: "half" }));
  assert.equal(response.status, 413);
  assert.ok(cancelled, "the request stream must be cancelled once the limit is crossed");
  assert.ok(delivered <= 2, `reading must stop at the limit, not drain the sender; ${delivered} MiB were accepted`);
});

test("REVIEW: the limit counts received bytes, not UTF-16 code units", async () => {
  // 40,000 multibyte characters measure 40,000 by String#length and 80,000 as bytes. The old check read
  // raw.length, so this body passed a limit it exceeded by 22%.
  const POST = await callbackRoute();
  const padding = "é".repeat(40_000);
  assert.ok(padding.length < CALLBACK_LIMIT, "under the limit when counted wrongly");
  assert.ok(new TextEncoder().encode(padding).byteLength > CALLBACK_LIMIT, "over the limit when counted correctly");
  assert.equal((await POST(callbackRequest(JSON.stringify({ padding })))).status, 413);
});

test("a multibyte body that genuinely fits is still accepted", async () => {
  // Non-vacuity: the byte-counting fix must not refuse every non-ASCII payload.
  const POST = await callbackRoute();
  const response = await POST(callbackRequest(JSON.stringify({ event_id: "E", request_id: "R", note: "é".repeat(100) })));
  assert.notEqual(response.status, 413, "a small multibyte body must survive the byte limit");
});

test("an oversized body is refused before the signature is even considered", async () => {
  const POST = await callbackRoute();
  const response = await POST(callbackRequest("x".repeat(CALLBACK_LIMIT + 1)));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/i);
});

// --- IDfy state transitions are monotonic --------------------------------------------------------------

test("REVIEW: a late nonterminal callback cannot revoke an already verified provider", async () => {
  // IDfy delivery is asynchronous and unordered, so a progress callback can land after the decision.
  // Measured before the fix: canTakeAssignments went true -> false when an `in_progress` callback
  // rewrote a `verified` row to `manual_review`.
  const { db, mandate, submit, post, statusOf } = await kycWorld();
  submit();
  submit({ id: "PVER-2", verification_type: "pan", provider_ref: "IDFY-REQ-2" });
  await post({ event_id: "MT-1", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  await post({ event_id: "MT-2", request_id: "IDFY-REQ-2", status: "completed", result: { verification_status: "verified" } });
  assert.equal((await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" })).canTakeAssignments, true);

  const late = await post({ event_id: "MT-3", request_id: "IDFY-REQ-1", status: "in_progress" });
  assert.equal(late.accepted, true, "a superseded callback is still accepted so the provider stops retrying");
  assert.equal(late.outcome, "verified", "the reported outcome is the state that stands, not the one ignored");
  assert.equal(statusOf().status, "verified");
  assert.equal((await mandate.verificationMandateStatus(db, { applicationId: "APP-1", category: "groomer" })).canTakeAssignments, true,
    "eligibility must survive an out-of-order progress callback");
});

test("a superseded callback is recorded, with a reason naming what was ignored", async () => {
  const { sqlite, submit, post } = await kycWorld();
  submit();
  await post({ event_id: "MT-4", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  await post({ event_id: "MT-5", request_id: "IDFY-REQ-1", status: "in_progress" });
  const row = sqlite.prepare("SELECT outcome,accepted,rejection_reason FROM provider_verification_callbacks WHERE provider_event_id='MT-5'").get();
  assert.equal(row.outcome, "verified");
  assert.equal(row.rejection_reason, "nonterminal_manual_review_ignored_after_verified");
});

test("terminal-to-terminal transitions still apply in both directions", async () => {
  // The rule blocks a non-decision overwriting a decision. It must NOT freeze the record: a later
  // revocation and a later correction are both the provider's own judgement.
  const { submit, post, statusOf } = await kycWorld();
  submit();
  await post({ event_id: "MT-6", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  await post({ event_id: "MT-7", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "not_verified" } });
  assert.equal(statusOf().status, "failed", "a later revocation must still land");
  await post({ event_id: "MT-8", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  assert.equal(statusOf().status, "verified", "a later correction must still land");
});

test("a nonterminal callback still applies to a record that has not been decided", async () => {
  const { submit, post, statusOf } = await kycWorld();
  submit({ status: "pending" });
  await post({ event_id: "MT-9", request_id: "IDFY-REQ-1", status: "in_progress" });
  assert.equal(statusOf().status, "manual_review", "progress must still be recorded before a decision exists");
});

// --- a refused callback must not poison its event id ---------------------------------------------------

test("REVIEW: refusal then a valid retry settles once, and the next duplicate changes nothing", async () => {
  // Measured before the fix: the 404 wrote the event id into the dedup table, so the retry matched the
  // replay check and was answered {accepted:true, status:200, outcome:"unmatched"} - the provider stopped
  // retrying, the response claimed success, and the verification stayed manual_review forever.
  const { sqlite, submit, post, statusOf } = await kycWorld();
  const payload = { event_id: "RT-1", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } };

  const refused = await post(payload);
  assert.equal(refused.accepted, false);
  assert.equal(refused.status, 404, "nothing to correlate to yet");

  submit();                                   // the submission becomes readable
  const retry = await post(payload);
  assert.equal(retry.accepted, true, "the retry must be able to succeed");
  assert.equal(retry.duplicate, false, "a refusal is not a delivery, so the retry is not a duplicate");
  assert.equal(retry.outcome, "verified");
  assert.equal(statusOf().status, "verified");

  sqlite.prepare("UPDATE provider_verifications SET status='failed' WHERE id='PVER-1'").run();
  const duplicate = await post(payload);
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.duplicate, true, "now it really is a redelivery");
  assert.equal(statusOf().status, "failed", "the duplicate must not re-apply the outcome");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_verification_callbacks WHERE provider_event_id='RT-1'").get().n, 1,
    "one row per event id - the accepted delivery replaces the refusal rather than sitting beside it");
  const row = sqlite.prepare("SELECT outcome,accepted FROM provider_verification_callbacks WHERE provider_event_id='RT-1'").get();
  assert.equal(row.accepted, 1, "the surviving row must describe the delivery that took effect");
  assert.equal(row.outcome, "verified");
});

test("REVIEW: a database read failure surfaces as an error, never as an unmatched 404", async () => {
  // .catch(() => null) mapped a transient D1 failure onto the same answer as "no such reference", so a
  // provider would be told there is nothing to deliver to and would stop retrying.
  const { db, boundary, submit, post } = await kycWorld();
  submit();
  const realPrepare = db.prepare;
  db.prepare = (sql) => sql.includes("FROM provider_verifications")
    ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR: network"); } }) }
    : realPrepare(sql);
  try {
    const raw = JSON.stringify({ event_id: "DB-1", request_id: "IDFY-REQ-1", status: "completed" });
    const stamp = String(Date.now());
    const headers = new Headers();
    headers.set(boundary.IDFY_SIGNATURE_HEADER, await boundary.idfyHmacHex(WEBHOOK_SECRET, `${stamp}.${raw}`));
    headers.set(boundary.IDFY_TIMESTAMP_HEADER, stamp);
    await assert.rejects(() => boundary.applyIdfyCallback(db, globalThis.__PAWSPACE_TEST_ENV, { rawBody: raw, headers }), /D1_ERROR/);
  } finally { db.prepare = realPrepare; }
  await post({ event_id: "DB-2", request_id: "IDFY-REQ-UNKNOWN", status: "completed" }).then((r) =>
    assert.equal(r.status, 404, "a genuinely unknown reference is still a 404"));
});

// --- the signature covers the timestamp exactly as received --------------------------------------------

test("REVIEW: a non-canonical timestamp header verifies, because the signature covers it verbatim", async () => {
  // `${stampMs}` re-serialised Number(stamp). "1700000000000.0", "+1700000000000" and a leading zero all
  // pass Number.isFinite and then serialise differently, so a correctly signed callback 401'd and the
  // verification never settled. The old tests could not see it: they signed the same normalised integer
  // string they posted.
  for (const stamp of [`${Date.now()}.0`, `+${Date.now()}`, `0${Date.now()}`]) {
    const { submit, post, statusOf } = await kycWorld();
    submit();
    assert.notEqual(String(Number(stamp)), stamp, `${stamp} must actually be non-canonical for this case to mean anything`);
    const result = await post({ event_id: `TS-${stamp}`, request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } }, { stamp });
    assert.equal(result.accepted, true, `a callback signed over the header "${stamp}" must verify`);
    assert.equal(statusOf().status, "verified");
  }
});

test("a signature computed over the NORMALISED timestamp is rejected", async () => {
  // The other direction, so the test above cannot pass by the boundary simply ignoring the timestamp.
  const { boundary, submit, statusOf, db } = await kycWorld();
  submit();
  const stamp = `${Date.now()}.0`;
  const raw = JSON.stringify({ event_id: "TS-N", request_id: "IDFY-REQ-1", status: "completed", result: { verification_status: "verified" } });
  const headers = new Headers();
  headers.set(boundary.IDFY_SIGNATURE_HEADER, await boundary.idfyHmacHex(WEBHOOK_SECRET, `${Number(stamp)}.${raw}`));
  headers.set(boundary.IDFY_TIMESTAMP_HEADER, stamp);
  const result = await boundary.applyIdfyCallback(db, globalThis.__PAWSPACE_TEST_ENV, { rawBody: raw, headers });
  assert.equal(result.accepted, false);
  assert.equal(result.status, 401);
  assert.equal(statusOf().status, "manual_review");
});

// --- negative GPS accuracy fails closed ----------------------------------------------------------------

test("REVIEW: a negative accuracy is malformed, not excellent, and cannot drive an ETA", async () => {
  // Number.isFinite(-1) is true and -1 > allowed is false, so accuracyMeters:-1 stored an ACCEPTED point
  // that drove a configured, customer-facing ETA. Same fail-open class as NaN, reached by another value.
  const { sqlite, db, location, point } = await gpsWorld();
  for (const accuracyMeters of [-1, -0.0001, -99999]) {
    const result = await point({ accuracyMeters });
    assert.equal(result.trustState, "low_accuracy", `accuracyMeters ${accuracyMeters} must fail the policy`);
    const row = sqlite.prepare("SELECT accuracy_meters,rejection_reason FROM universal_provider_location_events WHERE id=?").get(result.id);
    assert.ok(Number(row.accuracy_meters) > ALLOWED_ACCURACY_M, "the stored value must be the fail-closed sentinel, not the negative input");
    assert.equal(row.rejection_reason, "accuracy_reported_as_negative");
    await assert.rejects(
      () => location.recordEtaSnapshot(db, { bookingId: "BKG-1", providerId: "PRV-1", originEventId: result.id, destination: { address: "x" }, distanceMeters: 100, durationSeconds: 60, providerStatus: "configured" }),
      /untrusted_location_cannot_drive_eta/);
  }
});

test("zero accuracy is not swept up with the negative values", async () => {
  // Non-vacuity for the `>= 0` boundary: 0 is an unusual but legitimate reading, not a malformed one.
  const { point } = await gpsWorld();
  assert.equal((await point({ accuracyMeters: 0 })).trustState, "accepted");
});

// --- Maps must not treat an incomplete 200 as a route --------------------------------------------------

test("REVIEW: a 200 without a usable distance and duration is not a route", async () => {
  // `{"routes":[{}]}` returned status "configured" carrying distance 0 and NO duration, and a
  // non-numeric distance stored as NULL - incomplete evidence written as though the provider answered.
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  try {
    for (const body of [
      { routes: [{}] },
      { routes: [{ distanceMeters: 1250 }] },
      { routes: [{ duration: "90s" }] },
      { routes: [{ distanceMeters: -5, duration: "90s" }] },
      { routes: [{ distanceMeters: 1250, duration: "-3s" }] },
      { routes: [{ distanceMeters: "abc", duration: "xyz" }] },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
      assert.equal(result.status, "route_unavailable", JSON.stringify(body));
      assert.equal(result.durationSeconds, undefined, "no duration may be reported for a refused route");
    }
  } finally { globalThis.fetch = original; }
});

test("a complete route is still accepted, with both measures carried through", async () => {
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ routes: [{ distanceMeters: 1250, duration: "90s", polyline: { encodedPolyline: "abc" } }] }), { status: 200 });
  try {
    const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
    assert.equal(result.status, "configured");
    assert.equal(result.distanceMeters, 1250);
    assert.equal(result.durationSeconds, 90);
  } finally { globalThis.fetch = original; }
});

test("an incomplete provider answer cannot become a configured ETA snapshot", async () => {
  // The consequence: recordEtaSnapshot only refuses on UNTRUSTED origin evidence, so a "configured"
  // status with no duration would have been persisted with a null predicted arrival.
  const { sqlite, location, db, point } = await gpsWorld();
  const good = await point();
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  globalThis.__PAWSPACE_TEST_ENV.DB = db;
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ routes: [{}] }), { status: 200 });
  let route;
  try { route = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru"); }
  finally { globalThis.fetch = original; }
  const snapshot = await location.recordEtaSnapshot(db, { bookingId: "BKG-1", providerId: "PRV-1", originEventId: good.id, destination: { address: "x" }, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, providerStatus: route.status });
  const row = sqlite.prepare("SELECT provider_status,predicted_arrival_at FROM route_eta_snapshots WHERE id=?").get(snapshot.id);
  assert.equal(row.provider_status, "route_unavailable", "an incomplete answer must be stored as unavailable, not configured");
  assert.equal(row.predicted_arrival_at, null);
});

test("REVIEW: a provider that sends headers then stalls the body reports the timeout", async () => {
  // The abort fires after the headers arrive. `response.json().catch(() => ({}))` swallowed the
  // AbortError, so a request that had genuinely timed out reported "Routes API returned 200".
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const signal = options?.signal;
    assert.ok(signal, "the adapter must pass an abort signal or a stalled body could never be abandoned");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"routes":['));
        signal.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
    assert.equal(result.status, "route_unavailable");
    assert.match(result.error, /did not respond within/, "a stalled body must report the timeout, not the status line");
  } finally { globalThis.fetch = original; }
});

test("a non-abort body parse failure still degrades quietly", async () => {
  // The abort re-throw must not turn every malformed body into a thrown error.
  world({ GOOGLE_MAPS_SERVER_API_KEY_UAT: "uat-key-placeholder" });
  const { computeGoogleRoute } = await import("../lib/grooming-maps.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>not json</html>", { status: 200 });
  try {
    const result = await computeGoogleRoute({ lat: 12.97, lng: 77.59 }, "1 Example Road, Bengaluru");
    assert.equal(result.status, "route_unavailable");
    assert.doesNotMatch(result.error, /did not respond within/);
  } finally { globalThis.fetch = original; }
});
