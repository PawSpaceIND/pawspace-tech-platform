/**
 * Round-2 staging, Boarding customer screens (executed, not source-matched):
 *
 * BRD-01  The Care Card's extras (Pickup & drop, Three walks, Medication support, 1-hour play time, Grooming add-on,
 *         Training add-on) were listed on the Care Card and under "Care benefits" on Review, but the bill was only
 *         "Priya & Dev · 2 nights ₹1,398 | 1 additional pet ₹1,398 | Booking total ₹2,796": nothing priced them and
 *         nothing said they were not included. No add-on price exists (canonical bookings refuse add-ons outside
 *         Grooming), so every screen now says they are requests to the host, not part of the price.
 * BRD-02  An unpaid reservation's manage page showed "CANONICAL BOARDING STAY ... Awaiting Host Acceptance ... Payment
 *         status is tracked separately on the canonical booking payment record" and no way to pay.
 * BRD-10  "Request extension" was disabled before host acceptance with no reason.
 *
 * The lib modules run directly; the components render with react-dom/server from the props they are given.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOARDING_HONESTY_DB__");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { boardingCareDraft } = await import("../lib/boarding-customer-care.ts");
const requests = await import("../lib/boarding-host-requests.ts");
const view = await import("../lib/boarding-customer-stay-view.ts");
const { BoardingStaySummary, BoardingHostRequests } = await import("../app/mobile-app/boarding-customer-stay-panel.tsx");
const { default: StayCarePaymentGate } = await import("../app/mobile-app/stay-care-payment-gate.tsx");
const { SittingBookingStatus } = await import("../app/mobile-app/sitting-customer-panel.tsx");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const JARGON = /canonical|governed|Awaiting Host Acceptance|tracked separately|commercial quote required/i;

const EXTRAS = ["Pickup & drop", "Three walks", "Medication support", "1-hour play time", "Grooming add-on", "Training add-on"];

test("BRD-01: the Care Card's extras are requests to the host, not part of the price, wherever they are shown", () => {
  const plan = boardingCareDraft({ vet: "Dr Rao", emergencyContact: "Asha" }, ["Senior care"], EXTRAS, "Pet food from home");
  assert.deepEqual(requests.hostRequestsFromCarePlan(plan), EXTRAS, "the manage page reads back what the Care Card saved");
  assert.deepEqual(requests.hostRequestsFromCarePlan(boardingCareDraft({}, [], [], "")), []);
  assert.deepEqual(requests.hostRequestsFromCarePlan(undefined), []);
  assert.equal(requests.hostRequestsReviewValue(EXTRAS), "Pickup & drop · Three walks · Medication support · 1-hour play time · Grooming add-on · Training add-on - requests, not included in this price");
  assert.equal(requests.hostRequestsReviewValue([]), "None");
  assert.equal(requests.hostRequestsExcludedNote(["Pickup & drop", "Three walks"]), "Not included in this total: Pickup & drop, Three walks. Your host confirms any extra charge before it applies.");
  assert.equal(requests.hostRequestsExcludedNote([]), null);
  assert.match(requests.HOST_REQUESTS_NOTE, /not part of your booking price.*host confirms .*extra charge.*before it applies/);

  // The manage page.
  const manage = text(renderToStaticMarkup(React.createElement(BoardingHostRequests, { plan })));
  for (const shown of ["REQUESTS FOR YOUR HOST", "Not included in the price", ...EXTRAS, requests.HOST_REQUESTS_NOTE]) assert.ok(manage.includes(shown), `manage page: missing "${shown}" in ${manage}`);
  assert.equal(renderToStaticMarkup(React.createElement(BoardingHostRequests, { plan: { specialInstructions: "Crate at night" } })), "", "no requests, no section");

  // The payment step, before and while the care instructions are saved.
  const payment = { bookingId: "PS-UAT-B2", serviceName: "Boarding", total: 2796, dueNow: 2796, mode: "prepaid" };
  const gate = text(renderToStaticMarkup(React.createElement(StayCarePaymentGate, { mode: "boarding", carePlan: plan, payment, hostRequests: EXTRAS, onVerified() {} })));
  assert.ok(gate.includes(`Not included in this payment: ${EXTRAS.join(", ")}. Your host confirms any extra charge before it applies.`), gate);
  const plain = text(renderToStaticMarkup(React.createElement(StayCarePaymentGate, { mode: "boarding", carePlan: plan, payment, onVerified() {} })));
  assert.doesNotMatch(plain, /Not included/);

  // The Care Card and Review use the same wording (the steps past Plan cannot be reached by a server render).
  const flow = read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /<b>\{HOST_REQUESTS_TITLE\}<\/b><span>\{HOST_REQUESTS_NOT_INCLUDED\}<\/span><\/div><p className=\{styles\.hint\}>\{HOST_REQUESTS_NOTE\}<\/p>/);
  assert.match(flow, /\{HOST_REQUESTS_TITLE\}<b>\{hostRequestsReviewValue\(selectedBenefits\)\}<\/b>/);
  assert.match(flow, /<p>\{hostRequestsExcludedNote\(selectedBenefits\)\}<\/p>/);
  assert.match(flow, /hostRequests=\{mode==="boarding"\?selectedBenefits:\[\]\}/);
  assert.doesNotMatch(flow, /Care benefits|Subject to host agreement/);
});

const stayAt = (overrides) => ({
  id: "BSTAY-1", booking_id: "PS-UAT-MUIOLB6P-81A0", customer_id: "C1", host_provider_id: "host_priya_dev", provider_name: "Priya & Dev",
  city_id: "blr", zone_id: "blr-east", package_code: "boarding-24h", check_in_at: "2026-11-22T05:30:00.000Z", check_out_at: "2026-11-24T05:30:00.000Z",
  billed_units: 2, pet_count: 1, status: "awaiting_host_acceptance", care_plan_status: "ready", check_in_status: "pending", check_out_status: "pending",
  extension_status: "none", booking_status: "payment_pending", payment_status: "created", amount_due_now: 2796, total_amount: 2796, events: [], ...overrides,
});
const summary = (stay, routeScope = "v2") => renderToStaticMarkup(React.createElement(BoardingStaySummary, { stay, caregiverName: "Host name unavailable", routeScope }));

test("BRD-02: an unpaid stay says Payment pending and links to the booking's payment page, in the customer's words", () => {
  const html = summary(stayAt({}));
  const shown = text(html);
  assert.match(shown, /^BOARDING STAY · PS-UAT-MUIOLB6P-81A0 Payment pending Pay ₹2,796\.00 to send this stay to your host\. Your host can accept it once payment is complete\. Host: Priya & Dev\./);
  assert.match(html, /<a[^>]*href="\/v2\/booking\?bookingId=PS-UAT-MUIOLB6P-81A0"[^>]*>Pay ₹2,796\.00<\/a>/);
  assert.doesNotMatch(shown, JARGON);
  // The legacy route resumes payment on the confirmation page.
  assert.match(summary(stayAt({}), "legacy"), /href="\/mobile-app\/booking-confirmation\?bookingId=PS-UAT-MUIOLB6P-81A0&amp;payment=resume"/);
  // A 50/50 split's first instalment, to the paisa.
  assert.match(text(summary(stayAt({ payment_mode: "split_50_50", amount_due_now: 1747.5, total_amount: 3495 }))), /Pay ₹1,747\.50 to send this stay/);
  // An unpaid booking whose payment row says pending is still pending, and a missing amount still offers the payment page.
  assert.match(text(summary(stayAt({ booking_status: undefined, payment_status: "pending", amount_due_now: undefined }))), /Payment pending Complete your payment to send this stay to your host/);
});

test("BRD-02: a paid, cancelled or expired stay is never shown as payment pending, and no status reads as jargon", () => {
  const paid = text(summary(stayAt({ booking_status: "confirmed", payment_status: "captured" })));
  assert.match(paid, /^BOARDING STAY · PS-UAT-MUIOLB6P-81A0 Waiting for your host Your host still needs to accept this stay\. Host: Priya & Dev\..*Booking and payment details$/);
  assert.doesNotMatch(paid, /Payment pending|Pay ₹/);
  for (const [overrides, headline] of [
    [{ status: "cancelled", booking_status: "cancelled" }, "Cancelled"],
    [{ booking_status: "cancelled" }, "Cancelled"],
    [{ status: "confirmed", booking_status: "confirmed", payment_status: "captured" }, "Confirmed"],
    [{ status: "in_progress", booking_status: "in_progress", payment_status: "captured" }, "Checked in"],
    [{ status: "recovery_pending", booking_status: "confirmed", payment_status: "captured" }, "Finding you another host"],
    [{ status: "completed", booking_status: "completed", payment_status: "captured" }, "Completed"],
  ]) {
    const stay = stayAt(overrides);
    assert.equal(view.boardingStayPaymentDue(stay), null, JSON.stringify(overrides));
    assert.equal(view.boardingStayHeadline(stay), headline);
    const shown = text(summary(stay));
    assert.doesNotMatch(shown, /Payment pending/);
    assert.doesNotMatch(shown, JARGON, shown);
  }
  // The stay status card after payment reads the same helpers, and neither card infers payment from the stay status.
  const status = read("app/mobile-app/boarding-customer-stay-status.tsx"), panel = read("app/mobile-app/boarding-customer-stay-panel.tsx");
  for (const source of [status, panel]) assert.doesNotMatch(source, /CANONICAL BOARDING|canonical stay|canonical care plan|canonical ledger|governed quote/);
  assert.equal(view.boardingRequestStatusText("commercial_quote_required"), "Waiting for PawSpace to price it");
});

test("BRD-10: Request extension says why it is closed before the host accepts", () => {
  assert.equal(view.boardingExtensionClosedReason({ status: "awaiting_host_acceptance" }), "Extensions open once your host accepts the stay.");
  assert.equal(view.boardingExtensionClosedReason({ status: "recovery_pending" }), "Extensions open once your new host is confirmed.");
  assert.equal(view.boardingExtensionClosedReason({ status: "completed" }), "This stay has ended, so it can't be extended.");
  assert.equal(view.boardingExtensionClosedReason({ status: "confirmed" }), null);
  assert.equal(view.boardingExtensionClosedReason({ status: "in_progress" }), null);
  const panel = read("app/mobile-app/boarding-customer-stay-panel.tsx");
  assert.match(panel, /extensionClosed=boardingExtensionClosedReason\(stay\)/);
  assert.match(panel, /<span>STAY EXTENSION<\/span><h4>No automatic charge or date change<\/h4>\{extensionClosed&&<p className=\{styles\.hint\}>\{extensionClosed\}<\/p>\}/);
  assert.match(panel, /disabled=\{busy==="extension"\|\|!requestedEnd\|\|Boolean\(extensionClosed\)\}/);
});

test("an unpaid Pet Sitting booking's manage page also says Payment pending and links to its payment step", () => {
  const status = (props) => renderToStaticMarkup(React.createElement(SittingBookingStatus, { bookingId: "PS-UAT-SIT-1", ...props }));
  const unpaid = status({ status: "payment_pending", routeScope: "v2" });
  assert.equal(text(unpaid), "Payment pending Complete the payment to send this booking to your sitter. Complete payment");
  assert.match(unpaid, /<a[^>]*href="\/v2\/booking\?bookingId=PS-UAT-SIT-1"[^>]*>Complete payment<\/a>/);
  assert.match(status({ status: "payment_pending" }), /href="\/mobile-app\/booking-confirmation\?bookingId=PS-UAT-SIT-1&amp;payment=resume"/);
  assert.equal(status({ status: "assigned", routeScope: "v2" }), "<p>assigned</p>", "a paid booking keeps its status and no payment link");
});
