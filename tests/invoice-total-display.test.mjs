/** QA (L3) and the staging trace: the partner app showed "Invoice Rs 1,174" for a Rs 1,241 capture. */
import test from "node:test";
import assert from "node:assert/strict";
const { invoiceTotal } = await import("../lib/invoice-total.ts");
test("a completion invoice shows the order total including GST, not the amount after GST", () => {
  assert.equal(invoiceTotal({ gross_amount: 1241, net_amount: 1174 }), 1241);
  assert.equal(invoiceTotal({ gross_amount: 1747, net_amount: 1480.51 }), 1747);
});
test("a UAT invoice with exclusive GST shows the payable total", () => {
  assert.equal(invoiceTotal({ gross_amount: 1000, net_amount: 1180 }), 1180);
});
