import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/booking-operations/route.ts", import.meta.url), "utf8");
const repair = await readFile(new URL("../lib/schema-drift-repair.ts", import.meta.url), "utf8");

test("refund requests persist the authenticated requester identity", () => {
  assert.match(route, /booking_refund_cases[\s\S]*requested_by[\s\S]*actor\.email/);
  assert.doesNotMatch(route, /booking_refund_cases[\s\S]{0,500}requested_by[\s\S]{0,500}input\.providerId/);
});

test("refund approval enforces requester-approver segregation", () => {
  assert.match(route, /nextStatus === "approved" && String\(refund\.requested_by\) === actor\.email/);
  assert.match(route, /refund requester cannot approve their own refund/);
});

test("refund state changes use compare-and-set claim ownership", () => {
  assert.match(route, /booking_refund_cases[\s\S]*claim_token TEXT/);
  assert.match(route, /UPDATE booking_refund_cases SET status=.*claim_token=.*WHERE id=\? AND status=\?/);
  assert.match(route, /EXISTS \(SELECT 1 FROM booking_refund_cases WHERE id=\? AND claim_token=\?\)/);
  assert.match(route, /applied\[0\]\?\.meta\?\.changes/);
});

test("existing databases receive the refund claim token through drift repair", () => {
  assert.match(repair, /table: "booking_refund_cases", column: "claim_token"/);
});

test("refund audit side effects use authenticated actor identity", () => {
  assert.match(route, /refund\.\$\{nextStatus\}[\s\S]*actor\.email/);
  assert.match(route, /booking_operations\.refund_\$\{nextStatus\}/);
});
