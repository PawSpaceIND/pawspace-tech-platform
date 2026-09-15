/**
 * DEFECT: /grooming never offered the customer's saved default service address; /sitting and
 * /boarding do.
 *
 * On all five reported grooming runs, step 3 showed only an empty "Address Line 1 * / Address Line 2
 * / Verify service address", while /sitting and /boarding open with "Your location 221B Baker
 * Lane, ... / Change Address". Boarding and Sitting mount StayAddress, which reads the default
 * address from /api/customer-account and checks it against the live service zone
 * (lib/stay-saved-address.ts). Grooming mounts a bare AddressPicker, so a customer with a saved
 * default had to retype it for every grooming booking - and retyping is exactly what defeats address
 * dedupe and mints duplicate rows.
 *
 * These tests EXECUTE both real components. First the /grooming page runs its effects for real, then
 * the REAL AddressPicker is mounted against the same browser session the page just wrote to, so what
 * is asserted is what step 3 puts in front of the customer - not an internal value.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, memoryStorage } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__GROOMING_SAVED_ADDRESS_DB__");

const { default: GroomingPage } = await import("../app/grooming/page.tsx");
const { default: AddressPicker, SELECTED_SERVICE_ADDRESS_KEY } = await import("../app/mobile-app/address-picker.tsx");
const { defaultStayAddress } = await import("../lib/stay-saved-address.ts");

const CUSTOMER = { customerId: "E2E-CUS-UI-001", customerName: "UAT Customer", phone: "9000000001" };
const SAVED = { id: "ADDR-1", label: "Home", line1: "221B Baker Lane", line2: "Flat 4", area: "Koramangala", city: "Bengaluru", postalCode: "560034", isDefault: true };
const OTHER = { ...SAVED, id: "ADDR-2", label: "Office", line1: "12 Church Street", line2: null, isDefault: false };
const ZONE = { zoneId: "blr-south", zoneName: "Bengaluru South", description: "South zone", color: "#01261F", serviceAvailable: true };

function installBrowser(session = {}) {
  const sessionStore = memoryStorage(session);
  const localStore = memoryStorage({ pawspace_customer: JSON.stringify(CUSTOMER) });
  const previous = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage };
  const listeners = new Map();
  globalThis.sessionStorage = sessionStore;
  globalThis.localStorage = localStore;
  globalThis.window = {
    localStorage: localStore, sessionStorage: sessionStore,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  return { sessionStore, restore: () => { globalThis.window = previous.window; globalThis.sessionStorage = previous.sessionStorage; globalThis.localStorage = previous.localStorage; } };
}

function installFetch({ addresses, serviceAvailable = true }) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seen.push(href);
    const json = (data, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (href.startsWith("/api/identity-session")) return json({ subjectType: "customer", subjectId: CUSTOMER.customerId });
    if (href.startsWith("/api/customer-profile")) return json(CUSTOMER);
    if (href.startsWith("/api/customer-account")) return json({ customerId: CUSTOMER.customerId, addresses, pets: [], bookings: [] });
    if (href.startsWith("/api/service-zone?action=list")) return json([ZONE]);
    if (href.startsWith("/api/service-zone")) {
      const pincode = new URL(href, "https://test.local").searchParams.get("pincode");
      return json({ zone: { ...ZONE, serviceAvailable }, assignment: { pincode, zoneId: ZONE.zoneId, cityId: "blr", city: "Bengaluru", area: "Koramangala" } });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

/** Run the real /grooming page to settlement and hand back the browser session it leaves behind. */
async function visitGrooming(options) {
  const browser = installBrowser(options.session);
  const fetches = installFetch(options);
  try {
    const page = mount(GroomingPage, {}, { label: "GroomingPage" });
    await page.settle();
    const raw = browser.sessionStore.getItem(SELECTED_SERVICE_ADDRESS_KEY);
    return { offered: raw ? JSON.parse(raw) : null, sessionStore: browser.sessionStore, seen: fetches.seen };
  } finally { fetches.restore(); browser.restore(); }
}

/** Mount the REAL AddressPicker - what grooming step 3 renders - against that same session. */
async function step3(sessionStore, options) {
  const browser = installBrowser(Object.fromEntries(sessionStore._map));
  const fetches = installFetch(options);
  try {
    const resolved = [];
    const picker = mount(AddressPicker, { onZoneResolved: (zone) => resolved.push(zone) }, { label: "AddressPicker" });
    await picker.settle();
    const line1 = find(picker.tree(), (n) => n.type === "input" && n.props?.id === "grooming-address-line-1");
    const line2 = find(picker.tree(), (n) => n.type === "input" && n.props?.id === "grooming-address-line-2");
    return { line1: line1?.props.value, line2: line2?.props.value, resolved: resolved.filter(Boolean).at(-1) ?? null };
  } finally { fetches.restore(); browser.restore(); }
}

// ---------------------------------------------------------------------------------------------
test("a serviceable saved default is offered, and step 3 opens with it already verified", async () => {
  const visit = await visitGrooming({ addresses: [OTHER, SAVED] });
  assert.ok(visit.offered, "the saved default is offered to the booking flow");
  assert.equal(defaultStayAddress([OTHER, SAVED]).id, SAVED.id, "the DEFAULT address is the one chosen, not simply the first");
  assert.match(visit.offered.addressLine1, /221B Baker Lane/, "the customer's own saved line, not a rewritten one");
  assert.match(visit.offered.addressLine1, /Koramangala, Bengaluru, 560034/, "with the area, city and PIN the picker needs");
  assert.equal(visit.offered.addressLine2, "Flat 4");
  assert.equal(visit.offered.assignment.pincode, "560034");
  assert.equal(visit.offered.assignment.zoneId, ZONE.zoneId);
  assert.equal(visit.offered.zone.serviceAvailable, true);
  assert.equal(visit.offered.verification, "typed", "offered on exactly the terms a re-typed address would be");
  assert.ok(visit.seen.some((href) => href.includes("/api/service-zone?pincode=560034")), "the saved address was really checked against the live service zone");

  const screen = await step3(visit.sessionStore, { addresses: [OTHER, SAVED] });
  assert.match(String(screen.line1), /221B Baker Lane/, "step 3 opens with the address filled in, so nothing has to be retyped");
  assert.equal(screen.line2, "Flat 4");
  assert.ok(screen.resolved, "and already resolved, so the flow can continue without a second verification");
  assert.equal(screen.resolved.assignment.pincode, "560034");
});

test("no saved address: nothing is offered and step 3 is exactly as it was", async () => {
  const visit = await visitGrooming({ addresses: [] });
  assert.equal(visit.offered, null, "nothing is invented when the customer has saved nothing");
  const screen = await step3(visit.sessionStore, { addresses: [] });
  assert.equal(screen.line1, "", "the empty form is the correct behaviour here - this is the control for the test above");
  assert.equal(screen.resolved, null);
});

test("an address outside the service area is never offered", async () => {
  const visit = await visitGrooming({ addresses: [SAVED], serviceAvailable: false });
  assert.equal(visit.offered, null, "coverage is checked before offering, exactly as StayAddress does it");
});

test("an address with no PIN code is never offered - it cannot be coverage-checked", async () => {
  const visit = await visitGrooming({ addresses: [{ ...SAVED, postalCode: null, area: "Somewhere", line1: "No PIN Road" }] });
  assert.equal(visit.offered, null);
});

test("an address the customer already verified in this tab is not overwritten", async () => {
  const mine = { zone: ZONE, assignment: { pincode: "560038", zoneId: "blr-east", cityId: "blr", city: "Bengaluru", area: "Indiranagar" }, address: "42 Test Road, Indiranagar", addressLine1: "42 Test Road, Indiranagar", addressLine2: "", latitude: 12.97, longitude: 77.64, placeId: "typed:560038", verification: "typed" };
  const visit = await visitGrooming({ addresses: [SAVED], session: { [SELECTED_SERVICE_ADDRESS_KEY]: JSON.stringify(mine) } });
  assert.equal(visit.offered.addressLine1, "42 Test Road, Indiranagar",
    "a choice the customer just made is a more recent statement than a saved default");
});
