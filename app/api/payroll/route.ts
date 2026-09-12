import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import {
  approvePayroll,
  assignCompensation,
  calculatePayroll,
  payrollDirectory,
  prepareSandboxPaymentBatch,
  reviewPayroll,
  saveSalaryStructure,
} from "../../../lib/payroll-engine";
import {
  requestSalaryAdvance,
  approveSalaryAdvance,
  closeSalaryAdvance,
  salaryAdvanceDirectory,
} from "../../../lib/salary-advance-governance";
import { authorizeLivePayrollDisbursement } from "../../../lib/payroll-live-disbursement";

type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

export async function GET(request: Request) {
  try {
    await authorize(request, "payroll.view");
    const db = await database();
    const url = new URL(request.url);
    if (url.searchParams.get("mode") === "advances") {
      return Response.json({
        data: await salaryAdvanceDirectory(db, {
          employeeId: url.searchParams.get("employeeId") || undefined,
        }),
        productionReady: false,
      });
    }
    return Response.json({ data: await payrollDirectory(db), productionReady: false });
  } catch (error) {
    return authError(error, "Unable to load payroll");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Row;
    const action = text(body.action);
    const db = await database();

    if (action === "approve") {
      const actor = await authorize(request, "payroll.approve");
      await approvePayroll(db, { runId: text(body.runId), actorId: actor.email });
      await securityAudit(db, actor, "payroll.approve", "payroll_run", text(body.runId), "completed");
      return Response.json({
        data: { runId: text(body.runId), status: "approved" },
        productionReady: false,
      });
    }

    if (action === "authorize_live_disbursement") {
      const actor = await authorize(request, "payroll.approve");
      const result = await authorizeLivePayrollDisbursement(db, request, actor, {
        runId: text(body.runId),
      });
      await securityAudit(
        db,
        actor,
        "payroll.live_disbursement.authorize",
        "payroll_run",
        text(body.runId),
        "completed",
        { mfaBacked: true, role: actor.roleCode },
      );
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "save_structure") {
      const actor = await authorize(request, "compensation.manage");
      const result = await saveSalaryStructure(db, {
        structureCode: text(body.structureCode),
        effectiveFrom: Number(body.effectiveFrom),
        components: Array.isArray(body.components) ? (body.components as never[]) : [],
        actorId: actor.email,
        approvalReference: text(body.approvalReference) || null,
      });
      await securityAudit(db, actor, "payroll.save_structure", "salary_structure", null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "assign_compensation") {
      const actor = await authorize(request, "compensation.manage");
      const result = await assignCompensation(db, {
        employeeId: text(body.employeeId),
        structureId: text(body.structureId),
        effectiveFrom: Number(body.effectiveFrom),
        reason: text(body.reason),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.assign_compensation", "payroll_run", null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "calculate") {
      const actor = await authorize(request, "payroll.manage");
      const result = await calculatePayroll(db, {
        periodStart: Number(body.periodStart),
        periodEnd: Number(body.periodEnd),
        idempotencyKey: text(body.idempotencyKey),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.calculate", "payroll_run", text(body.runId) || null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "review") {
      const actor = await authorize(request, "payroll.manage");
      await reviewPayroll(db, { runId: text(body.runId), actorId: actor.email });
      const result = { runId: text(body.runId), status: "reviewed" };
      await securityAudit(db, actor, "payroll.review", "payroll_run", text(body.runId) || null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "prepare_payment") {
      const actor = await authorize(request, "payroll.manage");
      const result = await prepareSandboxPaymentBatch(db, {
        runId: text(body.runId),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.prepare_payment", "payroll_run", text(body.runId) || null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "request_advance") {
      const actor = await authorize(request, "payroll.manage");
      const result = await requestSalaryAdvance(db, {
        employeeId: text(body.employeeId),
        amount: Number(body.amount),
        recoveryMonths: Number(body.recoveryMonths),
        reason: text(body.reason),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.request_advance", "payroll_run", null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "approve_advance") {
      const actor = await authorize(request, "payroll.manage");
      const result = await approveSalaryAdvance(db, {
        advanceId: text(body.advanceId),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.approve_advance", "payroll_run", null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    if (action === "close_advance") {
      const actor = await authorize(request, "payroll.manage");
      const result = await closeSalaryAdvance(db, {
        advanceId: text(body.advanceId),
        action: text(body.mode) === "waive_remaining" ? "waive_remaining" : "cancel",
        reason: text(body.reason),
        actorId: actor.email,
      });
      await securityAudit(db, actor, "payroll.close_advance", "payroll_run", null, "completed");
      return Response.json({ data: result, productionReady: false });
    }

    return Response.json({ error: "Unknown payroll action" }, { status: 400 });
  } catch (error) {
    return authError(error, "Payroll update failed");
  }
}
