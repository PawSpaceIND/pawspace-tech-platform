import test from "node:test";
import assert from "node:assert/strict";
import { adaptCurrentProductContracts } from "./e2e/release-preview-gate.mjs";

test("current preview adapter reaches governed Sitting confirmation without weakening guards", async () => {
  const sql = [];
  const calls = [];
  const baseD1 = async (statement) => { sql.push(statement); return []; };
  const baseHttp = async (method, path, options = {}) => {
    calls.push({ method, path, options });
    if (path === "/api/staging-login") {
      return { status: 200, body: { ok: true }, headers: { "set-cookie": `ps=${options.body.email}; Path=/` } };
    }
    if (path === "/api/sitting-commercial") {
      return { status: 201, body: { data: {
        quoteId: "SQ-1", packageCode: "sitting-visit-60", packageName: "Home Visit",
        totalAmount: 399, amountDueNow: 399, paymentMode: "prepaid",
      } }, headers: {} };
    }
    if (path === "/api/sitting-payment-sandbox") return { status: 201, body: { data: { status: "captured" } }, headers: {} };
    if (path === "/api/canonical-bookings") return { status: 201, body: { data: { bookingId: "BK-1" } }, headers: {} };
    return { status: 404, body: null, headers: {} };
  };

  const adapted = adaptCurrentProductContracts({ http: baseHttp, d1: baseD1 });
  await adapted.d1("INSERT OR REPLACE INTO role_definitions (code,permissions_json) VALUES ('preview_viewer','[\"bookings.view\"]')");
  assert.match(sql.at(-1), /bookings\.manage/);
  assert.doesNotMatch(sql.at(-1), /bookings\.view/);

  await adapted.d1("INSERT OR REPLACE INTO scheduling_reservations (id,service_code,city_id,zone_id) VALUES ('R','pet_sitting','blr','koramangala')");
  assert.match(sql.at(-1), /'blr','blr-east'/);

  await adapted.http("POST", "/api/staging-login", { body: { email: "preview-booker@pawspace.test", code: "x" } });
  const booking = {
    idempotencyKey: "preview-1-ik", scheduleGroupId: "preview-1-sg",
    customer: { id: "preview-1-CUS", name: "Preview", primaryPhone: "+919000000900" },
    pets: [{ sourceId: "acct-1", name: "Bruno" }], cityId: "blr", zoneId: "koramangala",
    serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
    scheduledStart: "2027-03-04T09:00:00.000Z", scheduledEnd: "2027-03-04T11:00:00.000Z",
    provider: { id: "preview-PRV", name: "Preview sitter", model: "full_time" },
    totalAmount: 1349, amountDueNow: 1349,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "preview" },
    pricing: { discount: 0 },
  };
  const cookie = "ps=preview-booker@pawspace.test";
  await adapted.http("POST", "/api/canonical-bookings", { headers: { cookie }, body: booking });

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
    headers: { cookie }, body: { ...booking, pets: [{ sourceId: 7, name: "Bruno" }] },
  });
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);
  const replay = calls.filter((call) => call.path === "/api/canonical-bookings").at(-1);
  assert.equal(replay.options.body.pricing.sittingQuoteId, "SQ-1");

  // A NEW malformed payload is not pre-authorized by creating commercial state for it.
  await adapted.http("POST", "/api/canonical-bookings", {
    headers: { cookie },
    body: { ...booking, idempotencyKey: "preview-bad-ik", scheduleGroupId: "preview-bad-sg", pets: [{ sourceId: 7, name: "Seven" }] },
  });
  assert.equal(calls.filter((call) => call.path === "/api/sitting-commercial").length, 1);

  const stats = adapted.stats();
  assert.equal(stats.permissionRewrites, 1);
  assert.equal(stats.zoneRewrites, 1);
  assert.equal(stats.quotePreparations, 1);
  assert.equal(stats.quotePreparationFailures, 0);
});
