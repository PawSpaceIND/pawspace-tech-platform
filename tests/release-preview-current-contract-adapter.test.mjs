import test from "node:test";
import assert from "node:assert/strict";
import { adaptCurrentProductContracts } from "./e2e/release-preview-gate.mjs";

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

  // The customer booker must keep bookings.view. Giving it bookings.manage bypasses
  // requireCustomerOwnership and invalidates the wrong-owner 403 probe.
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
  assert.ok(quoteCall, "a valid booking must obtain the deployed server quote");
  assert.ok(captureCall, "the quote must be captured through the deployed sandbox payment route");
  assert.equal(captureCall.options.headers["x-payment-capture-key"].startsWith("preview-gate-"), true);
  assert.equal(canonical.options.body.zoneId, "blr-east");
  assert.equal(canonical.options.body.packageCode, "sitting-visit-60");
  assert.equal(canonical.options.body.packageName, "Home Visit");
  assert.equal(canonical.options.body.totalAmount, 399);
  assert.equal(canonical.options.body.amountDueNow, 399);
  assert.equal(canonical.options.body.pricing.sittingQuoteId, "SQ-1");
  assert.equal(canonical.options.body.payment.status, "captured");

  // Historical replay uses the already-prepared quote identity. It must not create a second quote,
  // even when the payload now contains an invalid source-id type: the product replay lookup happens
  // before new-booking identity validation.
  await adapted.http("POST", "/api/canonical-bookings", {
    headers: { cookie }, body: { ...booking(), pets: [{ sourceId: 7, name: "Bruno" }] },
  });
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);
  const replay = calls.filter((call) => call.path === "/api/canonical-bookings").at(-1);
  assert.equal(replay.options.body.pricing.sittingQuoteId, "SQ-1");

  // A NEW malformed payload is not pre-authorized by creating commercial state for it.
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
  const stats = adapted.stats();
  assert.equal(stats.quoteAttempts, 1);
  assert.equal(stats.quoteFailures, 0);
  assert.equal(stats.captureAttempts, 1);
  assert.equal(stats.captureFailures, 1);
  assert.equal(stats.captureFailureStatuses["403"], 1);
  assert.match(stats.firstPreparationFailure, /^capture:status=403:error=PAYMENT_CAPTURE_REPLAY$/);
});
