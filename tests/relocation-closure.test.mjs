/**
 * Relocation CLOSURE — EXECUTED. The lead → documents → quote → payment → transport → delivery
 * lifecycle, run for real, plus the production boundaries the build deliberately does not cross.
 *
 * WHAT THIS FILE USED TO BE. Three tests, every assertion a regex over the source of
 * `lib/relocation-governance.ts`, the route and the pages. "Relocation implements the original
 * lead-to-delivery lifecycle with trackable manual operations" asserted that the milestone names
 * appeared in the file. They appear whether a milestone can be completed, whether completing one
 * moves the case, or whether the checklist gates the quote at all.
 *
 * Each test below drives the real functions against a real SQLite-backed D1 and asserts on the rows
 * they wrote. Requests are built on a NON-PREVIEW origin, because `npm test` runs with
 * PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser holding ["*"].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal } from "./helpers/taxi-harness.mjs";
import { OPS_ORIGIN } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__RELO_DB__", "__RELO_ENV__");

const governance = await import("../lib/relocation-governance.ts");

const CUSTOMER = "CUST-RELO-1";
const AGENT = "relocation.agent@pawspace.test";
const FINANCE = "finance.checker@pawspace.test";
const CHECKLIST = ["vaccination_record", "health_certificate", "identity_document", "travel_authorisation", "crate_confirmation"];
const MILESTONES = ["lead_captured", "documents_review", "quote_issued", "payment_confirmed", "transport_booked", "origin_handover", "in_transit", "destination_handover", "delivery_confirmed"];

const future = (days = 45) => new Date(Date.now() + days * 86_400_000).toISOString();

async function reloWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__RELO_DB__ = db;
  globalThis.__RELO_ENV__ = {};
  await governance.ensureRelocationTables(db);
  return { sqlite, db };
}

const newCase = (db, overrides = {}) => governance.createRelocationCase(db, {
  customerId: CUSTOMER, petName: "Bruno", breed: "Indie", ageYears: 3, sizeClass: "medium",
  travelMode: "air", originCountry: "India", originCity: "Bengaluru",
  destinationCountry: "Germany", destinationCity: "Berlin",
  targetTravelDate: future(), crateRequirement: "IATA 300", ...overrides,
}, AGENT);

const act = (db, caseId, action, extra = {}) => governance.mutateRelocationCase(db, {
  caseId, action, actorId: AGENT, ...extra,
});

/** Verify every document on the checklist, which is what unlocks quoting. */
async function verifyAllDocuments(db, caseId) {
  for (const documentType of CHECKLIST) {
    await act(db, caseId, "register_document", { documentType, objectId: `uat-object-${documentType}` });
    await act(db, caseId, "review_document", { documentType });
  }
}

// ---------------------------------------------------------------------------------------------
test("Relocation runs the lead-to-delivery lifecycle with trackable manual operations", async () => {
  const { db } = await reloWorld();

  // 1. LEAD. A case opens as a lead with a full checklist and milestone board seeded.
  const created = await newCase(db);
  assert.match(created.id, /^RLC-/);
  assert.equal(created.status, "lead");
  assert.equal(created.regulation_status, "manual_verification_required", "regulations are verified by a human, not a feed");
  assert.equal(created.support_status, "none");
  assert.deepEqual(created.documents.map((row) => row.document_type).sort(), [...CHECKLIST].sort());
  for (const doc of created.documents) assert.equal(doc.status, "required");
  assert.deepEqual(created.milestones.map((row) => row.code), MILESTONES, "the whole board exists from the start");
  // Capturing the lead IS the first milestone, so it is already complete; nothing else is.
  const openingBoard = Object.fromEntries(created.milestones.map((row) => [row.code, row.status]));
  assert.equal(openingBoard.lead_captured, "complete");
  for (const code of MILESTONES.filter((row) => row !== "lead_captured")) {
    assert.equal(openingBoard[code], "pending", `${code} is not complete on a brand new case`);
  }
  assert.equal(created.quote, null);
  assert.equal(created.payment, null);

  // 2. QUALIFY. An agent takes ownership and the case moves to documents.
  const qualified = await act(db, created.id, "qualify", { agentId: AGENT });
  assert.equal(qualified.status, "documents_pending");
  assert.equal(qualified.assigned_agent_id, AGENT);

  // 3. DOCUMENTS. A quote cannot be issued until every document is VERIFIED.
  const tooEarly = await refusal(act(db, created.id, "issue_quote", { amount: 120_000, vendorCost: 90_000 }));
  assert.equal(tooEarly?.status, 409);
  assert.match(tooEarly.message, /can only be issued once all documents are verified/);

  await act(db, created.id, "register_document", { documentType: "vaccination_record", objectId: "uat-object-vax" });
  const uploaded = await governance.getRelocationCase(db, created.id);
  assert.equal(uploaded.documents.find((row) => row.document_type === "vaccination_record").status, "uploaded");

  // A review with a note is a rejection, and holds the case in documents_pending.
  const rejected = await act(db, created.id, "review_document", { documentType: "vaccination_record", reviewNote: "Certificate is out of date" });
  assert.equal(rejected.status, "documents_pending");
  const flagged = rejected.documents.find((row) => row.document_type === "vaccination_record");
  assert.equal(flagged.status, "needs_attention");
  assert.equal(flagged.review_note, "Certificate is out of date");

  await verifyAllDocuments(db, created.id);
  const cleared = await governance.getRelocationCase(db, created.id);
  assert.equal(cleared.status, "quote_pending", "the last verification is what unlocks quoting");
  for (const doc of cleared.documents) assert.equal(doc.status, "verified");

  // 4. QUOTE. Priced by an agent, with the margin recorded, and it must be positive.
  const free = await refusal(act(db, created.id, "issue_quote", { amount: 0, vendorCost: 0 }));
  assert.equal(free?.status, 400);
  assert.match(free.message, /Quote amount must be positive/);

  const quoted = await act(db, created.id, "issue_quote", { amount: 120_000, vendorCost: 90_000, validDays: 7 });
  assert.equal(quoted.status, "quote_sent");
  assert.equal(Number(quoted.quote.amount), 120_000);
  assert.equal(Number(quoted.quote.vendor_cost), 90_000);
  assert.equal(Number(quoted.quote.margin), 30_000, "the margin is derived by the server, not submitted");
  assert.equal(quoted.quote.status, "sent");
  assert.ok(Number(quoted.quote.valid_until) > Date.now());

  // 5. ACCEPT. Acceptance raises a payment DUE; it does not take money.
  const accepted = await act(db, created.id, "accept_quote");
  assert.equal(accepted.status, "payment_pending");
  assert.equal(accepted.quote.status, "accepted");
  assert.equal(accepted.payment.status, "due");
  assert.equal(Number(accepted.payment.amount), 120_000, "the amount due is the amount quoted");
  assert.equal(accepted.payment.provider, "internal_uat");
  assert.equal(accepted.payment.payment_reference, null, "no gateway reference is invented at acceptance");

  // 6. PAYMENT and TRANSPORT.
  const paid = await act(db, created.id, "record_payment", { paymentReference: "UAT-RELO-1" });
  assert.equal(paid.status, "transport_ready");
  assert.equal(paid.payment.status, "paid");
  assert.equal(paid.payment.payment_reference, "UAT-RELO-1");

  const vendor = await act(db, created.id, "assign_vendor", { vendorId: "VENDOR-AIRPET-1" });
  assert.equal(vendor.vendor_id, "VENDOR-AIRPET-1");

  // 7. MILESTONES drive the case status through to delivered.
  const badMilestone = await refusal(act(db, created.id, "complete_milestone", { milestoneCode: "teleported" }));
  assert.equal(badMilestone?.status, 400);
  assert.match(badMilestone.message, /Unknown relocation milestone/);

  await act(db, created.id, "complete_milestone", { milestoneCode: "transport_booked", note: "AI 121 booked" });
  const inTransit = await act(db, created.id, "complete_milestone", { milestoneCode: "in_transit" });
  assert.equal(inTransit.status, "in_transit");
  const delivered = await act(db, created.id, "complete_milestone", { milestoneCode: "delivery_confirmed", note: "Handed to owner in Berlin" });
  assert.equal(delivered.status, "delivered");

  const board = Object.fromEntries(delivered.milestones.map((row) => [row.code, row.status]));
  assert.equal(board.transport_booked, "complete");
  assert.equal(board.in_transit, "complete");
  assert.equal(board.delivery_confirmed, "complete");
  assert.equal(board.origin_handover, "pending", "only the milestones actually completed are marked complete");

  // 8. EVERY step left an audit trail against the SAME case.
  const eventTypes = delivered.events.map((row) => row.event_type);
  for (const expected of [
    "lead_captured", "lead_qualified", "document_uploaded", "document_reviewed", "quote_sent",
    "quote_accepted", "payment_confirmed", "vendor_assigned", "milestone_completed",
  ]) {
    assert.ok(eventTypes.includes(expected), `${expected} is on the case timeline`);
  }
  for (const row of delivered.events) assert.equal(row.case_id, created.id);
});

// ---------------------------------------------------------------------------------------------
test("Relocation validates its inputs and its lifecycle preconditions", async () => {
  const { db } = await reloWorld();

  const noPet = await refusal(newCase(db, { petName: "" }));
  assert.equal(noPet?.status, 400);
  assert.match(noPet.message, /Customer, pet, origin and destination are required/);

  const noDestination = await refusal(newCase(db, { destinationCity: "" }));
  assert.equal(noDestination?.status, 400);

  const badMode = await refusal(newCase(db, { travelMode: "teleport" }));
  assert.equal(badMode?.status, 400);
  assert.match(badMode.message, /Unsupported relocation travel mode/);

  const pastDate = await refusal(newCase(db, { targetTravelDate: new Date(Date.now() - 86_400_000).toISOString() }));
  assert.equal(pastDate?.status, 400);
  assert.match(pastDate.message, /target date must be in the future/);

  for (const travelMode of ["air", "road", "sea"]) {
    const ok = await newCase(db, { travelMode });
    assert.equal(ok.travel_mode, travelMode);
  }

  const open = await newCase(db);
  const unknownDoc = await refusal(act(db, open.id, "register_document", { documentType: "birth_certificate" }));
  assert.equal(unknownDoc?.status, 400);
  assert.match(unknownDoc.message, /Unknown relocation document type/);

  const noDocType = await refusal(act(db, open.id, "review_document", {}));
  assert.equal(noDocType?.status, 400);
  assert.match(noDocType.message, /Document type is required/);

  const noVendor = await refusal(act(db, open.id, "assign_vendor", {}));
  assert.equal(noVendor?.status, 400);
  assert.match(noVendor.message, /Vendor ID is required/);

  // A quote cannot be accepted before it exists, or after it has expired.
  const noQuote = await refusal(act(db, open.id, "accept_quote"));
  assert.equal(noQuote?.status, 409);
  assert.match(noQuote.message, /An active relocation quote is required/);

  await verifyAllDocuments(db, open.id);
  await act(db, open.id, "issue_quote", { amount: 50_000, vendorCost: 40_000 });
  await db.prepare("UPDATE relocation_quotes SET valid_until=? WHERE case_id=?").bind(Date.now() - 1000, open.id).run();
  const expired = await refusal(act(db, open.id, "accept_quote"));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /An active relocation quote is required/);

  // Payment cannot be recorded before a quote has been accepted.
  const noPayment = await refusal(act(db, open.id, "record_payment", { paymentReference: "UAT-EARLY" }));
  assert.equal(noPayment?.status, 409);
  assert.match(noPayment.message, /payment request not found/);

  const unsupported = await refusal(act(db, open.id, "invent_a_visa"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported relocation action/);

  const missing = await refusal(act(db, "RLC-NOPE", "qualify"));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Relocation case not found/);
});

// ---------------------------------------------------------------------------------------------
test("Relocation preserves production boundaries for vendor APIs, regulations, documents and money", async () => {
  const { db } = await reloWorld();

  // The readiness contract is explicit about what is NOT connected.
  assert.deepEqual(governance.relocationReadiness, {
    externalVendorApi: false, liveRegulationFeed: false, liveMoney: false,
    productionDocumentStorage: false, manualOperationsTrackable: true,
  });

  const created = await newCase(db);
  assert.equal(created.regulation_status, "manual_verification_required", "no regulation feed decides eligibility");

  // Assigning a vendor records the intent and says plainly that no vendor API was called.
  const vendor = await act(db, created.id, "assign_vendor", { vendorId: "VENDOR-AIRPET-1" });
  const vendorEvent = vendor.events.find((row) => row.event_type === "vendor_assigned");
  assert.equal(vendorEvent.detail.vendorId, "VENDOR-AIRPET-1");
  assert.equal(vendorEvent.detail.externalApiConnected, false);

  // Documents are held by opaque object id, never a URL.
  await act(db, created.id, "register_document", { documentType: "health_certificate", objectId: "uat-object-health-1" });
  const stored = await db.prepare("SELECT object_id FROM relocation_documents WHERE case_id=? AND document_type='health_certificate'").bind(created.id).first();
  assert.equal(stored.object_id, "uat-object-health-1");
  assert.doesNotMatch(String(stored.object_id), /^https?:/);

  // Money: quoting, accepting and paying all say liveMoney false and use the internal UAT provider.
  await verifyAllDocuments(db, created.id);
  const quoted = await act(db, created.id, "issue_quote", { amount: 80_000, vendorCost: 60_000 });
  assert.equal(quoted.events.find((row) => row.event_type === "quote_sent").detail.liveMoney, false);
  const accepted = await act(db, created.id, "accept_quote");
  assert.equal(accepted.events.find((row) => row.event_type === "quote_accepted").detail.liveMoney, false);
  assert.equal(accepted.payment.provider, "internal_uat");
  const paid = await act(db, created.id, "record_payment", { paymentReference: "UAT-RELO-BOUNDARY" });
  assert.equal(paid.events.find((row) => row.event_type === "payment_confirmed").detail.liveMoney, false);

  // Refunds are requested and decided by people; nothing is executed against a gateway.
  const thinRefund = await refusal(act(db, created.id, "request_refund", { refundAmount: 0, reason: "Changed mind" }));
  assert.equal(thinRefund?.status, 400);
  assert.match(thinRefund.message, /Refund amount and reason are required/);
  const noReason = await refusal(act(db, created.id, "request_refund", { refundAmount: 5000 }));
  assert.equal(noReason?.status, 400);

  const nothingPending = await refusal(governance.mutateRelocationCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE, decision: "approved",
  }));
  assert.equal(nothingPending?.status, 409);
  assert.match(nothingPending.message, /No pending relocation refund request/);

  const requested = await act(db, created.id, "request_refund", { refundAmount: 10_000, reason: "Flight cancelled by the airline" });
  assert.equal(requested.refunds.length, 1);
  assert.equal(Number(requested.refunds[0].amount), 10_000);
  assert.equal(requested.refunds[0].status, "requested", "requesting a refund does not approve it");

  const noDecision = await refusal(governance.mutateRelocationCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE,
  }));
  assert.equal(noDecision?.status, 400);
  assert.match(noDecision.message, /Refund decision is required/);

  const resolved = await governance.mutateRelocationCase(db, {
    caseId: created.id, action: "resolve_refund", actorId: FINANCE, decision: "approved", note: "Approved by Finance",
  });
  assert.equal(resolved.refunds[0].status, "approved");
  const refundEvent = resolved.events.find((row) => row.event_type === "refund_updated");
  assert.equal(refundEvent.detail.decision, "approved");
  assert.equal(refundEvent.detail.externalRefundExecution, false, "an approval is a decision, not a payout");

  // Support is a tracked state on the case, not a side channel.
  const supported = await act(db, created.id, "open_support", { reason: "Customer wants a status call" });
  assert.equal(supported.support_status, "open");
});

// ---------------------------------------------------------------------------------------------
test("Relocation reads and the gateway keep customer, agent and finance authority apart", async () => {
  const { db } = await reloWorld();
  const mine = await newCase(db);
  await newCase(db, { customerId: "CUST-RELO-2", petName: "Mia" });

  // Reads are scoped by customer and by status.
  const forMe = await governance.listRelocationCases(db, { customerId: CUSTOMER });
  assert.equal(forMe.length, 1, "a customer sees only their own cases");
  assert.equal(forMe[0].id, mine.id);
  assert.equal((await governance.listRelocationCases(db, {})).length, 2, "the unscoped staff read sees both");
  assert.equal((await governance.listRelocationCases(db, { status: "lead" })).length, 2);
  assert.equal((await governance.listRelocationCases(db, { status: "delivered" })).length, 0);
  assert.equal(await governance.getRelocationCase(db, "RLC-NOPE"), null, "an unknown case reads as null, not a throw");

  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };
  const ask = async (path, body, headers = {}) => {
    const init = body
      ? { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }
      : { headers };
    const decision = await gateway.authorizeApiRequest(new Request(`${OPS_ORIGIN}${path}`, init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };

  // An anonymous caller cannot open or move a relocation case.
  assert.equal(await ask("/api/relocation", { action: "qualify", caseId: mine.id }), 401);
  assert.equal(await ask("/api/relocation"), 401);
});
