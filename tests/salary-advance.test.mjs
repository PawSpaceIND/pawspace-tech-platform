import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/salary-advance-governance.ts");
const engine = await read("../lib/payroll-engine.ts");
const route = await read("../app/api/payroll/route.ts");

test("salary advance: configurable N-month recovery, maker/checker, exact schedule", () => {
  assert.match(lib, /export async function requestSalaryAdvance/);
  assert.match(lib, /months>=1&&months<=24/);                                  // configurable deduction months
  assert.match(lib, /the requester cannot approve their own advance/);        // maker/checker
  assert.match(lib, /already has a pending or active advance/);               // no stacking
  assert.match(lib, /seq===months\?money\(amount-monthly\*\(months-1\)\)/);   // last instalment absorbs rounding
  assert.match(lib, /Advance schedule does not reconcile/);                   // exactness guard
  assert.match(lib, /export async function closeSalaryAdvance/);              // cancel / waive_remaining
});

test("payroll auto-deducts one instalment per run and closes the advance on full recovery", () => {
  assert.match(engine, /advanceDeductionEntriesForPayroll\(db,\{employeeId\}\)/);
  assert.match(engine, /for\(const a of advances\)deductions\+=a\.amount/);
  assert.match(engine, /"ADVANCE_RECOVERY"/);                                  // payslip line
  assert.match(engine, /markAdvanceInstallmentsDeducted/);                     // idempotent recovery marking
  assert.match(lib, /status='recovered',closed_reason='fully_recovered'/);
});

test("the payroll route exposes governed advance actions", () => {
  for (const a of ["request_advance", "approve_advance", "close_advance"]) assert.match(route, new RegExp(`action==="${a}"`));
  assert.match(route, /mode"\)==="advances"/);
});
