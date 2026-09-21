/*
 * Launch verification repairs for the Grooming partner and customer surfaces, executed end to end
 * against the real routes and a real database.
 *
 *   LP-D01  "Create payment request" died with a 500 when the Razorpay sandbox credentials were
 *           absent, because the link client's `connected:false` reason was rethrown as a bare Error.
 *   LP-N01  A `decline` posted to /api/grooming-lifecycle crashed on `map[action][current]` - that
 *           verb lives on /api/provider-assignment-recovery and has no row in the transition map.
 *   LP-N02  After a decline the partner job list still read "Confirmed" and still offered Accept and
 *           Decline, because the projection reported the BOOKING status for a WORK ORDER that had
 *           moved to reassignment_needed.
 *   LP-N03  The same split told the customer their declined groomer was still assigned.
 *   LP-N19  Re-booking the same slot after that booking completed replayed the finished booking with
 *           a 200 and the same id, so the app said "Your groomer is reserved" about a finished job.
 *
 * Each case drives the production handler and reads the rows back; none of them asserts on source
 * text. Reverting any one of the five repairs turns the matching test red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

const PAYMENT_SANDBOX = "../../app/api/grooming-payment-sandbox/route.ts";
const LIFECYCLE = "../../app/api/grooming-lifecycle/route.ts";
const RECOVERY = "../../app/api/provider-assignment-recovery/route.ts";
const PARTNER_JOBS = "../../app/api/partner-grooming-jobs/route.ts";
const CUSTOMER_SUMMARY = "../../app/api/customer-grooming-summary/route.ts";
const CANONICAL_BOOKINGS = "../../app/api/canonical-bookings/route.ts";

const startInDays = (days) => {
  const start = new Date(Date.now() + days * 86_400_000);
  start.setUTCHours(3, 30, 0, 0);
  return start.toISOString();
};

async function journey(t, { stopAfterCapture = false, suffix = "A" } = {}) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  const result = await runCompletedJourney(ctx, {
    customerId: `LP-CUST-${suffix}`, customerName: "Launch verification parent", phone: `+91990000${suffix === "A" ? "0701" : suffix === "B" ? "0702" : "0703"}`,
    petSourceId: `LP-PET-${suffix}`, petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038",
    latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun",
    groupId: `LP-GROUP-${suffix}`, start: startInDays(3), stopAfterCapture,
  });
  const providerCookie = await sessionCookie(ctx.db, "provider", result.provider.id, `provider:${result.provider.id}`);
  return { ...ctx, result, providerCookie };
}

// ---------------------------------------------------------------------------------------------
test("LP-D01 a pay-after-service payment request refuses in plain words, with no row, when Razorpay sandbox is unconfigured", async (t) => {
  const f = await journey(t, { suffix: "A" });
  const bookingId = f.result.bookingId;

  // The booking is genuinely eligible: served, unpaid, and billed at the door. Only the gateway
  // credential is missing — which is what the UAT runtime actually looks like.
  f.sqlite.prepare("UPDATE booking_payments SET mode='pay_after_service',status='pending',amount_due_now=amount WHERE booking_id=?").run(bookingId);
  assert.equal(String(f.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "completed");
  assert.equal(globalThis.__GROOM_GOLDEN_ENV__.RAZORPAY_KEY_ID_SANDBOX, undefined, "the fixture runtime has no sandbox key, like the environment that produced the 500");

  const raised = await routeCall(PAYMENT_SANDBOX, "POST", "/api/grooming-payment-sandbox", { action: "request_after_service", bookingId }, f.providerCookie);
  assert.equal(raised.status, 503, `configuration must refuse, not crash: ${JSON.stringify(raised.body)}`);
  assert.equal(raised.body.code, "configuration_required");
  assert.match(String(raised.body.error), /not configured/i);
  assert.match(String(raised.body.error), /billing support/i);
  assert.doesNotMatch(String(raised.body.error), /Unable to run Grooming payment sandbox/i, "the groomer must not read a crash");
  assert.doesNotMatch(JSON.stringify(raised.body), /credentials are not configured - payment link/i, "nor the raw gateway sentence");

  // Twice, because the tester tapped twice — and still no half-written request.
  const again = await routeCall(PAYMENT_SANDBOX, "POST", "/api/grooming-payment-sandbox", { action: "request_after_service", bookingId }, f.providerCookie);
  assert.equal(again.status, 503);
  assert.equal(Number(f.sqlite.prepare("SELECT COUNT(*) c FROM post_service_payment_requests WHERE booking_id=?").get(bookingId).c), 0,
    "a refused request must leave no post-service payment row behind");

  // And the read side agrees there is nothing to collect, rather than inventing one.
  const read = await routeCall(PAYMENT_SANDBOX, "GET", `/api/grooming-payment-sandbox?bookingId=${encodeURIComponent(bookingId)}`, null, f.providerCookie);
  assert.equal(read.status, 200);
  assert.equal(read.body.data, null);
});

// ---------------------------------------------------------------------------------------------
test("LP-N01/N02/N03 a declined grooming assignment reads as awaiting reassignment to the provider, the customer and a replayed decline", async (t) => {
  const f = await journey(t, { stopAfterCapture: true, suffix: "B" });
  const bookingId = f.result.bookingId, providerId = f.result.provider.id;

  // A commission assignment, because that is the model the partner app offers Accept and Decline for
  // at all — asserting the buttons are gone for a full-time job would be vacuous.
  f.sqlite.prepare("UPDATE provider_work_orders SET provider_model='commission' WHERE booking_id=?").run(bookingId);
  f.sqlite.prepare("UPDATE provider_capacity_profiles SET provider_model='commission' WHERE id=?").run(providerId);
  // No other groomer is live, so recovery escalates to Operations instead of silently replacing the
  // provider — which is the state the launch pass found and the one both projections mis-reported.
  f.sqlite.prepare("UPDATE provider_capacity_profiles SET live=0 WHERE id<>?").run(providerId);

  const readJob = async () => {
    const listed = await routeCall(PARTNER_JOBS, "GET", `/api/partner-grooming-jobs?providerId=${encodeURIComponent(providerId)}`, null, f.providerCookie);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const found = listed.body.jobs.find((item) => item.bookingId === bookingId);
    assert.ok(found, "the provider's own job must stay listed");
    return found;
  };
  // Both predicates below are the partner app's own (app/partner-app/canonical-grooming-jobs.tsx).
  const offersAccept = (job) => job.status === "confirmed" || job.status === "awaiting_acceptance";
  const offersDecline = (job) => job.providerModel === "commission" && (job.status === "confirmed" || job.workOrderStatus === "awaiting_acceptance");

  const before = await readJob();
  assert.equal(offersAccept(before), true, "before the decline the workspace does offer Accept");
  assert.equal(offersDecline(before), true, "and Decline");

  const declined = await routeCall(RECOVERY, "POST", "/api/provider-assignment-recovery",
    { bookingId, providerId, action: "decline", reason: "Declined in Partner app" }, f.providerCookie);
  assert.ok([200, 202].includes(declined.status), `the decline itself must work: ${declined.status} ${JSON.stringify(declined.body)}`);
  const work = f.sqlite.prepare("SELECT status,provider_id FROM provider_work_orders WHERE booking_id=?").get(bookingId);
  assert.equal(String(work.status), "reassignment_needed", "this test is only meaningful against a reassignment_needed work order");

  // LP-N01: the replayed decline is a governed refusal, never a TypeError behind a 500.
  for (const attempt of ["first", "second"]) {
    const replay = await routeCall(LIFECYCLE, "POST", "/api/grooming-lifecycle", { bookingId, action: "decline" }, f.providerCookie);
    assert.equal(replay.status, 409, `${attempt} decline replay must be a governed conflict: ${replay.status} ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.code, "unsupported_lifecycle_action");
    assert.match(String(replay.body.error), /assignment recovery workflow/i);
    assert.doesNotMatch(String(replay.body.error), /Unable to update grooming lifecycle/i);
  }

  // LP-N02: the provider's own job reads as awaiting reassignment, so the workspace offers neither
  // Accept nor Decline.
  const job = await readJob();
  assert.equal(job.status, "reassignment_needed", "the job must not read as Confirmed after a decline");
  assert.equal(job.workOrderStatus, "reassignment_needed");
  assert.equal(offersAccept(job), false, "Accept job must not be offered for a declined assignment");
  assert.equal(offersDecline(job), false, "Decline job must not be offered for a declined assignment");

  // And the Accept the old projection invited is still refused, so the projection was the only lie.
  const accept = await routeCall(RECOVERY, "POST", "/api/provider-assignment-recovery", { bookingId, providerId, action: "accept" }, f.providerCookie);
  assert.equal(accept.status, 409);

  // LP-N03: the customer is told the truth about the same handover.
  const summary = await routeCall(CUSTOMER_SUMMARY, "GET", `/api/customer-grooming-summary?bookingId=${encodeURIComponent(bookingId)}`, null, f.result.customerCookie);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.data.status, "awaiting_reassignment");
  assert.equal(summary.body.data.awaitingReassignment, true);
  assert.deepEqual(summary.body.data.provider, { id: null, name: null, model: null }, "the declined groomer is not claimed as assigned");
  assert.equal(summary.body.data.tracking.state, "not_started");
  assert.equal(String(f.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "confirmed",
    "the customer's booking and slot are deliberately preserved; only the claim about the provider changed");
});

// ---------------------------------------------------------------------------------------------
test("LP-N19 re-booking a slot whose booking already completed is refused in words, not replayed as reserved", async (t) => {
  const f = await journey(t, { suffix: "C" });
  const bookingId = f.result.bookingId;
  assert.equal(String(f.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "completed");

  // Identical inputs produce an identical request fingerprint, which is exactly how the customer app
  // re-submits the same pet, package and slot.
  const rebooked = await routeCall(CANONICAL_BOOKINGS, "POST", "/api/canonical-bookings", f.result.bookingPayload, f.result.customerCookie);
  assert.equal(rebooked.status, 409, `a finished booking must not be replayed as a live one: ${rebooked.status} ${JSON.stringify(rebooked.body)}`);
  assert.equal(rebooked.body.code, "booking_request_already_closed");
  assert.equal(rebooked.body.bookingId, bookingId);
  assert.equal(rebooked.body.bookingStatus, "completed");
  assert.match(String(rebooked.body.error), /already completed/i);
  assert.equal(rebooked.body.data, undefined, "no booking payload, so nothing can render as reserved");
  assert.equal(Number(f.sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings WHERE customer_id=?").get(`LP-CUST-C`).c), 1,
    "and the refusal creates nothing either");

  // The non-vacuity control: while the booking is still open, the same request still replays 200 with
  // the same booking, which is the duplicate-submit protection this must not have cost.
  f.sqlite.prepare("UPDATE canonical_bookings SET status='confirmed' WHERE id=?").run(bookingId);
  const live = await routeCall(CANONICAL_BOOKINGS, "POST", "/api/canonical-bookings", f.result.bookingPayload, f.result.customerCookie);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.data.bookingId, bookingId);
  assert.equal(live.body.data.duplicatePrevented, true);

  // A cancelled booking is closed too, and reads as cancelled rather than as a reservation.
  f.sqlite.prepare("UPDATE canonical_bookings SET status='cancelled' WHERE id=?").run(bookingId);
  const afterCancel = await routeCall(CANONICAL_BOOKINGS, "POST", "/api/canonical-bookings", f.result.bookingPayload, f.result.customerCookie);
  assert.equal(afterCancel.status, 409);
  assert.equal(afterCancel.body.bookingStatus, "cancelled");
});
