import{
  approveAnnualReturn as approveAnnualReturnBase,
  ConfigurationRequired,
  ensureGstAccountingTables,
  generateAnnualReturn as generateAnnualReturnBase,
  generateStatutoryPackage as generateStatutoryPackageBase,
  issueInvoice as issueInvoiceBase,
}from"./gst-accounting";

type Db=D1Database;
type Row=Record<string,unknown>;
const DEFAULT_ENTITY_ID="pawspace_india";
const text=(value:unknown)=>String(value??"").trim();
const num=(value:unknown)=>Number(value??0);
const now=()=>Date.now();
const id=(prefix:string)=>`${prefix}_${crypto.randomUUID().slice(0,16)}`;

async function ensureColumn(db:Db,table:string,column:string,definition:string){
  const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();
  if(!columns.results.some(row=>text(row.name)===column))await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export async function ensureFinanceEntityScope(db:Db){
  await ensureGstAccountingTables(db);
  await ensureColumn(db,"finance_bills","entity_id",`TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}'`);
  await ensureColumn(db,"finance_journal_entries","entity_id",`TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}'`);
  await ensureColumn(db,"finance_expenses","entity_id",`TEXT NOT NULL DEFAULT '${DEFAULT_ENTITY_ID}'`).catch(()=>undefined);
}

async function sha256(value:string){
  const bytes=new TextEncoder().encode(value),digest=await crypto.subtle.digest("SHA-256",bytes);
  return[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("");
}

async function audit(db:Db,actor:string,entityId:string,action:string,after:unknown,reason:string){
  await db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)")
    .bind(id("ga_audit"),"accounting_export",entityId,action,JSON.stringify(after),actor,reason,now()).run();
}

/** The canonical invoice path owns immutable line-identity tax rows; this wrapper only adds entity-scope readiness. */
export async function issueInvoiceSafe(db:Db,input:Row,actor:string){
  await ensureFinanceEntityScope(db);
  return issueInvoiceBase(db,input,actor);
}

/** Recomputes monthly ITC using only bills belonging to the selected legal entity. */
export async function generateStatutoryPackageSafe(db:Db,input:Row,actor:string){
  await ensureFinanceEntityScope(db);
  const result=await generateStatutoryPackageBase(db,input,actor) as Row;
  const entityId=text(input.entityId),period=text(input.periodCode);
  const itc=await db.prepare("SELECT COALESCE(SUM(v.eligible_tax_amount),0) total FROM finance_vendor_tax_reviews v JOIN finance_bills b ON b.id=v.bill_id WHERE b.entity_id=? AND v.review_status='eligible' AND substr(b.bill_date,1,7)=?").bind(entityId,period).first<Row>();
  const summary={...((result.summary??{}) as Row),eligibleInputTax:num(itc?.total)};
  await db.prepare("UPDATE finance_statutory_packages SET summary_json=? WHERE id=?").bind(JSON.stringify(summary),text(result.id)).run();
  return{...result,summary};
}

/** Recomputes annual ITC using entity-scoped bills and preserves the monthly-completeness reconciliation. */
export async function generateAnnualReturnSafe(db:Db,input:Row,actor:string){
  await ensureFinanceEntityScope(db);
  const result=await generateAnnualReturnBase(db,input,actor) as Row;
  const entityId=text(input.entityId),startYear=Number(text(input.financialYear).slice(0,4)),fromPeriod=`${startYear}-04`,toPeriod=`${startYear+1}-03`;
  const itc=await db.prepare("SELECT COALESCE(SUM(v.eligible_tax_amount),0) total FROM finance_vendor_tax_reviews v JOIN finance_bills b ON b.id=v.bill_id WHERE b.entity_id=? AND v.review_status='eligible' AND substr(b.bill_date,1,7) BETWEEN ? AND ?").bind(entityId,fromPeriod,toPeriod).first<Row>();
  const current=(result.summary??{}) as Row,totalEligibleItc=Math.round(num(itc?.total)*100)/100;
  const summary={...current,totalEligibleItc,netTaxPayable:Math.round((num(current.totalOutputTax)+num(current.totalAdjustments)-totalEligibleItc)*100)/100};
  await db.prepare("UPDATE finance_annual_returns SET summary_json=? WHERE id=?").bind(JSON.stringify(summary),text(result.id)).run();
  return{...result,summary};
}

/** Annual approval is fail-closed until all twelve monthly statutory packages are reviewed. */
export async function approveAnnualReturnSafe(db:Db,input:Row,actor:string){
  await ensureFinanceEntityScope(db);
  const row=await db.prepare("SELECT reconciliation_json FROM finance_annual_returns WHERE id=?").bind(text(input.id)).first<Row>();
  if(!row)throw new Error("annual_return_not_found");
  const reconciliation=JSON.parse(text(row.reconciliation_json)||"{}") as {reconciled?:boolean;monthsMissingApprovedMonthlyReturn?:unknown[]};
  if(reconciliation.reconciled!==true||(reconciliation.monthsMissingApprovedMonthlyReturn?.length??0)>0)throw new Error("annual_reconciliation_not_clean");
  return approveAnnualReturnBase(db,input,actor);
}

/** Exports only posted journals for the requested legal entity and period. */
export async function generateAccountingExportSafe(db:Db,input:Row,actor:string){
  await ensureFinanceEntityScope(db);
  const entityId=text(input.entityId),period=text(input.periodCode),target=text(input.target)||"generic";
  if(!entityId||!/^\d{4}-\d{2}$/.test(period))throw new Error("accounting_export_scope_required");
  const mapping=await db.prepare("SELECT * FROM accounting_mapping_versions WHERE entity_id=? AND status='active' AND effective_from<=? ORDER BY version DESC LIMIT 1").bind(entityId,`${period}-31`).first<Row>();
  if(!mapping)throw new ConfigurationRequired("active_accounting_mapping");
  const journals=await db.prepare("SELECT id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code FROM finance_journal_entries WHERE entity_id=? AND period_code=? AND posted=1 ORDER BY created_at,id").bind(entityId,period).all<Row>();
  const snapshot={entityId,period,target,mappingId:text(mapping.id),mappingVersion:num(mapping.version),journals:journals.results},raw=JSON.stringify(snapshot),checksum=await sha256(raw);
  const existing=await db.prepare("SELECT * FROM accounting_export_runs WHERE entity_id=? AND period_code=? AND target=? AND mapping_id=? AND checksum=?").bind(entityId,period,target,text(mapping.id),checksum).first<Row>();
  if(existing)return existing;
  const exportId=id("export");
  await db.prepare("INSERT INTO accounting_export_runs (id,entity_id,period_code,target,mapping_id,source_snapshot_json,checksum,status,generated_by,generated_at) VALUES (?,?,?,?,?,?,?,'generated',?,?)").bind(exportId,entityId,period,target,text(mapping.id),raw,checksum,actor,now()).run();
  await audit(db,actor,exportId,"generated",{entityId,period,target,checksum,mappingId:text(mapping.id),journalCount:journals.results.length,productionPost:false},text(input.reason)||"Generate entity-scoped posted accounting export");
  return{id:exportId,status:"generated",checksum,journalCount:journals.results.length,productionPost:false};
}
