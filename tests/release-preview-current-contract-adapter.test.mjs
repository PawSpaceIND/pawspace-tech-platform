import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { adaptCurrentProductContracts, boundedPreviewFetch } from "./e2e/release-preview-gate.mjs";

const booking = (over = {}) => ({
  idempotencyKey: "preview-1-ik", scheduleGroupId: "preview-1-sg",
  customer: { id: "preview-1-CUS", name: "Preview", primaryPhone: "+919000000900" },
  pets: [{ sourceId: "acct-1", name: "Bruno" }], cityId: "blr", zoneId: "koramangala",
  serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
  scheduledStart: "2027-03-04T09:00:00.000Z", scheduledEnd: "2027-03-04T11:00:00.000Z",
  provider: { id: "preview-PRV", name: "Preview sitter", model: "full_time" },
  totalAmount: 1349, amountDueNow: 1349,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "preview" },
  pricing: { discount: 0 },
  ...over,
});

const loginResponse = (email) => ({ status: 200, body: { ok: true }, headers: { "set-cookie": `ps=${email}; Path=/` } });
const quoteResponse = () => ({ status: 201, body: { data: {
  quoteId: "SQ-1", packageCode: "sitting-visit-60", packageName: "Home Visit",
  totalAmount: 399, amountDueNow: 399, paymentMode: "prepaid",
} }, headers: {} });

async function signInBooker(adapted) {
  await adapted.http("POST", "/api/staging-login", { body: { email: "preview-booker@pawspace.test", code: "x" } });
  return "ps=preview-booker@pawspace.test";
}

test("preview transport retries one thrown network failure and returns the next response unchanged", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return { status: 400, marker: "real-response" };
  };
  const response = await boundedPreviewFetch(fetchImpl, "https://preview.example/api/canonical-bookings", { method: "POST" }, {
    attempts: 2, timeoutMs: 1000, retryDelayMs: 0,
  });
  assert.equal(calls, 2);
  assert.equal(response.status, 400);
  assert.equal(response.marker, "real-response");
});

test("preview transport never retries or softens an HTTP failure response", async () => {
  let calls = 0;
  const response = await boundedPreviewFetch(async () => {
    calls++;
    return { status: 500 };
  }, "https://preview.example/api/canonical-bookings", { method: "POST" }, {
    attempts: 2, timeoutMs: 1000, retryDelayMs: 0,
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 500);
});

test("preview transport failure names method and path after bounded attempts", async () => {
  await assert.rejects(
    boundedPreviewFetch(async () => { throw new TypeError("fetch failed"); }, "https://preview.example/api/canonical-bookings?secret=do-not-print", { method: "POST" }, {
      attempts: 2, timeoutMs: 1000, retryDelayMs: 0,
    }),
    /HTTP transport failed POST \/api\/canonical-bookings after 2 attempts \(TypeError: fetch failed\)/,
  );
});

test("current preview adapter reaches governed Sitting confirmation without weakening ownership", async () => {
  const sql = [];
  const calls = [];
  const baseD1 = async (statement) => { sql.push(statement); return []; };
  const baseHttp = async (method, path, options = {}) => {
    calls.push({ method, path, options });
    if (path === "/api/staging-login") return loginResponse(options.body.email);
    if (path === "/api/sitting-commercial") return quoteResponse();
    if (path === "/api/sitting-payment-sandbox") return { status: 201, body: { data: { status: "captured" } }, headers: {} };
    if (path === "/api/canonical-bookings") return { status: 201, body: { data: { bookingId: "BK-1" } }, headers: {} };
    return { status: 404, body: null, headers: {} };
  };

  const adapted = adaptCurrentProductContracts({ http: baseHttp, d1: baseD1 });
  await adapted.d1("INSERT OR REPLACE INTO role_definitions (code,permissions_json) VALUES ('preview_viewer','[\"bookings.view\"]')");
  assert.match(sql.at(-1), /bookings\.manage/);
  assert.doesNotMatch(sql.at(-1), /bookings\.view/);

  await adapted.d1("INSERT OR REPLACE INTO role_definitions (code,permissions_json) VALUES ('preview_booker','[\"bookings.view\",\"scheduling.book\"]')");
  assert.match(sql.at(-1), /bookings\.view/);
  assert.match(sql.at(-1), /scheduling\.book/);
  assert.doesNotMatch(sql.at(-1), /bookings\.manage/);

  await adapted.d1("INSERT OR REPLACE INTO scheduling_reservations (id,service_code,city_id,zone_id) VALUES ('R','pet_sitting','blr','koramangala')");
  assert.match(sql.at(-1), /'blr','blr-east'/);

  const cookie = await signInBooker(adapted);
  await adapted.http("POST", "/api/canonical-bookings", { headers: { cookie }, body: booking() });

  const quoteCall = calls.find((call) => call.path === "/api/sitting-commercial");
  const captureCall = calls.find((call) => call.path === "/api/sitting-payment-sandbox");
  const canonical = calls.filter((call) => call.path === "/api/canonical-bookings").at(-1);
  assert.ok(quoteCall);
  assert.ok(captureCall);
  assert.equal(captureCall.options.headers.cookie, cookie);
  assert.equal(captureCall.options.headers["x-payment-capture-key"].startsWith("preview-gate-"), true);
  assert.equal(canonical.options.body.zoneId, "blr-east");
  assert.equal(canonical.options.body.packageCode, "sitting-visit-60");
  assert.equal(canonical.options.body.packageName, "Home Visit");
  assert.equal(canonical.options.body.totalAmount, 399);
  assert.equal(canonical.options.body.amountDueNow, 399);
  assert.equal(canonical.options.body.pricing.sittingQuoteId, "SQ-1");
  assert.equal(canonical.options.body.payment.status, "captured");

  await adapted.http("POST", "/api/canonical-bookings", {
    headers: { cookie }, body: { ...booking(), pets: [{ sourceId: 7, name: "Bruno" }] },
  });
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);
  const replay = calls.filter((call) => call.path === "/api/canonical-bookings").at(-1);
  assert.equal(replay.options.body.pricing.sittingQuoteId, "SQ-1");

  await adapted.http("POST", "/api/canonical-bookings", {
    headers: { cookie },
    body: booking({ idempotencyKey: "preview-bad-ik", scheduleGroupId: "preview-bad-sg", pets: [{ sourceId: 7, name: "Seven" }] }),
  });
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);

  const stats = adapted.stats();
  assert.equal(stats.permissionRewrites, 1);
  assert.equal(stats.bookerPermissionPreserved, 1);
  assert.equal(stats.zoneRewrites, 1);
  assert.equal(stats.quoteAttempts, 1);
  assert.equal(stats.quotePreparations, 1);
  assert.equal(stats.quoteFailures, 0);
  assert.equal(stats.captureAttempts, 1);
  assert.equal(stats.captureFailures, 0);
  assert.equal(stats.preparationSuppressions, 0);
});

test("quote preparation failure is diagnosed once and subsequent doomed preparations are suppressed", async () => {
  const calls = [];
  const baseD1 = async (statement) => {
    if (/PRAGMA table_info\(sitting_commercial_quotes\)/.test(statement)) return [{ name: "id" }, { name: "amount_due_now" }];
    if (/sitting_commercial_packages/.test(statement)) return [{ package_code: "sitting-visit-60", active: 1, version: 1, effective_from: "2026-08-01", effective_to: null }];
    return [];
  };
  const baseHttp = async (method, path, options = {}) => {
    calls.push({ method, path, options });
    if (path === "/api/staging-login") return loginResponse(options.body.email);
    if (path === "/api/sitting-commercial") return { status: 500, body: { error: "Sitting commercial request failed" }, headers: {} };
    if (path === "/api/canonical-bookings") throw new Error("canonical booking must not run after setup failed");
    return { status: 404, body: null, headers: {} };
  };
  const adapted = adaptCurrentProductContracts({ http: baseHttp, d1: baseD1 });
  const cookie = await signInBooker(adapted);

  const first = await adapted.http("POST", "/api/canonical-bookings", { headers: { cookie }, body: booking() });
  const second = await adapted.http("POST", "/api/canonical-bookings", {
    headers: { cookie }, body: booking({ idempotencyKey: "preview-2-ik", scheduleGroupId: "preview-2-sg" }),
  });
  assert.equal(first.status, 424);
  assert.equal(second.status, 424);
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);
  assert.equal(calls.filter((call) => call.path === "/api/sitting-payment-sandbox").length, 0);

  const stats = adapted.stats();
  assert.equal(stats.quoteAttempts, 1);
  assert.equal(stats.quoteFailures, 1);
  assert.equal(stats.quoteFailureStatuses["500"], 1);
  assert.equal(stats.captureAttempts, 0);
  assert.equal(stats.captureFailures, 0);
  assert.equal(stats.preparationSuppressions, 1);
  assert.match(stats.firstPreparationFailure, /^quote:status=500:error=Sitting commercial request failed$/);
  assert.ok(stats.preparationDiagnostics);
  assert.deepEqual(stats.preparationDiagnostics.sittingQuoteColumns, ["amount_due_now", "id"]);
});

test("capture failure is reported separately from quote failure", async () => {
  const calls = [];
  const baseD1 = async () => [];
  const baseHttp = async (method, path, options = {}) => {
    calls.push({ method, path, options });
    if (path === "/api/staging-login") return loginResponse(options.body.email);
    if (path === "/api/sitting-commercial") return quoteResponse();
    if (path === "/api/sitting-payment-sandbox") return { status: 403, body: { error: "PAYMENT_CAPTURE_REPLAY" }, headers: {} };
    if (path === "/api/canonical-bookings") throw new Error("canonical booking must not run after capture failed");
    return { status: 404, body: null, headers: {} };
  };
  const adapted = adaptCurrentProductContracts({ http: baseHttp, d1: baseD1 });
  const cookie = await signInBooker(adapted);

  const result = await adapted.http("POST", "/api/canonical-bookings", { headers: { cookie }, body: booking() });
  assert.equal(result.status, 424);
  const captureCall = calls.find((call) => call.path === "/api/sitting-payment-sandbox");
  assert.equal(captureCall.options.headers.cookie, cookie);
  const stats = adapted.stats();
  assert.equal(stats.quoteAttempts, 1);
  assert.equal(stats.quoteFailures, 0);
  assert.equal(stats.captureAttempts, 1);
  assert.equal(stats.captureFailures, 1);
  assert.equal(stats.captureFailureStatuses["403"], 1);
  assert.match(stats.firstPreparationFailure, /^capture:status=403:error=PAYMENT_CAPTURE_REPLAY$/);
});

// Swarm regression coverage belongs to this existing adapter suite; keep the static-file ratchet unchanged.
test("current preview adapter gives each swarm scheduling group an independent provider slot", async () => {
  const d1Seen = [];
  const httpSeen = [];
  const d1 = async (sql) => { d1Seen.push(String(sql)); return []; };
  const http = async (method, path, options = {}) => {
    httpSeen.push({ method, path, body: options.body });
    return { status: 418, body: {}, headers: {} };
  };
  const adapted = adaptCurrentProductContracts({ http, d1 });

  const group = "preview-deadbeef-9001-1-swarm-3";
  const baseProvider = "preview-deadbeef-9001-1-PRV";
  const uniqueProvider = `${group}-PRV`;

  await adapted.d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${baseProvider}','assigned','preview','gate',1)`);
  await adapted.d1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${group}','${group}','${baseProvider}','pet_sitting','blr','koramangala','preview-deadbeef-9001-1-CUS','[]','2027-03-04T09:00:00.000Z','2027-03-04T11:00:00.000Z',1,1,NULL,'reserved','{}',1)`);

  assert.equal(d1Seen.length, 2);
  for (const sql of d1Seen) {
    assert.match(sql, new RegExp(`'${uniqueProvider}'`), "both assignment and reservation must use the unique swarm provider");
  }
  assert.match(d1Seen[1], /'blr','blr-east'/, "the existing current-zone adaptation must remain intact");

  await adapted.http("POST", "/api/canonical-bookings", {
    body: {
      idempotencyKey: group,
      scheduleGroupId: group,
      customer: { id: "not-the-owned-gate-customer" },
      pets: [{ sourceId: "swarm-3", name: "Pet 3" }],
      cityId: "maa",
      zoneId: "adyar",
      serviceCode: "pet_sitting",
      provider: { id: baseProvider, name: "Preview sitter", model: "full_time" },
    },
  });

  const forwarded = httpSeen.at(-1);
  assert.equal(forwarded.path, "/api/canonical-bookings");
  assert.equal(forwarded.body.provider.id, uniqueProvider, "booking payload must name the same provider the swarm reservation holds");

  const metrics = adapted.stats();
  assert.equal(metrics.swarmSeedProviderRewrites, 2, "assignment and reservation rewrites must both be observed");
  assert.equal(metrics.swarmBookingProviderRewrites, 1, "booking provider rewrite must be observed");
});

test("current preview adapter leaves non-swarm provider identities unchanged", async () => {
  const d1Seen = [];
  const httpSeen = [];
  const adapted = adaptCurrentProductContracts({
    d1: async (sql) => { d1Seen.push(String(sql)); return []; },
    http: async (method, path, options = {}) => { httpSeen.push({ method, path, body: options.body }); return { status: 418, body: {}, headers: {} }; },
  });

  const group = "preview-deadbeef-9001-1-normal";
  const provider = "preview-deadbeef-9001-1-PRV";
  await adapted.d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${provider}','assigned','preview','gate',1)`);
  await adapted.http("POST", "/api/canonical-bookings", {
    body: {
      scheduleGroupId: group,
      customer: { id: "not-the-owned-gate-customer" },
      pets: [{ sourceId: "pet", name: "Pet" }],
      cityId: "maa",
      zoneId: "adyar",
      serviceCode: "pet_sitting",
      provider: { id: provider, name: "Preview sitter", model: "full_time" },
    },
  });

  assert.match(d1Seen[0], new RegExp(`'${provider}'`));
  assert.equal(httpSeen.at(-1).body.provider.id, provider);
  assert.equal(adapted.stats().swarmSeedProviderRewrites, 0);
  assert.equal(adapted.stats().swarmBookingProviderRewrites, 0);
});

test("swarm seed identity follows group_id even after quoted JSON and reordered columns", async () => {
  const seen = [];
  const adapted = adaptCurrentProductContracts({ d1: async (sql) => { seen.push(sql); return []; }, http: async () => ({ status: 418 }) });
  const group = "preview-deadbeef-9001-1-swarm-7";
  const provider = "preview-deadbeef-9001-1-PRV";
  await adapted.d1(`INSERT OR REPLACE INTO scheduling_reservations (explanation_json,id,provider_id,group_id,status) VALUES ('{"note":"owner''s,fixture"}', 'RES-${group}', '${provider}', '${group}', 'reserved')`);
  assert.ok(seen[0].includes(`'${group}-PRV'`));
  assert.ok(seen[0].includes(`'RES-${group}'`), "reservation identity itself is never rewritten");
  assert.ok(seen[0].includes(`'{"note":"owner''s,fixture"}'`), "quoted data remains byte-for-byte intact");
  assert.equal(adapted.stats().swarmSeedProviderRewrites, 1);
});

test("swarm-looking reservation IDs do not rewrite a non-swarm or missing group_id", async () => {
  const seen = [];
  const adapted = adaptCurrentProductContracts({ d1: async (sql) => { seen.push(sql); return []; }, http: async () => ({ status: 418 }) });
  for (const sql of [
    "INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id) VALUES ('preview-x-swarm-1','preview-x-normal','preview-x-PRV')",
    "INSERT OR REPLACE INTO scheduling_reservations (id,provider_id) VALUES ('preview-x-swarm-1','preview-x-PRV')",
  ]) {
    await adapted.d1(sql);
    assert.equal(seen.at(-1), sql);
  }
  assert.equal(adapted.stats().swarmSeedProviderRewrites, 0);
});

test("all 60 swarm reservations survive a real SQLite provider-window uniqueness constraint", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  // Local fixture tables exercise SQLite REPLACE behavior, not a mock of its uniqueness semantics.
  db.exec(`
    CREATE TABLE scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,selected_provider_id TEXT);
    CREATE TABLE scheduling_reservations (
      id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,service_code TEXT,city_id TEXT,zone_id TEXT,
      customer_id TEXT,pet_ids_json TEXT,scheduled_start TEXT,scheduled_end TEXT,capacity_units INTEGER,
      occurrence_number INTEGER,care_mode TEXT,status TEXT,explanation_json TEXT,created_at INTEGER
    );
    CREATE UNIQUE INDEX uq_scheduling_reservations_active_provider_window
      ON scheduling_reservations(provider_id,scheduled_start,scheduled_end)
      WHERE status!='cancelled' AND service_code!='boarding' AND care_mode IS NOT 'overnight';
  `);
  const requests = [];
  const adapted = adaptCurrentProductContracts({
    d1: async (sql) => { db.exec(sql); return []; },
    http: async (method, path, options = {}) => {
      requests.push({ method, path, body: options.body });
      return { status: 418, body: {}, headers: {} };
    },
  });
  const prefix = "preview-deadbeef-9001-1";
  const provider = `${prefix}-PRV`;
  for (let i = 0; i < 60; i++) {
    const group = `${prefix}-swarm-${i}`;
    await adapted.d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,selected_provider_id) VALUES ('${group}','${provider}')`);
    await adapted.d1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${group}','${group}','${provider}','pet_sitting','blr','koramangala','${prefix}-CUS','[]','2027-03-04T09:00:00.000Z','2027-03-04T11:00:00.000Z',1,1,NULL,'reserved','{}',1)`);
    await adapted.http("POST", "/api/canonical-bookings", {
      body: booking({ idempotencyKey: group, scheduleGroupId: group, provider: { id: provider }, customer: { id: "not-the-owned-gate-customer" } }),
    });
  }
  const rows = db.prepare(`SELECT r.group_id,r.provider_id,a.selected_provider_id FROM scheduling_reservations r
    JOIN scheduling_assignment_decisions a ON a.group_id=r.group_id`).all();
  assert.equal(rows.length, 60, "REPLACE must not collapse the 60 valid reservations to one");
  assert.equal(new Set(rows.map((row) => row.provider_id)).size, 60);
  assert.equal(requests.length, 60);
  for (const row of rows) {
    assert.equal(row.provider_id, `${row.group_id}-PRV`);
    assert.equal(row.selected_provider_id, row.provider_id);
    assert.equal(requests.find((request) => request.body.scheduleGroupId === row.group_id).body.provider.id, row.provider_id);
  }
  assert.equal(adapted.stats().swarmSeedProviderRewrites, 120);
  assert.equal(adapted.stats().swarmBookingProviderRewrites, 60);
  // A genuinely duplicated slot must still fail; the fixture adapter cannot weaken this guard.
  assert.throws(() => db.exec(`INSERT INTO scheduling_reservations
    (id,group_id,provider_id,service_code,scheduled_start,scheduled_end,care_mode,status)
    VALUES ('duplicate','duplicate','${prefix}-swarm-0-PRV','pet_sitting','2027-03-04T09:00:00.000Z','2027-03-04T11:00:00.000Z',NULL,'reserved')`), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM scheduling_reservations").get().n, 60);
});
