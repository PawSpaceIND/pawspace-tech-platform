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

// PAY-03 / PAY-05: once a split's first instalment is captured the page offered the balance as a fresh "Due now".
test("after the first instalment the payment surface shows the balance with what was paid, never the deposit again", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: BookingPaymentPage } = await import("../app/mobile-app/booking-payment-page.tsx");
  const text = (props) => renderToStaticMarkup(React.createElement(BookingPaymentPage, { serviceName: "Luxury Stay", bookingId: "B1", totalAmount: 3495, amountDueNow: 1747.5, mode: "split_50_50", ...props })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const deposit = text({});
  assert.match(deposit, /Due now ₹1,747\.50/);
  assert.match(deposit, /Pay securely · ₹1,747\.50/);
  const balance = text({ stage: "balance", paidAmount: 1747.5, balanceDueAt: Date.parse("2027-02-09T04:30:00.000Z") });
  assert.doesNotMatch(balance, /Due now|Pay securely/, balance);
  assert.match(balance, /Paid so far ₹1,747\.50/);
  assert.match(balance, /Balance · due by .*₹1,747\.50/);
  assert.match(balance, /Pay balance · ₹1,747\.50/);
});

test("the booking page labels a captured split's balance and never offers a Pet Taxi balance before drop-off", () => {
  const source = fs.readFileSync(new URL("../app/v2/booking/page.tsx", import.meta.url), "utf8");
  assert.match(source, /paymentStage==="outstanding_balance"/);
  assert.match(source, /balancePayableNow!==false/, "payment is offered only when the balance may be paid now");
  assert.match(source, /stage=\{balanceStage\?"balance":undefined\}/);
  assert.match(source, /requested after drop-off/);
});
