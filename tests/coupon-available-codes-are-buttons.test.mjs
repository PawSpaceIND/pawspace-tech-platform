/**
 * DEFECT: each available coupon code was rendered as
 *   <button type="button" role="listitem"> ... </button>
 * An explicit role REPLACES the implicit one, so the browser accessibility tree carried these
 * controls as list items, not buttons: getByRole("button") could not find them, and a screen-reader
 * or keyboard user was told an activatable control was a static list item.
 *
 * These tests EXECUTE the real CouponField - its offers fetch runs, the "View N available codes"
 * toggle is really clicked - and then read the accessibility-relevant shape of what it rendered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, all, textOf } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__COUPON_ROLE_DB__");

const { default: CouponField } = await import("../app/mobile-app/coupon-field.tsx");

const OFFERS = [
  { code: "UATCARE100", name: "Care 100", description: "₹100 off your first grooming visit", autoApply: false },
  { code: "UATWELCOME", name: "Welcome", description: "Welcome offer", autoApply: false },
];

function installFetch(quote) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push(href);
    const json = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    if (href.startsWith("/api/customer-offers")) return json({ coupons: OFFERS, autoApply: null });
    if (href.startsWith("/api/coupon-governance")) {
      const body = JSON.parse(init.body);
      return json({ valid: true, code: body.input.code, discount: quote, quoteId: "Q-COUPON-1" });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function openOffers() {
  const fetchStub = installFetch(100);
  const discounts = [];
  const app = mount(CouponField, {
    service: "Grooming", orderValue: 1899, customerId: "E2E-CUS-UI-001",
    onDiscountChange: (discount, code, quoteId) => discounts.push({ discount, code, quoteId }),
  }, { label: "CouponField" });
  await app.settle();
  const toggle = find(app.tree(), (n) => n.type === "button" && /available code/.test(textOf(n)));
  assert.ok(toggle, "the offers toggle is on screen - without it there is nothing to open");
  toggle.props.onClick();
  await app.settle();
  return { app, discounts, ...fetchStub };
}

const listOf = (tree) => find(tree, (n) => n.props?.role === "list");
const offerButtons = (tree) => all(tree, (n) => n.type === "button" && OFFERS.some((offer) => textOf(n).includes(offer.code)));

// ---------------------------------------------------------------------------------------------
test("every available code is an activatable button, not something announced as a list item", async () => {
  const { app, restore } = await openOffers();
  try {
    const buttons = offerButtons(app.tree());
    assert.equal(buttons.length, OFFERS.length, "both codes are on screen - or the assertions below are vacuous");
    for (const node of buttons) {
      assert.equal(node.props.role, undefined, `an explicit role would replace the implicit button role: ${textOf(node)}`);
      assert.equal(node.props.type, "button");
    }
    // And in the markup a browser would actually parse.
    const html = app.html();
    assert.doesNotMatch(html, /<button[^>]*role="listitem"/, "no button may carry role=listitem");
    assert.match(html, /<button[^>]*>.*UATCARE100/s);
  } finally { restore(); }
});

test("the list semantics survive: each button sits inside its own listitem, inside the list", async () => {
  const { app, restore } = await openOffers();
  try {
    const list = listOf(app.tree());
    assert.ok(list, "the group is still announced as a list");
    const items = all(list, (n) => n.props?.role === "listitem");
    assert.equal(items.length, OFFERS.length, "one list item per code");
    for (const item of items) {
      assert.notEqual(item.type, "button", "the listitem must be a wrapper, never the control itself");
      assert.ok(find(item.props.children, (n) => n.type === "button"), "and it wraps a real button");
    }
  } finally { restore(); }
});

test("picking a code still applies it - the role fix changed nothing about what the control does", async () => {
  const { app, discounts, calls, restore } = await openOffers();
  try {
    const first = offerButtons(app.tree()).find((node) => textOf(node).includes("UATCARE100"));
    first.props.onClick();
    await app.settle();
    assert.ok(calls.some((href) => href.startsWith("/api/coupon-governance")), "the governed quote is still requested from the server");
    assert.deepEqual(discounts.at(-1), { discount: 100, code: "UATCARE100", quoteId: "Q-COUPON-1" });
  } finally { restore(); }
});
