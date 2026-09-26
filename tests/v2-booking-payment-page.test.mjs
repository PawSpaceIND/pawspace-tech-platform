import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// CUST-L-D04: /v2/booking?bookingId= ("View booking & payment" from /v2/activity) used to not exist at
// all — the booking record, its status and its Manage link had no owned surface independent of the
// Razorpay gateway. This pins the page's safe initial state (react-dom/server renders no effects, so
// this is genuinely the pre-fetch render a browser shows first) and the wiring that a browser test
// cannot reach without effects running: the owned read, the Manage link and the gateway message
// rendering ALONGSIDE the booking card rather than instead of it.
installWorkersHooks("__V2_BOOKING_PAGE_DB__");

const MODULE = "../app/v2/booking/page.tsx";
async function renderText() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(MODULE);
  return renderToStaticMarkup(React.createElement(mod.default, {})).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("with no bookingId the page tells the customer to open a booking from Activity, and fabricates nothing", async () => {
  const text = await renderText();
  assert.match(text, /Open a booking from your Activity/);
  assert.match(text, /Your bookings/);
  for (const fabricated of ["Booking reference", "Manage service", "Pay securely", "due now"]) {
    assert.ok(!text.includes(fabricated), `an unopened booking must not render "${fabricated}": ${text.slice(0, 200)}`);
  }
});

test("the page reads the owned, gateway-independent booking projection and renders its own Manage link", () => {
  const source = fs.readFileSync(new URL("../app/v2/booking/page.tsx", import.meta.url), "utf8");
  assert.match(source, /loadCustomerConfirmationProjection/, "must read the customer-owned booking projection");
  assert.match(source, /customerBookingManageHref/, "must derive the service Manage link from the owned booking");
  // The booking card renders from the owned projection, and the payment surface is its SIBLING: a
  // gateway refusal shows up beside the booking, it can never replace it. That is the defect this
  // page exists to prevent (CUST-L-D04), so the order of the two is the thing worth pinning.
  const cardIndex = source.indexOf("Manage service");
  const paymentIndex = source.indexOf("<BookingPaymentPage");
  assert.ok(cardIndex >= 0, "the booking card must carry the Manage link");
  assert.ok(paymentIndex > cardIndex, "the payment surface must render after the booking card, not instead of it");
  // The only whole-page error state is a failure to load the booking itself, and it offers a retry.
  assert.match(source, /error\?<section[^>]*><p role="alert">\{error\}<\/p><button onClick=\{\(\)=>setAttempt/,
    "a load failure must be retryable and must not be produced by payment state");
  assert.ok(!/Razorpay|checkout is not configured/.test(source), "the page must not hard-code a gateway message");
});

test("/v2/activity links each booking to its owned booking & payment page", () => {
  const source = fs.readFileSync(new URL("../app/v2/activity/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\/v2\/booking\?bookingId=\$\{encodeURIComponent\(x\.id\)\}/);
  assert.match(source, /View booking & payment/);
});

test("the V2 training recovery banner links to the owned booking & payment page (CUST-L-D11)", () => {
  const source = fs.readFileSync(new URL("../app/training/page.tsx", import.meta.url), "utf8");
  assert.match(source, /useQueryParameter\("bookingId"\)/);
  assert.match(source, /routeScope==="v2"&&recoveryBookingId/, "the recovery banner is scoped to the V2 route");
  // The link is built by bookingRecordHref, which sends the V2 route scope to /v2/booking (and legacy /training
  // to its own mobile-app confirmation page).
  assert.match(source, /href=\{bookingRecordHref\(recoveryBookingId\)\}/);
  assert.match(source, /bookingRecordHref=\(bookingId:string\)=>routeScope==="v2"\?`\/v2\/booking\?bookingId=\$\{encodeURIComponent\(bookingId\)\}`/);
});

// QA: a V2 Training customer had no way to ask for a new session time or a programme cancellation - "Manage service"
// opened a payment-return page. These render the manage section from a loaded programme, as the browser first shows it.
const MANAGE = "../app/v2/booking/training-manage.tsx";
const trainingSession = (n, status) => ({ id: `TS-${n}`, programme_id: "TP-1", booking_id: "B1", sequence_no: n, provider_id: "train_kiran", scheduled_start: `2026-10-0${n}T04:30:00.000Z`, scheduled_end: `2026-10-0${n}T05:30:00.000Z`, status, attendance_json: "{}", homework_json: "{}", progress_json: "{}", evidence_json: "[]", started_at: null, completed_at: null });
const trainingRecord = (statuses, programme = {}) => ({ programme: { id: "TP-1", booking_id: "B1", provider_id: "train_kiran", plan_code: "obedience-starter", plan_name: "Starter Plan", status: "scheduled", total_sessions: statuses.length, completed_sessions: 0, no_show_sessions: 0, cancelled_sessions: 0, meet_booking_id: null, pricing_snapshot_json: "{}", ...programme }, sessions: statuses.map((status, index) => trainingSession(index + 1, status)), events: [] });
async function renderManage(record, inactive = false) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(MANAGE);
  return renderToStaticMarkup(React.createElement(mod.default, { bookingId: "B1", record, inactive, onRescheduled() {} })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("an open Training programme offers a new time for its next unlocked session and a cancellation review", async () => {
  const text = await renderManage(trainingRecord(["scheduled", "locked", "locked"]));
  assert.match(text, /Change or cancel your programme/);
  assert.match(text, /Next session 1 · 1 Oct, 10:00 am IST\. Only your next upcoming session can be rescheduled, before it starts\./);
  assert.match(text, /Request reschedule/);
  assert.match(text, /Request programme cancellation \/ refund review/);
  // Later sessions unlock one at a time, so the section never offers one of them.
  assert.doesNotMatch(text, /Next session [23]/);
});

test("a session already awaiting a new time, or already under way, is not offered again", async () => {
  const pending = await renderManage(trainingRecord(["completed", "reschedule_requested", "locked"], { status: "in_progress" }));
  assert.match(pending, /Session 2 · 2 Oct, 10:00 am IST: you asked for a new time\. Our team will contact you to confirm it\./);
  assert.doesNotMatch(pending, /Request reschedule/);
  assert.match(pending, /Request programme cancellation \/ refund review/, "a cancellation review stays available while the programme is open");
  const started = await renderManage(trainingRecord(["completed", "in_session", "locked"], { status: "in_progress" }));
  assert.match(started, /No session can be rescheduled right now\. Only your next upcoming session can be rescheduled, before it starts\./);
  assert.doesNotMatch(started, /Request reschedule/);
});

test("a closed programme or inactive booking offers no requests, and an assessment is named as one", async () => {
  for (const status of ["completed", "completed_with_exceptions", "cancelled"]) assert.equal(await renderManage(trainingRecord(["completed"], { status })), "", status);
  assert.equal(await renderManage(trainingRecord(["scheduled", "locked"]), true), "");
  const assessment = await renderManage(trainingRecord(["scheduled"], { plan_code: "trainer-meet-greet" }));
  assert.match(assessment, /Change or cancel your assessment/);
  assert.match(assessment, /Request assessment cancellation \/ refund review/);
});

test("a cancellation outcome is told in customer words with its reference, never as a raw case status", async () => {
  const { trainingCancellationNotice } = await import(MANAGE);
  assert.equal(trainingCancellationNotice("blocked_policy_configuration", "TCAN-1", false), "Your cancellation request has been sent. PawSpace will review it and confirm any refund for unused sessions before your programme changes. Reference: TCAN-1.");
  assert.match(trainingCancellationNotice("calculated", "TCAN-1", true), /^Your cancellation request is already with our team\./);
  assert.match(trainingCancellationNotice("rejected", "TCAN-1", true), /not approved/);
  assert.match(trainingCancellationNotice("refund_completed_sandbox", "TCAN-1", true), /^Your cancellation has been approved\./);
  for (const status of ["blocked_policy_configuration", "calculated_outstanding_review", "approved_refund_ready", "refund_processing_sandbox", "refund_completed_sandbox", "rejected"]) {
    assert.doesNotMatch(trainingCancellationNotice(status, "TCAN-1", false), /policy|configuration|sandbox|finance|canonical|_/i, status);
  }
});

test("the V2 booking page manages Training in place and keeps the payment-return page for a pending payment only", () => {
  const page = fs.readFileSync(new URL("../app/v2/booking/page.tsx", import.meta.url), "utf8");
  assert.match(page, /customerBookingManageHref\(\{[^}]*\},"v2"\)/, "the V2 page asks for the V2 manage route");
  assert.match(page, /manage\.startsWith\("\/v2\/booking\?"\)\?<a href="#training-sessions">Manage service<\/a>/, "Training's Manage link stays on this page");
  const sessions = fs.readFileSync(new URL("../app/v2/booking/training-sessions.tsx", import.meta.url), "utf8");
  assert.match(sessions, /<section id="training-sessions"/);
  assert.match(sessions, /record&&<TrainingManage bookingId=\{bookingId\} record=\{record\} inactive=\{inactive\}/);
  const manage = fs.readFileSync(new URL("../app/v2/booking/training-manage.tsx", import.meta.url), "utf8");
  assert.match(manage, /requestTrainingSessionReschedule\(\{bookingId,sessionId:next\.id,reason:text,scheduledStart:next\.scheduled_start\}\)/);
  assert.match(manage, /requestTrainingCancellation\(\{bookingId,reason:text\}\)/);
  assert.doesNotMatch(manage, /fetch\(|window\.prompt/, "requests go through the shared client, with the reason typed on the page");
  const confirmation = fs.readFileSync(new URL("../app/mobile-app/booking-confirmation/booking-confirmation-view.tsx", import.meta.url), "utf8");
  assert.match(confirmation, /customerBookingManageHref\(\{[^}]*\}, props\.routeScope\)/, "the V2 payment-return page links Training to its manage page");
});

test("a reschedule request is keyed to the session's current slot: a retry is deduplicated, a moved session can be asked again", async () => {
  const { requestTrainingSessionReschedule } = await import("../lib/training-cancellation-client.ts");
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ data: { status: "reschedule_requested", caseId: "TSR-1", duplicatePrevented: false } }); };
  try {
    for (const scheduledStart of ["2026-10-01T04:30:00.000Z", "2026-10-01T04:30:00.000Z", "2026-10-04T04:30:00.000Z", undefined]) await requestTrainingSessionReschedule({ bookingId: "B1", sessionId: "TS-1", reason: "family trip conflicts", scheduledStart });
  } finally { globalThis.fetch = original; }
  assert.ok(calls.every(call => call.url === "/api/training-customer-session-change" && call.body.action === "request_reschedule" && call.body.bookingId === "B1" && call.body.sessionId === "TS-1"));
  assert.deepEqual(calls.map(call => call.body.idempotencyKey), ["training-customer-reschedule:TS-1:2026-10-01T04:30:00.000Z", "training-customer-reschedule:TS-1:2026-10-01T04:30:00.000Z", "training-customer-reschedule:TS-1:2026-10-04T04:30:00.000Z", "training-customer-reschedule:TS-1"]);
});
