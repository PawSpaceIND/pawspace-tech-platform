/**
 * When a booking never happens, who gets the slot back?
 *
 * A reserve writes a scheduling_reservations row and only THEN does the caller create the canonical
 * booking. So there is a window where capacity is held by a reservation that has no booking behind it -
 * and Tester 3 asked the right question about it: if the booking is subsequently rejected, does that
 * capacity come back, or is it held forever?
 *
 * This suite characterises the real behaviour rather than asserting a hoped-for one. It pins three
 * separate properties, because they have three different answers:
 *
 *   1. TTL             - there is none, by design. scheduling_reservations has no expiry column and no
 *                        sweep, so nothing releases a reservation on a timer. Pinned here so that if
 *                        someone adds a TTL later they have to come back and decide what it means for
 *                        an in-flight booking, rather than silently cancelling live work.
 *   2. capacity leak   - an orphaned reservation IS released, but only by an explicit Ops cancel. It is
 *                        recoverable, not self-healing.
 *   3. double-holding  - a reassign moves the existing reservation rather than adding a second one, so
 *                        one group never holds two slots. The concurrent case - two reserves racing for
 *                        one slot - is proven in tests/scheduling-hardening.test.mjs, not here.
 *
 * Everything drives the real handler. A test that inserted reservation rows by hand would prove nothing
 * about whether the reserve path and the release path agree on what "held" means.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__RCR_DB__", "__RCR_ENV__");

const HOST = "https://pawspace-staging.example.dev";
const NOW = Date.UTC(2026, 7, 1);
// A weekday slot inside the 09:00-19:00 grooming roster window, in IST. 3 hours clears the 120-minute
// grooming minimum with room to spare.
const START = "2026-09-10T05:00:00.000Z";
const END = "2026-09-10T08:00:00.000Z";

let sqlite;

async function fresh() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__RCR_DB__ = db;
  globalThis.__RCR_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.exec(`
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE canonical_pets (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT, species TEXT, breed TEXT, vaccination_status TEXT);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, provider_id TEXT, service_code TEXT, schedule_group_id TEXT, scheduled_start TEXT, scheduled_end TEXT, status TEXT, total_amount REAL);
  `);
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-A','Asha'),('CUS-B','Bhavna')").run();
  sqlite.prepare("INSERT INTO canonical_pets VALUES ('PET-A','CUS-A','Bruno','dog','indie','verified'),('PET-B','CUS-B','Coco','dog','indie','verified')").run();
  for (const [email, role] of [["asha@pawspace.test", "customer"], ["bhavna@pawspace.test", "customer"], ["ops@pawspace.test", "manager"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(`u-${email}`, email, email.split("@")[0], role, NOW, NOW);
  }
  for (const [email, customerId] of [["asha@pawspace.test", "CUS-A"], ["bhavna@pawspace.test", "CUS-B"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
  }
  return db;
}

async function scheduling(email, payload) {
  const route = await import("../app/api/uat-scheduling/route.ts");
  const response = await route.POST(new Request(`${HOST}/api/uat-scheduling`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    body: JSON.stringify({ serviceCode: "grooming", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END, ...payload }),
  }));
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
  return { status: response.status, body };
}

const active = () => sqlite.prepare("SELECT id,group_id,provider_id,status FROM scheduling_reservations WHERE status!='cancelled'").all();
const all = () => sqlite.prepare("SELECT id,group_id,provider_id,status FROM scheduling_reservations").all();

/** Reserve the slot for Asha and return the group and the provider that was assigned. */
async function reserveForAsha(groupId = "GRP-ORPHAN") {
  const reserved = await scheduling("asha@pawspace.test", { clientRequestId: groupId, customerId: "CUS-A", petIds: ["PET-A"] });
  assert.equal(reserved.status, 200, `the fixture reserve failed: ${JSON.stringify(reserved.body)}`);
  assert.equal(reserved.body.data.status, "assigned", JSON.stringify(reserved.body));
  return { groupId, providerId: String(reserved.body.data.provider.id) };
}

test("scheduling_reservations has no expiry column and no sweep, so nothing releases a slot on a timer", async () => {
  await fresh();
  await reserveForAsha();

  const columns = sqlite.prepare("PRAGMA table_info(scheduling_reservations)").all().map((c) => String(c.name));
  // Stated as a finding, not a complaint: capacity release here is event-driven, never time-driven.
  // provider_assignment_offers DOES carry expires_at, which is what times a provider's ACCEPTANCE out -
  // that is a different thing from releasing the customer's slot, and the two are easy to confuse.
  assert.ok(!columns.some((c) => /expir|ttl|hold_until|reserved_until/i.test(c)),
    `scheduling_reservations now has a time-based expiry column (${columns.join(", ")}). If that is deliberate, decide what it does to an in-flight booking before relying on it: every release path today is an explicit lifecycle transition, so a sweep would be the first thing able to cancel live work with no actor.`);

  // And the offer table is the one that does carry a deadline, so the distinction is pinned too.
  const offerColumns = sqlite.prepare("PRAGMA table_info(provider_assignment_offers)").all().map((c) => String(c.name));
  assert.ok(offerColumns.includes("expires_at"), "the provider acceptance deadline has moved; the offer/slot distinction above needs rechecking");
});

test("a reservation whose booking never lands keeps holding the slot", async () => {
  await fresh();
  const { providerId } = await reserveForAsha();
  // The rejected-booking shape: the reserve succeeded, and no canonical booking was ever created for
  // the group. Nothing in the product knows this group is dead.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE schedule_group_id='GRP-ORPHAN'").get().n, 0);
  assert.equal(active().length, 1, "the reserve did not hold a slot at all");

  // A second customer ASKING FOR THAT EXACT PROVIDER does not get them: the dead reservation is
  // consuming real capacity. Asserting on the provider rather than on the status matters, because the
  // engine falls back to another groomer and answers 200 - so a test that accepted "200 or 409" would
  // pass whether or not the slot was actually held.
  const second = await scheduling("bhavna@pawspace.test", { clientRequestId: "GRP-SECOND", customerId: "CUS-B", petIds: ["PET-B"], preferredProviderId: providerId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(String(second.body.data.provider?.id), providerId,
    `the held provider ${providerId} was handed to a second customer for the same window`);

  // And the orphan is still there. No timer, no sweep, no self-healing - which is the answer to
  // "does it expire?": it does not, and it never will without an actor.
  assert.equal(active().some((r) => r.group_id === "GRP-ORPHAN"), true, "the orphaned reservation was released with no actor");
  // No double-holding ACROSS groups either. This is a cheap state check, NOT proof of the atomic
  // guard: the engine's pre-check already steers B elsewhere, so deleting the guarded INSERT does not
  // fail this line. tests/scheduling-hardening.test.mjs owns that proof - it parks one statement to
  // force a genuine interleave, and three of its tests die when the guard is removed.
  const overlapping = sqlite.prepare(
    "SELECT a.provider_id, a.group_id ga, b.group_id gb FROM scheduling_reservations a JOIN scheduling_reservations b ON a.provider_id=b.provider_id AND a.group_id<b.group_id WHERE a.status!='cancelled' AND b.status!='cancelled' AND a.scheduled_start<b.scheduled_end AND b.scheduled_start<a.scheduled_end",
  ).all();
  assert.deepEqual(overlapping, [], `one provider is held by two groups at once: ${JSON.stringify(overlapping)}`);
});

test("an explicit Ops cancel releases the orphaned slot, so the capacity is recoverable rather than lost", async () => {
  await fresh();
  const { providerId } = await reserveForAsha();

  const cancelled = await scheduling("ops@pawspace.test", { action: "cancel", groupId: "GRP-ORPHAN", customerId: "CUS-A", petIds: ["PET-A"], reason: "Booking was rejected; releasing the held slot" });
  assert.equal(cancelled.status, 200, `Ops could not release the slot: ${JSON.stringify(cancelled.body)}`);
  assert.equal(cancelled.body.data.status, "cancelled");

  // Released, not deleted - the row stays for audit, at status cancelled, and every capacity query
  // filters on status!='cancelled'.
  assert.deepEqual(active(), [], "the cancel did not release the held capacity");
  assert.equal(all().length, 1, "the cancel deleted the audit trail instead of releasing it");

  // And the slot is genuinely bookable again by someone else - the assertion that proves "released"
  // means released to the capacity engine, not merely relabelled.
  const second = await scheduling("bhavna@pawspace.test", { clientRequestId: "GRP-SECOND", customerId: "CUS-B", petIds: ["PET-B"], preferredProviderId: providerId });
  assert.equal(second.status, 200, `the freed slot could not be rebooked: ${JSON.stringify(second.body)}`);
  assert.equal(String(second.body.data.provider.id), providerId, "the freed provider was not the one reassigned");
  assert.equal(active().length, 1, "rebooking the freed slot did not hold it");
});

test("a reassign moves the held slot rather than holding a second one", async () => {
  await fresh();
  const { providerId } = await reserveForAsha("GRP-MOVE");

  const moved = await scheduling("ops@pawspace.test", { action: "reassign", groupId: "GRP-MOVE", customerId: "CUS-A", petIds: ["PET-A"], reason: "Provider unavailable, moving the slot" });
  assert.ok([200, 409].includes(moved.status), JSON.stringify(moved.body));

  const held = active();
  assert.equal(held.length, 1, `the group holds ${held.length} slots at once: ${JSON.stringify(held)}`);
  if (moved.status === 200) {
    // Reassigned: exactly one hold, and it is on the NEW provider, not both.
    assert.notEqual(String(held[0].provider_id), providerId, "the reassign left the hold on the original provider");
    assert.equal(String(held[0].provider_id), String(moved.body.data.provider.id));
  } else {
    // No replacement was available, so the original assignment is restored rather than dropped - the
    // customer must not silently lose a perfectly good slot because a reassign failed.
    assert.equal(String(held[0].provider_id), providerId, "a failed reassign lost the customer's original slot");
  }
});

test("cancelling a group twice does not double-release or resurrect the hold", async () => {
  await fresh();
  await reserveForAsha("GRP-TWICE");

  const first = await scheduling("ops@pawspace.test", { action: "cancel", groupId: "GRP-TWICE", customerId: "CUS-A", petIds: ["PET-A"], reason: "First release" });
  const second = await scheduling("ops@pawspace.test", { action: "cancel", groupId: "GRP-TWICE", customerId: "CUS-A", petIds: ["PET-A"], reason: "Duplicate release" });

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, `a repeated release is not idempotent: ${JSON.stringify(second.body)}`);
  assert.deepEqual(active(), [], "a second cancel resurrected the hold");
  assert.equal(all().length, 1, "a second cancel duplicated the reservation row");
});
