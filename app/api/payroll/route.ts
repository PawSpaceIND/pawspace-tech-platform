import {
  authError,
  authorize,
  database,
  securityAudit,
} from "../../../lib/server-auth";
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
    const actor=await authorize(request, "payroll.view");
    const db = await database();
    const url = new URL(request.url);
    if(url.searchParams.get("mode")==="salary"){const {employeeSalaryDirectory}=await import("../../../lib/employee-payroll-payout");return Response.json({data:await employeeSalaryDirectory(db,url.searchParams.get("runId")||undefined),productionReady:false});}
    if (url.searchParams.get("mode") === "advances") {
      return Response.json({
        data: await salaryAdvanceDirectory(db, {
          employeeId: url.searchParams.get("employeeId") || undefined,
        }),
        productionReady: false,
      });
    }
    return Response.json({
      data: {...await payrollDirectory(db),capabilities:{configure:actor.permissions.includes("*")||actor.permissions.includes("compensation.manage"),calculate:actor.permissions.includes("*")||actor.permissions.includes("payroll.manage"),approve:actor.permissions.includes("*")||actor.permissions.includes("payroll.approve")}},
      productionReady: false,
    });
  } catch (error) {
    return authError(error, "Unable to load payroll");
  }
}

type PayrollActionContext = {
  request: Request;
  body: Row;
  db: Awaited<ReturnType<typeof database>>;
};

type PayrollActionHandler = (
  context: PayrollActionContext,
) => Promise<Response>;

type PayrollActionDefinition = {
  requiredPermission:
    "payroll.approve" | "compensation.manage" | "payroll.manage";
  handler: PayrollActionHandler;
};

const handleApprove: PayrollActionHandler = async ({ request, body, db }) => {
  const actor = await authorize(request, "payroll.approve");
  await approvePayroll(db, { runId: text(body.runId), actorId: actor.email });
  await securityAudit(
    db,
    actor,
    "payroll.approve",
    "payroll_run",
    text(body.runId),
    "completed",
  );
  return Response.json({
    data: { runId: text(body.runId), status: "approved" },
    productionReady: false,
  });
};

const handleAuthorizeLiveDisbursement: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
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
    {
      mfaBacked: true,
      role: actor.roleCode,
    },
  );
  return Response.json({ data: result, productionReady: false });
};

const handleSaveStructure: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "compensation.manage");
  const result = await saveSalaryStructure(db, {
    structureCode: text(body.structureCode),
    effectiveFrom: Number(body.effectiveFrom),
    components: Array.isArray(body.components)
      ? (body.components as never[])
      : [],
    actorId: actor.email,
    approvalReference: text(body.approvalReference) || null,
  });
  await securityAudit(
    db,
    actor,
    "payroll.save_structure",
    "salary_structure",
    null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleAssignCompensation: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "compensation.manage");
  const result = await assignCompensation(db, {
    employeeId: text(body.employeeId),
    structureId: text(body.structureId),
    effectiveFrom: Number(body.effectiveFrom),
    reason: text(body.reason),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.assign_compensation",
    "payroll_run",
    null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleCalculate: PayrollActionHandler = async ({ request, body, db }) => {
  const actor = await authorize(request, "payroll.manage");
  const result = await calculatePayroll(db, {
    periodStart: Number(body.periodStart),
    periodEnd: Number(body.periodEnd),
    idempotencyKey: text(body.idempotencyKey),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.calculate",
    "payroll_run",
    text(body.runId) || null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleReview: PayrollActionHandler = async ({ request, body, db }) => {
  const actor = await authorize(request, "payroll.manage");
  await reviewPayroll(db, { runId: text(body.runId), actorId: actor.email });
  await securityAudit(
    db,
    actor,
    "payroll.review",
    "payroll_run",
    text(body.runId) || null,
    "completed",
  );
  return Response.json({
    data: { runId: text(body.runId), status: "reviewed" },
    productionReady: false,
  });
};

const handlePreparePayment: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "payroll.manage");
  const result = await prepareSandboxPaymentBatch(db, {
    runId: text(body.runId),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.prepare_payment",
    "payroll_run",
    text(body.runId) || null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleRequestAdvance: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "payroll.manage");
  const result = await requestSalaryAdvance(db, {
    employeeId: text(body.employeeId),
    amount: Number(body.amount),
    recoveryMonths: Number(body.recoveryMonths),
    reason: text(body.reason),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.request_advance",
    "payroll_run",
    null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleApproveAdvance: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "payroll.manage");
  const result = await approveSalaryAdvance(db, {
    advanceId: text(body.advanceId),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.approve_advance",
    "payroll_run",
    null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleCloseAdvance: PayrollActionHandler = async ({
  request,
  body,
  db,
}) => {
  const actor = await authorize(request, "payroll.manage");
  const result = await closeSalaryAdvance(db, {
    advanceId: text(body.advanceId),
    action:
      text(body.mode) === "waive_remaining" ? "waive_remaining" : "cancel",
    reason: text(body.reason),
    actorId: actor.email,
  });
  await securityAudit(
    db,
    actor,
    "payroll.close_advance",
    "payroll_run",
    null,
    "completed",
  );
  return Response.json({ data: result, productionReady: false });
};

const handleSaveCalculationPolicy: PayrollActionHandler = async ({request,body,db}) => {
  const actor=await authorize(request,"compensation.manage");
  const {ensurePayrollTables}=await import("../../../lib/payroll-engine");
  const {saveSalaryCalculationPolicy}=await import("../../../lib/payroll-proration");
  await ensurePayrollTables(db);
  const data=await saveSalaryCalculationPolicy(db,{structureId:text(body.structureId),mode:text(body.mode),componentCodes:Array.isArray(body.componentCodes)?body.componentCodes.map(text):[],approvalReference:text(body.approvalReference),actorId:actor.email});
  await securityAudit(db,actor,"payroll.calculation_policy.save","salary_structure",text(body.structureId),"completed");
  return Response.json({data,productionReady:false});
};

const handleSalarySandbox: PayrollActionHandler = async ({request,body,db}) => {
  const actor=await authorize(request,"payroll.approve");
  if(body.confirmSandbox!==true)return Response.json({error:"Explicit TEST-only salary action confirmation is required"},{status:400});
  const {env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  const {razorpayXSandboxReadiness}=await import("../../../lib/razorpayx-client");
  if(!razorpayXSandboxReadiness(runtime).ready)return Response.json({error:"Employee salary actions require complete sandbox payout configuration; live salary is disabled"},{status:503});
  const salary=await import("../../../lib/employee-payroll-payout");
  const action=text(body.action);let data:unknown;
  if(action==="save_salary_beneficiary")data=await salary.saveEmployeeSalaryBeneficiary(db,{employeeId:text(body.employeeId),fundAccountId:text(body.fundAccountId),verificationReference:text(body.verificationReference),expiresAt:Number(body.expiresAt),actorId:actor.email});
  else if(action==="authorize_salary_sandbox")data=await salary.queueEmployeeSalary(db,{runId:text(body.runId),actorId:actor.email});
  else{const input={instructionId:text(body.instructionId),actorId:actor.email};data=action==="dispatch_salary_sandbox"?await salary.dispatchEmployeeSalarySandbox(db,runtime,input):await salary.reconcileEmployeeSalarySandbox(db,runtime,input);}
  await securityAudit(db,actor,`payroll.${action}`,"employee_salary",text(body.instructionId)||text(body.runId)||text(body.employeeId),"completed");
  return Response.json({data,productionReady:false});
};

const ACTION_MAP: Readonly<Record<string, PayrollActionDefinition>> =
  Object.freeze({
    save_salary_beneficiary:{requiredPermission:"payroll.approve",handler:handleSalarySandbox},
    authorize_salary_sandbox:{requiredPermission:"payroll.approve",handler:handleSalarySandbox},
    dispatch_salary_sandbox:{requiredPermission:"payroll.approve",handler:handleSalarySandbox},
    reconcile_salary_sandbox:{requiredPermission:"payroll.approve",handler:handleSalarySandbox},
    save_calculation_policy: {requiredPermission:"compensation.manage",handler:handleSaveCalculationPolicy},
    approve: { requiredPermission: "payroll.approve", handler: handleApprove },
    authorize_live_disbursement: {
      requiredPermission: "payroll.approve",
      handler: handleAuthorizeLiveDisbursement,
    },
    save_structure: {
      requiredPermission: "compensation.manage",
      handler: handleSaveStructure,
    },
    assign_compensation: {
      requiredPermission: "compensation.manage",
      handler: handleAssignCompensation,
    },
    calculate: {
      requiredPermission: "payroll.manage",
      handler: handleCalculate,
    },
    review: { requiredPermission: "payroll.manage", handler: handleReview },
    prepare_payment: {
      requiredPermission: "payroll.manage",
      handler: handlePreparePayment,
    },
    request_advance: {
      requiredPermission: "payroll.manage",
      handler: handleRequestAdvance,
    },
    approve_advance: {
      requiredPermission: "payroll.manage",
      handler: handleApproveAdvance,
    },
    close_advance: {
      requiredPermission: "payroll.manage",
      handler: handleCloseAdvance,
    },
  });

export async function POST(request: Request) {
  try {
    // Establish the payroll authorization perimeter before parsing any user-controlled payload.
    // Each static action handler still enforces its stricter, action-specific permission.
    await authorize(request, "payroll.view");
    const body = (await request.json()) as Row;
    const definition = ACTION_MAP[text(body.action)];
    if (!definition) {
      return Response.json(
        { error: "Unknown payroll action" },
        { status: 400 },
      );
    }

    const db = await database();
    return await definition.handler({ request, body, db });
  } catch (error) {
    return authError(error, "Payroll update failed");
  }
}
