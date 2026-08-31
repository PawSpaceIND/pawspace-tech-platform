// TCS (Tax Collected at Source) engine — section 52 of the CGST Act, the e-commerce-operator levy.
// PawSpace, as an operator that collects the consideration for taxable supplies made THROUGH it by
// marketplace (commission-model) providers, must collect TCS on the net value of those supplies and
// file GSTR-8. This computes the liability from REAL payout data; it never disburses or files.
//
// Rate (statutory, s52 + notification 52/2018): 1% of the net value of taxable supplies — split
// 0.5% CGST-TCS + 0.5% SGST-TCS for intra-state, or 1% IGST-TCS for inter-state. Hardcoded here as a
// statutory constant, the same way lib/tds-governance.ts hardcodes the s194H/s194J income-tax rates;
// this is NOT the configurable GST OUTPUT rate that lib/gst-accounting.ts fail-closes on.
//
// SCOPE / MARKETPLACE: only commission-model engagements (commission_standard / commission_groomer)
// are supplies made "through the operator" by another supplier. direct_employee delivery is PawSpace's
// OWN supply and carries no s52 TCS.
//
// BASE DEFINITION (requires Finance/CA sign-off before production filing): net taxable value of the
// marketplace supply = order_value − provider_gst_deducted (order value less the GST already carried
// on the provider's supply). It is surfaced explicitly in every row and statement so a reviewer can
// confirm the interpretation. INTER vs INTRA state defaults to INTRA (operator home state); a supply
// whose place-of-supply state differs must be marked inter — POS is not yet wired from booking zones,
// so that determination is flagged, never guessed.

type Db=D1Database;
type Row=Record<string,unknown>;
export const TCS_PRODUCTION_READY=false;
/** Section 52 net-value TCS: 1% total. Named statutory constant (see file header), not GST output rate. */
export const TCS_RATE_S52={total:0.01,cgst:0.005,sgst:0.005,igst:0.01} as const;
const MARKETPLACE_MODELS=new Set(["commission_standard","commission_groomer"]);
const round2=(v:number)=>Math.round(v*100)/100;
const num=(v:unknown)=>Number(v??0);
const text=(v:unknown)=>String(v??"").trim();

const tcsTablesEnsured=new WeakSet<Db>();
export async function ensureTcsTables(db:Db){
 if(tcsTablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS tcs_collections (id TEXT PRIMARY KEY,period TEXT NOT NULL,supplier_id TEXT NOT NULL,service_code TEXT NOT NULL,booking_id TEXT NOT NULL,supply_type TEXT NOT NULL,order_value REAL NOT NULL,net_taxable_value REAL NOT NULL,cgst_tcs REAL NOT NULL DEFAULT 0,sgst_tcs REAL NOT NULL DEFAULT 0,igst_tcs REAL NOT NULL DEFAULT 0,tcs_total REAL NOT NULL,rate_pct REAL NOT NULL,source_ref TEXT NOT NULL,computed_at INTEGER NOT NULL,UNIQUE(period,supplier_id,booking_id))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_tcs_period ON tcs_collections(period,supplier_id)"),
  db.prepare("CREATE TABLE IF NOT EXISTS tcs_statements (id TEXT PRIMARY KEY,period TEXT NOT NULL UNIQUE,total_net_value REAL NOT NULL,total_tcs REAL NOT NULL,cgst_tcs REAL NOT NULL,sgst_tcs REAL NOT NULL,igst_tcs REAL NOT NULL,supplier_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',summary_json TEXT NOT NULL,acknowledgement_ref TEXT,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,filed_by TEXT,filed_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS tcs_deposits (period TEXT PRIMARY KEY,amount REAL NOT NULL,challan_reference TEXT NOT NULL,due_date TEXT NOT NULL,deposited_by TEXT NOT NULL,deposited_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'deposited')"),
 ]);
 tcsTablesEnsured.add(db);
}

function monthWindow(period:string):{startMs:number;endMs:number}{
 const[year,month]=period.split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw new Response("TCS period must be YYYY-MM",{status:400});
 return{startMs:Date.UTC(year,month-1,1)-330*60_000,endMs:Date.UTC(month===12?year+1:year,month===12?0:month,1)-330*60_000};
}
async function safeAll(db:Db,sql:string,b:unknown[]=[]):Promise<Row[]>{try{const s=b.length?db.prepare(sql).bind(...b):db.prepare(sql);return((await s.all<Row>()).results)||[];}catch{return[];}}

export type TcsComputation={period:string;supplierCount:number;totalNetValue:number;totalTcs:number;cgstTcs:number;sgstTcs:number;igstTcs:number;issues:string[];depositDueDate:string};

/** Compute (and idempotently persist) the month's s52 TCS from marketplace payout computations.
 *  Destructive per period (DELETE + reinsert), mirroring computeMonthlyTds — safe to re-run, but a
 *  reconciliation utility must NOT call it as a read. */
export async function computeMonthlyTcs(db:Db,input:{period:string;actorId:string;asOf?:number}):Promise<TcsComputation>{
 await ensureTcsTables(db);
 const{startMs,endMs}=monthWindow(input.period),now=input.asOf??Date.now(),issues:string[]=[];
 await db.prepare("DELETE FROM tcs_collections WHERE period=?").bind(input.period).run();
 // Marketplace supplies through the operator this month: commission-model payout computations.
 const payouts=await safeAll(db,"SELECT c.booking_id,c.provider_id,c.service_code,c.order_value,c.provider_gst_deducted,c.computed_at,t.engagement_model FROM provider_payout_computations c JOIN provider_commercial_terms t ON t.id=c.term_id WHERE c.computed_at>=? AND c.computed_at<?",[startMs,endMs]);
 const rows:Array<{supplierId:string;serviceCode:string;bookingId:string;supplyType:"intra"|"inter";orderValue:number;netValue:number;cgst:number;sgst:number;igst:number;total:number}>=[];
 for(const p of payouts){
  const model=text(p.engagement_model).toLowerCase();
  if(!MARKETPLACE_MODELS.has(model))continue; // direct_employee = operator's own supply, no s52 TCS
  const orderValue=round2(num(p.order_value)),netValue=round2(orderValue-num(p.provider_gst_deducted));
  if(netValue<=0)continue;
  // INTER/INTRA place-of-supply is not yet wired from booking zones; default INTRA and flag it.
  const supplyType:"intra"|"inter"="intra";
  const cgst=round2(netValue*TCS_RATE_S52.cgst),sgst=round2(netValue*TCS_RATE_S52.sgst),igst=0,total=round2(cgst+sgst+igst);
  rows.push({supplierId:text(p.provider_id),serviceCode:text(p.service_code),bookingId:text(p.booking_id),supplyType,orderValue,netValue,cgst,sgst,igst,total});
 }
 const statements=rows.map(r=>db.prepare("INSERT OR REPLACE INTO tcs_collections (id,period,supplier_id,service_code,booking_id,supply_type,order_value,net_taxable_value,cgst_tcs,sgst_tcs,igst_tcs,tcs_total,rate_pct,source_ref,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(`TCS-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,r.supplierId,r.serviceCode,r.bookingId,r.supplyType,r.orderValue,r.netValue,r.cgst,r.sgst,r.igst,r.total,TCS_RATE_S52.total*100,r.bookingId,now));
 if(statements.length)await db.batch(statements);
 if(rows.length)issues.push("Place-of-supply defaulted to INTRA (CGST+SGST TCS); confirm inter-state marketplace supplies once booking-zone POS is wired.");
 if(rows.length)issues.push("s52 base = order_value − provider_gst_deducted; confirm this net-taxable-value definition with Finance/CA before production filing.");
 const totals=rows.reduce((a,r)=>({net:a.net+r.netValue,cgst:a.cgst+r.cgst,sgst:a.sgst+r.sgst,igst:a.igst+r.igst,total:a.total+r.total}),{net:0,cgst:0,sgst:0,igst:0,total:0});
 const suppliers=new Set(rows.map(r=>r.supplierId));
 const[year,month]=input.period.split("-").map(Number);
 const depositDueDate=`${month===12?year+1:year}-${String(month===12?1:month+1).padStart(2,"0")}-10`; // GSTR-8 / TCS: 10th of next month
 return{period:input.period,supplierCount:suppliers.size,totalNetValue:round2(totals.net),totalTcs:round2(totals.total),cgstTcs:round2(totals.cgst),sgstTcs:round2(totals.sgst),igstTcs:round2(totals.igst),issues,depositDueDate};
}

/** Prepare the month's GSTR-8 (TCS return) from recorded collections: supplier-wise net value + TCS. */
export async function prepareGstr8(db:Db,input:{period:string;actorId:string;asOf?:number}){
 await ensureTcsTables(db);
 monthWindow(input.period);
 const bySupplier=await safeAll(db,"SELECT supplier_id,COALESCE(SUM(net_taxable_value),0) net,COALESCE(SUM(cgst_tcs),0) cgst,COALESCE(SUM(sgst_tcs),0) sgst,COALESCE(SUM(igst_tcs),0) igst,COALESCE(SUM(tcs_total),0) total,COUNT(*) supplies FROM tcs_collections WHERE period=? GROUP BY supplier_id ORDER BY total DESC",[input.period]);
 const suppliers=bySupplier.map(r=>({supplierId:text(r.supplier_id),netValue:round2(num(r.net)),cgstTcs:round2(num(r.cgst)),sgstTcs:round2(num(r.sgst)),igstTcs:round2(num(r.igst)),tcsTotal:round2(num(r.total)),supplies:num(r.supplies)}));
 const totals=suppliers.reduce((a,s)=>({net:a.net+s.netValue,cgst:a.cgst+s.cgstTcs,sgst:a.sgst+s.sgstTcs,igst:a.igst+s.igstTcs,total:a.total+s.tcsTotal}),{net:0,cgst:0,sgst:0,igst:0,total:0});
 const now=input.asOf??Date.now();
 const summary={returnType:"GSTR-8",period:input.period,suppliers,totalNetValue:round2(totals.net),totalTcs:round2(totals.total),cgstTcs:round2(totals.cgst),sgstTcs:round2(totals.sgst),igstTcs:round2(totals.igst),supplierCount:suppliers.length,liveFilingEnabled:false};
 await db.prepare("INSERT INTO tcs_statements (id,period,total_net_value,total_tcs,cgst_tcs,sgst_tcs,igst_tcs,supplier_count,status,summary_json,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?,'prepared',?,?,?) ON CONFLICT(period) DO UPDATE SET total_net_value=excluded.total_net_value,total_tcs=excluded.total_tcs,cgst_tcs=excluded.cgst_tcs,sgst_tcs=excluded.sgst_tcs,igst_tcs=excluded.igst_tcs,supplier_count=excluded.supplier_count,summary_json=excluded.summary_json,prepared_by=excluded.prepared_by,prepared_at=excluded.prepared_at,status='prepared'")
  .bind(`GSTR8-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,summary.totalNetValue,summary.totalTcs,summary.cgstTcs,summary.sgstTcs,summary.igstTcs,summary.supplierCount,JSON.stringify(summary),input.actorId,now).run();
 return{...summary,status:"prepared" as const,productionReady:false};
}

export async function recordTcsDeposit(db:Db,input:{period:string;challanReference:string;amount:number;actorId:string;asOf?:number}){
 await ensureTcsTables(db);
 const challan=text(input.challanReference);if(!challan)throw new Response("Challan reference is required",{status:400});
 const computed=await db.prepare("SELECT COALESCE(SUM(tcs_total),0) total FROM tcs_collections WHERE period=?").bind(input.period).first<Row>();
 const liability=round2(num(computed?.total));
 if(Math.abs(liability-round2(num(input.amount)))>0.01)throw new Response(`Deposit must equal the computed TCS liability of ${liability} for ${input.period}`,{status:409});
 const[year,month]=input.period.split("-").map(Number);
 const dueDate=`${month===12?year+1:year}-${String(month===12?1:month+1).padStart(2,"0")}-10`;
 const now=input.asOf??Date.now();
 const existing=await db.prepare("SELECT period FROM tcs_deposits WHERE period=?").bind(input.period).first<Row>();
 if(existing)return{period:input.period,amount:liability,duplicatePrevented:true};
 await db.prepare("INSERT INTO tcs_deposits (period,amount,challan_reference,due_date,deposited_by,deposited_at,status) VALUES (?,?,?,?,?,?,'deposited')").bind(input.period,liability,challan,dueDate,input.actorId,now).run();
 return{period:input.period,amount:liability,challanReference:challan,dueDate,duplicatePrevented:false};
}

export async function tcsDashboard(db:Db,period:string){
 await ensureTcsTables(db);
 const collections=await safeAll(db,"SELECT supplier_id,service_code,booking_id,supply_type,order_value,net_taxable_value,cgst_tcs,sgst_tcs,igst_tcs,tcs_total,rate_pct FROM tcs_collections WHERE period=? ORDER BY tcs_total DESC",[period]);
 const statement=await db.prepare("SELECT * FROM tcs_statements WHERE period=?").bind(period).first<Row>();
 const deposit=await db.prepare("SELECT * FROM tcs_deposits WHERE period=?").bind(period).first<Row>();
 return{period,collections,statement:statement||null,deposit:deposit||null,productionReady:false};
}
