import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source = await readFile(new URL("../app/mobile-app/account-tools.tsx", import.meta.url), "utf8");
const welcome = await readFile(new URL("../app/mobile-app/location-welcome.tsx", import.meta.url), "utf8");

test("customer billing physically applies Wallet before sandbox Razorpay checkout", () => {
  assert.match(source, /fetch\('\/api\/pawspace-wallet'/);
  assert.match(source, /Apply PawSpace Wallet/);
  assert.match(source, /walletAmount:wallet\.balance/);
  assert.match(source, /fetch\('\/api\/payment-order'/);
  assert.match(source, /openMobileRazorpayCheckout/);
  assert.match(source, /Pay securely \(Test\)/);
  assert.match(source, /PAWSPACE_PAYMENT_ENV:'sandbox'/);
  assert.match(source, /FORBID_PRODUCTION:'true'/);
  assert.match(source, /PAWSPACE_PAYMENT_LIVE_APPROVED:'false'/);
});

test("browser success remains provisional until server webhook truth changes billing", () => {
  assert.match(source, /only after the verified webhook is received/);
  assert.match(source, /\/api\/customer-billing/);
  assert.doesNotMatch(source, /status\s*[:=]\s*['\"]captured['\"]/i);
  assert.doesNotMatch(source, /paymentCaptured\s*=\s*true/i);
});

test("customer welcome uses an asset that exists in the reviewed beta", () => {
  assert.match(welcome, /\/assets\/pawspace-logo\.jpeg/);
  assert.doesNotMatch(welcome, /pawspace-official-lockup\.png/);
});