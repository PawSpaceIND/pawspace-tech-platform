/*
 * Owner decision, 27 Sep 2026, after staging master E2E 36278778677: after a Dog Training payment the customer app
 * stays in its Training flow. A paid Meet & Greet continues to choosing a programme, and a deposit opens the
 * programme dashboard (plan, homework, progress and "Request programme cancellation"). #1120 returns every other
 * verified payment to the booking confirmation, and the web (V2) Training pages keep that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__TRAINING_APP_PAYMENT_DB__");

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const page = read("app/mobile-app/booking-payment-page.tsx");
const flow = read("app/mobile-app/training-flow.tsx");

test("the shared payment page returns to the booking unless its caller keeps the customer in the flow", () => {
  assert.match(page, /returnAfterVerified\?:boolean;/);
  assert.match(page, /onBack,returnAfterVerified=true,stage/, "a caller that says nothing keeps #1120's return");
  assert.match(page, /await onVerified\?\.\(\);notified\.current=true;if\(bookingId&&returnAfterVerified\)returnToBooking\(bookingId\);/, "the caller's next step runs first; the return follows only when asked for");
  assert.match(page, /\},\[bookingId,onVerified,returnAfterVerified\]\);/);
});

test("the app's Training flow stays in place, and its next steps are the programme choice and the dashboard", () => {
  assert.match(flow, /if\(pendingPayment\)return <BookingPaymentPage returnAfterVerified=\{false\} /);
  const start = flow.indexOf('onVerified={()=>{if(pendingPayment.kind==="meet")');
  const handler = flow.slice(start, flow.indexOf("onBack={()=>setPendingPayment(null)}", start));
  assert.ok(start > 0 && handler.length > 0, "the Training payment handler");
  assert.match(handler, /setPendingPayment\(null\);setStage\(2\);/, "a paid Meet & Greet goes on to choosing a programme");
  assert.match(handler, /setPendingPayment\(null\);setConfirmed\(true\);/, "a paid deposit opens the programme dashboard");
  assert.match(flow, /if \(confirmed\)\s*return \(\s*<TrainingDashboard/);
});

test("every other caller of the payment page, the web Training pages included, keeps the return to the booking", () => {
  const callers = readdirSync(new URL("app/", root), { recursive: true })
    .map((file) => `app/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => /\.tsx?$/.test(file) && file !== "app/mobile-app/booking-payment-page.tsx" && file !== "app/mobile-app/training-flow.tsx")
    .filter((file) => /booking-payment-page/.test(read(file)));
  assert.ok(callers.includes("app/training/page.tsx"), "the web Training page uses the shared payment page");
  assert.ok(callers.length >= 6, callers.join(", "));
  for (const file of callers) assert.doesNotMatch(read(file), /returnAfterVerified/, `${file} keeps #1120's return`);
});

test("the option changes only what happens after a verified payment, not what the payment step shows", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: BookingPaymentPage } = await import("../app/mobile-app/booking-payment-page.tsx");
  const render = (props) => renderToStaticMarkup(React.createElement(BookingPaymentPage, { serviceName: "Dog Training", bookingId: "PS-UAT-TRAINING-1", totalAmount: 12000, amountDueNow: 6000, mode: "split", ...props }));
  const returning = render({}), staying = render({ returnAfterVerified: false });
  assert.equal(staying, returning);
  assert.match(staying.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /Due now ₹6,000\.00/);
});
