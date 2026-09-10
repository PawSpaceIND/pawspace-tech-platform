import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const keyId = String(process.env.RAZORPAYX_KEY_ID_SANDBOX || "").trim();
const keySecret = String(process.env.RAZORPAYX_KEY_SECRET_SANDBOX || "").trim();
const account = String(process.env.RAZORPAYX_ACCOUNT_NUMBER_SANDBOX || "").trim();
const rawMap = String(process.env.RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX || "").trim();

if (!keyId.startsWith("rzp_test_")) throw new Error("Refusing RazorpayX provider test without rzp_test_ key");
if (!keySecret || !account || !rawMap) throw new Error("RazorpayX sandbox key secret, account number and fund-account map are required");

function candidates(value) {
  const out = [];
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      if (/^fa_[A-Za-z0-9]+$/.test(candidate.trim())) out.push(candidate.trim());
      return;
    }
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    if (candidate && typeof candidate === "object") for (const item of Object.values(candidate)) visit(item);
  };
  try { visit(JSON.parse(value)); }
  catch { for (const token of value.split(/[\s,;]+/)) visit(token); }
  return [...new Set(out)];
}

const fundAccounts = candidates(rawMap);
if (!fundAccounts.length) throw new Error("RAZORPAYX_FUND_ACCOUNT_MAP_SANDBOX contains no fa_ fund account id");
const fundAccount = fundAccounts[0];
const amount = 100;
const reference = `PawSpaceUAT${Date.now()}`.slice(0, 40);
const idempotency = `pawspace-rpx-${Date.now()}-${Math.random().toString(16).slice(2)}`.slice(0, 64);
const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;

async function api(path, init = {}) {
  const response = await fetch(`https://api.razorpay.com${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...(init.headers || {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`RazorpayX TEST ${init.method || "GET"} ${path} failed HTTP ${response.status}: ${String(body?.error?.description || "provider error")}`);
  return body;
}

const payout = await api("/v1/payouts", {
  method: "POST",
  headers: { "X-Payout-Idempotency": idempotency },
  body: JSON.stringify({
    account_number: account,
    fund_account_id: fundAccount,
    amount,
    currency: "INR",
    mode: "IMPS",
    purpose: "payout",
    queue_if_low_balance: true,
    reference_id: reference,
    narration: "PawSpace UAT",
    notes: { purpose: "pawspace_provider_e2e", environment: "sandbox" },
  }),
});

assert.match(String(payout.id || ""), /^pout_/);
assert.equal(Number(payout.amount), amount);
assert.equal(String(payout.currency), "INR");
const fetched = await api(`/v1/payouts/${encodeURIComponent(payout.id)}`);
assert.equal(String(fetched.id), String(payout.id));

const evidence = {
  provider: "razorpayx",
  environment: "sandbox",
  liveMoney: false,
  providerBacked: true,
  payoutIdPatternVerified: true,
  createAmountVerified: true,
  createCurrencyVerified: true,
  fetchIdentityVerified: true,
  amountPaise: amount,
  fundAccountConfigured: true,
  accountConfigured: true,
  idempotencyHeader: true,
  createdAt: new Date().toISOString(),
};
mkdirSync("/tmp/razorpayx-evidence", { recursive: true });
writeFileSync("/tmp/razorpayx-evidence/provider.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(`PASS RazorpayX TEST payout create+fetch; provider payout id validated; amount=${amount} paise; liveMoney=false`);
