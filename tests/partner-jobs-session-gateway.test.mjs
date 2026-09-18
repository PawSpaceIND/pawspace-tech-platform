import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb } from "./helpers/ai-harness.mjs";

installAiHooks();
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");

async function sessionCookie(db, subjectType, subjectId) {
  const identitySource = subjectType === "provider" ? "provider_otp" : "customer_otp";
  const principalType = "identity_subject";
  const principalKey = `${subjectType}:${subjectId}`;
  const binding = await upsertIdentityBinding(db, {
    identitySource, principalType, principalKey, subjectType, subjectId,
    verificationState: "verified", actorId: "test", reason: "Partner jobs gateway regression",
  });
  const issued = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource, principalType, principalKey, subjectType, subjectId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

test("provider session can read only its own aggregate Partner jobs endpoint", async t => {
  const { sqlite, db } = freshAiDb({ PAWSPACE_DEPLOYMENT_ENV: "e2e" });
  t.after(() => sqlite.close());
  const own = await authorizePlatformSessionRequest(new Request("https://pawspace.test/api/partner-jobs?providerId=PRV-1", { headers: { cookie: await sessionCookie(db, "provider", "PRV-1") } }), db);
  assert.equal(own.permission, "bookings.view");
  const other = await authorizePlatformSessionRequest(new Request("https://pawspace.test/api/partner-jobs?providerId=PRV-2", { headers: { cookie: await sessionCookie(db, "provider", "PRV-1") } }), db);
  assert.equal(other.status, 403);
  const customer = await authorizePlatformSessionRequest(new Request("https://pawspace.test/api/partner-jobs?providerId=PRV-1", { headers: { cookie: await sessionCookie(db, "customer", "CUS-1") } }), db);
  assert.equal(customer.status, 403);
});
