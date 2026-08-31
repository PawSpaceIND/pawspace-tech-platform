// TDS / TCS ledger reconciliation — READ-ONLY. Cross-checks the recorded statutory ledgers against
// (a) the statutory deduction/collection RULES (rate + arithmetic), (b) PAN readiness, (c) the
// deposit and return records, and (d) the source payout population. It never writes, and never calls
// the destructive computeMonthlyTds/computeMonthlyTcs recompute (which DELETE+reinsert a period).
//
// Withholding note it surfaces: partner payouts disburse the provider's GROSS net-of-GST share and
// withhold NOTHING at source (lib/provider-commercial-terms.ts). TDS/TCS are separate downstream
// deposit obligations computed from those gross figures. That is a real control gap this utility
// makes explicit, not a defect in these ledgers.

import{TDS_RATES,monthlySalaryTds}from"./tds-governance";
import{TCS_RATE_S52}from"./tcs-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(v:number)=>Math.round(v*100)/100;
const num=(v:unknown)=>Number(v??0);
const text=(v:unknown)=>String(v??"").trim();
const TOLERANCE=0.01;
async function safeAll(db:Db,sql:string,b:unknown[]=[]):Promise<Row[]>{try{const s=b.length?db.prepare(sql).bind(...b):db.prepare(sql);return((await s.all<Row>()).results)||[];}catch{return[];}}
async function safeFirst(db:Db,sql:string,b:unknown[]=[]):Promise<Row|null>{try{const s=b.length?db.prepare(sql).bind(...b):db.prepare(sql);return await s.first<Row>();}catch{return null;}}
function monthMs(period:string){const[y,m]=period.split("-").map(Number);return{startMs:Date.UTC(y,m-1,1)-330*60_000,endMs:Date.UTC(m===12?y+1:y,m===12?0:m,1)-330*60_000};}

export type ReconciliationFinding={severity:"ok"|"warning"|"critical";code:string;detail:string;deducteeId?:string;expected?:number;recorded?:number};

/** Cross-check recorded TDS deductions against statutory rates/arithmetic, PAN status and deposits. */
export async function reconcileTds(db:Db,input:{period:string}){
 const period=input.period;
 const rows=await safeAll(db,"SELECT section,deductee_type,deductee_id,deductee_name,base_amount,rate_pct,tds_amount,pan_status,source_type FROM tds_deductions WHERE period=? ORDER BY section,tds_amount DESC",[period]);
 const findings:ReconciliationFinding[]=[];
 let recordedTds=0,verifiedRows=0;
 for(const r of rows){
  const section=text(r.section),base=round2(num(r.base_amount)),recorded=round2(num(r.tds_amount)),ratePct=num(r.rate_pct);
  recordedTds+=recorded;
  // Expected TDS from the statutory rule for the section.
  let expected:number,expectedRatePct:number|null;
  if(section==="192"){expected=monthlySalaryTds(base);expectedRatePct=null;/* slab-based, rate_pct not applicable */}
  else if(section==="194H"){expectedRatePct=TDS_RATES.commission194H*100;expected=round2(base*TDS_RATES.commission194H);}
  else if(section==="194J"){expectedRatePct=TDS_RATES.professional194J*100;expected=round2(base*TDS_RATES.professional194J);}
  else{findings.push({severity:"critical",code:"unknown_section",detail:`Deductee ${text(r.deductee_id)}: unrecognised TDS section ${section}`,deducteeId:text(r.deductee_id)});continue;}
  if(expectedRatePct!==null&&Math.abs(ratePct-expectedRatePct)>TOLERANCE)findings.push({severity:"critical",code:"rate_mismatch",detail:`${section} ${text(r.deductee_id)}: recorded rate ${ratePct}% ≠ statutory ${expectedRatePct}%`,deducteeId:text(r.deductee_id),expected:expectedRatePct,recorded:ratePct});
  if(Math.abs(expected-recorded)>TOLERANCE)findings.push({severity:"critical",code:"amount_mismatch",detail:`${section} ${text(r.deductee_id)}: recorded TDS ${recorded} ≠ rule-computed ${expected} on base ${base}`,deducteeId:text(r.deductee_id),expected,recorded});
  else verifiedRows+=1;
  if(text(r.pan_status)!=="verified")findings.push({severity:"warning",code:"pan_pending",detail:`${section} ${text(r.deductee_id)}: PAN ${text(r.pan_status)||"missing"} — s206AA 20% risk; resolve before filing`,deducteeId:text(r.deductee_id)});
 }
 recordedTds=round2(recordedTds);
 // Deposit reconciliation.
 const deposit=await safeFirst(db,"SELECT amount,challan_reference FROM tds_deposits WHERE period=?",[period]);
 const deposited=deposit?round2(num(deposit.amount)):null;
 let depositStatus:"matched"|"short"|"over"|"missing";
 if(deposited===null)depositStatus=recordedTds===0?"matched":"missing";
 else if(Math.abs(deposited-recordedTds)<=TOLERANCE)depositStatus="matched";
 else depositStatus=deposited<recordedTds?"short":"over";
 if(depositStatus==="missing")findings.push({severity:recordedTds>0?"critical":"ok",code:"deposit_missing",detail:`No TDS challan recorded for ${period} against a liability of ${recordedTds}`,expected:recordedTds,recorded:0});
 else if(depositStatus!=="matched")findings.push({severity:"critical",code:`deposit_${depositStatus}`,detail:`TDS deposit ${deposited} ≠ liability ${recordedTds} for ${period}`,expected:recordedTds,recorded:deposited??0});
 // Coverage: marketplace/professional payouts in the period vs the withholding note.
 const{startMs,endMs}=monthMs(period);
 const payouts=await safeFirst(db,"SELECT COUNT(*) count,COALESCE(SUM(provider_net_payout),0) gross FROM provider_payout_computations WHERE computed_at>=? AND computed_at<?",[startMs,endMs]);
 const payoutCount=num(payouts?.count),payoutGross=round2(num(payouts?.gross));
 const summary={period,recordedRows:rows.length,verifiedRows,recordedTds,deposited,depositStatus,
  panPending:findings.filter(f=>f.code==="pan_pending").length,
  criticalCount:findings.filter(f=>f.severity==="critical").length,
  reconciled:findings.every(f=>f.severity!=="critical"),
  payoutWithholdingNote:{providerPayoutsInPeriod:payoutCount,providerGrossDisbursed:payoutGross,withheldAtPayout:0,detail:"Payouts disburse the provider's gross net-of-GST share; nothing is withheld at source, so recorded TDS is a separate deposit obligation, not a payout deduction."}};
 return{summary,findings,productionReady:false};
}

/** Cross-check recorded s52 TCS collections against the statutory rate/arithmetic and deposits. */
export async function reconcileTcs(db:Db,input:{period:string}){
 const period=input.period;
 const rows=await safeAll(db,"SELECT supplier_id,booking_id,supply_type,net_taxable_value,cgst_tcs,sgst_tcs,igst_tcs,tcs_total,rate_pct FROM tcs_collections WHERE period=?",[period]);
 const findings:ReconciliationFinding[]=[];
 let recordedTcs=0,verifiedRows=0;
 for(const r of rows){
  const net=round2(num(r.net_taxable_value)),recorded=round2(num(r.tcs_total)),componentSum=round2(num(r.cgst_tcs)+num(r.sgst_tcs)+num(r.igst_tcs)),ratePct=num(r.rate_pct);
  recordedTcs+=recorded;
  const expected=round2(net*TCS_RATE_S52.total);
  if(Math.abs(ratePct-TCS_RATE_S52.total*100)>TOLERANCE)findings.push({severity:"critical",code:"rate_mismatch",detail:`${text(r.supplier_id)}/${text(r.booking_id)}: recorded rate ${ratePct}% ≠ statutory ${TCS_RATE_S52.total*100}%`,deducteeId:text(r.supplier_id),expected:TCS_RATE_S52.total*100,recorded:ratePct});
  if(Math.abs(expected-recorded)>TOLERANCE)findings.push({severity:"critical",code:"amount_mismatch",detail:`${text(r.supplier_id)}/${text(r.booking_id)}: recorded TCS ${recorded} ≠ rule-computed ${expected} on net ${net}`,deducteeId:text(r.supplier_id),expected,recorded});
  else if(Math.abs(componentSum-recorded)>TOLERANCE)findings.push({severity:"critical",code:"component_split_mismatch",detail:`${text(r.supplier_id)}/${text(r.booking_id)}: CGST+SGST+IGST ${componentSum} ≠ total ${recorded}`,deducteeId:text(r.supplier_id),expected:recorded,recorded:componentSum});
  else verifiedRows+=1;
 }
 recordedTcs=round2(recordedTcs);
 const statement=await safeFirst(db,"SELECT total_tcs FROM tcs_statements WHERE period=?",[period]);
 if(statement&&Math.abs(round2(num(statement.total_tcs))-recordedTcs)>TOLERANCE)findings.push({severity:"critical",code:"statement_mismatch",detail:`GSTR-8 statement total ${round2(num(statement.total_tcs))} ≠ recorded collections ${recordedTcs}`,expected:recordedTcs,recorded:round2(num(statement.total_tcs))});
 const deposit=await safeFirst(db,"SELECT amount FROM tcs_deposits WHERE period=?",[period]);
 const deposited=deposit?round2(num(deposit.amount)):null;
 let depositStatus:"matched"|"short"|"over"|"missing";
 if(deposited===null)depositStatus=recordedTcs===0?"matched":"missing";
 else if(Math.abs(deposited-recordedTcs)<=TOLERANCE)depositStatus="matched";
 else depositStatus=deposited<recordedTcs?"short":"over";
 if(depositStatus==="missing"&&recordedTcs>0)findings.push({severity:"critical",code:"deposit_missing",detail:`No TCS challan recorded for ${period} against a liability of ${recordedTcs}`,expected:recordedTcs,recorded:0});
 else if(depositStatus!=="matched"&&deposited!==null)findings.push({severity:"critical",code:`deposit_${depositStatus}`,detail:`TCS deposit ${deposited} ≠ liability ${recordedTcs} for ${period}`,expected:recordedTcs,recorded:deposited});
 const summary={period,recordedRows:rows.length,verifiedRows,recordedTcs,deposited,depositStatus,
  criticalCount:findings.filter(f=>f.severity==="critical").length,reconciled:findings.every(f=>f.severity!=="critical")};
 return{summary,findings,productionReady:false};
}

/** One combined partner-payout tax reconciliation view for a month (TDS + TCS + the withholding gap). */
export async function reconcilePartnerPayoutTax(db:Db,input:{period:string}){
 const tds=await reconcileTds(db,input);
 const tcs=await reconcileTcs(db,input);
 return{period:input.period,tds,tcs,
  reconciled:tds.summary.reconciled&&tcs.summary.reconciled,
  productionReady:false,liveFilingEnabled:false};
}
