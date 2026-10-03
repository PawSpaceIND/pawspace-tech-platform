import { governedJsonError } from "../governed-http-error";
/** Demonstration settings only. These are never financial or approved loyalty policy. */
export type TestCoinPolicy = {
  enabled: boolean; label: "TEST coins — no cash value";
  earnPercent: number; expirySeconds: number | null; previewRupeesPerCoin: number;
};
export function testCoinPolicy(env: Record<string, unknown>): TestCoinPolicy {
  const percent = Number(env.PAWSPACE_TEST_COINS_EARN_PERCENT ?? 10);
  const expirySeconds = env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS == null || env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS === "" ? null : Number(env.PAWSPACE_TEST_COINS_EXPIRY_SECONDS);
  const conversion = Number(env.PAWSPACE_TEST_COINS_PREVIEW_RUPEES ?? 1);
  if (!Number.isFinite(percent) || percent < 0 || (expirySeconds !== null && (!Number.isSafeInteger(expirySeconds) || expirySeconds <= 0 || Date.now() + expirySeconds * 1000 > 8640000000000000)) || !Number.isFinite(conversion) || conversion <= 0)
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
