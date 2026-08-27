import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// PTJA-P1-F37 — no customer-facing page may carry a hardcoded customer identity.
//
// MEASURED: /food issued GET /api/customer-account?customerId=TST-101 with a real customer session
// present. Seven pages carried that constant. On a public host the consequence is total: anonymous
// callers get 401, and a signed-in customer asking for TST-101 is refused by
// requireCustomerOwnership — so every one of these pages was non-functional for every real customer.
// They only appeared to work on localhost, where the development-preview actor stands in.
//
// app/training/page.tsx:14 records this exact defect being fixed there. The decision was taken once
// and never propagated; this closes the other seven.
//
// WHY THIS IS A SOURCE-TEXT TEST, WHEN THIS AUDIT HAS REPEATEDLY CRITICISED THOSE.
// Measured, not assumed: rendering these pages does NOT put the fixture id in the markup. The id is
// spent in an EFFECT — the request the page issues — and react-dom/server runs no effects, so a
// render-level assertion passes today and would be vacuous. There is no jsdom here to flush them.
// A source-text assertion is the wrong tool when a literal stands in for a behaviour. It is the RIGHT
// tool when the literal IS the defect, which is the case here: a hardcoded customer id in a
// customer-facing page is the bug, not evidence of it. Each fix is additionally driven in a browser,
// recorded in ptja/phase1/P1-10.
// ---------------------------------------------------------------------------

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Every customer-facing page that books or reads on behalf of the signed-in customer. */
const CUSTOMER_PAGES = [
  "app/training/page.tsx",
  "app/boarding/page.tsx",
  "app/sitting/page.tsx",
  "app/walking/page.tsx",
  "app/taxi/canonical-taxi-page.tsx",
  "app/food/canonical-food-page.tsx",
  "app/funeral-memorial/page.tsx",
  "app/relocation/page.tsx",
];

/** The fixture identities these pages used to carry. */
const FIXTURES = ["TST-101", "uat.customer@pawspace.test", "+919880222741", "TST-PET-BRUNO", "TST-PET-PEPPER"];

test("P1-I01 no customer-facing page carries a fixture customer identity", async () => {
  for (const path of CUSTOMER_PAGES) {
    const source = await read(path);
    for (const fixture of FIXTURES) {
      // A fixture named inside a comment is a record of the defect, not the defect. Only code counts.
      const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
      assert.ok(!code.includes(fixture), `${path} still carries the fixture identity ${fixture}`);
    }
  }
});

test("P1-I02 each resolves the customer from the session instead", async () => {
  // loadCustomerAccount() sends NO id: the server derives the subject from the platform session, which
  // is the same identity the booking is scoped to, so the two cannot disagree the way a fixture did.
  for (const path of CUSTOMER_PAGES) {
    const source = await read(path);
    assert.match(source, /loadCustomerAccount/, `${path} must resolve the signed-in customer`);
    assert.doesNotMatch(source, /loadCustomerAccount\(\s*["'`]/, `${path} must not pass a literal customer id`);
  }
});

test("P1-I03 non-vacuity: the fixture list is the one that was actually there", async () => {
  // If FIXTURES were misspelled, P1-I01 would pass against pages that still carry the real constant.
  // The audit ledger records the exact values; assert they are the ones this file bans.
  const ledger = await read("ptja/phase1/P1-06-FIXTURE-CUSTOMER-IDENTITY-SWEEP.json");
  assert.match(ledger, /TST-101/, "the banned id is the one the sweep recorded");
  assert.equal(CUSTOMER_PAGES.length, 8, "training plus the seven the sweep found");
});
