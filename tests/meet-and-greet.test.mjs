import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Real execution: npm test runs node with --experimental-strip-types, so the pure
// pricing function is imported and executed directly from the TypeScript source.
const { meetGreetPrice, istMinutesOfDay } = await import("../lib/meet-and-greet.ts");

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lib = read("lib/meet-and-greet.ts");
const route = read("app/api/meet-and-greet/route.ts");
const card = read("app/mobile-app/meet-greet-card.tsx");
const staff = read("app/team/meet-and-greet/page.tsx");
const gateway = read("lib/api-gateway.ts");

test("meetGreetPrice: phone calls are always free", () => {
  assert.deepEqual(meetGreetPrice("phone", 0), { amount: 0, waived: false, reason: null });
  assert.deepEqual(meetGreetPrice("phone", 4), { amount: 0, waived: false, reason: null });
  assert.deepEqual(meetGreetPrice("phone", 30), { amount: 0, waived: false, reason: null });
});

test("meetGreetPrice: house visit costs 499 below the 5-day threshold", () => {
  assert.deepEqual(meetGreetPrice("house_visit", 0), { amount: 499, waived: false, reason: null });
  assert.deepEqual(meetGreetPrice("house_visit", 4), { amount: 499, waived: false, reason: null });
});

test("meetGreetPrice: house visit is free at exactly 5 days", () => {
  assert.deepEqual(meetGreetPrice("house_visit", 5), { amount: 0, waived: true, reason: "stay_5_days_or_more" });
});

test("meetGreetPrice: house visit is free above 5 days", () => {
  assert.deepEqual(meetGreetPrice("house_visit", 6), { amount: 0, waived: true, reason: "stay_5_days_or_more" });
  assert.deepEqual(meetGreetPrice("house_visit", 21), { amount: 0, waived: true, reason: "stay_5_days_or_more" });
});

test("istMinutesOfDay converts UTC epochs into IST minutes (UTC+05:30)", () => {
  // 2026-01-01T03:30:00Z is exactly 09:00 IST.
  assert.equal(istMinutesOfDay(Date.UTC(2026, 0, 1, 3, 30)), 9 * 60);
  // 2026-01-01T13:30:00Z is exactly 19:00 IST.
  assert.equal(istMinutesOfDay(Date.UTC(2026, 0, 1, 13, 30)), 19 * 60);
});

test("D1 tables and audit trail are created idempotently", () => {
  assert.match(lib, /CREATE TABLE IF NOT EXISTS meet_greet_requests/);
  assert.match(lib, /CREATE TABLE IF NOT EXISTS meet_greet_events/);
  for (const column of ["customer_id", "host_provider_id", "format", "intended_stay_start", "intended_stay_end", "intended_stay_days", "preferred_at", "price_charged", "price_waived_reason", "status", "notes"]) {
    assert.match(lib, new RegExp(column), `requests table declares ${column}`);
  }
  // Events follow the boarding_stay_events pattern: event_type, actor_id, detail_json.
  assert.match(lib, /event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '\{\}'/);
});

test("one open meet & greet per customer+host pair is DB-enforced", () => {
  assert.match(lib, /CREATE UNIQUE INDEX IF NOT EXISTS meet_greet_open_pair ON meet_greet_requests\(customer_id,host_provider_id\) WHERE status IN \('requested','confirmed'\)/);
  assert.match(lib, /An open meet & greet already exists with this host/);
});

test("host must be a boarding host or a pet_sitting capacity provider", () => {
  assert.match(lib, /FROM boarding_host_profiles WHERE provider_id=\?/);
  assert.match(lib, /FROM provider_capacity_profiles WHERE id=\? AND services_json LIKE '%pet_sitting%'/);
});

test("lifecycle transitions are enforced: requested -> confirmed -> completed|cancelled|no_show", () => {
  assert.match(lib, /confirm:\s*\{\s*from:\s*\["requested"\],\s*to:\s*"confirmed"\s*\}/);
  assert.match(lib, /complete:\s*\{\s*from:\s*\["confirmed"\],\s*to:\s*"completed"\s*\}/);
  assert.match(lib, /no_show:\s*\{\s*from:\s*\["confirmed"\],\s*to:\s*"no_show"\s*\}/);
  assert.match(lib, /cancel:\s*\{\s*from:\s*\["requested",\s*"confirmed"\],\s*to:\s*"cancelled"\s*\}/);
  assert.match(lib, /Cannot \$\{input\.action\} a meet & greet in/);
  assert.match(lib, /Preferred time must be in the future/);
  assert.match(lib, /between 09:00 and 19:00 IST/);
});

test("POST is public with strict server-side coercion; GET/PATCH are staff-gated", () => {
  const postBody = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
  assert.match(postBody, /sameOrigin\(request\)/);
  assert.doesNotMatch(postBody, /authorize|requirePermission|resolveActor/, "public POST must not require auth");
  assert.match(postBody, /String\(body\.customerId \?\? ""\)\.trim\(\)/);
  assert.match(postBody, /Number\(body\.preferredAt\)/);
  assert.match(route, /export async function GET[\s\S]*?authorize\(request, "bookings\.manage"\)/);
  assert.match(route, /export async function PATCH[\s\S]*?authorize\(request, "bookings\.manage"\)/);
});

test("gateway maps /api/meet-and-greet: public POST, bookings.manage otherwise", () => {
  assert.match(gateway, /if\(url\.pathname==="\/api\/meet-and-greet"\)return method==="POST"\?null:"bookings\.manage";/);
});

test("customer card shows both formats with live pricing and the 5+ day waiver message", () => {
  assert.match(card, /"use client"/);
  assert.match(card, /hostProviderId: string/);
  assert.match(card, /hostName: string/);
  assert.match(card, /intendedStayDays: number/);
  assert.match(card, /onRequested\?/);
  assert.match(card, /Free with stays of 5\+ days/);
  assert.match(card, /Phone call/);
  assert.match(card, /House visit/);
  assert.match(card, /fetch\("\/api\/meet-and-greet"/);
});

test("customer card never imports flow/checkout files", () => {
  assert.doesNotMatch(card, /stay-flow|grooming-flow|training-flow|checkout/);
  const staticImports = card.match(/^import .*$/gm) || [];
  assert.ok(staticImports.every((line) => /react|\.module\.css/.test(line)), "card only imports react and its own stylesheet");
});

test("staff queue page lists requests and drives transitions through PATCH", () => {
  assert.match(staff, /fetch\("\/api\/meet-and-greet", \{ cache: "no-store" \}\)/);
  assert.match(staff, /method: "PATCH"/);
  for (const action of ["confirm", "complete", "cancel", "no_show"]) assert.match(staff, new RegExp(action));
});
