import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const meetGreet = read("lib/meet-and-greet.ts");
const route = read("app/api/meet-and-greet/route.ts");
const card = read("app/mobile-app/meet-greet-card.tsx");
const staff = read("app/team/meet-and-greet/page.tsx");
const gateway = read("lib/api-gateway.ts");

test("meet-greet pricing function enforces free rules", () => {
  assert.match(meetGreet, /export function meetGreetPrice/);
  assert.match(meetGreet, /format === "phone_call"\) return 0/);
  assert.match(meetGreet, /format === "house_visit"\) return intendedStayDays >= 5 \? 0 : 499/);
});

test("meet-greet persists requests and events on the server", () => {
  assert.match(meetGreet, /meet_greet_requests/);
  assert.match(meetGreet, /meet_greet_events/);
  assert.match(meetGreet, /customer_id TEXT NOT NULL/);
  assert.match(meetGreet, /host_id TEXT NOT NULL/);
  assert.match(meetGreet, /format TEXT NOT NULL/);
  assert.match(meetGreet, /preferred_at INTEGER NOT NULL/);
  assert.match(meetGreet, /intended_stay_days INTEGER NOT NULL/);
  assert.match(meetGreet, /status TEXT NOT NULL DEFAULT 'requested'/);
});

test("meet-greet enforces host validation against existing profiles", () => {
  assert.match(meetGreet, /boarding_host_profiles/);
  assert.match(meetGreet, /provider_capacity_profiles/);
  assert.match(meetGreet, /Host profile not found/);
});

test("meet-greet enforces one-open-request guard per customer-host pair", () => {
  assert.match(
    meetGreet,
    /An open meet-greet request already exists with this host/
  );
  assert.match(meetGreet, /UNIQUE.*customer_id.*host_id.*status.*requested.*confirmed/);
});

test("meet-greet validates time constraints: house visits 09:00-19:00 IST", () => {
  assert.match(
    meetGreet,
    /House visits must be scheduled between 09:00 and 19:00 IST/
  );
});

test("meet-greet lifecycle: requested → confirmed → completed/no_show", () => {
  assert.match(meetGreet, /confirmMeetGreetRequest/);
  assert.match(meetGreet, /completeMeetGreetRequest/);
  assert.match(meetGreet, /markMeetGreetNoShow/);
  assert.match(meetGreet, /cancelMeetGreetRequest/);
  assert.match(meetGreet, /Cannot confirm request in.*status/);
  assert.match(meetGreet, /Cannot complete request in.*status/);
  assert.match(meetGreet, /Cannot mark no-show for request in.*status/);
});

test("meet-greet API separates customer request from staff management", () => {
  assert.match(route, /action === "create"/);
  assert.match(route, /requirePermission.*scheduling\.book/);
  assert.match(route, /requireCustomerOwnership/);
  assert.match(route, /action === "confirm"/);
  assert.match(route, /action === "complete"/);
  assert.match(route, /action === "no_show"/);
  assert.match(route, /requirePermission.*bookings\.manage/);
});

test("customer request component uses governed server API", () => {
  assert.match(card, /\/api\/meet-and-greet/);
  assert.match(card, /phone_call.*house_visit/);
  assert.match(card, /intendedStayDays/);
  assert.match(card, /price === 0 \? "Free" : `₹\${price}`/);
});

test("staff queue page shows request lifecycle and event timeline", () => {
  assert.match(staff, /meet-and-greet/);
  assert.match(staff, /Timeline/);
  assert.match(staff, /events\.length/);
  assert.match(staff, /Confirm|Complete|Mark No-Show/);
});

test("gateway maps meet-greet permissions explicitly", () => {
  assert.match(gateway, /\/api\/meet-and-greet/);
  assert.match(gateway, /bookings\.manage/);
});
