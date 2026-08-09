import{ensurePeopleTables}from"./people-foundation";
import{ensurePayrollTables}from"./payroll-engine";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const validPeriod=(value:string)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const parseJson=(value:unknown)=>{try{return JSON.parse(String(value||"{}")) as unknown;}catch{return{};}};

export const requiredPayrollAccountKeys=[
 "payroll.salary_expense",
 "payroll.reimbursement_expense",
 "payroll.employer_cost_expense",
 "payroll.deductions_payable",
 "payroll.net_pay_payable",
 "payroll.employer_cost_payable",
]as const;

export async function ensurePeopleFinanceTables(db:Db){
 await ensurePeopleTables(db);await ensurePayrollTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_expenses (id text PRIMARY KEY NOT NULL,expense_date text NOT NULL,claimant text NOT NULL,merchant text NOT NULL,category text NOT NULL,cost_centre text NOT NULL,vertical text NOT NULL,amount real NOT NULL,gst_amount real DEFAULT 0 NOT NULL,payment_mode text NOT NULL,receipt_reference text,status text DEFAULT 'submitted' NOT NULL,duplicate_risk integer DEFAULT 0 NOT NULL,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_finance_account_mappings (source_key TEXT PRIMARY KEY,account_code TEXT NOT NULL,approval_reference TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_expense_links (expense_id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,linkage_status TEXT NOT NULL DEFAULT 'linked_uat',detail_json TEXT NOT NULL,reason TEXT NOT NULL,linked_by TEXT NOT NULL,linked_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_payroll_finance_posts (payroll_run_id TEXT PRIMARY KEY,journal_group_id TEXT NOT NULL UNIQUE,period_code TEXT NOT NULL,total_debit REAL NOT NULL,total_credit REAL NOT NULL,status TEXT NOT NULL DEFAULT 'posted_uat',posted_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_statutory_policy_versions (id TEXT PRIMARY KEY,policy_code TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active_uat',effective_from INTEGER NOT NULL,effective_until INTEGER,config_json TEXT NOT NULL,approval_reference TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(policy_code,version))"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_statutory_exports (id TEXT PRIMARY KEY,payroll_run_id TEXT NOT NULL,policy_version_id TEXT NOT NULL,period_code TEXT NOT NULL,payload_json TEXT NOT NULL,sandbox_only INTEGER NOT NULL DEFAULT 1,external_submission INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(payroll_run_id,policy_version_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS people_bank_reconciliation_refs (id TEXT PRIMARY KEY,payroll_batch_id TEXT NOT NULL UNIQUE,period_code TEXT NOT NULL,sandbox_reference TEXT NOT NULL,expected_amount REAL NOT NULL,matched_amount REAL NOT NULL,status TEXT NOT NULL,sandbox_only INTEGER NOT NULL DEFAULT 1,external_transmission INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 ]);
}

async function assertPeriodOpen(db:Db,periodCode:string){
 if(!validPeriod(periodCode))throw new Error("A valid finance period code YYYY-MM is required");
 const row=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(periodCode).first<Row>();
 if(text(row?.status)==="locked")throw new Error("period_locked");
}

export async function configurePayrollAccountMapping(db:Db,input:{sourceKey:string;accountCode:string;approvalReference:string;actorId:string}){
 await ensurePeopleFinanceTables(db);
 if(!requiredPayrollAccountKeys.includes(input.sourceKey as (typeof requiredPayrollAccountKeys)[number]))throw new Error("Unsupported payroll finance mapping key");
 if(!input.accountCode.trim())throw new Error("Finance account code is required");
 if(input.approvalReference.trim().length<4)throw new Error("Finance approval reference is required");
 const now=Date.now();
 await db.prepare("INSERT INTO people_finance_account_mappings (source_key,account_code,approval_reference,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET account_code=excluded.account_code,approval_reference=excluded.approval_reference,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(input.sourceKey,input.accountCode.trim(),input.approvalReference.trim(),input.actorId,now).run();
 return db.prepare("SELECT * FROM people_finance_account_mappings WHERE source_key=?").bind(input.sourceKey).first<Row>();
}

export async function linkExpenseToEmployee(db:Db,input:{expenseId:string;employeeId:string;reason:string;actorId:string}){
 await ensurePeopleFinanceTables(db);
 if(input.reason.trim().length<8)throw new Error("A clear expense linkage reason is required");
 const expense=await db.prepare("SELECT * FROM finance_expenses WHERE id=?").bind(input.expenseId).first<Row>();
 if(!expense)throw new Error("Finance expense not found");
 await assertPeriodOpen(db,text(expense.expense_date).slice(0,7));
 const employee=await db.prepare("SELECT id,employee_code,work_email FROM employees WHERE id=? AND employment_status='active'").bind(input.employeeId).first<Row>();
 if(!employee)throw new Error("Active employee not found");
 const prior=await db.prepare("SELECT * FROM people_expense_links WHERE expense_id=?").bind(input.expenseId).first<Row>();
 if(prior){if(text(prior.employee_id)===input.employeeId)return{link:prior,duplicatePrevented:true};throw new Error("Expense already linked; use an explicit correction workflow");}
 const employment=await db.prepare("SELECT cost_centre_code,team_code,location_code FROM employee_employment_versions WHERE employee_id=? AND effective_until IS NULL ORDER BY version DESC LIMIT 1").bind(input.employeeId).first<Row>();
 const detail={employeeCode:employee.employee_code,workEmail:employee.work_email,expenseDate:expense.expense_date,merchant:expense.merchant,amount:expense.amount,expenseCostCentre:expense.cost_centre,employeeCostCentre:employment?.cost_centre_code??null,teamCode:employment?.team_code??null,locationCode:employment?.location_code??null};
 const now=Date.now();
 await db.prepare("INSERT INTO people_expense_links (expense_id,employee_id,detail_json,reason,linked_by,linked_at) VALUES (?,?,?,?,?,?)").bind(input.expenseId,input.employeeId,JSON.stringify(detail),input.reason.trim(),input.actorId,now).run();
 return{link:await db.prepare("SELECT * FROM people_expense_links WHERE expense_id=?").bind(input.expenseId).first<Row>(),duplicatePrevented:false};
}

export async function saveStatutoryPolicy(db:Db,input:{policyCode:string;effectiveFrom:number;config:Record<string,unknown>;approvalReference:string;actorId:string}){
 await ensurePeopleFinanceTables(db);
 if(!input.policyCode.trim())throw new Error("Statutory policy code is required");
 if(!Number.isFinite(input.effectiveFrom)||input.effectiveFrom<=0)throw new Error("Statutory policy effective date is required");
 if(!input.config||!Object.keys(input.config).length)throw new Error("Explicit statutory configuration is required");
 if(input.approvalReference.trim().length<4)throw new Error("Statutory approval reference is required");
 const prior=await db.prepare("SELECT * FROM people_statutory_policy_versions WHERE policy_code=? ORDER BY version DESC LIMIT 1").bind(input.policyCode.trim()).first<Row>();
 if(prior&&Number(prior.effective_from)>=input.effectiveFrom)throw new Error("Statutory policy effective date must follow the current version");
 if(prior)await db.prepare("UPDATE people_statutory_policy_versions SET effective_until=? WHERE id=? AND effective_until IS NULL").bind(input.effectiveFrom-1,prior.id).run();
 const version=Number(prior?.version||0)+1,id=uid("STATPOL"),now=Date.now();
 await db.prepare("INSERT INTO people_statutory_policy_versions (id,policy_code,version,status,effective_from,config_json,approval_reference,created_by,created_at) VALUES (?,?,?,'active_uat',?,?,?,?,?)").bind(id,input.policyCode.trim(),version,input.effectiveFrom,JSON.stringify(input.config),input.approvalReference.trim(),input.actorId,now).run();
 return db.prepare("SELECT * FROM people_statutory_policy_versions WHERE id=?").bind(id).first<Row>();
}

async function payrollMappings(db:Db){
 const rows=await db.prepare("SELECT source_key,account_code FROM people_finance_account_mappings").all<Row>(),map=new Map<string,string>();
 for(const row of rows.results)map.set(text(row.source_key),text(row.account_code));
 const missing=requiredPayrollAccountKeys.filter(key=>!map.get(key));
 if(missing.length)throw new Error(`configuration_required: finance account mapping missing for ${missing.join(", ")}`);
 return map;
}

export async function postPayrollJournal(db:Db,input:{runId:string;periodCode:string;actorId:string}){
 await ensurePeopleFinanceTables(db);await assertPeriodOpen(db,input.periodCode);
 const prior=await db.prepare("SELECT * FROM people_payroll_finance_posts WHERE payroll_run_id=?").bind(input.runId).first<Row>();
 if(prior)return{post:prior,duplicatePrevented:true};
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();
 if(!run||!["approved","payment_prepared"].includes(text(run.status)))throw new Error("Approved payroll is required before Finance posting");
 const totals=await db.prepare("SELECT COUNT(*) employee_count,COALESCE(SUM(gross_earnings),0) gross_earnings,COALESCE(SUM(total_deductions),0) total_deductions,COALESCE(SUM(reimbursements),0) reimbursements,COALESCE(SUM(employer_cost),0) employer_cost,COALESCE(SUM(net_pay),0) net_pay FROM employee_payroll_results WHERE run_id=?").bind(input.runId).first<Row>();
 if(Number(totals?.employee_count||0)<=0)throw new Error("Payroll results are required before Finance posting");
 const mappings=await payrollMappings(db),journalGroup=uid("PAYJRN"),entryDate=new Date(Number(run.period_end)).toISOString().slice(0,10),now=Date.now();
 const lines=[
  {key:"payroll.salary_expense",debit:money(totals?.gross_earnings),credit:0,label:"Payroll salary expense"},
  {key:"payroll.reimbursement_expense",debit:money(totals?.reimbursements),credit:0,label:"Payroll reimbursements"},
  {key:"payroll.employer_cost_expense",debit:money(totals?.employer_cost),credit:0,label:"Payroll employer cost"},
  {key:"payroll.deductions_payable",debit:0,credit:money(totals?.total_deductions),label:"Payroll deductions payable"},
  {key:"payroll.net_pay_payable",debit:0,credit:money(totals?.net_pay),label:"Payroll net pay payable"},
  {key:"payroll.employer_cost_payable",debit:0,credit:money(totals?.employer_cost),label:"Payroll employer cost payable"},
 ].filter(line=>line.debit!==0||line.credit!==0);
 const totalDebit=money(lines.reduce((sum,line)=>sum+line.debit,0)),totalCredit=money(lines.reduce((sum,line)=>sum+line.credit,0));
 if(Math.abs(totalDebit-totalCredit)>.01)throw new Error("Payroll Finance journal is not balanced");
 const statements=lines.map((line,index)=>db.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?,1,?)").bind(`${journalGroup}-${index+1}`,entryDate,"payroll_run",input.runId,mappings.get(line.key),line.debit,line.credit,line.label,input.periodCode,now));
 statements.push(db.prepare("INSERT INTO people_payroll_finance_posts (payroll_run_id,journal_group_id,period_code,total_debit,total_credit,status,posted_by,created_at) VALUES (?,?,?,?,?,'posted_uat',?,?)").bind(input.runId,journalGroup,input.periodCode,totalDebit,totalCredit,input.actorId,now));
 await db.batch(statements);
 return{post:await db.prepare("SELECT * FROM people_payroll_finance_posts WHERE payroll_run_id=?").bind(input.runId).first<Row>(),duplicatePrevented:false};
}

export async function createSandboxStatutoryExport(db:Db,input:{runId:string;policyVersionId:string;periodCode:string;actorId:string}){
 await ensurePeopleFinanceTables(db);await assertPeriodOpen(db,input.periodCode);
 const prior=await db.prepare("SELECT * FROM people_statutory_exports WHERE payroll_run_id=? AND policy_version_id=?").bind(input.runId,input.policyVersionId).first<Row>();
 if(prior)return{exportRecord:prior,duplicatePrevented:true};
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();
 if(!run||!["approved","payment_prepared"].includes(text(run.status)))throw new Error("Approved payroll is required before statutory sandbox export");
 const policy=await db.prepare("SELECT * FROM people_statutory_policy_versions WHERE id=? AND status='active_uat'").bind(input.policyVersionId).first<Row>();
 if(!policy)throw new Error("Active UAT statutory policy version is required");
 if(Number(policy.effective_from)>Number(run.period_end)||(policy.effective_until!=null&&Number(policy.effective_until)<Number(run.period_start)))throw new Error("Statutory policy is not effective for this payroll run");
 const totals=await db.prepare("SELECT COUNT(*) employee_count,COALESCE(SUM(gross_earnings),0) gross_earnings,COALESCE(SUM(total_deductions),0) total_deductions,COALESCE(SUM(reimbursements),0) reimbursements,COALESCE(SUM(employer_cost),0) employer_cost,COALESCE(SUM(net_pay),0) net_pay FROM employee_payroll_results WHERE run_id=?").bind(input.runId).first<Row>();
 const payload={format:"pawspace_statutory_sandbox_v1",sandboxOnly:true,externalSubmission:false,submissionReady:false,periodCode:input.periodCode,payroll:{runId:input.runId,periodStart:run.period_start,periodEnd:run.period_end,employeeCount:Number(totals?.employee_count||0),grossEarnings:money(totals?.gross_earnings),totalDeductions:money(totals?.total_deductions),reimbursements:money(totals?.reimbursements),employerCost:money(totals?.employer_cost),netPay:money(totals?.net_pay)},policy:{id:policy.id,policyCode:policy.policy_code,version:policy.version,approvalReference:policy.approval_reference,config:parseJson(policy.config_json)}};
 const id=uid("STATEXP"),now=Date.now();
 await db.prepare("INSERT INTO people_statutory_exports (id,payroll_run_id,policy_version_id,period_code,payload_json,sandbox_only,external_submission,created_by,created_at) VALUES (?,?,?,?,?,1,0,?,?)").bind(id,input.runId,input.policyVersionId,input.periodCode,JSON.stringify(payload),input.actorId,now).run();
 return{exportRecord:await db.prepare("SELECT * FROM people_statutory_exports WHERE id=?").bind(id).first<Row>(),payload,duplicatePrevented:false};
}

export async function recordSandboxBankReconciliation(db:Db,input:{payrollBatchId:string;periodCode:string;sandboxReference:string;matchedAmount:number;actorId:string}){
 await ensurePeopleFinanceTables(db);await assertPeriodOpen(db,input.periodCode);
 if(input.sandboxReference.trim().length<4)throw new Error("Sandbox reconciliation reference is required");
 if(!Number.isFinite(input.matchedAmount)||input.matchedAmount<0)throw new Error("Matched amount must be zero or positive");
 const batch=await db.prepare("SELECT * FROM payroll_payment_batches WHERE id=?").bind(input.payrollBatchId).first<Row>();
 if(!batch||text(batch.status)!=="sandbox_prepared"||Number(batch.external_transmission)!==0)throw new Error("Sandbox payroll payment batch is required");
 const prior=await db.prepare("SELECT * FROM people_bank_reconciliation_refs WHERE payroll_batch_id=?").bind(input.payrollBatchId).first<Row>();
 if(prior){if(text(prior.sandbox_reference)===input.sandboxReference.trim()&&money(prior.matched_amount)===money(input.matchedAmount))return{reconciliation:prior,duplicatePrevented:true};throw new Error("Reconciliation already recorded; use an explicit correction workflow");}
 const expected=money(batch.total_amount),matched=money(input.matchedAmount),status=Math.abs(expected-matched)<=.01?"matched_uat":"exception_uat",id=uid("BANKREC"),now=Date.now();
 await db.prepare("INSERT INTO people_bank_reconciliation_refs (id,payroll_batch_id,period_code,sandbox_reference,expected_amount,matched_amount,status,sandbox_only,external_transmission,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,0,?,?)").bind(id,input.payrollBatchId,input.periodCode,input.sandboxReference.trim(),expected,matched,status,input.actorId,now).run();
 return{reconciliation:await db.prepare("SELECT * FROM people_bank_reconciliation_refs WHERE id=?").bind(id).first<Row>(),duplicatePrevented:false};
}

export async function peopleFinanceDirectory(db:Db){
 await ensurePeopleFinanceTables(db);
 const [mappings,expenseLinks,payrollPosts,statutoryPolicies,statutoryExports,bankReconciliations,periods]=await Promise.all([
  db.prepare("SELECT * FROM people_finance_account_mappings ORDER BY source_key").all<Row>(),
  db.prepare("SELECT l.*,e.employee_code,x.merchant,x.amount,x.expense_date FROM people_expense_links l LEFT JOIN employees e ON e.id=l.employee_id LEFT JOIN finance_expenses x ON x.id=l.expense_id ORDER BY l.linked_at DESC LIMIT 50").all<Row>(),
  db.prepare("SELECT * FROM people_payroll_finance_posts ORDER BY created_at DESC LIMIT 30").all<Row>(),
  db.prepare("SELECT * FROM people_statutory_policy_versions ORDER BY policy_code,version DESC LIMIT 30").all<Row>(),
  db.prepare("SELECT id,payroll_run_id,policy_version_id,period_code,sandbox_only,external_submission,created_by,created_at FROM people_statutory_exports ORDER BY created_at DESC LIMIT 30").all<Row>(),
  db.prepare("SELECT * FROM people_bank_reconciliation_refs ORDER BY created_at DESC LIMIT 30").all<Row>(),
  db.prepare("SELECT * FROM finance_close_periods ORDER BY period_code DESC LIMIT 18").all<Row>(),
 ]);
 const configured=new Set(mappings.results.map(row=>text(row.source_key))),missingPayrollAccountMappings=requiredPayrollAccountKeys.filter(key=>!configured.has(key));
 return{mappings:mappings.results,expenseLinks:expenseLinks.results,payrollPosts:payrollPosts.results,statutoryPolicies:statutoryPolicies.results,statutoryExports:statutoryExports.results,bankReconciliations:bankReconciliations.results,periods:periods.results,requiredPayrollAccountKeys,truth:{expenseEmployeeLinkageEnabled:true,payrollJournalConfigured:missingPayrollAccountMappings.length===0,missingPayrollAccountMappings,statutoryPolicyConfigured:statutoryPolicies.results.some(row=>text(row.status)==="active_uat"),financePeriodLockingEnforced:true,statutoryExternalSubmissionEnabled:false,liveBankTransmissionEnabled:false,bankReconciliationMode:"sandbox_reference_only",sandboxOnly:true,productionReady:false}};
}
