/** Owner decision (QA M1): arrive/start only from 60 min before to 2 h after the booked start. */
import test from "node:test";
import assert from "node:assert/strict";
const { serviceWindowIssue } = await import("../lib/grooming-service-window.ts");
const start = "2026-09-30T05:30:00.000Z"; // 30 Sept, 11:00 am IST
const at = iso => Date.parse(iso);

test("a job days ahead cannot be arrived at or started", () => {
  assert.match(serviceWindowIssue("arrived", start, at("2026-09-26T05:30:00.000Z")), /You can mark arrival or start from 30 Sept, 10:00 am IST/);
  assert.match(serviceWindowIssue("start_service", start, at("2026-09-26T05:30:00.000Z")), /starts 30 Sept, 11:00 am IST/);
});
test("the window opens 60 minutes before and closes 2 hours after the booked start", () => {
  assert.equal(serviceWindowIssue("arrived", start, at("2026-09-30T04:30:00.000Z")), null);
  assert.equal(serviceWindowIssue("start_service", start, at("2026-09-30T07:30:00.000Z")), null);
  assert.match(serviceWindowIssue("arrived", start, at("2026-09-30T04:29:00.000Z")), /You can mark arrival/);
  assert.match(serviceWindowIssue("start_service", start, at("2026-09-30T07:31:00.000Z")), /authorise a late start/);
});
test("other lifecycle steps are not time-gated here", () => {
  for (const action of ["accept", "on_the_way", "complete", "add_proof"]) assert.equal(serviceWindowIssue(action, start, at("2026-09-26T05:30:00.000Z")), null);
});
