/**
 * Provider availability write-path — runtime coverage.
 *
 * POST /api/provider-availability binds the request to the caller's OWN provider identity
 * (requireProviderOwnership), so a provider can only toggle their own availability. Going offline writes
 * an active provider_unavailability window that excludes them from assignment (loadGovernedProviders);
 * re-enabling clears it and restores eligibility.
 *
 * Driven through the real handler with a REAL verified provider platform session on a NON-LOCALHOST host
 * (so resolveActor cannot hand out a development-preview superuser that bypasses ownership).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__PAVAIL_DB__", "__PAVAIL_ENV__");

const HOST = "https://app.pawspace.in";
const SELF = "groom_arun", OTHER = "groom_kiran"; // both grooming providers in blr / blr-east
const PHONE = { [SELF]: "+919000010001", [OTHER]: "+919000010002" };

const gov = await import("../lib/provider-capacity-governance.ts");

async function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__PAVAIL_DB__ = db;
  globalThis.__PAVAIL_ENV__ = {};
  await gov.seedProviderCapacityDefaults(db); // seeds groom_arun / groom_kiran etc. (live=1)
  return { sqlite, db };
}

async function providerCookie(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: PHONE[providerId],
    subjectType: "provider", subjectId: providerId, verificationState: "verified",
    actorId: "test", reason: "provider availability test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const post = (cookie, body) => import("../app/api/provider-availability/route.ts").then(m => m.POST(new Request(`${HOST}/api/provider-availability`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })));
// Evaluate assignment eligibility a beat in the future, so an offline window created "now" is
// unambiguously active (starts_at strictly before the evaluation instant) rather than tying on the ms.
const eligible = (db) => gov.loadGovernedProviders(db, "blr", "blr-east", "grooming", new Date(Date.now() + 60_000)).then(ps => ps.map(p => p.id));

test("a provider can take THEMSELVES offline (own-provider write succeeds)", async () => {
  const { sqlite, db } = await freshDb();
  const cookie = await providerCookie(db, SELF);
  const res = await post(cookie, { providerId: SELF, available: false, reason: "taking leave today" });
  assert.equal(res.status, 200, `own write must succeed: ${JSON.stringify(await res.json())}`);
  const active = sqlite.prepare("SELECT COUNT(*) c FROM provider_unavailability WHERE provider_id=? AND status='active'").get(SELF).c;
  assert.equal(active, 1, "an active unavailability window was written");
});

test("a provider CANNOT toggle a different provider (cross-provider write -> 403)", async () => {
  const { sqlite, db } = await freshDb();
  const cookie = await providerCookie(db, SELF);
  const res = await post(cookie, { providerId: OTHER, available: false, reason: "malicious offline" });
  assert.equal(res.status, 403, `cross-provider write must be refused: ${JSON.stringify(await res.json())}`);
  const wrote = sqlite.prepare("SELECT COUNT(*) c FROM provider_unavailability WHERE provider_id=?").get(OTHER).c;
  assert.equal(wrote, 0, "a refused write leaves no window behind");
});

test("an OFFLINE provider is not assignable, and re-enabling RESTORES eligibility", async () => {
  const { db } = await freshDb();
  const cookie = await providerCookie(db, SELF);

  assert.ok((await eligible(db)).includes(SELF), "precondition: the provider is assignable while online");

  const off = await post(cookie, { providerId: SELF, available: false, reason: "on leave" });
  assert.equal(off.status, 200);
  assert.ok(!(await eligible(db)).includes(SELF), "an offline provider is excluded from assignment");
  assert.ok((await eligible(db)).includes(OTHER), "other providers remain assignable");

  const on = await post(cookie, { providerId: SELF, available: true, reason: "back online" });
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.ok(Number(body.data.windowsCleared) >= 1, "re-enable clears the active window");
  assert.ok((await eligible(db)).includes(SELF), "re-enabling restores eligibility");
});

test("an anonymous caller cannot write availability", async () => {
  await freshDb();
  const res = await import("../app/api/provider-availability/route.ts").then(m => m.POST(new Request(`${HOST}/api/provider-availability`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: SELF, available: false, reason: "no session" }) })));
  assert.ok([401, 403].includes(res.status), `no session must be refused, got ${res.status}`);
});
