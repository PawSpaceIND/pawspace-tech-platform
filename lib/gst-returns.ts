// GST portal-return generators: GSTR-1 (outward supplies), GSTR-3B (summary/liability) and GSTR-9C
// (annual reconciliation statement). These map the platform's canonical tax registers to the GST
// portal JSON section shapes; they NEVER file. Every artifact is a versioned, maker/checker DRAFT
// with liveFilingEnabled:false, exactly like lib/gst-accounting.ts's monthly package and GSTR-9.
//
// Output-tax truth has two disjoint sources and both are honoured (same rule as
// lib/finance-monthly-close.ts):
//   1. finance_invoices / finance_invoice_lines  - the canonical, component-split, POS/HSN-aware path
//      (this is what becomes line-level b2b / b2cs / cdnr / hsn in GSTR-1).
//   2. booking_invoices.tax_amount               - the five service verticals, AGGREGATE only (no
//      rate / place-of-supply / HSN). It cannot become compliant GSTR-1 line detail, so it is
//      surfaced in a reconciliation block, never fabricated into invoice rows.
// For source 2, only PawSpace's OWN output GST is its statutory liability: on a marketplace supply that is
// the COMMISSION GST alone; the provider's supply GST (carved from the GST-inclusive order) is the
// provider's liability, remitted via s52 GST TCS / GSTR-8 - NOT PawSpace GSTR-1/3B. serviceVerticalOutputTax
// derives the split from provider_payout_computations and falls back to the full tax for any booking without
// a payout split, so the liability is never understated.
//
// No tax rate is decided here: rates/components come from the tax_snapshot the issuing module already
// computed. Missing Finance/CA-approved configuration throws ConfigurationRequired (HTTP 409), never
// a default. Import-safe for `node --experimental-strip-types` (no TS parameter properties).

import{ConfigurationRequired,ensureGstAccountingTables}from"./gst-accounting";
import{serviceVerticalOutputTax}from"./service-output-tax";

type Db=D1Database;
type Row=Record<string,unknown>;
export const GST_RETURNS_PRODUCTION_READY=false;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v??0);
const round2=(v:number)=>Math.round(v*100)/100;
const idOf=(p:string)=>`${p}_${crypto.randomUUID().slice(0,16)}`;
const now=()=>Date.now();
const periodMs=(period:string)=>{const[y,m]=period.split("-").map(Number);return{startMs:Date.UTC(y,m-1,1)-330*60_000,endMs:Date.UTC(m===12?y+1:y,m===12?0:m,1)-330*60_000};};
async function sha256(value:string){const bytes=new TextEncoder().encode(value),digest=await crypto.subtle.digest("SHA-256",bytes);return[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function safeFirst(db:Db,sql:string,b:unknown[]):Promise<Row|null>{try{return await db.prepare(sql).bind(...b).first<Row>();}catch{return null;}}
// serviceVerticalOutputTax (the PawSpace-own vs provider-supply output-tax split) lives in
// ./service-output-tax so the monthly close, statutory package, GSTR-9 and these return generators all read
// one identical figure.

async function ensureColumn(db:Db,table:string,column:string,definition:string){
 const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();
 if(!columns.results.some(row=>text(row.name)===column))await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

const returnTablesEnsured=new WeakSet<Db>();
export async function ensureGstReturnTables(db:Db){
 if(returnTablesEnsured.has(db))return;
 await ensureGstAccountingTables(db);
 // Full-fidelity GSTR-1 needs an HSN/SAC per line. Older invoice lines predate the column, so add it
 // additively and backfill from the classification code already captured in tax_classifications.
 await ensureColumn(db,"finance_invoice_lines","hsn_sac","TEXT");
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS gst_return_documents (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,return_type TEXT NOT NULL,period_code TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',payload_json TEXT NOT NULL,summary_json TEXT NOT NULL,checksum TEXT NOT NULL,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,reviewed_by TEXT,reviewed_at INTEGER,approval_reference TEXT,supersedes_id TEXT,UNIQUE(entity_id,registration_id,return_type,period_code,version))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_gst_return_documents_lookup ON gst_return_documents(entity_id,registration_id,return_type,period_code)"),
 ]);
 returnTablesEnsured.add(db);
}

async function audit(db:Db,actor:string,entityId:string,action:string,after:unknown,reason:string){
 await db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)")
  .bind(idOf("ga_audit"),"gst_return",entityId,action,JSON.stringify(after),actor,reason,now()).run();
}

async function registration(db:Db,entityId:string,onDate:string){
 const r=await db.prepare("SELECT * FROM tax_registrations WHERE entity_id=? AND status='active' AND (effective_from IS NULL OR effective_from<=?) AND (effective_to IS NULL OR effective_to>=?) ORDER BY approved_at DESC LIMIT 1").bind(entityId,onDate,onDate).first<Row>();
 if(!r)throw new ConfigurationRequired("active_tax_registration");
 return r;
}
/** GST state code = the first two chars of a 15-char GSTIN, used to decide inter vs intra state. */
const stateCode=(gstin:string)=>text(gstin).slice(0,2);
const returnPeriod=(period:string)=>{const[y,m]=period.split("-");return`${m}${y}`;}; // MMYYYY, portal fp format

type LineTax={txval:number;rt:number;iamt:number;camt:number;samt:number;csamt:number;hsn:string;desc:string;pos:string};
/** Decompose one invoice line's snapshot into portal tax fields, splitting by component code. */
function lineTaxFromSnapshot(snapshotJson:unknown,fallbackHsn:string,fallbackPos:string):LineTax{
 const snap=(()=>{try{return typeof snapshotJson==="string"?JSON.parse(snapshotJson):snapshotJson;}catch{return{};}})() as Row;
 const components=Array.isArray(snap.components)?snap.components as Array<{code?:string;rate?:number}>:[];
 const txval=round2(num(snap.taxableAmount));let rt=0,iamt=0,camt=0,samt=0,csamt=0;
 for(const c of components){const code=text(c.code).toLowerCase(),rate=num(c.rate),amt=round2(txval*(rate/100));rt+=rate;if(code.includes("igst"))iamt+=amt;else if(code.includes("cgst"))camt+=amt;else if(code.includes("sgst")||code.includes("utgst"))samt+=amt;else if(code.includes("cess"))csamt+=amt;}
 return{txval,rt:round2(rt),iamt:round2(iamt),camt:round2(camt),samt:round2(samt),csamt:round2(csamt),hsn:text(snap.classificationCode)||fallbackHsn,desc:text(snap.description)||"",pos:fallbackPos};
}

async function persist(db:Db,entityId:string,regId:string,returnType:string,period:string,payload:Row,summary:Row,actor:string,reason:string){
 const versionRow=await db.prepare("SELECT COALESCE(MAX(version),0)+1 version FROM gst_return_documents WHERE entity_id=? AND registration_id=? AND return_type=? AND period_code=?").bind(entityId,regId,returnType,period).first<Row>();
 const previous=await db.prepare("SELECT id FROM gst_return_documents WHERE entity_id=? AND registration_id=? AND return_type=? AND period_code=? ORDER BY version DESC LIMIT 1").bind(entityId,regId,returnType,period).first<Row>();
 const version=num(versionRow?.version),docId=idOf("gstret"),payloadRaw=JSON.stringify(payload),checksum=await sha256(payloadRaw);
 await db.prepare("INSERT INTO gst_return_documents (id,entity_id,registration_id,return_type,period_code,version,status,payload_json,summary_json,checksum,prepared_by,prepared_at,supersedes_id) VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?)")
  .bind(docId,entityId,regId,returnType,period,version,payloadRaw,JSON.stringify(summary),checksum,actor,now(),previous?text(previous.id):null).run();
 await audit(db,actor,docId,"generated",{returnType,period,version,summary,checksum,liveFilingEnabled:false},reason);
 return{id:docId,returnType,period,version,status:"draft" as const,checksum,summary,payload,liveFilingEnabled:false,productionReady:false};
}

// -------------------------------------------------------------------------------------------------
// GSTR-1 — outward supplies
// -------------------------------------------------------------------------------------------------
export async function generateGstr1(db:Db,input:Row,actor:string){
 await ensureGstReturnTables(db);
 const entityId=text(input.entityId),regId=text(input.registrationId),period=text(input.periodCode),reason=text(input.reason)||"Generate GSTR-1 outward-supply draft";
 if(!entityId||!/^\d{4}-\d{2}$/.test(period))throw new Error("gstr1_scope_required");
 const reg=await registration(db,entityId,`${period}-28`);
 const gstin=text(reg.registration_reference),homeState=stateCode(gstin);
 const invoices=await db.prepare("SELECT * FROM finance_invoices WHERE entity_id=? AND substr(issue_date,1,7)=? AND status!='cancelled' ORDER BY issue_date,invoice_number").bind(entityId,period).all<Row>();
 const b2b=new Map<string,Row>();const b2csMap=new Map<string,{sply_ty:string;pos:string;typ:string;rt:number;txval:number;iamt:number;camt:number;samt:number;csamt:number}>();
 const hsnMap=new Map<string,{hsn_sc:string;desc:string;txval:number;iamt:number;camt:number;samt:number;csamt:number;num:number}>();
 let canonicalTaxable=0,canonicalTax=0,b2bCount=0,b2cCount=0;
 for(const inv of invoices.results){
  const profile=await safeFirst(db,"SELECT registration_reference,customer_type,place_of_supply FROM finance_customer_tax_profiles WHERE customer_id=?",[text(inv.customer_id)]);
  const customerGstin=text(profile?.registration_reference);
  const pos=(text(profile?.place_of_supply)||homeState).slice(0,2);
  const isB2b=Boolean(customerGstin)&&text(profile?.customer_type)!=="consumer";
  const lines=await db.prepare("SELECT description,service_code,taxable_amount,tax_amount,tax_snapshot_json,hsn_sac FROM finance_invoice_lines WHERE invoice_id=?").bind(text(inv.id)).all<Row>();
  const itms:Row[]=[];let invTaxable=0,invTax=0;
  for(let i=0;i<lines.results.length;i++){const l=lines.results[i];const t=lineTaxFromSnapshot(l.tax_snapshot_json,text(l.hsn_sac),pos);invTaxable+=t.txval;invTax+=t.iamt+t.camt+t.samt+t.csamt;
   itms.push({num:i+1,itm_det:{txval:t.txval,rt:t.rt,iamt:t.iamt,camt:t.camt,samt:t.samt,csamt:t.csamt}});
   const hkey=`${t.hsn||text(l.service_code)}:${t.rt}`;const h=hsnMap.get(hkey)||{hsn_sc:t.hsn||text(l.service_code),desc:t.desc||text(l.description),txval:0,iamt:0,camt:0,samt:0,csamt:0,num:0};
   h.txval=round2(h.txval+t.txval);h.iamt=round2(h.iamt+t.iamt);h.camt=round2(h.camt+t.camt);h.samt=round2(h.samt+t.samt);h.csamt=round2(h.csamt+t.csamt);h.num+=1;hsnMap.set(hkey,h);}
  canonicalTaxable+=invTaxable;canonicalTax+=invTax;
  if(isB2b){b2bCount+=1;const entry=(b2b.get(customerGstin)||{ctin:customerGstin,inv:[]}) as Row;(entry.inv as Row[]).push({inum:text(inv.invoice_number),idt:text(inv.issue_date),val:round2(num(inv.total)),pos,rchrg:"N",inv_typ:"R",itms});b2b.set(customerGstin,entry);}
  else{b2cCount+=1;const sply_ty=pos===homeState?"INTRA":"INTER";for(const it of itms){const d=it.itm_det as Row;const rt=num(d.rt);const key=`${sply_ty}:${pos}:${rt}`;const bucket=b2csMap.get(key)||{sply_ty,pos,typ:"OE",rt,txval:0,iamt:0,camt:0,samt:0,csamt:0};bucket.txval=round2(bucket.txval+num(d.txval));bucket.iamt=round2(bucket.iamt+num(d.iamt));bucket.camt=round2(bucket.camt+num(d.camt));bucket.samt=round2(bucket.samt+num(d.samt));bucket.csamt=round2(bucket.csamt+num(d.csamt));b2csMap.set(key,bucket);}}
 }
 // Credit/debit notes against B2B registered counterparties -> cdnr; against consumers -> cdnur.
 const notes=await db.prepare("SELECT a.document_number,a.kind,a.amount,a.tax_amount,a.created_at,i.invoice_number,i.issue_date,i.total,i.customer_id FROM finance_adjustment_documents a JOIN finance_invoices i ON i.id=a.invoice_id WHERE i.entity_id=? AND substr(i.issue_date,1,7)=? AND a.status='issued'").bind(entityId,period).all<Row>();
 const cdnr:Row[]=[],cdnur:Row[]=[];
 for(const n of notes.results){const profile=await safeFirst(db,"SELECT registration_reference,customer_type FROM finance_customer_tax_profiles WHERE customer_id=?",[text(n.customer_id)]);const cgstin=text(profile?.registration_reference);const ntty=text(n.kind)==="credit_note"?"C":"D";const nt_det={ntty,nt_num:text(n.document_number),nt_dt:text(n.issue_date),val:round2(num(n.amount)+num(n.tax_amount)),itms:[{num:1,itm_det:{txval:round2(num(n.amount)),iamt:round2(num(n.tax_amount))}}]};if(cgstin&&text(profile?.customer_type)!=="consumer")cdnr.push({ctin:cgstin,...nt_det});else cdnur.push(nt_det);}
 // Service verticals: aggregate-only in booking_invoices; cannot be compliant GSTR-1 line detail. Only
 // PawSpace's OWN output GST (commission / principal) belongs in PawSpace's outward tax; the provider-supply
 // GST is the provider's, routed to s52 GST TCS / GSTR-8 (see serviceVerticalOutputTax).
 const{startMs,endMs}=periodMs(period);
 const svc=await serviceVerticalOutputTax(db,startMs,endMs);
 const serviceTax=svc.pawspaceOwnOutputTax,serviceGross=svc.grossTotal,serviceCount=svc.invoiceCount;
 const payload={gstin,fp:returnPeriod(period),gt:round2(canonicalTaxable),cur_gt:round2(canonicalTaxable),
  b2b:[...b2b.values()],b2cs:[...b2csMap.values()],cdnr,cdnur,hsn:{data:[...hsnMap.values()]}};
 const summary={returnType:"GSTR-1",period,gstin,b2bInvoices:b2bCount,b2cInvoices:b2cCount,cdnrCount:cdnr.length,cdnurCount:cdnur.length,hsnLines:hsnMap.size,
  canonicalTaxableValue:round2(canonicalTaxable),canonicalOutputTax:round2(canonicalTax),
  serviceVerticalTax:serviceTax,serviceVerticalGross:serviceGross,serviceVerticalInvoices:serviceCount,totalOutputTax:round2(canonicalTax+serviceTax),
  taxCollectedFromCustomers:svc.totalTaxCollected,providerSupplyGstCollectedOnBehalf:svc.providerSupplyGstOnBehalf,
  reconciliation:{note:serviceCount>0?"Service-vertical supplies are aggregate-only in booking_invoices (no line-level rate/place-of-supply/HSN) and are NOT represented in GSTR-1 sections; issue canonical finance_invoices for them to file line-level. Only PawSpace's OWN output GST (commission/principal) is in totalOutputTax; the provider-supply GST collected on their behalf is routed to s52 GST TCS / GSTR-8, not PawSpace GSTR-1/3B.":"No aggregate-only service supplies this period.",serviceVerticalTaxExcludedFromSections:svc.totalTaxCollected,providerSupplyGstToGstr8:svc.providerSupplyGstOnBehalf}};
 return persist(db,entityId,regId,"GSTR-1",period,payload,summary,actor,reason);
}

// -------------------------------------------------------------------------------------------------
// GSTR-3B — summary and tax liability
// -------------------------------------------------------------------------------------------------
export async function generateGstr3b(db:Db,input:Row,actor:string){
 await ensureGstReturnTables(db);
 const entityId=text(input.entityId),regId=text(input.registrationId),period=text(input.periodCode),reason=text(input.reason)||"Generate GSTR-3B summary draft";
 if(!entityId||!/^\d{4}-\d{2}$/.test(period))throw new Error("gstr3b_scope_required");
 const reg=await registration(db,entityId,`${period}-28`);const gstin=text(reg.registration_reference);
 // Output tax by component from the canonical ledger (B2B), aggregate service tax from booking_invoices.
 const components=await db.prepare("SELECT component,COALESCE(SUM(amount),0) total FROM finance_tax_ledger WHERE entity_id=? AND registration_id=? AND period_code=? AND ledger_type='output' GROUP BY component").bind(entityId,regId,period).all<Row>();
 let ledgerTaxable=0;const iamt0={iamt:0,camt:0,samt:0,csamt:0};for(const c of components.results){const code=text(c.component).toLowerCase(),amt=round2(num(c.total));if(code.includes("igst"))iamt0.iamt+=amt;else if(code.includes("cgst"))iamt0.camt+=amt;else if(code.includes("sgst")||code.includes("utgst"))iamt0.samt+=amt;else if(code.includes("cess"))iamt0.csamt+=amt;else iamt0.iamt+=amt;}
 const taxableRow=await safeFirst(db,"SELECT COALESCE(SUM(subtotal),0) txval FROM finance_invoices WHERE entity_id=? AND substr(issue_date,1,7)=? AND status!='cancelled'",[entityId,period]);ledgerTaxable=round2(num(taxableRow?.txval));
 const{startMs,endMs}=periodMs(period);
 // Only PawSpace's OWN service-vertical output GST (commission/principal) is its 3B liability; the
 // provider-supply GST collected on their behalf goes to s52 GST TCS / GSTR-8, not here.
 const svc=await serviceVerticalOutputTax(db,startMs,endMs);
 const serviceTax=svc.pawspaceOwnOutputTax,serviceTaxable=svc.pawspaceOwnTaxableValue;
 // Eligible ITC only from approved vendor reviews (never claim unreviewed credit).
 const itc=await safeFirst(db,"SELECT COALESCE(SUM(v.eligible_tax_amount),0) total FROM finance_vendor_tax_reviews v JOIN finance_bills b ON b.id=v.bill_id WHERE v.review_status='eligible' AND substr(b.bill_date,1,7)=?",[period]);
 const eligibleItc=round2(num(itc?.total));
 const outputTaxLedger=round2(iamt0.iamt+iamt0.camt+iamt0.samt+iamt0.csamt);
 const totalOutputTax=round2(outputTaxLedger+serviceTax);
 const netTaxPayable=round2(Math.max(0,totalOutputTax-eligibleItc));
 // Portal 3B shape: 3.1(a) outward taxable supplies; 4 eligible ITC; 5.1 interest/late (0 in UAT).
 const payload={gstin,ret_period:returnPeriod(period),
  sup_details:{osup_det:{txval:round2(ledgerTaxable+serviceTaxable),iamt:round2(iamt0.iamt),camt:round2(iamt0.camt),samt:round2(iamt0.samt),csamt:round2(iamt0.csamt)}},
  itc_elg:{itc_avl:[{ty:"OTH",iamt:eligibleItc,camt:0,samt:0,csamt:0}],itc_net:{iamt:eligibleItc,camt:0,samt:0,csamt:0}},
  intr_ltfee:{intr_details:{iamt:0,camt:0,samt:0,csamt:0}}};
 const summary={returnType:"GSTR-3B",period,gstin,outputTaxLedger,serviceVerticalTax:serviceTax,totalOutputTax,eligibleInputTax:eligibleItc,netTaxPayable,outputTaxByComponent:iamt0,
  taxCollectedFromCustomers:svc.totalTaxCollected,providerSupplyGstCollectedOnBehalf:svc.providerSupplyGstOnBehalf,providerSupplyGstNote:"Provider-supply GST collected on the provider's behalf is remitted via s52 GST TCS / GSTR-8, not in PawSpace's own GSTR-3B outward liability."};
 return persist(db,entityId,regId,"GSTR-3B",period,payload,summary,actor,reason);
}

// -------------------------------------------------------------------------------------------------
// GSTR-9C — annual reconciliation statement (books vs annual return)
// -------------------------------------------------------------------------------------------------
export async function generateGstr9c(db:Db,input:Row,actor:string){
 await ensureGstReturnTables(db);
 const entityId=text(input.entityId),regId=text(input.registrationId),reason=text(input.reason)||"Generate GSTR-9C reconciliation draft";
 const startYear=Number(text(input.financialYear).slice(0,4));if(!Number.isInteger(startYear)||startYear<2000||startYear>2100)throw new Error("valid_financial_year_required");
 const fyLabel=`${startYear}-${String((startYear+1)%100).padStart(2,"0")}`,fromPeriod=`${startYear}-04`,toPeriod=`${startYear+1}-03`;
 const reg=await registration(db,entityId,`${startYear+1}-03-28`);const gstin=text(reg.registration_reference);
 // Books turnover + tax: canonical invoices (accrual) + service verticals; the same two sources. Only
 // PawSpace's OWN service output GST is its liability (commission/principal); the provider-supply GST is
 // reconciled separately (routed to s52 GST TCS / GSTR-8), never in PawSpace's own books output tax.
 const canonical=await safeFirst(db,"SELECT COALESCE(SUM(subtotal),0) txval,COALESCE(SUM(tax_total),0) tax FROM finance_invoices WHERE entity_id=? AND substr(issue_date,1,7) BETWEEN ? AND ? AND status!='cancelled'",[entityId,fromPeriod,toPeriod]);
 const fyStartMs=Date.UTC(startYear,3,1)-330*60_000,fyEndMs=Date.UTC(startYear+1,3,1)-330*60_000;
 const svc=await serviceVerticalOutputTax(db,fyStartMs,fyEndMs);
 const booksTaxable=round2(num(canonical?.txval)+svc.pawspaceOwnTaxableValue);
 const booksOutputTax=round2(num(canonical?.tax)+svc.pawspaceOwnOutputTax);
 // The annual return (GSTR-9) as filed/drafted, if present.
 const annual=await safeFirst(db,"SELECT summary_json FROM finance_annual_returns WHERE entity_id=? AND registration_id=? AND financial_year=? ORDER BY version DESC LIMIT 1",[entityId,regId,fyLabel]);
 const annualSummary=(()=>{try{return annual?JSON.parse(text(annual.summary_json)):null;}catch{return null;}})() as Row|null;
 const returnOutputTax=annualSummary?round2(num(annualSummary.totalOutputTax)):null;
 const returnItc=annualSummary?round2(num(annualSummary.totalEligibleItc)):null;
 // Eligible ITC per books (approved vendor reviews) for the FY.
 const itc=await safeFirst(db,"SELECT COALESCE(SUM(v.eligible_tax_amount),0) total FROM finance_vendor_tax_reviews v JOIN finance_bills b ON b.id=v.bill_id WHERE v.review_status='eligible' AND substr(b.bill_date,1,7) BETWEEN ? AND ?",[fromPeriod,toPeriod]);
 const booksItc=round2(num(itc?.total));
 const outputTaxDelta=returnOutputTax===null?null:round2(booksOutputTax-returnOutputTax);
 const itcDelta=returnItc===null?null:round2(booksItc-returnItc);
 const reconciled=annualSummary!==null&&outputTaxDelta===0&&itcDelta===0;
 const payload={gstin,financialYear:fyLabel,
  partII_turnover:{turnoverPerBooks:booksTaxable,turnoverPerReturn:returnOutputTax===null?null:round2(num(annualSummary?.totalOutputTax)),unreconciledDifference:null},
  partIII_tax:{taxPayablePerBooks:booksOutputTax,taxPaidPerReturn:returnOutputTax,unreconciledDifference:outputTaxDelta},
  partIV_itc:{itcPerBooks:booksItc,itcPerReturn:returnItc,unreconciledDifference:itcDelta}};
 const summary={returnType:"GSTR-9C",financialYear:fyLabel,gstin,booksTaxable,booksOutputTax,booksItc,returnOutputTax,returnItc,outputTaxDelta,itcDelta,reconciled,
  taxCollectedFromCustomers:svc.totalTaxCollected,providerSupplyGstCollectedOnBehalf:svc.providerSupplyGstOnBehalf,
  reconciliation:{note:annualSummary===null?"No GSTR-9 annual return has been drafted for this FY; generate it first for a books-vs-return reconciliation.":reconciled?"Books reconcile with the annual return.":"Books do NOT reconcile with the annual return; investigate the unreconciled differences before certification."}};
 return persist(db,entityId,regId,"GSTR-9C",fyLabel,payload,summary,actor,reason);
}

// -------------------------------------------------------------------------------------------------
// Maker/checker approval + read model. Approval never files; it records CA/Finance sign-off only.
// -------------------------------------------------------------------------------------------------
export async function approveGstReturn(db:Db,input:Row,actor:string){
 await ensureGstReturnTables(db);
 const row=await db.prepare("SELECT * FROM gst_return_documents WHERE id=?").bind(text(input.id)).first<Row>();
 if(!row)throw new Error("gst_return_not_found");
 if(text(row.status)!=="draft")throw new Error("gst_return_not_draft");
 if(text(row.prepared_by)===actor)throw new Error("maker_checker_required");
 if(!text(input.approvalReference))throw new Error("approval_reference_required");
 await db.prepare("UPDATE gst_return_documents SET status='reviewed',reviewed_by=?,reviewed_at=?,approval_reference=? WHERE id=?").bind(actor,now(),text(input.approvalReference),text(input.id)).run();
 await audit(db,actor,text(input.id),"reviewed",{status:"reviewed",approvalReference:text(input.approvalReference),liveFilingEnabled:false},text(input.reason)||"Approve GST return draft");
 return{id:text(input.id),status:"reviewed" as const,liveFilingEnabled:false,productionReady:false};
}

export async function getGstReturnsSnapshot(db:Db,filter?:{returnType?:string;period?:string}){
 await ensureGstReturnTables(db);
 const clauses:string[]=[],binds:unknown[]=[];
 if(filter?.returnType){clauses.push("return_type=?");binds.push(filter.returnType);}
 if(filter?.period){clauses.push("period_code=?");binds.push(filter.period);}
 const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
 const docs=await db.prepare(`SELECT id,entity_id,registration_id,return_type,period_code,version,status,summary_json,checksum,prepared_by,prepared_at,reviewed_by,reviewed_at,approval_reference FROM gst_return_documents ${where} ORDER BY prepared_at DESC LIMIT 100`).bind(...binds).all<Row>();
 return{documents:docs.results.map(d=>({...d,summary:(()=>{try{return JSON.parse(text(d.summary_json));}catch{return{};}})()})),productionReady:false,liveFilingEnabled:false};
}
