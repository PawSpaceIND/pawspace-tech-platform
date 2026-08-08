import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{configurePayrollAccountMapping,createSandboxStatutoryExport,linkExpenseToEmployee,peopleFinanceDirectory,postPayrollJournal,recordSandboxBankReconciliation,saveStatutoryPolicy}from"../../../lib/people-finance-integration";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();

export async function GET(request:Request){try{await authorize(request,"finance.view");const db=await database();return Response.json({data:await peopleFinanceDirectory(db),productionReady:false});}catch(error){return authError(error,"Unable to load People Finance integration");}}

export async function POST(request:Request){try{const body=await request.json() as Row,action=text(body.action),actor=await authorize(request,"finance.manage"),db=await database();let result:unknown,resourceType="people_finance",resourceId:string|null=null;
 if(action==="configure_account"){result=await configurePayrollAccountMapping(db,{sourceKey:text(body.sourceKey),accountCode:text(body.accountCode),approvalReference:text(body.approvalReference),actorId:actor.email});resourceType="finance_account_mapping";resourceId=text(body.sourceKey);}
 else if(action==="link_expense"){result=await linkExpenseToEmployee(db,{expenseId:text(body.expenseId),employeeId:text(body.employeeId),reason:text(body.reason),actorId:actor.email});resourceType="employee_expense_link";resourceId=text(body.expenseId);}
 else if(action==="post_payroll_journal"){result=await postPayrollJournal(db,{runId:text(body.runId),periodCode:text(body.periodCode),actorId:actor.email});resourceType="payroll_finance_post";resourceId=text(body.runId);}
 else if(action==="save_statutory_policy"){const config=body.config&&typeof body.config==="object"&&!Array.isArray(body.config)?body.config as Record<string,unknown>:{};result=await saveStatutoryPolicy(db,{policyCode:text(body.policyCode),effectiveFrom:Number(body.effectiveFrom),config,approvalReference:text(body.approvalReference),actorId:actor.email});resourceType="statutory_policy";resourceId=text((result as Row)?.id);}
 else if(action==="create_statutory_export"){result=await createSandboxStatutoryExport(db,{runId:text(body.runId),policyVersionId:text(body.policyVersionId),periodCode:text(body.periodCode),actorId:actor.email});resourceType="statutory_export";resourceId=text(body.runId);}
 else if(action==="record_bank_reconciliation"){result=await recordSandboxBankReconciliation(db,{payrollBatchId:text(body.payrollBatchId),periodCode:text(body.periodCode),sandboxReference:text(body.sandboxReference),matchedAmount:Number(body.matchedAmount),actorId:actor.email});resourceType="bank_reconciliation";resourceId=text(body.payrollBatchId);}
 else return Response.json({error:"Unknown People Finance action"},{status:400});
 await securityAudit(db,actor,`people_finance.${action}`,resourceType,resourceId,"completed",{sandboxOnly:true});return Response.json({data:result,productionReady:false});}catch(error){return authError(error,"People Finance update failed");}}
