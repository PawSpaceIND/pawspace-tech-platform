import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// GET /api/booking-operations — horizontal authorization between authenticated providers.
//
// The GET handler read four tables straight from the `bookingId` query parameter with no actor
// resolution, no permission check and no record-level ownership check. The gateway maps this route to
// `bookings.view`, and the `service_provider` role holds `bookings.view` — the role whose own
// description is "sees assigned jobs only". So any signed-in provider could read any other provider's
// booking operations: operational events, customer notification message bodies, rebooking cases, and
// refund cases with amounts and gateway references.
//
// The defect that matters is provider-to-provider disclosure, not unauthenticated access. So this suite
// authenticates for real — a verified identity binding plus an issued platform session cookie, the same
// path the provider app uses — and drives the real route handler.
//
// It deliberately does NOT use a localhost URL. resolveActor short-circuits localhost to a
// development-preview superuser, and every check below would then pass for the wrong reason.
//
// Booking B is seeded with identifiable values in all four tables. An empty booking would prove nothing:
// empty arrays look identical whether the boundary holds or leaks.
// ---------------------------------------------------------------------------
installWorkersHooks("__BOPS_DB__", "__BOPS_ENV__");

// D1's batch() is one transaction; the loop this replaced committed as it went, so any claim in this
// file about a half-applied write was measured against the wrong machine.
const makeD1 = (sqlite) => createD1(sqlite);

// Identifiable seeded content. If any of these strings reaches the wrong provider, that is the leak.
const B = {
  bookingId: "BK-PROV-B",
  providerId: "PRV-B",
  customerId: "CUS-B",
  eventReason: "Booking B provider reported a vehicle breakdown on Sarjapur Road",
  notification: "Booking B customer told the groomer is 45 minutes late",
  rebookReason: "Booking B rebooking offered after the breakdown",
  refundReason: "Booking B refund for the missed grooming slot",
  refundAmount: 4321.5,
  gatewayReference: "rzp_refund_BOOKINGB_9931",
};
const A = {
  bookingId: "BK-PROV-A",
  providerId: "PRV-A",
  customerId: "CUS-A",
  eventReason: "Booking A provider running late after a long groom",
  notification: "Booking A customer told the groomer is 20 minutes late",
  rebookReason: "Booking A rebooking offered after the overrun",
  refundReason: "Booking A partial refund for the shortened session",
  refundAmount: 777.25,
  gatewayReference: "rzp_refund_BOOKINGA_1102",
};
/** Every Booking B value that must never cross the boundary. */
const B_SECRETS = [B.eventReason, B.notification, B.rebookReason, B.refundReason, B.gatewayReference, String(B.refundAmount)];

async function seed() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BOPS_DB__ = db;
  // PAWSPACE_UAT_LOGIN unset on purpose: the staging sign-in path must not be what authenticates here.
  globalThis.__BOPS_ENV__ = {};

  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT 'grooming',scheduled_start TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'confirmed',total_amount REAL NOT NULL DEFAULT 0,package_name TEXT NOT NULL DEFAULT 'Basic',pricing_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'assigned')");
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)");
  // The four tables the GET handler reads, using the DDL the route itself owns.
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_operational_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,reason TEXT NOT NULL,impact_minutes INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_rebooking_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,source_event_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',reason TEXT NOT NULL,eligible_at INTEGER NOT NULL,selected_start TEXT,assigned_provider_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");

  const now = Date.now();
  for (const side of [A, B]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,scheduled_start) VALUES (?,?,?,?)").run(side.bookingId, side.customerId, side.providerId, "2026-12-01T09:00:00.000Z");
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_name) VALUES (?,?,?,?)").run(`WO-${side.providerId}`, side.bookingId, side.providerId, `Provider ${side.providerId}`);
    sqlite.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`EV-${side.providerId}`, side.bookingId, side.providerId, "vehicle_issue", side.eventReason, 45, "{}", side.providerId, now);
    sqlite.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`NT-${side.providerId}`, side.bookingId, side.customerId, "whatsapp", "order_vehicle_issue", side.notification, "queued", `EV-${side.providerId}`, now);
    sqlite.prepare("INSERT INTO booking_rebooking_cases (id,booking_id,source_event_id,status,reason,eligible_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(`RB-${side.providerId}`, side.bookingId, `EV-${side.providerId}`, "offered", side.rebookReason, now, now, now);
    sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`RF-${side.providerId}`, side.bookingId, `PAY-${side.providerId}`, side.refundAmount, side.refundReason, "requested", side.providerId, side.gatewayReference, now, now);
  }
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-mgr", "ops.manager@pawspace.in", "Ops manager", "manager", "active");
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status) VALUES (?,?,?,?,?)").run("u-assoc", "associate@pawspace.in", "Associate", "associate", "active");
  return { sqlite, db };
}

/** A real provider session: verified identity binding, then an issued session token. */
async function providerCookie(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  // One distinct principal per provider, from an explicit map that throws on an unknown id.
  //
  // This was a two-way ternary (`PRV-A ? "01" : "02"`). Correct for exactly two providers and a trap for
  // the third: it would reuse Provider B's principal key, and upsertIdentityBinding's
  // ON CONFLICT(identity_source,principal_type,principal_key,subject_type) would rebind that principal to
  // the new subject — silently revoking Provider B's binding. The isolation assertions would then pass
  // because B had no identity, not because the boundary held. Raised in review on #181.
  const PRINCIPALS = { "PRV-A": "+919900000001", "PRV-B": "+919900000002" };
  const principalKey = PRINCIPALS[providerId];
  if (!principalKey) throw new Error(`No test principal for ${providerId} — add one to PRINCIPALS rather than sharing a key`);
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey,
    subjectType: "provider", subjectId: providerId, verificationState: "verified",
    actorId: "test", reason: "authorization boundary test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const url = (bookingId) => `https://uat.pawspace.in/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`;
const asProvider = (bookingId, cookie) => new Request(url(bookingId), { headers: { cookie } });
const asManager = (bookingId) => new Request(url(bookingId), { headers: { "oai-authenticated-user-email": "ops.manager@pawspace.in" } });
const asAssociate = (bookingId) => new Request(url(bookingId), { headers: { "oai-authenticated-user-email": "associate@pawspace.in" } });
const anonymous = (bookingId) => new Request(url(bookingId));

async function get(request) {
  const { GET } = await import("../app/api/booking-operations/route.ts");
  const response = await GET(request);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

/** Everything the response actually carried, flattened, so a leak cannot hide in a nested field. */
const payload = (body) => JSON.stringify(body ?? {});
const rowCount = (body) => {
  const data = body?.data ?? {};
  return ["events", "notifications", "rebooking", "refunds"].reduce((total, key) => total + (Array.isArray(data[key]) ? data[key].length : 0), 0);
};

// ---------------------------------------------------------------------------
// The exploit.
// ---------------------------------------------------------------------------
test("Provider A -> Booking B: refused, and none of Booking B's data is disclosed", async () => {
  const { db } = await seed();
  const cookie = await providerCookie(db, A.providerId);
  const { status, body } = await get(asProvider(B.bookingId, cookie));

  // Record exactly what leaked when this fails, so the reproduction is self-evidencing.
  const leaked = B_SECRETS.filter((secret) => payload(body).includes(secret));
  assert.deepEqual(leaked, [], `Provider A -> ${B.bookingId} -> HTTP ${status} -> leaked ${leaked.length} Booking B fields: ${leaked.join(" | ")}`);
  assert.equal(rowCount(body), 0, `Provider A -> ${B.bookingId} -> HTTP ${status} -> ${rowCount(body)} Booking B rows returned`);
  assert.notEqual(status, 200, `Provider A must not get 200 for ${B.bookingId}`);
  assert.equal(status, 403, `expected a non-disclosing refusal, got HTTP ${status}: ${payload(body).slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// Control cases. Refusing everything is not a fix.
// ---------------------------------------------------------------------------
test("Provider A -> Booking A: allowed, and really returns its own operational data", async () => {
  const { db } = await seed();
  const cookie = await providerCookie(db, A.providerId);
  const { status, body } = await get(asProvider(A.bookingId, cookie));
  assert.equal(status, 200, `Provider A must still read its own booking: ${payload(body).slice(0, 200)}`);
  // Real rows, not an empty success — an over-broad fix that returned nothing would pass a status check.
  assert.equal(body.data.events.length, 1);
  assert.equal(body.data.notifications.length, 1);
  assert.equal(body.data.rebooking.length, 1);
  assert.equal(body.data.refunds.length, 1);
  assert.equal(body.data.events[0].reason, A.eventReason);
  assert.equal(body.data.refunds[0].amount, A.refundAmount);
  // And its own booking must not carry the other provider's rows.
  assert.deepEqual(B_SECRETS.filter((secret) => payload(body).includes(secret)), []);
});

test("Provider B -> Booking B: allowed, and gets the data Provider A was refused", async () => {
  const { db } = await seed();
  const cookie = await providerCookie(db, B.providerId);
  const { status, body } = await get(asProvider(B.bookingId, cookie));
  assert.equal(status, 200, payload(body).slice(0, 200));
  assert.equal(body.data.events[0].reason, B.eventReason);
  assert.equal(body.data.notifications[0].message, B.notification);
  assert.equal(body.data.rebooking[0].reason, B.rebookReason);
  assert.equal(body.data.refunds[0].amount, B.refundAmount);
  assert.equal(body.data.refunds[0].gateway_reference, B.gatewayReference);
});

test("privileged Ops manager -> Booking B: allowed, cross-booking authority preserved", async () => {
  const { db } = await seed();
  void db;
  const { status, body } = await get(asManager(B.bookingId));
  assert.equal(status, 200, `staff with bookings.manage must keep cross-booking access: ${payload(body).slice(0, 200)}`);
  assert.equal(body.data.refunds[0].amount, B.refundAmount);
  assert.equal(body.data.events[0].reason, B.eventReason);
  // The same actor can read the other booking too — that is what "cross-booking" means.
  const other = await get(asManager(A.bookingId));
  assert.equal(other.status, 200);
  assert.equal(other.body.data.refunds[0].amount, A.refundAmount);
});

test("an associate is refused: holding bookings.view is not the same as owning the job", async () => {
  // Raised in review on #181, reproduced, and decided rather than left implicit. An `associate` holds
  // `bookings.view` and so passes the gateway, but has no provider assignment and none of the manage
  // permissions requireProviderOwnership recognises — so it gets 403 here where it previously got 200.
  //
  // That is intended. The same `bookings.view` + requireProviderOwnership pairing governs 22 route files
  // (grooming-lifecycle, walking-proof, taxi-lifecycle, partner-job-feed, boarding-stays …), and an
  // associate is already refused by every one of them. booking-operations was the outlier with no record
  // check at all; this brings it into line rather than inventing a restriction.
  //
  // The tempting alternative — treat "has bookings.view but no provider binding" as a staff reader — is
  // fail-open: a provider whose binding expired or was revoked would be silently promoted to
  // cross-booking access. Granting associates this read is a deliberate platform-wide decision, not a
  // local patch, and it is not what this fix does.
  const { sqlite } = await seed();
  const { status, body } = await get(asAssociate(B.bookingId));
  assert.equal(status, 403, `an associate has no assignment to own: HTTP ${status} ${payload(body).slice(0, 160)}`);
  assert.deepEqual(B_SECRETS.filter((secret) => payload(body).includes(secret)), []);
  assert.equal(rowCount(body), 0);
  // Its own seeded rows are untouched — refusing the read must not be confused with there being no data.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_operational_events WHERE booking_id=?").get(B.bookingId).c, 1);
  // And the role really does hold the permission the gateway checks, so the refusal is record-level,
  // not a permission failure that would have shown up as a 403 at the gateway instead.
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const associate = defaultRoles.find((role) => role.code === "associate");
  assert.ok(associate.permissions.includes("bookings.view"), "associate holds bookings.view — the refusal is about the record, not the endpoint");
  assert.ok(!associate.permissions.includes("bookings.manage"), "and lacks the manage permission that grants cross-booking authority");
});

test("unauthenticated -> Booking B: rejected with nothing disclosed", async () => {
  await seed();
  const { status, body } = await get(anonymous(B.bookingId));
  assert.equal(status, 401, `expected 401, got ${status}: ${payload(body).slice(0, 200)}`);
  assert.deepEqual(B_SECRETS.filter((secret) => payload(body).includes(secret)), []);
  assert.equal(rowCount(body), 0);
});

// ---------------------------------------------------------------------------
// Boundary details worth pinning, because each is a way a partial fix stays exploitable.
// ---------------------------------------------------------------------------
test("a provider cannot read a booking that has no work order at all", async () => {
  const { sqlite, db } = await seed();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id) VALUES (?,?,?)").run("BK-ORPHAN", "CUS-X", "PRV-X");
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("RF-ORPHAN", "BK-ORPHAN", "PAY-X", 5555, "Orphan booking refund", "requested", "PRV-X", 1, 1);
  const cookie = await providerCookie(db, A.providerId);
  const { status, body } = await get(asProvider("BK-ORPHAN", cookie));
  // Fail closed: no assignment to own means no read. An `if (workOrder)` guard would let this through.
  assert.equal(status, 403, `an unassigned booking must not be readable: HTTP ${status} ${payload(body).slice(0, 200)}`);
  assert.ok(!payload(body).includes("Orphan booking refund"));
});

test("a revoked provider session cannot read even its own booking", async () => {
  const { sqlite, db } = await seed();
  const cookie = await providerCookie(db, A.providerId);
  sqlite.prepare("UPDATE platform_identity_sessions SET status='revoked' WHERE subject_id=?").run(A.providerId);
  const { status } = await get(asProvider(A.bookingId, cookie));
  assert.equal(status, 401, "a revoked session is not an identity");
});

test("a missing bookingId is a 400 for an authenticated caller, and a 401 for an anonymous one", async () => {
  const { db } = await seed();
  const { GET } = await import("../app/api/booking-operations/route.ts");
  const cookie = await providerCookie(db, A.providerId);
  const authenticated = await GET(new Request("https://uat.pawspace.in/api/booking-operations", { headers: { cookie } }));
  assert.equal(authenticated.status, 400, "a signed-in caller gets the ordinary validation error");
  // Authentication runs first, so an anonymous caller is not told which parameters the route wants.
  const anon = await GET(new Request("https://uat.pawspace.in/api/booking-operations"));
  assert.equal(anon.status, 401);
});

test("the fix did not escalate the gateway permission away from providers", async () => {
  // Everything above calls GET directly, never through the gateway — so those tests already prove the
  // route enforces the boundary itself. The one thing they cannot see is the gateway mapping, and the
  // failure mode there is a fix that "secures" the route by demanding a staff-only permission: the
  // boundary would hold and the provider app would break. `service_provider` must keep this read.
  //
  // This EXECUTES the gateway rather than regex-matching lib/api-gateway.ts, which is what it used to do.
  // A source match would break on a harmless reformat and, worse, would keep passing if the mapping moved
  // somewhere the regex no longer looked — the same certifies-nothing failure this whole suite exists to
  // avoid. authorizeApiRequest is exported and returns the resolved permission, so ask it. Raised in
  // review on #181.
  await seed();
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  // A localhost hostname short-circuits to the preview actor, which is exactly what is wanted here: the
  // question is which permission the gateway RESOLVES for this route and method, not who may pass it.
  const resolved = await authorizeApiRequest(new Request("http://localhost/api/booking-operations?bookingId=BK-PROV-A"), { DB: globalThis.__BOPS_DB__ });
  assert.ok(!(resolved instanceof Response), "the gateway must resolve a permission for this route, not refuse outright");
  assert.equal(resolved.permission, "bookings.view", "GET must still be reachable with bookings.view — providers legitimately need this read");
});

test("service_provider still holds the permission this read requires", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const provider = defaultRoles.find((role) => role.code === "service_provider");
  assert.ok(provider.permissions.includes("bookings.view"), "the provider role must keep the read it legitimately needs");
  // And it must NOT hold the permissions that grant cross-booking authority — otherwise the ownership
  // check would wave every provider through and the boundary above would be decorative.
  for (const privileged of ["bookings.manage", "providers.manage", "grooming.manage"]) {
    assert.ok(!provider.permissions.includes(privileged), `service_provider must not hold ${privileged}`);
  }
});
