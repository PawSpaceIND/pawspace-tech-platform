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
// React loads before the first import of the payment page. On Node 22.16 (the CI runners) with registerHooks, a
// transpiled TSX that is the first module to import both "react/jsx-runtime" and "react" leaves the JSX runtime
// holding React before its exports are populated, and a later server render then fails on undefined React internals.
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const page = read("app/mobile-app/booking-payment-page.tsx");
const flow = read("app/mobile-app/training-flow.tsx");

test("the shared payment page hands a captured payment, and the caller's choice, to one completion step", () => {
  assert.match(page, /returnAfterVerified\?:boolean;/);
  assert.match(page, /onBack,returnAfterVerified=true,stage/, "a caller that says nothing keeps #1120's return");
  assert.match(page, /try\{await completeVerifiedPayment\(\{bookingId,onVerified,returnAfterVerified,onNotified:\(\)=>\{notified\.current=true;\}\}\);\}/);
  assert.match(page, /\},\[bookingId,onVerified,returnAfterVerified\]\);/);
});

// Runs the real completion step with the booking read (fetch) and the browser location stubbed, recording the order.
const BOOKING = "PS-UAT-TRAINING-1";
async function complete(t, { ready = true, onVerified, ...options } = {}) {
  const { completeVerifiedPayment } = await import("../app/mobile-app/booking-payment-page.tsx");
  const events = [], oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); events.push(`read ${url} ${body.action} ${body.bookingId}`); return Response.json({ data: { bookingId: BOOKING, environment: "sandbox", confirmation: { bookingId: BOOKING, ready } } }); };
  globalThis.window = { location: { pathname: "/mobile-app", assign: (href) => events.push(`return ${href}`) } };
  t.after(() => { globalThis.fetch = oldFetch; if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  const outcome = await completeVerifiedPayment({ bookingId: BOOKING, onVerified: onVerified ?? (() => { events.push("next step"); }), onNotified: () => events.push("notified"), ...options })
    .then(() => "done", (problem) => problem.message);
  return { events, outcome };
}
const bookingRead = `read /api/customer-checkout status ${BOOKING}`;

test("a verified payment reads the booking, runs the caller's next step, then returns to the booking by default", async (t) => {
  assert.deepEqual(await complete(t), { outcome: "done", events: [bookingRead, "next step", "notified", `return /mobile-app/booking-confirmation?bookingId=${BOOKING}`] });
  assert.deepEqual(await complete(t, { returnAfterVerified: true }), { outcome: "done", events: [bookingRead, "next step", "notified", `return /mobile-app/booking-confirmation?bookingId=${BOOKING}`] });
});

test("a caller that keeps the customer in its flow gets its next step and no return", async (t) => {
  assert.deepEqual(await complete(t, { returnAfterVerified: false }), { outcome: "done", events: [bookingRead, "next step", "notified"] });
});

test("a booking still synchronizing, or a next step that fails, neither completes nor returns, so confirmation can be retried", async (t) => {
  const syncing = await complete(t, { ready: false, returnAfterVerified: false });
  assert.match(syncing.outcome, /still synchronizing\. Retry confirmation, not payment\./);
  assert.deepEqual(syncing.events, [bookingRead]);
  const failing = await complete(t, { onVerified: () => { throw new Error("next step failed"); } });
  assert.deepEqual(failing, { outcome: "next step failed", events: [bookingRead] });
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

test("web Training and other direct payment callers return to the booking; Stay opens its Care Card", () => {
  const callers = readdirSync(new URL("app/", root), { recursive: true })
    .map((file) => `app/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => /\.tsx?$/.test(file) && file !== "app/mobile-app/booking-payment-page.tsx" && file !== "app/mobile-app/training-flow.tsx")
    .filter((file) => /booking-payment-page/.test(read(file)) && file !== "app/mobile-app/stay-care-payment-gate.tsx");
  assert.ok(callers.includes("app/training/page.tsx"), "the web Training page uses the shared payment page");
  assert.ok(callers.length >= 6, callers.join(", "));
  for (const file of callers) assert.doesNotMatch(read(file), /returnAfterVerified/, `${file} keeps #1120's return`);
  assert.match(read("app/mobile-app/stay-care-payment-gate.tsx"), /<BookingPaymentPage returnAfterVerified=\{false\}/);
});

test("the option changes only what happens after a verified payment, not what the payment step shows", async () => {
  const { default: BookingPaymentPage } = await import("../app/mobile-app/booking-payment-page.tsx");
  const render = (props) => renderToStaticMarkup(React.createElement(BookingPaymentPage, { serviceName: "Dog Training", bookingId: "PS-UAT-TRAINING-1", totalAmount: 12000, amountDueNow: 6000, mode: "split", ...props }));
  const returning = render({}), staying = render({ returnAfterVerified: false });
  assert.equal(staying, returning);
  assert.match(staying.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), /Due now ₹6,000\.00/);
});
