import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PTJA-P1-F35 — /food/manage drew a complete order page for an order that does not exist.
//
// MEASURED in a browser at /food/manage?orderId=PS-UAT-FOOD-DOES-NOT-EXIST:
//   "PS-UAT-FOOD-DOES-NOT-EXIST · qty · not set · fulfilment not set / Order truth /
//    Inventory reservation: not set · lot not picked / Dispatch not dispatched ..."
//
// loadCustomerFoodOrder returns [] for an unknown order, so setOrder(rows[0]||null) stores null — and
// the render path had no `if(!order)` branch. Every field went through
// label(v)=String(v||"not set"), so ABSENT was drawn as an order whose fields merely happen to be
// unset. The screen could not tell apart "still loading", "no such order" and "a real order with
// nothing filled in", and it carried a cancellation control while doing so.
//
// The audit's recurring class — unknown or absent treated as a valid state — rendered as a whole page.
//
// Pinned two ways, because react-dom/server renders only the INITIAL state (effects do not run):
//   the state decision is a pure exported function, so every branch including not-found is reachable;
//   the initial render is asserted to show no order detail, which is the browser-visible half.
// ---------------------------------------------------------------------------
installWorkersHooks("__FOOD_NOT_FOUND_DB__");

const MODULE = "../app/food/manage/food-customer-management.tsx";
const ORDER = { id: "PS-UAT-FOOD-REAL", item_name: "Chicken & Rice", quantity: 2, status: "uat_reserved", fulfilment_status: "fulfilment_review_required", events: [] };

async function screen({ orderId, loaded, order, error }) {
  const { resourceScreenState } = await import("../lib/resource-screen-state.ts");
  return resourceScreenState({ id: orderId, loaded, resource: order, error });
}
async function renderText(props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(MODULE);
  return renderToStaticMarkup(React.createElement(mod.default, props)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("P1-N01 an order that does not exist is reported as not found, not drawn as an empty order", async () => {
  assert.equal(await screen({ orderId: "PS-UAT-FOOD-NOPE", loaded: true, order: null, error: "" }), "not-found");
});

test("P1-N02 not-yet-loaded is a distinct state from not-found", async () => {
  // These were the same state before, which is why an absent order looked like a real one.
  assert.equal(await screen({ orderId: "PS-UAT-FOOD-NOPE", loaded: false, order: null, error: "" }), "loading");
});

test("P1-N03 the states that already worked still do", async () => {
  assert.equal(await screen({ orderId: "", loaded: false, order: null, error: "" }), "no-id", "no id at all");
  assert.equal(await screen({ orderId: "  ", loaded: true, order: ORDER, error: "" }), "no-id", "a blank id is no id");
  assert.equal(await screen({ orderId: "PS-UAT-FOOD-REAL", loaded: true, order: ORDER, error: "" }), "ready", "a real order still renders");
  assert.equal(await screen({ orderId: "PS-UAT-FOOD-REAL", loaded: true, order: ORDER, error: "Network down" }), "failed", "an error is not hidden by a stale order");
  assert.equal(await screen({ orderId: "PS-UAT-FOOD-NOPE", loaded: false, order: null, error: "Network down" }), "failed", "nor by still loading");
});

test("P1-N04 the screen shows no order detail before an order has been loaded", async () => {
  // The browser-visible half. react-dom/server runs no effects, so this IS the pre-fetch state.
  const text = await renderText({ orderId: "PS-UAT-FOOD-DOES-NOT-EXIST" });
  for (const fabricated of ["Order truth", "Inventory reservation", "Dispatch", "Delivery payment event", "Request cancellation", "not set"]) {
    assert.ok(!text.includes(fabricated), `an unloaded order must not render "${fabricated}": ${text.slice(0, 200)}`);
  }
});

// NOT pinned here, deliberately. After the first fix the browser still showed "We could not find that
// Food order" followed by "Quality / safety incidents" — a section about an order that does not exist.
// app/food/manage/page.tsx now nests that section inside the order screen so it renders only in the
// ready state. A test for it would be VACUOUS in this harness: the "does not render" half passes even
// against a component that drops children entirely, and the "does render" half needs the ready state,
// which needs effects to have run — the exact limit recorded for the .tsx harness in P1-08. Browser-
// verified instead, and said plainly rather than pinned by an assertion that cannot fail.
test("P1-N05 the empty-orderId screen is unchanged", async () => {
  // Non-vacuity: P1-N04 could be satisfied by rendering nothing at all for every input.
  const text = await renderText({ orderId: "" });
  assert.match(text, /Manage Food order/);
  assert.match(text, /Back to Food/, "and still offers a way out");
});

// --- the mirror failure on the renewal payment screen ------------------------------------------

const PAYMENT = "../app/food/subscription-payment/page.tsx";

async function paymentText() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import(PAYMENT);
  return renderToStaticMarkup(React.createElement(mod.default, {})).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("P1-N06 the renewal payment screen says something when it has no renewal to show", async () => {
  // MEASURED: with no renewalId, and with one that matches nothing, the page rendered its header and
  // then silently nothing — the page a customer reaches from a truncated or expired payment link.
  // (My first probe used ?requestId=, which this page does not read; that is the no-parameter case.)
  const text = await paymentText();
  assert.ok(text.length > 0, "the screen renders");
  assert.match(text, /payment request|renewal/i, "it still identifies itself");
  assert.doesNotMatch(text, /^\s*← Food subscriptions FOOD RENEWAL PAYMENT REQUEST · UAT Payment request\s*$/,
    `a customer must be told why there is nothing here: ${text}`);
  assert.match(text, /could not|no longer|out of date|expired|check the link/i,
    `the screen must explain the absence: ${text}`);
});
