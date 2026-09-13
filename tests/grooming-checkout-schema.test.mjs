/**
 * The grooming review step disables "Confirm booking" until groomingCheckoutSchema accepts the form.
 * Alternative Phone used to be mandatory, so a customer who left it blank saw a dead Confirm button
 * with no message. It is optional now; these cases pin that, and that a filled value is still validated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { groomingCheckoutSchema } from "../lib/grooming-checkout-schema.ts";

const base = { customerName: "Asha Rao", customerPhone: "9000000915", addressLine1: "42 Indiranagar Double Road" };

test("grooming checkout: a blank Alternative Phone never blocks Confirm on its own", () => {
  for (const alternativePhone of ["", "   ", undefined]) {
    const parsed = groomingCheckoutSchema.safeParse({ ...base, alternativePhone });
    assert.equal(parsed.success, true, `alternativePhone=${JSON.stringify(alternativePhone)} must validate`);
    assert.equal(parsed.data.alternativePhone, "", "a blank value normalises to an empty string so nothing downstream sees whitespace");
  }
});

test("grooming checkout: a filled Alternative Phone must still be a valid Indian mobile number", () => {
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, alternativePhone: "9000000916" }).success, true);
  for (const bad of ["12345", "5000000000", "abc", "90000009160"]) {
    assert.equal(groomingCheckoutSchema.safeParse({ ...base, alternativePhone: bad }).success, false, `${bad} must be rejected`);
  }
});

test("grooming checkout: name, primary phone and address stay mandatory", () => {
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, customerPhone: "" }).success, false);
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, customerName: "A" }).success, false);
  assert.equal(groomingCheckoutSchema.safeParse({ ...base, addressLine1: "" }).success, false);
});
