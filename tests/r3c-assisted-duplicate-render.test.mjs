/*
 * R3-C / F6 (P1) — the idempotency feature crashed the screen.
 *
 * MEASURED: create the same assisted order twice from /assisted-booking. /api/assisted-orders replays
 * the existing one (correct) as {assistedOrderId,bookingId,status,duplicatePrevented:true} - with no
 * provider and no totalAmount. app/assisted-booking/page.tsx rendered {result.provider.name}
 * unconditionally, threw `TypeError: Cannot read properties of undefined (reading 'name')`, and the
 * React error boundary replaced the WHOLE page with "This page didn't load". The operator was never
 * told the booking already existed; the toast that would have said so was destroyed with the page.
 *
 * This test RUNS THE REAL PAGE through tests/helpers/customer-ui-harness.mjs - real state, real
 * effects, a real click on the real submit control - and renders the settled tree. A page that throws
 * fails here exactly as it failed in the browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3C_DUP_UI_DB__", "__R3C_DUP_UI_ENV__");

const { default: AssistedBooking } = await import("../app/assisted-booking/page.tsx");

const CONFIG = {
  environment: "UAT", testOnly: true, liveMoney: false, serviceCode: "grooming",
  customers: [{ id: "UAT-CUST-ASSIST-001", name: "Meera Shah", primaryPhone: "+919800000101",
    pets: [{ sourceId: "UAT-PET-BRUNO", name: "Bruno", species: "dog", breed: "Golden Retriever", vaccinationStatus: "verified" }] }],
  packages: [{ code: "dog-basic", name: "Bath & Basic", offerType: "regular", tier: "Adult",
    eligiblePetTypes: ["dog"], singlePrice: 1899, multiPetPrice: 1599, version: "v1" }],
};

/** Exactly the replay body the route answered with BEFORE the fix: four fields, no provider, no total. */
const BARE_DUPLICATE = { assistedOrderId: "ASST-UAT-EXISTING1", bookingId: "PS-UAT-EXISTING", status: "confirmed", duplicatePrevented: true };

function installFetch(postResult) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!init || init.method !== "POST") return Response.json({ data: CONFIG });
    return Response.json({ data: postResult });
  };
  return () => { globalThis.fetch = previous; };
}

async function submitOnce(postResult) {
  const screen = mount(AssistedBooking, {}, { label: "AssistedBooking" });
  await screen.settle();
  const form = find(screen.tree(), (node) => node.type === "form");
  assert.ok(form, "the order form is on screen");
  await form.props.onSubmit({ preventDefault() {} });
  await screen.settle();
  return screen;
}

test("DUP-UI-01: a replayed order renders the existing booking instead of destroying the page", async () => {
  const restore = installFetch(BARE_DUPLICATE);
  try {
    const screen = await submitOnce(BARE_DUPLICATE);
    // If the page throws, renderToStaticMarkup throws here - which is precisely the browser failure.
    const text = screenText(screen.html());
    assert.match(text, /THIS BOOKING ALREADY EXISTS/, `the operator must be told the order already exists: ${text.slice(0, 400)}`);
    assert.ok(text.includes("ASST-UAT-EXISTING1"), "and which order it is");
    assert.ok(text.includes("PS-UAT-EXISTING"), "and which booking");
    assert.match(text, /Existing order reused/, "the duplicate-safe line still reads correctly");
    assert.match(text, /Existing UAT assisted order returned safely/, "and the toast survives with the page");
    assert.equal(/This page didn't load/.test(text), false);
  } finally { restore(); }
});

test("DUP-UI-02: a NEW order still renders its provider and governed total", async () => {
  // NON-VACUITY: rendering "—" for everything would pass DUP-UI-01 and ruin the normal path.
  const restore = installFetch({
    assistedOrderId: "ASST-UAT-NEW00001", bookingId: "PS-UAT-NEW", customerId: "UAT-CUST-ASSIST-001",
    scheduleGroupId: "assist-1", provider: { id: "PRV-1", name: "Kavya Groomer", model: "full_time" },
    totalAmount: 2240, amountDueNow: 0, status: "confirmed", duplicatePrevented: false,
    lead: { leadId: "LEAD-9", converted: true, reason: "customer_and_normalized_service" },
    testOnly: true, liveMoney: false,
  });
  try {
    const screen = await submitOnce();
    const text = screenText(screen.html());
    assert.match(text, /Kavya Groomer/, "the assigned provider is named");
    assert.match(text, /₹2,240/, "and the governed total is shown");
    assert.match(text, /New order/);
    assert.match(text, /Closed · LEAD-9/, "and the operator sees that the lead was closed");
    assert.equal(/THIS BOOKING ALREADY EXISTS/.test(text), false);
  } finally { restore(); }
});
