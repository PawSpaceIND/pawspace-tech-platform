/*
 * R3-A7 — three P3 defects the round-3 audit reported, each one the screen telling the customer less
 * than it knows.
 *
 *  · Manage screens rendered service times with a bare toLocaleString — the READER'S timezone — while
 *    every booking flow labels its times "IST". The same session showed a different clock time
 *    depending on where it was opened, with nothing on screen to say so.
 *  · The Grooming review showed "−₹285" and "₹1,614" and never the ₹1,899 those came off, so the
 *    customer could see a saving but not check it.
 *  · Fresh Food blocked late and far from the cause: deselecting the default-selected pet left every
 *    Continue enabled and only failed at step 4/5, four screens from the control that caused it.
 *
 * Each test executes the real component and reads what the customer would see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, all, textOf, screenText, memoryStorage } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3A_CLARITY_DB__", "__R3A_CLARITY_ENV__");

const { default: WalkingCustomerManagement } = await import("../app/walking/manage/walking-customer-management.tsx");
const { default: FoodFlow } = await import("../app/mobile-app/food-flow.tsx");
const { default: GroomingFlow } = await import("../app/mobile-app/grooming-flow.tsx");
const { customerServiceTimeLabel } = await import("../lib/customer-activity.ts");

const CUSTOMER = { customerId: "CUS-R3A-A7", customerName: "R3A Customer", phone: "9100000197" };
/** 09:30 UTC = 15:00 IST. Chosen so an IST rendering and a UTC one cannot coincide. */
const WALK_START = "2026-11-12T09:30:00.000Z";
const WALK_END = "2026-11-12T10:00:00.000Z";

function browserWorld(t) {
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  const priorDocument = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  globalThis.window = {
    localStorage: memoryStorage(), sessionStorage: memoryStorage(),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    location: { search: "", href: "http://localhost/" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
    // A real interval would keep this process alive; these components only use one to refresh a clock.
    setInterval: () => 0, clearInterval: () => {}, prompt: () => "",
    history: { state: null, pushState() {}, replaceState() {}, back() {}, go() {} },
  };
  t.after(() => { globalThis.window = priorWindow; globalThis.fetch = priorFetch; globalThis.document = priorDocument; });
}

test("a manage screen says which clock its times are on, and it is Asia/Kolkata", async (t) => {
  browserWorld(t);
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/walking-lifecycle")) {
      return Response.json({ data: [{ id: "BKG-A7", booking_id: "BKG-A7", status: "assigned", ownerCare: null, sessions: [
        { id: "WS-1", occurrence_number: 1, status: "scheduled", scheduled_start: WALK_START, scheduled_end: WALK_END, handover_status: "pending", completion_status: "pending" },
      ] }] });
    }
    return Response.json({ data: [] });
  };
  const screen = mount(WalkingCustomerManagement, { bookingId: "BKG-A7" }, { label: "WalkingCustomerManagement" });
  await screen.settle();
  const text = screenText(screen.html());

  assert.match(text, /IST/, "a service time with no timezone label is a different time for every reader");
  const istRendering = new Date(WALK_START).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  assert.ok(text.includes(istRendering), `the walk must be rendered in IST (${istRendering}); screen said: ${text.slice(0, 400)}`);
  // …and the shared helper the screen uses produces exactly that, labelled.
  assert.equal(customerServiceTimeLabel(WALK_START), `${istRendering} IST`);
  assert.equal(customerServiceTimeLabel("not a date"), "time not set", "an unreadable instant must not be drawn as a real time");
});

test("Fresh Food refuses at the step that caused it, not four screens later", async (t) => {
  browserWorld(t);
  const CATALOGUE = [{ sku: "DOG-CHICKEN-1", name: "Chicken & Rice \u00b7 500g", pet_type: "dog", unit_price: 450, max_qty_per_order: 5, uat_available_units: 10, currency: "INR" }];
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/customer-account")) return Response.json({ data: { customerId: CUSTOMER.customerId, addresses: [], bookings: [], pets: [
      { id: "PET-A7-DOG", sourceId: "pet-a7-dog", name: "Bruno", species: "dog", breed: null, vaccinationStatus: "verified", ageYears: 3, weightKg: 20, profile: null },
    ] } });
    if (href.startsWith("/api/service-zone")) return Response.json({ data: { zone: { zoneId: "blr-east", zoneName: "East Bengaluru", description: "", color: "#000", serviceAvailable: true }, assignment: { pincode: "560038", zoneId: "blr-east", cityId: "blr", city: "Bengaluru", area: "Indiranagar" } } });
    return Response.json({ data: { items: CATALOGUE, catalogue: CATALOGUE } });
  };

  const screen = mount(FoodFlow, { customer: CUSTOMER }, { label: "FoodFlow" });
  await screen.settle();

  // Reach the state the auditor was in: coverage confirmed and food in the cart.
  find(screen.tree(), (n) => n.type === "input").props.onChange({ target: { value: "560038" } });
  await screen.settle();
  find(screen.tree(), (n) => n.type === "button" && /Check service area/.test(textOf(n))).props.onClick();
  await screen.settle();
  const addFood = find(screen.tree(), (n) => n.type === "button" && textOf(n).trim() === "Add");
  assert.ok(addFood, `the catalogue must offer an Add control; buttons: ${JSON.stringify(all(screen.tree(), (n) => n.type === "button").map((n) => textOf(n).trim()))}`);
  addFood.props.onClick();
  await screen.settle();

  const continueButton = () => {
    const node = find(screen.tree(), (n) => n.type === "button" && /Review cart|Add food to continue|Choose the pet this food is for/.test(textOf(n)));
    assert.ok(node, "step 1 must offer a continue control");
    return node;
  };
  // Non-vacuity first: with the default pet selected and food in the cart, step 1 is completable.
  assert.equal(continueButton().props.disabled, false, "a complete step 1 must not be blocked");
  assert.match(textOf(continueButton()), /Review cart/);

  // The whole defect, in one click: deselect the default-selected pet.
  find(screen.tree(), (n) => n.type === "button" && textOf(n).includes("Bruno")).props.onClick();
  await screen.settle();

  assert.equal(continueButton().props.disabled, true,
    "with no pet selected, step 1 must not let the customer walk three more screens before refusing");
  assert.equal(textOf(continueButton()).trim(), "Choose the pet this food is for",
    "and the button has to name what is missing");
  assert.match(screenText(screen.html()), /Select at least one pet before ordering Fresh Food/,
    "the same sentence the submit used to produce, shown next to the control that caused it");

  // Re-selecting releases it, so the block is the pet selection and nothing else.
  find(screen.tree(), (n) => n.type === "button" && textOf(n).includes("Bruno")).props.onClick();
  await screen.settle();
  assert.equal(continueButton().props.disabled, false);
  assert.match(textOf(continueButton()), /Review cart/);
});

test("the Grooming review shows the price a coupon was taken off, not only the saving", async (t) => {
  browserWorld(t);
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith("/api/customer-account")) return Response.json({ data: { customerId: CUSTOMER.customerId, addresses: [], bookings: [], pets: [
      { id: "PET-A7-GROOM", sourceId: "pet-a7-groom", name: "Bruno", species: "dog", breed: null, vaccinationStatus: "verified", ageYears: 3, weightKg: 20, profile: null },
    ] } });
    return Response.json({ data: null }, { status: 404 });
  };

  const screen = mount(GroomingFlow, { customer: CUSTOMER }, { label: "GroomingFlow" });
  await screen.settle();

  const click = (label) => {
    const node = find(screen.tree(), (n) => n.type === "button" && textOf(n).trim() === label);
    assert.ok(node, `a button labelled "${label}" must be on screen; saw ${JSON.stringify(all(screen.tree(), (n) => n.type === "button").map((n) => textOf(n).trim()).slice(0, 20))}`);
    node.props.onClick();
  };
  // The customer's only dog is selected by default; walk the wizard with its own controls.
  click("Choose a package");
  await screen.settle();
  click("Choose address and requested time");
  await screen.settle();
  const toReview = find(screen.tree(), (n) => n.type === "button" && /Review booking|Verify service address/.test(textOf(n)));
  assert.ok(toReview, "the slot step must offer a way forward");
  toReview.props.onClick();
  await screen.settle();

  const beforeCoupon = screenText(screen.html());
  assert.match(beforeCoupon, /Total incl\. all charges/, `the review screen must be open; saw: ${beforeCoupon.slice(0, 300)}`);
  assert.doesNotMatch(beforeCoupon, /Price before coupon/, "with no coupon there is no discounted-from price to show");

  // Apply a coupon through the REAL CouponField callback the review screen hands it.
  const coupon = find(screen.tree(), (n) => typeof n.props?.onDiscountChange === "function");
  assert.ok(coupon, "the review screen must offer the governed coupon field");
  const orderValue = Number(coupon.props.orderValue);
  assert.ok(orderValue > 0, "the coupon field is priced against a real order value");
  coupon.props.onDiscountChange(285, "R3A285", "CQ-R3A");
  await screen.settle();

  const text = screenText(screen.html());
  const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
  assert.match(text, /Price before coupon/, "a saving with nothing to subtract it from is not checkable");
  assert.ok(text.includes(money(orderValue)), `the review must show the ${money(orderValue)} the coupon came off; saw: ${text.slice(-400)}`);
  assert.ok(text.includes(money(285)), "and the saving itself");
  assert.ok(text.includes(money(orderValue - 285)), "and the total the two produce");
});
