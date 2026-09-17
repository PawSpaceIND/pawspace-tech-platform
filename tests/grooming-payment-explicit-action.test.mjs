import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const FLOW = new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url);
const PAYMENT = new URL("../app/mobile-app/booking-payment-page.tsx", import.meta.url);

test("grooming prepaid checkout requires an explicit Pay securely action", async () => {
  const [flow, payment] = await Promise.all([
    readFile(FLOW, "utf8"),
    readFile(PAYMENT, "utf8"),
  ]);

  assert.match(flow, /if\(pendingPayment\)return <BookingPaymentPage\b/);
  assert.doesNotMatch(flow, /BookingPaymentPage\s+autoStart=/);
  assert.match(payment, /`Pay securely · \$\{money\(dueNow\)\}`/);
  assert.match(payment, /onClick=\{\(\)=>void primary\(\)\}/);
});
