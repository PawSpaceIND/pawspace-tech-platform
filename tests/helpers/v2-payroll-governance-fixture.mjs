// Synthetic local-only fixture; canonical employee, payroll and approval functions.
export async function v2PayrollFixture(db) {
  const people = await import("../../lib/people-foundation.ts");
  const payroll = await import("../../lib/payroll-engine.ts");
  const governance = await import("../../lib/v2-payroll-governance.ts");
  const start = Date.parse("2026-09-01T00:00:00+05:30"), end = Date.parse("2026-10-01T00:00:00+05:30");
  await people.ensurePeopleTables(db);
  const employee = await people.upsertEmployee(db, { employeeCode: "V2-GOV-QA", displayName: "Synthetic payroll employee",
    workEmail: "employee@v2-payroll.test", joinedAt: start - 86400000, actorId: "hr@v2-payroll.test" });
  const structure = await payroll.saveSalaryStructure(db, { structureCode: "V2-GOV-QA", effectiveFrom: start - 86400000,
    components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 30000 }], actorId: "hr@v2-payroll.test" });
  await payroll.assignCompensation(db, { employeeId: employee.id, structureId: structure.id, effectiveFrom: start - 86400000,
    reason: "Synthetic local V2 governance check", actorId: "hr@v2-payroll.test" });
  const calculated = await payroll.calculatePayroll(db, { periodStart: start, periodEnd: end,
    idempotencyKey: "v2-payroll-local-test", actorId: "maker@v2-payroll.test" });
  const runId = calculated.run.id, employeeId = employee.id;
  const policy = { salaryDay: 7, cutoffDay: 28, paidLeaveCodes: ["CL"], unpaidLeaveCodes: ["LOP"],
    lopDeductibleComponentCodes: ["BASIC"], authorizedDeductionEnabled: true,
    authorizedDeductionPolicyReference: "SYNTHETIC-APPROVED-POLICY", maxAuthorizedDeductionPercent: 25, actorId: "hr@v2-payroll.test" };
  await governance.saveV2PayrollPolicy(db, policy);
  const adjustment = async (amount = 1000) => {
    const row = await governance.proposeV2AuthorizedDeduction(db, { runId, employeeId, amount,
      reason: "Reviewed synthetic deduction", evidenceReference: "QA-EVIDENCE-ONLY", actorId: "requester@v2-payroll.test" });
    await governance.decideV2Adjustment(db, { adjustmentId: row.id, stage: "hr", decision: "approve", actorId: "checker@v2-payroll.test" });
    await governance.decideV2Adjustment(db, { adjustmentId: row.id, stage: "finance", decision: "approve", actorId: "finance@v2-payroll.test" });
    return row.id;
  };
  const approve = async () => {
    await payroll.reviewPayroll(db, { runId, actorId: "reviewer@v2-payroll.test" });
    await payroll.approvePayroll(db, { runId, actorId: "approver@v2-payroll.test" });
  };
  return { db, payroll, governance, start, end, runId, employeeId, policy, adjustment, approve,
    apply: () => governance.applyApprovedV2Adjustments(db, { runId, actorId: "operator@v2-payroll.test" }),
    result: () => db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=?").bind(runId).first(),
    lines: async () => (await db.prepare("SELECT * FROM payroll_result_lines WHERE source_type='v2_hr_payroll_adjustment'").all()).results };
}
