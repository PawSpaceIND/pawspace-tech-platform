import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const { getProviderPublicProfile } = await import("../lib/provider-public-profile.ts");

test("cold D1: a public provider profile self-initializes every table it reads", async () => {
  const { db, sqlite } = freshCountingD1();

  const profile = await getProviderPublicProfile(db, "groom_arun");

  assert.equal(profile?.providerId, "groom_arun");
  assert.equal(profile?.displayName, "Arun R.");
  assert.equal(profile?.verified, false);
  assert.equal(profile?.stats, null);
  assert.equal(profile?.isNewProvider, true);
  for (const table of [
    "provider_capacity_profiles",
    "provider_onboarding_profiles",
    "provider_onboarding_activation_runs",
    "provider_onboarding_profile_media",
    "canonical_bookings",
  ]) {
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
});

test("cold D1: an unknown provider remains a clean not-found result", async () => {
  const { db } = freshCountingD1();
  assert.equal(await getProviderPublicProfile(db, "not-a-provider"), null);
});
