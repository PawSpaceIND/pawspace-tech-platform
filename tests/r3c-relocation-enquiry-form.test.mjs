/*
 * R3-C / F1 (P0) — the public relocation enquiry form could never be submitted.
 *
 * MEASURED in a browser at /relocation-enquiry: fill every field on the form, press "Submit enquiry"
 * -> 400 `Relocation type must be "domestic" or "international"`. The same payload with
 * relocationKind:"domestic" added returns 200. app/relocation-enquiry/page.tsx contained the string
 * "relocationKind" ZERO times: it is absent from FormState and no control collected it, while
 * app/api/relocation-enquiry reads body.relocationKind and lib/relocation-enquiry rejects a missing
 * one. Every submission from the public front door was refused; the in-app flow worked only because
 * app/mobile-app/relocation-flow.tsx sends the field.
 *
 * This test DRIVES THE REAL PAGE - state, effects and the real button click - through
 * tests/helpers/customer-ui-harness.mjs, and the page's fetch is served by the REAL route handler
 * over real SQLite. What it asserts is the OUTCOME the customer sees: the confirmation screen with a
 * real enquiry id, and a persisted row. Asserting that a control exists would not have caught a
 * control wired to nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { mount, find, all, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__RELQ_FORM_DB__", "__RELQ_FORM_ENV__");

const { default: RelocationEnquiryPage } = await import("../app/relocation-enquiry/page.tsx");
const route = await import("../app/api/relocation-enquiry/route.ts");

const FIELDS = {
  "Customer name": "Ananya Verma",
  "Primary phone (10 digits)": "9812345670",
  "Email": "ananya.verma@example.in",
  "Pickup location": "Flat 2, Indiranagar, Bengaluru",
  "Drop location": "Baner, Pune",
};
const DATES = { "Pickup date": "2026-10-05", "Pickup approximate time": "09:30", "Expected travel date": "2026-10-08" };

/** The page posts to a relative path; route it to the REAL handler over a real D1. */
function installFetch(calls) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    assert.equal(path, "/api/relocation-enquiry", `the form talks only to its own endpoint, not ${path}`);
    calls.push(JSON.parse(String(init.body)));
    return route.POST(new Request(`https://uat.pawspace.in${path}`, { method: init.method, headers: init.headers, body: init.body }));
  };
  return () => { globalThis.fetch = previous; };
}

/** Type into every labelled control the page renders, by its visible label text. */
function fillEverything(tree) {
  const labelled = (text) => {
    const node = find(tree, (n) => (n.type === "label") && String(n.props?.children?.[0] ?? "") === text);
    assert.ok(node, `the form shows a "${text}" field`);
    const input = find(node, (n) => n.type === "input" || n.type === "select");
    assert.ok(input, `"${text}" has a control`);
    return input;
  };
  for (const [label, value] of Object.entries({ ...FIELDS, ...DATES })) labelled(label).props.onChange({ target: { value } });
}

async function world() {
  const { sqlite, db } = freshCountingD1();
  enterWorkersDbScope(db);
  return { sqlite, db };
}

test("RELQ-FORM-01: filling the public form and pressing Submit produces a logged enquiry, not a 400", async () => {
  const { sqlite } = await world();
  const calls = [];
  const restore = installFetch(calls);
  try {
    const screen = mount(RelocationEnquiryPage, {}, { label: "RelocationEnquiryPage" });
    await screen.settle();
    fillEverything(screen.tree());
    await screen.settle();

    const submit = find(screen.tree(), (n) => n.type === "button" && String(n.props?.children ?? "").includes("Submit"));
    assert.ok(submit, "the Submit button is on screen");
    submit.props.onClick();
    await screen.settle();

    // THE OUTCOME, not the ingredient: the customer is looking at the confirmation screen.
    const text = screenText(screen.html());
    assert.match(text, /ENQUIRY RECEIVED/, `the confirmation screen must render; instead: ${text.slice(0, 400)}`);
    assert.match(text, /Thanks, Ananya Verma/);
    assert.match(text, /RELQ-/, "a real enquiry id is shown");

    // And it is really in the database, with the kind the form collected.
    const row = sqlite.prepare("SELECT customer_name,relocation_kind,pickup_location FROM relocation_enquiries").get();
    assert.equal(row.customer_name, "Ananya Verma");
    assert.equal(row.relocation_kind, "domestic", "the form's default relocation type reached the database");
    assert.equal(calls.length, 1, "exactly one submission");
    assert.equal(calls[0].relocationKind, "domestic", "the page actually sends the field the API requires");
  } finally { restore(); }
});

test("RELQ-FORM-02: choosing International sends and persists 'international'", async () => {
  const { sqlite } = await world();
  const calls = [];
  const restore = installFetch(calls);
  try {
    const screen = mount(RelocationEnquiryPage, {}, { label: "RelocationEnquiryPage" });
    await screen.settle();
    fillEverything(screen.tree());

    const radios = all(screen.tree(), (n) => n.type === "input" && n.props?.name === "relocationKind");
    assert.deepEqual(radios.map((r) => r.props.value).sort(), ["domestic", "international"],
      "the form offers exactly the two kinds the API accepts");
    const international = radios.find((r) => r.props.value === "international");
    assert.equal(international.props.checked, false, "domestic is the India-first default");
    international.props.onChange({ target: { value: "international" } });
    await screen.settle();

    // The control is really bound: the radio now reads as checked on the next render.
    const after = all(screen.tree(), (n) => n.type === "input" && n.props?.name === "relocationKind");
    assert.equal(after.find((r) => r.props.value === "international").props.checked, true);

    find(screen.tree(), (n) => n.type === "button" && String(n.props?.children ?? "").includes("Submit")).props.onClick();
    await screen.settle();

    assert.match(screenText(screen.html()), /ENQUIRY RECEIVED/, "the international enquiry is accepted too");
    assert.equal(calls[0].relocationKind, "international");
    assert.equal(sqlite.prepare("SELECT relocation_kind k FROM relocation_enquiries").get().k, "international");
  } finally { restore(); }
});

test("RELQ-FORM-03: the refusal the audit measured is real - the same payload without the field is rejected", async () => {
  // NON-VACUITY: proves the API really does require relocationKind, so RELQ-FORM-01 is passing
  // because the page now sends it and not because the validation went away.
  await world();
  const response = await route.POST(new Request("https://uat.pawspace.in/api/relocation-enquiry", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerName: "Ananya Verma", phonePrimary: "9812345670", email: "ananya.verma@example.in",
      petType: "dog", pickupDate: "2026-10-05", pickupApproxTime: "09:30", pickupLocation: "Indiranagar, Bengaluru",
      dropLocation: "Baner, Pune", expectedTravelDate: "2026-10-08" }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Relocation type must be/);
});
