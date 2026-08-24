import{findExpenseCategory}from"../../../lib/chart-of-accounts";
import{financeControlSummary,financeSourceStatus}from"../../../lib/finance-control-summary";
import{listIntegrationReadiness}from"../../../lib/integration-readiness";
import{ensureFinanceEntityScope}from"../../../lib/finance-filing-closeout";
import{repairSchemaDrift}from"../../../lib/schema-drift-repair";
import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{uatLoginEnabled}from"../../../lib/uat-staging-auth";

type Db=Awaited<ReturnType<typeof database>>;
type Row=Record<string,unknown>;
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store"}});
const id=(prefix:string)=>`${prefix}_${crypto.randomUUID().slice(0,12)}`;
const DEFAULT_ENTITY_ID="pawspace_india";
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}
function finite(value:unknown,fallback?:number){const parsed=value===undefined&&fallback!==undefined?fallback:Number(value);return Number.isFinite(parsed)?parsed:null;}

async function ensureColumn(db:Db,table:"finance_expenses"|"finance_bills",column:"category_code"|"created_by"){
 const exists=async()=>{const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();return columns.results.some(row=>String(row.name)===column);};
 if(await exists())return;
 try{await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} text`).run();}
 catch(error){if(!(await exists()))throw error;}
}

async function ensureSchema(db:Db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_expenses (id text PRIMARY KEY NOT NULL,expense_date text NOT NULL,claimant text NOT NULL,merchant text NOT NULL,category text NOT NULL,cost_centre text NOT NULL,vertical text NOT NULL,amount real NOT NULL,gst_amount real DEFAULT 0 NOT NULL,payment_mode text NOT NULL,receipt_reference text,status text DEFAULT 'submitted' NOT NULL,duplicate_risk integer DEFAULT 0 NOT NULL,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_vendors (id text PRIMARY KEY NOT NULL,name text NOT NULL,gstin text,pan text,payment_terms_days integer DEFAULT 30 NOT NULL,bank_reference text,tds_section text,status text DEFAULT 'active' NOT NULL,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_bills (id text PRIMARY KEY NOT NULL,vendor_id text NOT NULL,bill_number text NOT NULL,bill_date text NOT NULL,due_date text NOT NULL,cost_centre text NOT NULL,vertical text NOT NULL,taxable_amount real NOT NULL,gst_amount real NOT NULL,tds_amount real DEFAULT 0 NOT NULL,total_amount real NOT NULL,status text DEFAULT 'draft' NOT NULL,purchase_order_id text,attachment_reference text,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_posting_claims (source_type text NOT NULL,source_id text NOT NULL,claim_token text NOT NULL,created_at integer NOT NULL,PRIMARY KEY(source_type,source_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_bank_transactions (id text PRIMARY KEY NOT NULL,bank_account text NOT NULL,transaction_date text NOT NULL,reference text NOT NULL,description text NOT NULL,amount real NOT NULL,match_type text,matched_source_id text,status text DEFAULT 'unmatched' NOT NULL,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_budgets (id text PRIMARY KEY NOT NULL,period_code text NOT NULL,cost_centre text NOT NULL,vertical text NOT NULL,category text NOT NULL,budget_amount real NOT NULL,alert_threshold real DEFAULT 90 NOT NULL,approved_by text,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_audit_events (id text PRIMARY KEY NOT NULL,entity_type text NOT NULL,entity_id text NOT NULL,action text NOT NULL,before_json text,after_json text NOT NULL,actor_id text NOT NULL,reason text NOT NULL,created_at integer NOT NULL)"),
 ]);
 for(const table of["finance_expenses","finance_bills"]as const){await ensureColumn(db,table,"category_code");await ensureColumn(db,table,"created_by");}
 await repairSchemaDrift(db);
 await ensureFinanceEntityScope(db);
 await db.prepare("INSERT OR IGNORE INTO finance_journal_posting_claims (source_type,source_id,claim_token,created_at) SELECT source_type,source_id,'legacy:'||source_type||':'||source_id,MIN(created_at) FROM finance_journal_entries GROUP BY source_type,source_id").run();
}

function resolveAccountCode(categoryCode:string|undefined,fallback:string){if(!categoryCode)return fallback;const entry=findExpenseCategory(categoryCode);return entry?entry.accountCode:fallback;}
async function audit(db:Db,actor:string,entityType:string,entityId:string,action:string,after:unknown,reason:string){await db.prepare("INSERT INTO finance_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)").bind(id("fin_audit"),entityType,entityId,action,JSON.stringify(after),actor,reason,Date.now()).run();}
async function periodLocked(db:Db,date:string){const code=date.slice(0,7);const row=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(code).first<{status:string}>();return row?.status==="locked";}

type ApprovalInput={table:"finance_expenses"|"finance_bills";dateColumn:"expense_date"|"bill_date";sourceType:"expense"|"vendor_bill";sourceId:string;actor:string;entityId:string;date:string;debitAccount:string;creditAccount:string;amount:number;narration:string;costCentre:string;vertical:string;changedAt:number};
async function approveWithJournal(db:Db,input:ApprovalInput){
 const period=input.date.slice(0,7),claimToken=crypto.randomUUID(),createdAt=Date.now(),group=id("journal");
 const eligible=`EXISTS (SELECT 1 FROM ${input.table} WHERE id=? AND status NOT IN ('approved','paid','rejected') AND (created_by IS NULL OR created_by<>?)) AND NOT EXISTS (SELECT 1 FROM finance_close_periods WHERE period_code=? AND status='locked')`;
 const claim=db.prepare(`INSERT INTO finance_journal_posting_claims (source_type,source_id,claim_token,created_at) SELECT ?,?,?,? WHERE ${eligible}`).bind(input.sourceType,input.sourceId,claimToken,createdAt,input.sourceId,input.actor,period);
 const journal=(suffix:number,account:string,debit:number,credit:number)=>db.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM finance_journal_posting_claims WHERE source_type=? AND source_id=? AND claim_token=?").bind(`${group}_${suffix}`,input.entityId,input.date,input.sourceType,input.sourceId,account,input.costCentre,input.vertical,debit,credit,input.narration,period,1,createdAt,input.sourceType,input.sourceId,claimToken);
 const transition=db.prepare(`UPDATE ${input.table} SET status='approved',updated_at=? WHERE id=? AND status NOT IN ('approved','paid','rejected') AND EXISTS (SELECT 1 FROM finance_journal_posting_claims WHERE source_type=? AND source_id=? AND claim_token=?)`).bind(input.changedAt,input.sourceId,input.sourceType,input.sourceId,claimToken);
 let results;
 try{results=await db.batch([claim,journal(1,input.debitAccount,input.amount,0),journal(2,input.creditAccount,0,input.amount),transition]);}
 catch(error){const message=error instanceof Error?error.message:String(error);if(/finance_journal_posting_claims|UNIQUE constraint failed.*source_type.*source_id/i.test(message))throw new Error("journal_already_posted");throw error;}
 if(!Number(results[0]?.meta?.changes)||!Number(results[3]?.meta?.changes)){
  const current=await db.prepare(`SELECT status,created_by,${input.dateColumn} transaction_date FROM ${input.table} WHERE id=?`).bind(input.sourceId).first<Row>();
  if(current?.created_by&&String(current.created_by)===input.actor)throw new Error("maker_cannot_approve");
  if(current&&await periodLocked(db,String(current.transaction_date||input.date)))throw new Error("period_locked");
  const status=String(current?.status||"");if(["approved","paid"].includes(status))return{duplicatePrevented:true,status};
  throw new Error("approval_conflict");
 }
 return{duplicatePrevented:false,status:"approved"};
}

async function seed(db:Db){
 await ensureSchema(db);
 const{env}=await import("cloudflare:workers");
 if(!uatLoginEnabled(env as unknown as Record<string,unknown>))return;
 const createdAt=Date.now(),seedActor="uat-seed@pawspace.invalid";
 const vendors=[["ven_fuel","Shell Fleet Services","29AAACS0001A1Z5","194C"],["ven_food","Happy Tails Foods","29AAHFT2201B1Z9","194Q"],["ven_software","Cloud Software India","29AABCC2233D1ZA","194J"]]as const;
 for(const vendor of vendors)await db.prepare("INSERT OR IGNORE INTO finance_vendors (id,name,gstin,pan,payment_terms_days,bank_reference,tds_section,status,created_at,updated_at) VALUES (?,?,?,NULL,30,'masked',?,'active',?,?)").bind(vendor[0],vendor[1],vendor[2],vendor[3],createdAt,createdAt).run();
 await db.prepare("INSERT OR IGNORE INTO finance_expenses (id,entity_id,expense_date,claimant,merchant,category,cost_centre,vertical,amount,gst_amount,payment_mode,receipt_reference,status,duplicate_risk,created_by,created_at,updated_at) VALUES ('exp_1001',?,'2026-08-02','Arun K','Shell','Travel & fuel','Bengaluru Ops','Grooming',2840,433,'Corporate card','RCPT-8421','approval_due',0,?,?,?)").bind(DEFAULT_ENTITY_ID,seedActor,createdAt,createdAt).run();
 await db.prepare("INSERT OR IGNORE INTO finance_expenses (id,entity_id,expense_date,claimant,merchant,category,cost_centre,vertical,amount,gst_amount,payment_mode,receipt_reference,status,duplicate_risk,created_by,created_at,updated_at) VALUES ('exp_1002',?,'2026-08-01','Priya S','Quick Print','Marketing collateral','Growth','All verticals',11800,1800,'Employee paid','INV-QP-118','held',1,?,?,?)").bind(DEFAULT_ENTITY_ID,seedActor,createdAt,createdAt).run();
 await db.prepare("INSERT OR IGNORE INTO finance_bills (id,entity_id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,tds_amount,total_amount,status,purchase_order_id,attachment_reference,created_by,created_at,updated_at) VALUES ('bill_2001',?,'ven_food','HTF-882','2026-07-28','2026-08-12','Boarding Ops','Boarding',48000,8640,0,56640,'approval_due','PO-2241','receipt://uat/htf-882',?,?,?)").bind(DEFAULT_ENTITY_ID,seedActor,createdAt,createdAt).run();
 await db.prepare("INSERT OR IGNORE INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-07','review','[\"Bank reconciled\",\"GST reviewed\",\"Payroll posted\",\"Accruals approved\"]',NULL,NULL,?)").bind(createdAt).run();
}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"finance.view");const db=await database();await seed(db);const[expenses,bills,vendors,journals,bank,budgets,periods,audits]=await Promise.all([
 db.prepare("SELECT * FROM finance_expenses ORDER BY updated_at DESC LIMIT 50").all(),db.prepare("SELECT b.*,v.name vendor_name FROM finance_bills b LEFT JOIN finance_vendors v ON v.id=b.vendor_id ORDER BY b.updated_at DESC LIMIT 50").all(),db.prepare("SELECT * FROM finance_vendors ORDER BY name").all(),db.prepare("SELECT * FROM finance_journal_entries ORDER BY created_at DESC LIMIT 60").all(),db.prepare("SELECT * FROM finance_bank_transactions ORDER BY updated_at DESC LIMIT 50").all(),db.prepare("SELECT * FROM finance_budgets ORDER BY period_code DESC LIMIT 50").all(),db.prepare("SELECT * FROM finance_close_periods ORDER BY period_code DESC").all(),db.prepare("SELECT * FROM finance_audit_events ORDER BY created_at DESC LIMIT 30").all()]);
 const registry=await listIntegrationReadiness(db).catch(()=>({items:[] as Array<Record<string,unknown>>}));
 const summary=financeControlSummary({expenses:expenses.results as never,bills:bills.results as never,journals:journals.results as never,bank:bank.results as never});
 return json({data:{expenses:expenses.results,bills:bills.results,vendors:vendors.results,journals:journals.results,bank:bank.results,budgets:budgets.results,periods:periods.results,audits:audits.results,summary,sourceStatus:financeSourceStatus(registry.items as never)},actor:{email:actor.email,roleCode:actor.roleCode}});}catch(error){return authError(error,"Unable to load finance control");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database();await seed(db);const body=await request.json()as Record<string,unknown>,entity=String(body.entity??""),entityId=String(body.entityId??DEFAULT_ENTITY_ID),createdAt=Date.now();
 if(entity==="expense"){
  const amount=finite(body.amount),gst=finite(body.gstAmount,0),date=String(body.expenseDate??"");
  if(!date||!body.merchant||!body.category||amount===null||amount<=0||gst===null||gst<0)return json({error:"Date, merchant, category and finite non-negative amounts are required"},400);
  if(await periodLocked(db,date))return json({error:"period_locked"},409);
  const expenseId=id("exp"),duplicate=await db.prepare("SELECT id FROM finance_expenses WHERE entity_id=? AND merchant=? AND amount=? AND expense_date=? LIMIT 1").bind(entityId,body.merchant,amount,date).first();
  await db.prepare("INSERT INTO finance_expenses (id,entity_id,expense_date,claimant,merchant,category,category_code,cost_centre,vertical,amount,gst_amount,payment_mode,receipt_reference,status,duplicate_risk,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(expenseId,entityId,date,body.claimant??actor.email,body.merchant,body.category,body.categoryCode??null,body.costCentre??"Bengaluru Ops",body.vertical??"All verticals",amount,gst,body.paymentMode??"Employee paid",body.receiptReference??null,duplicate?"held":"submitted",duplicate?1:0,actor.email,createdAt,createdAt).run();
  await audit(db,actor.email,"expense",expenseId,"created",body,"Expense submitted");await securityAudit(db,actor,"finance.expense.create","expense",expenseId,"completed",{entityId});return json({data:{id:expenseId,status:duplicate?"held":"submitted",duplicateRisk:Boolean(duplicate)}},201);
 }
 if(entity==="bill"){
  const total=finite(body.totalAmount),taxable=finite(body.taxableAmount,total??undefined),gst=finite(body.gstAmount,0),tds=finite(body.tdsAmount,0),date=String(body.billDate??"");
  if(!date||!body.vendorId||!body.billNumber||total===null||total<=0||taxable===null||taxable<0||gst===null||gst<0||tds===null||tds<0)return json({error:"Vendor, bill number, date and finite non-negative amounts are required"},400);
  if(await periodLocked(db,date))return json({error:"period_locked"},409);
  const billId=id("bill");await db.prepare("INSERT INTO finance_bills (id,entity_id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,tds_amount,total_amount,status,purchase_order_id,attachment_reference,category_code,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(billId,entityId,body.vendorId,body.billNumber,date,body.dueDate??date,body.costCentre??"Bengaluru Ops",body.vertical??"All verticals",taxable,gst,tds,total,"draft",body.purchaseOrderId??null,body.attachmentReference??null,body.categoryCode??null,actor.email,createdAt,createdAt).run();
  await audit(db,actor.email,"bill",billId,"created",body,"Vendor bill created");await securityAudit(db,actor,"finance.bill.create","bill",billId,"completed",{entityId});return json({data:{id:billId,status:"draft"}},201);
 }
 return json({error:"Unsupported finance entity"},400);
 }catch(error){return authError(error,"Finance save failed");}}

export async function PATCH(request:Request){try{sameOrigin(request);const actor=await resolveActor(request);requirePermission(actor,"finance.manage");const db=await database();await seed(db);const body=await request.json()as{entity?:string;id?:string;action?:string;reason?:string};if(!body.id||!body.action||!body.reason||body.reason.trim().length<5)return json({error:"A reason of at least 5 characters is required"},400);const changedAt=Date.now();
 if(body.entity==="expense"){
  if(!["approve","reject","pay"].includes(body.action))return json({error:"Unsupported expense action"},400);
  const row=await db.prepare("SELECT * FROM finance_expenses WHERE id=?").bind(body.id).first<Row>();if(!row)return json({error:"Expense not found"},404);const currentStatus=String(row.status||"");
  if(body.action==="approve"){
   if(row.created_by&&String(row.created_by)===actor.email)return json({error:"Maker cannot approve their own transaction"},403);
   if(["approved","paid"].includes(currentStatus))return json({data:{id:body.id,status:currentStatus,duplicatePrevented:true}});
   if(currentStatus==="rejected")return json({error:"Rejected expense cannot be approved without a new submission"},409);
   const result=await approveWithJournal(db,{table:"finance_expenses",dateColumn:"expense_date",sourceType:"expense",sourceId:body.id,actor:actor.email,entityId:String(row.entity_id||DEFAULT_ENTITY_ID),date:String(row.expense_date),debitAccount:resolveAccountCode(row.category_code?String(row.category_code):undefined,"6200-Operating expense"),creditAccount:"2100-Expense payable",amount:Number(row.amount),narration:String(row.merchant),costCentre:String(row.cost_centre),vertical:String(row.vertical),changedAt});
   if(result.duplicatePrevented)return json({data:{id:body.id,status:result.status,duplicatePrevented:true}});
   await audit(db,actor.email,"expense",body.id,"approve",{status:"approved"},body.reason);await securityAudit(db,actor,"finance.expense.approve","expense",body.id,"completed",{});return json({data:{id:body.id,status:"approved"}});
  }
  if(body.action==="pay"){
   if(currentStatus==="paid")return json({data:{id:body.id,status:"paid",duplicatePrevented:true}});
   if(currentStatus!=="approved")return json({error:"Expense must be approved before payment"},409);
   const result=await db.prepare("UPDATE finance_expenses SET status='paid',updated_at=? WHERE id=? AND status='approved'").bind(changedAt,body.id).run();
   if(!Number(result.meta.changes)){const latest=await db.prepare("SELECT status FROM finance_expenses WHERE id=?").bind(body.id).first<Row>();if(String(latest?.status)==="paid")return json({data:{id:body.id,status:"paid",duplicatePrevented:true}});return json({error:"Expense payment state changed concurrently"},409);}
   await audit(db,actor.email,"expense",body.id,"pay",{status:"paid"},body.reason);await securityAudit(db,actor,"finance.expense.pay","expense",body.id,"completed",{});return json({data:{id:body.id,status:"paid"}});
  }
  if(["approved","paid"].includes(currentStatus))return json({error:"Approved or paid expense cannot be rejected"},409);
  const rejected=await db.prepare("UPDATE finance_expenses SET status='rejected',updated_at=? WHERE id=? AND status NOT IN ('approved','paid','rejected')").bind(changedAt,body.id).run();
  if(!Number(rejected.meta.changes)){const latest=await db.prepare("SELECT status FROM finance_expenses WHERE id=?").bind(body.id).first<Row>();return json({error:`Expense can no longer be rejected from ${String(latest?.status||"unknown")}`},409);}
  await audit(db,actor.email,"expense",body.id,"reject",{status:"rejected"},body.reason);await securityAudit(db,actor,"finance.expense.reject","expense",body.id,"completed",{});return json({data:{id:body.id,status:"rejected"}});
 }
 if(body.entity==="bill"){
  if(!["approve","reject","pay"].includes(body.action))return json({error:"Unsupported bill action"},400);
  const row=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(body.id).first<Row>();if(!row)return json({error:"Bill not found"},404);const currentStatus=String(row.status||"");
  if(body.action==="approve"){
   if(row.created_by&&String(row.created_by)===actor.email)return json({error:"Maker cannot approve their own transaction"},403);
   if(["approved","paid"].includes(currentStatus))return json({data:{id:body.id,status:currentStatus,duplicatePrevented:true}});
   if(currentStatus==="rejected")return json({error:"Rejected bill cannot be approved without a new submission"},409);
   const result=await approveWithJournal(db,{table:"finance_bills",dateColumn:"bill_date",sourceType:"vendor_bill",sourceId:body.id,actor:actor.email,entityId:String(row.entity_id||DEFAULT_ENTITY_ID),date:String(row.bill_date),debitAccount:resolveAccountCode(row.category_code?String(row.category_code):undefined,"6300-Vendor expense"),creditAccount:"2200-Accounts payable",amount:Number(row.total_amount),narration:String(row.bill_number),costCentre:String(row.cost_centre),vertical:String(row.vertical),changedAt});
   if(result.duplicatePrevented)return json({data:{id:body.id,status:result.status,duplicatePrevented:true}});
   await audit(db,actor.email,"bill",body.id,"approve",{status:"approved"},body.reason);await securityAudit(db,actor,"finance.bill.approve","bill",body.id,"completed",{});return json({data:{id:body.id,status:"approved"}});
  }
  if(body.action==="pay"){
   if(currentStatus==="paid")return json({data:{id:body.id,status:"paid",duplicatePrevented:true}});
   if(currentStatus!=="approved")return json({error:"Bill must be approved before payment"},409);
   const result=await db.prepare("UPDATE finance_bills SET status='paid',updated_at=? WHERE id=? AND status='approved'").bind(changedAt,body.id).run();
   if(!Number(result.meta.changes)){const latest=await db.prepare("SELECT status FROM finance_bills WHERE id=?").bind(body.id).first<Row>();if(String(latest?.status)==="paid")return json({data:{id:body.id,status:"paid",duplicatePrevented:true}});return json({error:"Bill payment state changed concurrently"},409);}
   await audit(db,actor.email,"bill",body.id,"pay",{status:"paid"},body.reason);await securityAudit(db,actor,"finance.bill.pay","bill",body.id,"completed",{});return json({data:{id:body.id,status:"paid"}});
  }
  if(["approved","paid"].includes(currentStatus))return json({error:"Approved or paid bill cannot be rejected"},409);
  const rejected=await db.prepare("UPDATE finance_bills SET status='rejected',updated_at=? WHERE id=? AND status NOT IN ('approved','paid','rejected')").bind(changedAt,body.id).run();
  if(!Number(rejected.meta.changes)){const latest=await db.prepare("SELECT status FROM finance_bills WHERE id=?").bind(body.id).first<Row>();return json({error:`Bill can no longer be rejected from ${String(latest?.status||"unknown")}`},409);}
  await audit(db,actor.email,"bill",body.id,"reject",{status:"rejected"},body.reason);await securityAudit(db,actor,"finance.bill.reject","bill",body.id,"completed",{});return json({data:{id:body.id,status:"rejected"}});
 }
 if(body.entity==="period"&&body.action==="lock"){await db.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','[]',?,?,?) ON CONFLICT(period_code) DO UPDATE SET status='locked',locked_at=excluded.locked_at,locked_by=excluded.locked_by,updated_at=excluded.updated_at").bind(body.id,changedAt,actor.email,changedAt).run();await audit(db,actor.email,"period",body.id,"locked",{status:"locked"},body.reason);await securityAudit(db,actor,"finance.period.lock","period",body.id,"completed",{});return json({data:{id:body.id,status:"locked"}});}
 return json({error:"Unsupported finance change"},400);
 }catch(error){const message=error instanceof Error?error.message:"Finance update failed";if(message==="period_locked")return json({error:message},409);if(message==="journal_already_posted")return json({error:"Finance source has already been posted by another approval"},409);if(message==="maker_cannot_approve")return json({error:"Maker cannot approve their own transaction"},403);if(message==="approval_conflict")return json({error:"Finance approval state changed concurrently"},409);return authError(error,"Finance update failed");}}
