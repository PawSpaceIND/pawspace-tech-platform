/**
 * WAVE 3 TIER A - adversarial verification of W2-B3-R01. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "the ?customerId= parameter on the customer self-service family is NOT a
 * cross-tenant read - provider, foreign-customer and anonymous callers are all refused".
 *
 * The hunter probed EIGHT routes and its probe lived under /tmp, so nothing was reproducible and nothing
 * covered the other forty-six. This file commits the behavioural probe AND replaces the eight-route
 * spot-check with a structural sweep over every route that reads a caller-supplied customerId, so a new
 * route cannot join the family unguarded and still pass.
 *
 * Note on the structural half: a STAFF route reading ?customerId= correctly uses a permission rather
 * than customer ownership, so "no requireCustomerOwnership" is not by itself a defect. What must never
 * happen is a route that takes a caller-supplied customer id and applies NEITHER.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_XT_DB__", "__W3A_XT_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const VICTIM = "CUST-VICTIM";
const OTHER = "CUST-OTHER";
const ATTACKER_PROVIDER = "PRV-ATTACKER";

async function securityWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3A_XT_DB__ = db;
  globalThis.__W3A_XT_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  return { sqlite, db, now: Date.now() };
}

/** A REAL platform session for the given subject, issued through the real issuer. */
async function sessionCookie(db, { identitySource, subjectType, subjectId }) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource, principalType: "identity_subject", principalKey: `${subjectType}:${subjectId}`,
    subjectType, subjectId, verificationState: "verified",
    actorId: "ptja-w3a", reason: "PTJA W3A cross-tenant verification",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource,
    principalType: "identity_subject", principalKey: String(binding.principal_key),
    subjectType, subjectId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const providerCookie = (db) => sessionCookie(db, { identitySource: "partner_otp", subjectType: "provider", subjectId: ATTACKER_PROVIDER });
const customerCookie = (db, id) => sessionCookie(db, { identitySource: "customer_otp", subjectType: "customer", subjectId: id });

async function get(modulePath, path, headers = {}) {
  const route = await import(modulePath);
  const response = await route.GET(new Request(`https://uat.pawspace.in${path}`, { headers }));
  let parsed = null;
  try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

// The eight routes the original refutation named, so its exact claim is reproducible.
const SELF_SERVICE = [
  ["customer-support-case", "../app/api/customer-support-case/route.ts", "/api/customer-support-case"],
  ["customer-account", "../app/api/customer-account/route.ts", "/api/customer-account"],
  ["customer-offers", "../app/api/customer-offers/route.ts", "/api/customer-offers"],
  ["pet-vaccination", "../app/api/pet-vaccination/route.ts", "/api/pet-vaccination"],
  ["pet-emergency", "../app/api/pet-emergency/route.ts", "/api/pet-emergency"],
  ["booking-rating", "../app/api/booking-rating/route.ts", "/api/booking-rating"],
  ["service-review", "../app/api/service-review/route.ts", "/api/service-review"],
  ["pet-birthday", "../app/api/pet-birthday/route.ts", "/api/pet-birthday"],
];

for (const [label, modulePath, path] of SELF_SERVICE) {
  test(`R01-a (${label}): a PROVIDER session cannot read a customer's records by id`, async () => {
    const { db } = await securityWorld();
    const cookie = await providerCookie(db);
    const res = await get(modulePath, `${path}?customerId=${VICTIM}`, { cookie });
    assert.ok(res.status === 401 || res.status === 403,
      `a provider must be refused, got ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  });

  test(`R01-b (${label}): another CUSTOMER's session cannot read the victim's records`, async () => {
    const { db } = await securityWorld();
    const cookie = await customerCookie(db, OTHER);
    const res = await get(modulePath, `${path}?customerId=${VICTIM}`, { cookie });
    assert.ok(res.status === 401 || res.status === 403,
      `a foreign customer must be refused, got ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  });

  test(`R01-c (${label}): an ANONYMOUS caller cannot read a customer's records`, async () => {
    await securityWorld();
    const res = await get(modulePath, `${path}?customerId=${VICTIM}`);
    assert.ok(res.status === 401 || res.status === 403,
      `an anonymous caller must be refused, got ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  });
}

test("R01-d (non-vacuity): the victim's OWN session passes the ownership gate", async () => {
  // Without this every case above would pass on a family that refuses everyone, including the owner -
  // which would be a different bug wearing the same green tick.
  const { db } = await securityWorld();
  const { requireCustomerOwnership, resolveActor } = await import("../lib/server-auth.ts");
  const cookie = await customerCookie(db, VICTIM);
  const actor = await resolveActor(new Request("https://uat.pawspace.in/api/x", { headers: { cookie } }));
  await assert.doesNotReject(() => requireCustomerOwnership(db, actor, VICTIM),
    "the real owner must be admitted by the ownership gate");
  await assert.rejects(() => requireCustomerOwnership(db, actor, OTHER),
    "and the same actor must be refused for somebody else's id");
});

// -----------------------------------------------------------------------------------------------
// The structural half: every route, not the eight the hunt happened to reach.
// -----------------------------------------------------------------------------------------------

async function apiRoutes() {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (entry.name !== "route.ts") continue;
      found.push([`${dir}/${entry.name}`, await readFile(new URL(`../${dir}/${entry.name}`, import.meta.url), "utf8")]);
    }
  };
  await walk("app/api");
  return found;
}

const READS_CUSTOMER_ID = /searchParams\.get\("customerId"\)|body\.customerId/;
const ANY_AUTHORIZATION = /\bauthorize\s*\(|requirePermission\s*\(|resolveActor\s*\(|authorizeApiRequest\s*\(|requireCustomerOwnership\s*\(|requireProviderOwnership\s*\(/;

test("R01-e: every route taking a caller-supplied customerId applies SOME authorization", async () => {
  const routes = await apiRoutes();
  const taking = routes.filter(([, source]) => READS_CUSTOMER_ID.test(source));
  assert.ok(taking.length >= 40,
    `the sweep must actually find the family, found ${taking.length} - if this drops, the detector broke, not the codebase`);
  const unguarded = taking.filter(([, source]) => !ANY_AUTHORIZATION.test(source)).map(([path]) => path);
  assert.deepEqual(unguarded, [],
    "a route that accepts a caller-supplied customer id and applies neither ownership nor a permission is a cross-tenant read waiting to happen");
});

test("R01-f: the customer SELF-SERVICE family specifically uses ownership, not a bare permission", async () => {
  // A staff route may use a permission. These eight may not: every one of them is reachable by a
  // customer session, and a bare permission that the service_provider role also holds is exactly the
  // W2-17 defect class (bookings.view admitting any onboarded provider to the whole platform).
  for (const [label, modulePath] of SELF_SERVICE) {
    const file = `app/api/${modulePath.split("/api/")[1].replace("/route.ts", "")}/route.ts`;
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /requireCustomerOwnership/,
      `${label} is customer-facing and must gate on ownership, not on a permission other roles hold`);
  }
});
