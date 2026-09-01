import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("D1 refund workflow uses authenticated maker/checker identities and blocks self approval", async () => {
  const route = await read("app/api/booking-operations/route.ts");

  assert.match(route, /refund_self_approval_forbidden/);
  assert.match(route, /String\(refund\.requested_by\)===actor\.email/);
  assert.match(route, /approved_by=CASE WHEN \?='approved' THEN \? ELSE approved_by END/);
  assert.match(route, /\.bind\(toStatus,toStatus,actor\.email,/);
  assert.match(route, /"requested",actor\.email,now,now/);

  assert.ok(!route.includes("\"requested\",input.providerId,now,now"), "requester identity must never come from providerId in the request body");
  assert.ok(!route.includes("input.refundStatus,input.refundStatus,input.providerId"), "approver identity must never come from providerId in the request body");
});

test("refund state transition is claimed atomically before side effects", async () => {
  const route = await read("app/api/booking-operations/route.ts");

  assert.match(route, /CREATE TABLE IF NOT EXISTS booking_refund_transition_claims/);
  assert.match(route, /UNIQUE\(refund_case_id,from_status\)/);
  assert.match(route, /INSERT OR IGNORE INTO booking_refund_transition_claims/);
  assert.match(route, /WHERE id=\? AND status=\? AND \$\{guard\}/);
  assert.match(route, /refund_transition_already_claimed/);
  assert.match(route, /booking_operations\.refund_\$\{toStatus\}/);
});

test("legacy backend cannot auto-approve a refund request for privileged roles", async () => {
  const finance = await read("backend/src/finance.ts");

  const requestRefund = finance.slice(finance.indexOf("export async function requestRefund"), finance.indexOf("export async function recordCash"));
  assert.match(requestRefund, /status:\"requested\"/);
  assert.match(requestRefund, /requestedBy:actor\.id/);
  assert.ok(!requestRefund.includes("approvedBy:"), "maker and checker must not be the same actor at request creation");
  assert.ok(!requestRefund.includes('actor.role==="finance"'), "finance authority must not bypass maker/checker");
  assert.ok(!requestRefund.includes('actor.role==="super_admin"'), "super-admin authority must not bypass maker/checker");
});
