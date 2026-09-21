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
  // The gateway refusal (checkoutState.message on phase "error") must render ALONGSIDE the booking
  // card, never gate whether the card itself renders — the exact defect this page exists to fix.
  const bookingCardIndex = source.indexOf("aria-label=\"Booking details\"");
  const checkoutMessageIndex = source.indexOf("checkoutState.message &&");
  assert.ok(bookingCardIndex >= 0 && checkoutMessageIndex >= 0 && checkoutMessageIndex > bookingCardIndex,
    "the gateway message must be inside the same booking-details section as the booking data, not a replacement for it");
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
  assert.match(source, /\/v2\/booking\?bookingId=\$\{encodeURIComponent\(recoveryBookingId\)\}/);
});
