import { governedJsonError } from "../governed-http-error";
/** Demonstration settings only. These are never financial or approved loyalty policy. */
export type TestCoinPolicy = {
  enabled: boolean; label: "TEST coins — no cash value";
  earnPercent: number; expirySeconds: number | null; previewRupeesPerCoin: number;
};
/** Representability bounds, not reward values. Earn percent follows the repository's percent-of-value convention
 * (0..100, as promotion, payroll-deduction and commission percents are bounded): coins can never exceed the eligible
 * rupees, so the INTEGER ledger column and the JavaScript estimate stay within Number.MAX_SAFE_INTEGER and agree.
 * Above that, SQLite saturates CAST(...) at 2^63-1 while JavaScript floors a different double, and the stored row
 * cannot be read back as a number. The preview conversion is bounded by the ledger's paise rounding unit
 * (Math.round(x * 100) / 100): below one paisa a coin has no representable value, and above MAX_SAFE_INTEGER
 * paise a single coin's value is not an exact integer number of paise. */
export const TEST_COIN_EARN_PERCENT_MAX = 100;
export const TEST_COIN_PREVIEW_RUPEES_MIN = 0.01;
export const TEST_COIN_PREVIEW_RUPEES_MAX = Number.MAX_SAFE_INTEGER / 100;
/** Money the module will reason about: a rupee amount whose paise value is a safe integer, the same rule the
 * finance journal applies (lib/finance-accounts.ts "exceeds safe precision"). Canonical booking and payment
 * amounts are REAL columns with no upstream maximum, so the percent cap alone cannot keep an earned coin count
 * representable; every source amount, payable and ledger sum is checked against this instead. The SQL form is
 * ROUND(amount*100)<=TEST_COIN_MAX_PAISE, bound as a parameter. */
export const TEST_COIN_MAX_PAISE = Number.MAX_SAFE_INTEGER;
export function representableTestCoinAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100));
}
export function testCoinPolicy(env: Record<string, unknown>): TestCoinPolicy {
  const percent = Number(env.PAWSPACE_TEST_COINS_EARN_PERCENT ?? 10);
  const expirySeconds = env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS == null || env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS === "" ? null : Number(env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS);
  const conversion = Number(env.PAWSPACE_TEST_COINS_PREVIEW_RUPEES ?? 1);
  if (!Number.isFinite(percent) || percent < 0 || percent > TEST_COIN_EARN_PERCENT_MAX
    || (expirySeconds !== null && (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0 || Date.now() + expirySeconds * 1000 > 8640000000000000))
    || !Number.isFinite(conversion) || conversion < TEST_COIN_PREVIEW_RUPEES_MIN || conversion > TEST_COIN_PREVIEW_RUPEES_MAX)
    throw new Error("Invalid TEST coin demonstration settings");
  return {
    enabled: env.PAWSPACE_TEST_COINS === "on" && env.FORBID_PRODUCTION === "true" &&
      ["test", "staging", "development", "local"].includes(String(env.APP_ENV)),
    label: "TEST coins — no cash value", earnPercent: percent, expirySeconds, previewRupeesPerCoin: conversion,
  };
}
export function requireTestCoinPolicy(policy: TestCoinPolicy) {
  if (!policy.enabled) throw governedJsonError({ error: "TEST coins are disabled in this environment" }, 404);
}
