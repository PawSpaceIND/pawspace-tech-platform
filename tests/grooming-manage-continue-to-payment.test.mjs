import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// CUST-L-D05: mobile /grooming/manage?bookingId= for a payment_pending booking had only Refresh
// controls and "Cancellation unavailable" — no way back to payment. A "Continue to payment" control
// now reuses the existing mobile booking-confirmation payment surface for owned payment_pending
// bookings. No cancellation policy is invented here.
installWorkersHooks("__GROOMING_MANAGE_PAY_DB__");

const MODULE = "../app/grooming/manage/grooming-customer-booking.tsx";
async function renderText(props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(MODULE);
  return renderToStaticMarkup(React.createElement(mod.default, props)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("with no bookingId the page still renders its own safe state (non-vacuity anchor)", async () => {
  const text = await renderText({ bookingId: "" });
  assert.match(text, /Open a Grooming booking from your Activity/);
  assert.ok(!text.includes("Continue to payment"));
});

test("a payment_pending booking gets a Continue to payment link to the mobile booking-confirmation payment surface", () => {
  const source = fs.readFileSync(new URL("../app/grooming/manage/grooming-customer-booking.tsx", import.meta.url), "utf8");
  assert.match(source, /booking\.status==="payment_pending"&&<Link href=\{`\/mobile-app\/booking-confirmation\?bookingId=\$\{encodeURIComponent\(booking\.id\)\}`\}>Continue to payment<\/Link>/);
  // Additive, not a replacement: the existing change-policy section (Refresh policy preview,
  // Cancellation unavailable/eligible/needs review) must still be rendered underneath it.
  assert.match(source, /GroomingChangePolicy/);
});
