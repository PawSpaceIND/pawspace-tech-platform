/*
 * The booking channel selects which authorization runs, so an unrecognised one ran none.
 *
 * app/api/taxi-ride-bookings branches on `channel`:
 *
 *   customer_app | boarding_cross_sell   -> requireCustomerOwnership(db, actor, input.customer.id)
 *   assisted_staff                       -> consent evidence required
 *   anything else                        -> neither, and the booking proceeded
 *
 * A caller holding `scheduling.book` could therefore book a ride for ANY customer id, with no
 * ownership check and no consent evidence, simply by sending a channel nobody had written a branch
 * for. The union on the Input type is compile-time only: the body arrives through request.json(),
 * so at runtime channel is whatever the caller sent, and validate() did not look at it.
 *
 * The route now rejects an unrecognised channel instead of adding a fourth branch, so a channel
 * introduced later fails closed until its own authorization is written. CHANNEL-3 is the part that
 * matters most over time: it fails if a new channel is added to the allowlist without also being
 * given a branch that authorizes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const route = fs.readFileSync(new URL("../app/api/taxi-ride-bookings/route.ts", import.meta.url), "utf8");
const { isTaxiRideChannel, taxiRideChannelRequirement, TAXI_RIDE_CHANNELS } = await importLibModule("taxi-ride-channels");
const allowlist = TAXI_RIDE_CHANNELS;

test("CHANNEL-0: the decision itself fails closed on anything unrecognised", () => {
  /* Executed, not read: this is the function the route actually calls. */
  for (const allowed of allowlist) assert.equal(isTaxiRideChannel(allowed), true, `${allowed} must be accepted`);
  for (const rejected of ["partner_portal", "", "CUSTOMER_APP", "customer_app ", "__proto__", "constructor",
                          "toString", null, undefined, 0, {}, ["customer_app"]]) {
    assert.equal(isTaxiRideChannel(rejected), false, `${String(rejected)} must not be accepted as a channel`);
    assert.equal(taxiRideChannelRequirement(rejected), null, `${String(rejected)} must name no requirement`);
  }
});

test("CHANNEL-1: an unrecognised channel is rejected before any booking work", () => {
  assert.match(route, /if\(!isTaxiRideChannel\(channel\)\)return json\(\{error:[^}]*\},400\);/,
    "an unknown channel must be refused, not fall through every authorization branch");
  const guard = route.indexOf("isTaxiRideChannel(channel)");
  for (const later of ["requireCustomerOwnership(db,actor", "reserveTaxi", "INSERT INTO canonical_bookings"]) {
    const at = route.indexOf(later, guard);
    if (at !== -1) assert.ok(at > guard, `${later} must not run before the channel is validated`);
  }
});

test("CHANNEL-2: the allowlist is exactly the channels the Input type declares", () => {
  const declared = route.match(/channel\?:([^;]*);/);
  assert.ok(declared, "the Input type no longer declares channel");
  const fromType = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...allowlist].sort(), fromType,
    "the runtime allowlist and the compile-time union must not drift: whichever is wider is the one that decides");
});

test("CHANNEL-3: every allowed channel is actually authorized by a branch", () => {
  /* An allowlist entry with no authorization branch is the original bug wearing a different hat:
   * the channel is accepted, and then nothing checks who the caller is booking for. */
  const OWNERSHIP = /if\(channel==="customer_app"\|\|channel==="boarding_cross_sell"\)await requireCustomerOwnership/;
  const CONSENT = /if\(channel==="assisted_staff"&&/;
  assert.match(route, OWNERSHIP, "customer_app and boarding_cross_sell must require customer ownership");
  assert.match(route, CONSENT, "assisted_staff must require consent evidence");
  /* Each allowed channel must name a requirement AND have a branch enforcing it. An entry with
   * neither is the original bug wearing a different hat. */
  const enforced = { customer_ownership: OWNERSHIP, assisted_consent: CONSENT };
  const unauthorized = allowlist.filter((c) => {
    const requirement = taxiRideChannelRequirement(c);
    return !requirement || !enforced[requirement] || !enforced[requirement].test(route) || !route.includes(`channel==="${c}"`);
  });
  assert.deepEqual(unauthorized, [],
    `allowed but authorized by no branch: ${unauthorized.join(", ")} — give each one an ownership or consent check`);
});
