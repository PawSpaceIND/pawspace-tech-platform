/**
 * P1 RUNTIME CLOSURE TEST — cross-customer object ownership.
 *
 * A signed-in customer must never reach another customer's objects. Every self-service route takes the
 * customerId from the request (query param or body) and binds it through requireCustomerOwnership
 * (lib/server-auth.ts), which compares the requested id to the subject_id of the caller's OWN verified
 * identity binding — not to anything in the body. A foreign id is 403.
 *
 * This drives the REAL route handlers with a REAL verified platform session cookie, exactly as the
 * customer app does. It deliberately uses a NON-LOCALHOST host: resolveActor short-circuits localhost to
 * a development-preview superuser (permissions ["*"]) that bypasses every ownership check, so a localhost
 * URL would pass for the wrong reason. There is no localhost-superuser shortcut here.
 *
 * Customer A is signed in. Every assertion is A reaching for customer B's object -> 403. Controls: A
 * reaching for A's own object gets PAST ownership (never 403); an anonymous caller is 401.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__XCUST_DB__", "__XCUST_ENV__");

const HOST = "https://app.pawspace.in"; // non-localhost: no development-preview superuser
const CUS_A = "CUS-A", CUS_B = "CUS-B";
const PHONE = { [CUS_A]: "+919000000001", [CUS_B]: "+919000000002" };

async function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__XCUST_DB__ = db;
  globalThis.__XCUST_ENV__ = {}; // PAWSPACE_UAT_LOGIN unset: the staging path must not authenticate here
  // Both customers get a verified identity binding (distinct principal keys, so ON CONFLICT can't rebind
  // one onto the other). ensureSecurityTables / ensurePlatformSessionTables / ensureIdentityBindingTables
  // all run CREATE TABLE IF NOT EXISTS during resolveActor / issuePlatformSession, so no manual DDL needed.
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  for (const customerId of [CUS_A, CUS_B]) {
    await upsertIdentityBinding(db, {
      identitySource: "customer_app", principalType: "phone", principalKey: PHONE[customerId],
      subjectType: "customer", subjectId: customerId, verificationState: "verified",
      actorId: "test", reason: "cross-customer ownership boundary test",
    });
  }
  return { sqlite, db };
}

/** A real verified customer session cookie bound to customerId — the exact path the customer app uses. */
async function customerCookie(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: PHONE[customerId],
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "test", reason: "session mint",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const routes = {
  wallet: () => import("../app/api/pawspace-wallet/route.ts"),
  points: () => import("../app/api/paw-points/route.ts"),
  review: () => import("../app/api/service-review/route.ts"),
  passport: () => import("../app/api/pet-passport/route.ts"),
  payment: () => import("../app/api/payment-order/route.ts"),
};

const getWith = (cookie, path) => new Request(`${HOST}${path}`, { headers: cookie ? { cookie } : {} });
const postWith = (cookie, path, body) => new Request(`${HOST}${path}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: JSON.stringify(body) });

// --- GET reads: A signed in, asking for B's data by ?customerId=CUS-B -----------------------------------

test("GET wallet: customer A cannot read customer B's wallet (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.wallet();
  const res = await route.GET(getWith(cookie, `/api/pawspace-wallet?customerId=${CUS_B}`));
  assert.equal(res.status, 403, `A must be refused B's wallet: ${JSON.stringify(await res.json())}`);
});

test("GET paw-points: customer A cannot read customer B's points (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.points();
  const res = await route.GET(getWith(cookie, `/api/paw-points?customerId=${CUS_B}`));
  assert.equal(res.status, 403);
});

test("GET service-review: customer A cannot read customer B's reviews (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.review();
  const res = await route.GET(getWith(cookie, `/api/service-review?customerId=${CUS_B}`));
  assert.equal(res.status, 403);
});

test("GET pet-passport: customer A cannot read customer B's pet passport (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.passport();
  const res = await route.GET(getWith(cookie, `/api/pet-passport?customerId=${CUS_B}&petId=PET-B`));
  assert.equal(res.status, 403);
});

// --- POST writes: A signed in, writing against B's id ---------------------------------------------------

test("POST payment-order: customer A cannot open a payment against customer B (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.payment();
  const res = await route.POST(postWith(cookie, "/api/payment-order", { customerId: CUS_B, bookingId: "BK-B" }));
  assert.equal(res.status, 403, `A must not open a payment for B: ${JSON.stringify(await res.json())}`);
});

test("POST wallet redeem: customer A cannot redeem against customer B's wallet (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.wallet();
  const res = await route.POST(postWith(cookie, "/api/pawspace-wallet", { customerId: CUS_B, walletAmount: 100, bookingId: "BK-B", idempotencyKey: "x1" }));
  assert.equal(res.status, 403);
});

test("POST paw-points redeem: customer A cannot redeem against customer B's points (foreign customerId -> 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.points();
  const res = await route.POST(postWith(cookie, "/api/paw-points", { customerId: CUS_B, points: 50, bookingId: "BK-B" }));
  assert.equal(res.status, 403);
});

// --- Controls: the boundary is not simply "deny everything" --------------------------------------------

test("CONTROL: customer A reaching for A's OWN wallet gets PAST ownership (never 403)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db, CUS_A);
  const route = await routes.wallet();
  const res = await route.GET(getWith(cookie, `/api/pawspace-wallet?customerId=${CUS_A}`));
  assert.notEqual(res.status, 403, "the rightful owner must not be refused");
  assert.notEqual(res.status, 401, "a verified session must authenticate");
});

test("CONTROL: an anonymous caller (no session) is refused authentication (401), not silently allowed", async () => {
  await freshDb();
  const route = await routes.wallet();
  const res = await route.GET(getWith(null, `/api/pawspace-wallet?customerId=${CUS_A}`));
  assert.equal(res.status, 401, `no session -> 401, got ${res.status}`);
});
