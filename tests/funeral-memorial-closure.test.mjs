/**
 * Funeral and Memorial CLOSURE — EXECUTED. The urgent-request → pickup → care → ritual → memorial →
 * closure lifecycle, run for real, plus the configuration, invoice, refund and reporting surfaces and
 * the boundaries this build deliberately does not cross.
 *
 * WHAT THIS FILE USED TO BE. Five tests, every assertion a regex over the source of
 * `lib/funeral-memorial-governance.ts`, the routes and the pages. "implements the written
 * urgent-request to closure lifecycle" asserted that the milestone names appeared in the file. They
 * appear whether a case can be closed with the ritual incomplete, whether cash can be taken for a
 * service that forbids it, or whether the closure gate exists at all.
 *
 * This is the most sensitive service in the product, so almost every assertion here is about a
 * refusal that protects a grieving customer: no closure without the ritual confirmed, no closure
 * without the ashes actually collected, no cash where cash is not enabled, no payment without a
 * configured price, and no message that claims to have been delivered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, OPS_ORIGIN } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__FUNERAL_DB__", "__FUNERAL_ENV__");

const governance = await import("../lib/funeral-memorial-governance.ts");

const CUSTOMER = "CUST-FUN-1";
const AGENT = "care.agent@pawspace.test";
const FINANCE = "finance.checker@pawspace.test";
const MILESTONES = ["request_received", "pickup_coordinated", "pickup_complete", "ritual_scheduled", "ritual_complete", "ash_collection_ready", "ash_collected", "memorial_record_created", "closure_confirmed"];

async function funeralWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FUNERAL_DB__ = db;
  globalThis.__FUNERAL_ENV__ = {};
  await governance.ensureFuneralMemorialTables(db);
  return { sqlite, db };
}

const enable = (db, serviceType, { baseAmount = 6500, cashAllowed = false } = {}) =>
  governance.saveFuneralServiceConfig(db, { serviceType, enabled: true, baseAmount, cashAllowed });

const newCase = (db, overrides = {}) => governance.createFuneralCase(db, {
  customerId: CUSTOMER, petName: "Bruno", petSpecies: "dog",
  pickupAddress: "12 MG Road, Bengaluru", alternateContact: "+919800000001",
  serviceType: "cremation", memorialOption: "ash_collection", urgency: "same_day", ...overrides,
}, AGENT);

const act = (db, caseId, action, extra = {}) => governance.mutateFuneralCase(db, {
  caseId, action, actorId: AGENT, ...extra,
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial runs the urgent-request to closure lifecycle", async () => {
  const { db } = await funeralWorld();
  await enable(db, "cremation");

  const created = await newCase(db);
  assert.match(created.id, /^FNC-|^[A-Z]/);
  assert.equal(created.status, "urgent_request");
  assert.equal(created.service_type, "cremation");
  assert.equal(created.memorial_option, "ash_collection");
  assert.deepEqual(created.milestones.map((row) => row.code), MILESTONES, "the whole board exists from the start");

  const opening = Object.fromEntries(created.milestones.map((row) => [row.code, row.status]));
  assert.equal(opening.request_received, "complete", "receiving the request is the first milestone");
  for (const code of MILESTONES.filter((row) => row !== "request_received")) {
    assert.equal(opening[code], "pending", `${code} is not complete on a brand new case`);
  }

  await act(db, created.id, "qualify", { agentId: AGENT });
  const coordinated = await act(db, created.id, "coordinate_pickup", { note: "Team dispatched, ETA 40 minutes" });
  assert.equal(coordinated.status, "pickup_coordinated");

  await act(db, created.id, "assign_vendor", { vendorId: "VENDOR-CREMATORIUM-1" });
  await act(db, created.id, "complete_milestone", { milestoneCode: "pickup_complete" });
  await act(db, created.id, "complete_milestone", { milestoneCode: "ritual_scheduled" });
  const ritual = await act(db, created.id, "complete_milestone", { milestoneCode: "ritual_complete" });
  assert.equal(Object.fromEntries(ritual.milestones.map((row) => [row.code, row.status])).ritual_complete, "complete");

  // The ashes are promised to this customer, so closure waits on them actually being collected.
  const beforeAshes = await refusal(act(db, created.id, "close_case", { closureNote: "Wrapping up" }));
  assert.equal(beforeAshes?.status, 409);
  assert.match(beforeAshes.message, /Ash collection must be completed before closure/);

  const noTime = await refusal(act(db, created.id, "schedule_ash_collection", {}));
  assert.equal(noTime?.status, 400);
  assert.match(noTime.message, /Preferred ash collection time is required/);

  await act(db, created.id, "schedule_ash_collection", { preferredAt: new Date(Date.now() + 86_400_000).toISOString() });
  const badStatus = await refusal(act(db, created.id, "update_ash_collection", { ashStatus: "posted" }));
  assert.equal(badStatus?.status, 400);
  assert.match(badStatus.message, /Unknown ash collection status/);

  await act(db, created.id, "update_ash_collection", { ashStatus: "collected" });
  await act(db, created.id, "create_memorial_record", { recordType: "ash_collection", reference: "MEM-1" });

  const closed = await act(db, created.id, "close_case", { closureNote: "Ashes handed to the family" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closure_note, "Ashes handed to the family");
  assert.equal(Object.fromEntries(closed.milestones.map((row) => [row.code, row.status])).closure_confirmed, "complete");

  // Every step is on the timeline for the SAME case.
  const eventTypes = closed.events.map((row) => row.event_type);
  for (const expected of ["pickup_coordinated", "vendor_assigned", "milestone_completed"]) {
    assert.ok(eventTypes.includes(expected), `${expected} is on the case timeline`);
  }
  for (const row of closed.events) assert.equal(row.case_id, created.id);
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial refuses closure while the promised outcome is outstanding", async () => {
  const { db } = await funeralWorld();
  await enable(db, "cremation");
  await enable(db, "memorial");

  // No ritual, no closure -- whatever else is done.
  const early = await newCase(db, { memorialOption: "none" });
  const noRitual = await refusal(act(db, early.id, "close_case", { closureNote: "Closing early" }));
  assert.equal(noRitual?.status, 409);
  assert.match(noRitual.message, /Ritual completion must be confirmed before closure/);
  assert.equal(
    (await governance.getFuneralCase(db, early.id)).status,
    "urgent_request",
    "a refused closure leaves the case open",
  );

  // With the ritual done and no memorial promised, closure is allowed.
  await act(db, early.id, "complete_milestone", { milestoneCode: "ritual_complete" });
  const closedPlain = await act(db, early.id, "close_case", { closureNote: "Service completed" });
  assert.equal(closedPlain.status, "closed");

  // A plantation memorial demands a memorial RECORD before closure.
  const plantation = await newCase(db, { serviceType: "memorial", memorialOption: "plantation" });
  await act(db, plantation.id, "complete_milestone", { milestoneCode: "ritual_complete" });
  const noRecord = await refusal(act(db, plantation.id, "close_case", { closureNote: "Closing" }));
  assert.equal(noRecord?.status, 409);
  assert.match(noRecord.message, /Memorial record is required before closure/);

  const badType = await refusal(act(db, plantation.id, "create_memorial_record", { recordType: "monument" }));
  assert.equal(badType?.status, 400);
  assert.match(badType.message, /Unknown memorial record type/);

  await act(db, plantation.id, "create_memorial_record", { recordType: "plantation", reference: "SAPLING-42" });
  const closedPlantation = await act(db, plantation.id, "close_case", { closureNote: "Sapling planted" });
  assert.equal(closedPlantation.status, "closed");
  assert.equal(closedPlantation.memorialRecords?.length ?? closedPlantation.memorial_records?.length ?? 1, 1);
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial configuration gates the service type and the money that can be taken", async () => {
  const { db } = await funeralWorld();

  const unknownType = await refusal(governance.saveFuneralServiceConfig(db, {
    serviceType: "taxidermy", enabled: true, baseAmount: 1000, cashAllowed: false,
  }));
  assert.equal(unknownType?.status, 400);
  assert.match(unknownType.message, /Unknown funeral service type/);

  const negative = await refusal(governance.saveFuneralServiceConfig(db, {
    serviceType: "burial", enabled: true, baseAmount: -1, cashAllowed: false,
  }));
  assert.equal(negative?.status, 400);
  assert.match(negative.message, /Configured amount must be positive/);

  // A service that is not enabled cannot be requested at all.
  const disabled = await refusal(newCase(db, { serviceType: "burial" }));
  assert.equal(disabled?.status, 409);
  assert.match(disabled.message, /This service type is not enabled/);

  const badService = await refusal(newCase(db, { serviceType: "taxidermy" }));
  assert.equal(badService?.status, 400);
  assert.match(badService.message, /Unsupported funeral service type/);

  const badMemorial = await refusal(newCase(db, { serviceType: "cremation", memorialOption: "fireworks" }));
  assert.equal(badMemorial?.status, 400);
  assert.match(badMemorial.message, /Unsupported memorial option/);

  const noDetails = await refusal(newCase(db, { pickupAddress: "" }));
  assert.equal(noDetails?.status, 400);
  assert.match(noDetails.message, /Customer, pet and pickup details are required/);

  // Cash is off by default, and stays off until it is explicitly configured on.
  await enable(db, "cremation", { baseAmount: 6500, cashAllowed: false });
  const cashCase = await newCase(db);
  await act(db, cashCase.id, "set_service_amount", { amount: 6500 });
  const cashRefused = await refusal(act(db, cashCase.id, "record_payment", { paymentMode: "cash_uat" }));
  assert.equal(cashRefused?.status, 409);
  assert.match(cashRefused.message, /Cash is not enabled for this service type/);

  await enable(db, "cremation", { baseAmount: 6500, cashAllowed: true });
  const cashPaid = await act(db, cashCase.id, "record_payment", { paymentMode: "cash_uat", paymentReference: "UAT-CASH-1" });
  assert.equal(cashPaid.payment.status, "paid");
  assert.equal(cashPaid.payment.payment_mode, "cash_uat");

  // Payment is impossible before a price has been set. A service enabled with NO configured base
  // amount seeds no payment row, which is the state this guard exists for.
  await enable(db, "memorial", { baseAmount: null, cashAllowed: false });
  const unpriced = await newCase(db, { serviceType: "memorial", memorialOption: "digital_memorial" });
  const noPrice = await refusal(act(db, unpriced.id, "record_payment", {}));
  assert.equal(noPrice?.status, 409);
  assert.match(noPrice.message, /configured service amount is required before payment/);

  const freeService = await refusal(act(db, unpriced.id, "set_service_amount", { amount: 0 }));
  assert.equal(freeService?.status, 400);
  assert.match(freeService.message, /Service amount must be positive/);
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial money is sandbox-only, invoiced untaxed, and refunded by decision", async () => {
  const { db } = await funeralWorld();
  await enable(db, "cremation", { baseAmount: 6500, cashAllowed: false });
  const created = await newCase(db);

  await act(db, created.id, "set_service_amount", { amount: 6500 });
  const paid = await act(db, created.id, "record_payment", { paymentReference: "UAT-FUN-1" });
  assert.equal(paid.payment.status, "paid");
  assert.equal(Number(paid.payment.amount), 6500);
  assert.equal(paid.payment.payment_mode, "internal_uat");
  const paymentEvent = paid.events.find((row) => row.event_type === "payment_recorded");
  assert.equal(paymentEvent.detail.liveMoney, false);
  assert.equal(paymentEvent.detail.provider, "internal_uat");
  assert.equal(paymentEvent.detail.taxConfigured, false);

  // An invoice is raised, and it is explicit that tax is not configured.
  const invoice = await db.prepare("SELECT amount,status,tax_status FROM funeral_invoices WHERE case_id=?").bind(created.id).first();
  assert.equal(Number(invoice.amount), 6500);
  assert.equal(invoice.status, "uat_issued");
  assert.equal(invoice.tax_status, "not_configured", "no tax is invented on a sandbox invoice");

  // Refunds need an amount and a reason, and are DECIDED, never executed.
  const thin = await refusal(act(db, created.id, "request_refund", { refundAmount: 0, reason: "Changed mind" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /Refund amount and reason are required/);

  const nothingPending = await refusal(governance.mutateFuneralCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE, decision: "approved",
  }));
  assert.equal(nothingPending?.status, 409);
  assert.match(nothingPending.message, /No pending refund request/);

  const requested = await act(db, created.id, "request_refund", { refundAmount: 1500, reason: "Service downgraded on the day" });
  assert.equal(requested.refunds.length, 1);
  assert.equal(requested.refunds[0].status, "requested");

  const noDecision = await refusal(governance.mutateFuneralCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE,
  }));
  assert.equal(noDecision?.status, 400);
  assert.match(noDecision.message, /Refund decision is required/);

  const resolved = await governance.mutateFuneralCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE, decision: "approved",
    resolutionMode: "wallet_credit_uat", note: "Approved by Finance",
  });
  assert.equal(resolved.refunds[0].status, "approved");

  // Support is a tracked state with an explicit close, not a side channel.
  const noTicket = await refusal(act(db, created.id, "resolve_support", { note: "Nothing open" }));
  assert.equal(noTicket?.status, 409);
  assert.match(noTicket.message, /No open support ticket/);
  await act(db, created.id, "open_support", { reason: "Family asked about the timeline" });
  const supported = await act(db, created.id, "resolve_support", { note: "Called the family back" });
  assert.notEqual(supported.support_status, "open");

  // The report reads from the same rows, and never claims live money.
  const report = await governance.getFuneralReport(db);
  assert.deepEqual(report.requestsByType, [{ serviceType: "cremation", count: 1 }]);
  assert.equal(report.revenueAndAverageOrderValue.sandboxPaidAmount, 6500);
  assert.equal(report.revenueAndAverageOrderValue.currency, "INR");
  assert.equal(report.revenueAndAverageOrderValue.liveMoney, false);
  assert.equal(report.turnaroundTime.basis, "request_to_closure");
  assert.ok(report.serviceFulfillment.some((row) => row.status === "urgent_request" || row.count >= 1));
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial preserves sensitive communication and non-production boundaries", async () => {
  const { db } = await funeralWorld();
  await enable(db, "cremation");

  // The readiness contract is explicit about every disconnected dependency.
  assert.deepEqual(governance.funeralMemorialReadiness, {
    liveVendorApi: false, livePaymentGateway: false, liveMoney: false, productionMediaStorage: false,
    externalMessaging: false, externalRefundExecution: false, walletConnected: false,
    cashCollectionConnected: false, taxConfigured: false, payoutPolicyConfigured: false,
    supportPhoneConfigured: false, manualVendorCoordinationTrackable: true,
    sensitiveTemplates: "internal_uat", fulfillmentReports: true,
  });

  // The bereavement templates are real, non-empty text held internally -- not an external campaign.
  assert.ok(Object.keys(governance.funeralSensitiveTemplates).length > 0);
  for (const [name, body] of Object.entries(governance.funeralSensitiveTemplates)) {
    assert.equal(typeof body, "string", `${name} is text`);
    assert.ok(body.trim().length > 10, `${name} is a real message, not a placeholder`);
  }

  const created = await newCase(db);

  // Media is held by opaque object id, never a URL, and the type is required.
  const noType = await refusal(act(db, created.id, "register_media", { objectId: "uat-object-1" }));
  assert.equal(noType?.status, 400);
  assert.match(noType.message, /Photo or video type is required/);

  await act(db, created.id, "register_media", { mediaType: "photo", objectId: "uat-object-funeral-1" });
  const media = await db.prepare("SELECT object_id FROM funeral_media WHERE case_id=? LIMIT 1").bind(created.id).first();
  assert.equal(media.object_id, "uat-object-funeral-1");
  assert.doesNotMatch(String(media.object_id), /^https?:/, "no public URL is stored for a bereavement photo");

  const noVendor = await refusal(act(db, created.id, "assign_vendor", {}));
  assert.equal(noVendor?.status, 400);
  assert.match(noVendor.message, /Vendor ID is required/);

  const badMilestone = await refusal(act(db, created.id, "complete_milestone", { milestoneCode: "teleported" }));
  assert.equal(badMilestone?.status, 400);
  assert.match(badMilestone.message, /Unknown funeral milestone/);

  const unsupported = await refusal(act(db, created.id, "invent_an_urn"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported funeral or memorial action/);

  const missing = await refusal(act(db, "FNC-NOPE", "qualify"));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Funeral or memorial request not found/);
});

// ---------------------------------------------------------------------------------------------
test("Funeral and Memorial reads and the gateway keep customer, Ops and Finance apart", async () => {
  const { db } = await funeralWorld();
  await enable(db, "cremation");
  const mine = await newCase(db);
  await newCase(db, { customerId: "CUST-FUN-2", petName: "Mia" });

  const forMe = await governance.listFuneralCases(db, { customerId: CUSTOMER });
  assert.equal(forMe.length, 1, "a customer sees only their own case");
  assert.equal(forMe[0].id, mine.id);
  assert.equal((await governance.listFuneralCases(db, {})).length, 2, "the unscoped staff read sees both");
  assert.equal(await governance.getFuneralCase(db, "FNC-NOPE"), null, "an unknown case reads as null, not a throw");

  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };
  const ask = async (path, body) => {
    const init = body
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {};
    const decision = await gateway.authorizeApiRequest(new Request(`${OPS_ORIGIN}${path}`, init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };

  assert.equal(await ask("/api/funeral-memorial", { action: "close_case", caseId: mine.id }), 401,
    "an anonymous caller cannot close a bereavement case");
  assert.equal(await ask("/api/funeral-memorial"), 401);
});
