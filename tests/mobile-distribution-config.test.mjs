import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { assertSandboxPaymentLocks } from "../lib/mobile/razorpay.ts";

const safe = {
  ...process.env,
  PAWSPACE_PAYMENT_ENV: "sandbox",
  FORBID_PRODUCTION: "true",
  PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  APP_STORE_CONNECT_API_KEY_KEY_ID: "fixture-id",
  APP_STORE_CONNECT_API_KEY_ISSUER_ID: "fixture-issuer",
  APP_STORE_CONNECT_API_KEY_KEY: "fixture-only-not-a-key",
};
function lane(platform, name, overrides = {}) {
  return spawnSync("ruby", ["tests/helpers/mobile-fastlane-harness.rb", platform, name], {
    env: { ...safe, ...overrides }, encoding: "utf8",
  });
}
test("Fastlane executes distinct app identities and the SPM project without external actions", () => {
  for (const platform of ["android", "ios"]) for (const target of ["customer", "partner"]) {
    const result = lane(platform, target === "partner" ? "partner_beta" : "beta");
    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stdout);
    assert.equal(calls.find(c => c.action === "sync").target, target);
    if (platform === "ios") {
      const build = calls.find(c => c.action === "build");
      assert.equal(build.options.project, "ios/App/App.xcodeproj");
      assert.equal(build.options.xcargs, `PRODUCT_BUNDLE_IDENTIFIER=com.pawspace.${target}`);
      assert.equal(calls.find(c => c.action === "testflight").options.api_key.key_id, "fixture-id");
    } else {
      assert.equal(calls.find(c => c.action === "gradle").target, target);
      assert.equal(calls.find(c => c.action === "play").options.package_name, `com.pawspace.${target}`);
    }
  }
});
test("Fastlane refuses missing or invalid isolation and missing Apple credentials", () => {
  for (const key of ["PAWSPACE_PAYMENT_ENV", "FORBID_PRODUCTION", "PAWSPACE_PAYMENT_LIVE_APPROVED"]) {
    for (const value of [undefined, "", "invalid"]) {
      assert.throws(() => assertSandboxPaymentLocks({ ...safe, [key]: value }), "device and distribution isolation guards must both reject this configuration");
      const result = lane("android", "beta", { [key]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /SECURITY LOCK VIOLATION/);
    }
  }
  const missing = lane("ios", "beta", { APP_STORE_CONNECT_API_KEY_KEY: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing Apple distribution configuration/);
});
