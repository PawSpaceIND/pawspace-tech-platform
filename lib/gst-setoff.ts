/**
 * GST payment and set-off (section 49, section 49A, Rule 88A; Circular 98/17/2019), GSTR-3B Table 6.1, and the payment journal.
 *
 * For a month (entity + GST registration + IST month) the liability is the output tax by head that the GSTR-3B draft files in 3.1(a)
 * (the service supply register and canonical invoices, owned by lib/gst-returns.ts) plus the reverse-charge tax of 3.1(d). The
 * credit is the saved ITC computation's net ITC (Table 4(C), lib/gst-input-tax.ts) plus what earlier paid months left unused. The
 * set-off follows Rule 88A: IGST credit is used first and in full (IGST, then CGST and SGST in whichever split leaves the least
 * cash), CGST credit against CGST then IGST, SGST credit against SGST then IGST (only once CGST credit is exhausted for IGST), cess
 * against cess; CGST never pays SGST or the reverse. Reverse-charge tax is never paid from the credit ledger (section 49(4)): cash
 * only. A negative net ITC for a head is added to that head's liability.
 *
 * Interest (section 50(1), Rule 88B): 18% a year on the CASH paid after the due date (the 20th of the next month for a monthly
 * filer), for the days late; plus, shown as an estimate the CA confirms, 18% on a Rule 37 reversal from the return in which the
 * credit was taken (section 50(3)) and on a Rule 42 annual true-up shortfall from 1 April (Rule 42(2)(a)). Late fee (section 47):
 * Rs 25 CGST + Rs 25 SGST a day (Rs 10 + Rs 10 for a nil return); the cap depends on turnover.
 *
 * Recording a payment (finance.manage, checked by the route) needs the month's ITC computation saved and a GSTR-3B draft generated
 * from it. It refuses a challan paying more than is owed per head, interest or late fee above what is due, a date in the future
 * or in a locked month, and a month whose earlier saved month is not paid yet (returns are filed in order). One balanced journal:
 * Dr 2130 GST payable (credit used + cash), Dr 2135 reverse-charge payable (cash), Dr interest / late fee expense; Cr the input tax
 * heads for the credit used, Cr 1010 Bank. No live money moves: this records a payment Finance made on the GST portal.
 */
import{ACCT,round as round2}from"./finance-accounts";
import{findExpenseCategory}from"./chart-of-accounts";
import{governedJsonError}from"./governed-http-error";
import{ensureTaxPaymentTables}from"./gst-tax-payments";
import{HEADS,type Heads,addHeads,subHeads,zeroHeads,headsTotal,portalHeads,INPUT_TAX_ACCOUNTS,type ItcComputation,type Scope,computationFigures,computeItc,ensureInputTaxTables,isIsoDate,isPeriod,istToday,lastDayOf,nextPeriod,postClaimedJournal,type PostingLine,activeRegistration,deltaLines,netByAccount,periodLocked}from"./gst-input-tax";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const DAY=86_400_000;
const refuse=(error:string,status=409)=>governedJsonError({error},status);
const readHeads=(value:unknown):Heads=>{const v=(value&&typeof value==="object"?value:{}) as Row;return{igst:round2(num(v.igst)),cgst:round2(num(v.cgst)),sgst:round2(num(v.sgst)),cess:round2(num(v.cess))};};
const positive=(a:Heads):Heads=>({igst:Math.max(0,a.igst),cgst:Math.max(0,a.cgst),sgst:Math.max(0,a.sgst),cess:Math.max(0,a.cess)});
const negativePart=(a:Heads):Heads=>({igst:Math.max(0,-a.igst),cgst:Math.max(0,-a.cgst),sgst:Math.max(0,-a.sgst),cess:Math.max(0,-a.cess)});
/** "Interest/Late Fee on GST" in the MIS chart. */
export const GST_INTEREST_ACCOUNT=findExpenseCategory("EXP-TAX-GSTLATE")?.accountCode??"6130-Rates and Taxes (3)";
/** A monthly filer's GSTR-3B is due on the 20th of the next month (QRMP is not built; the day can be set in the tax policy). */
export const GSTR3B_DUE_DAY=20;
export const INTEREST_RATE_PERCENT=18;

// ---------------------------------------------------------------------------------------------------------------------
// Rule 88A
// ---------------------------------------------------------------------------------------------------------------------
export type CreditUse={igst_igst:number;igst_cgst:number;igst_sgst:number;cgst_cgst:number;cgst_igst:number;sgst_sgst:number;sgst_igst:number;cess_cess:number};
const toPaise=(v:number)=>Math.round(v*100),fromPaise=(v:number)=>v/100;
/**
 * The Rule 88A set-off of a liability by head against a credit by head (both >= 0). Works in paise, so nothing drifts. IGST credit
 * is used in full before any CGST or SGST credit: first against IGST, then against the CGST and SGST that their own credits cannot
 * cover (split in proportion to those shortfalls), then against whatever CGST and SGST is left.
 */
export function rule88aSetOff(liability:Heads,credit:Heads){
 const L={i:toPaise(Math.max(0,liability.igst)),c:toPaise(Math.max(0,liability.cgst)),s:toPaise(Math.max(0,liability.sgst)),x:toPaise(Math.max(0,liability.cess))};
 const C={i:toPaise(Math.max(0,credit.igst)),c:toPaise(Math.max(0,credit.cgst)),s:toPaise(Math.max(0,credit.sgst)),x:toPaise(Math.max(0,credit.cess))};
 const use={ii:0,ic:0,is:0,cc:0,ci:0,ss:0,si:0,xx:0};
 use.ii=Math.min(C.i,L.i);C.i-=use.ii;L.i-=use.ii;
 const shortC=Math.max(0,L.c-C.c),shortS=Math.max(0,L.s-C.s),toShort=Math.min(C.i,shortC+shortS);
 if(toShort>0){const toC=Math.floor(toShort*shortC/(shortC+shortS));use.ic+=toC;use.is+=toShort-toC;C.i-=toShort;L.c-=toC;L.s-=toShort-toC;}
 const rest=Math.min(C.i,L.c+L.s);
 if(rest>0){const toC=Math.floor(rest*L.c/(L.c+L.s));use.ic+=toC;use.is+=rest-toC;C.i-=rest;L.c-=toC;L.s-=rest-toC;}
 use.cc=Math.min(C.c,L.c);C.c-=use.cc;L.c-=use.cc;
 use.ss=Math.min(C.s,L.s);C.s-=use.ss;L.s-=use.ss;
 use.ci=Math.min(C.c,L.i);C.c-=use.ci;L.i-=use.ci;
 use.si=Math.min(C.s,L.i);C.s-=use.si;L.i-=use.si;
 use.xx=Math.min(C.x,L.x);C.x-=use.xx;L.x-=use.xx;
 const used:CreditUse={igst_igst:fromPaise(use.ii),igst_cgst:fromPaise(use.ic),igst_sgst:fromPaise(use.is),cgst_cgst:fromPaise(use.cc),cgst_igst:fromPaise(use.ci),sgst_sgst:fromPaise(use.ss),sgst_igst:fromPaise(use.si),cess_cess:fromPaise(use.xx)};
 return{used,creditUsed:creditUsedByHead(used),liabilitySettled:liabilitySettledByHead(used),cash:{igst:fromPaise(L.i),cgst:fromPaise(L.c),sgst:fromPaise(L.s),cess:fromPaise(L.x)} as Heads,creditLeft:{igst:fromPaise(C.i),cgst:fromPaise(C.c),sgst:fromPaise(C.s),cess:fromPaise(C.x)} as Heads};
}
/** Credit taken out of each head of the credit ledger. */
export const creditUsedByHead=(u:CreditUse):Heads=>({igst:round2(u.igst_igst+u.igst_cgst+u.igst_sgst),cgst:round2(u.cgst_cgst+u.cgst_igst),sgst:round2(u.sgst_sgst+u.sgst_igst),cess:round2(u.cess_cess)});
/** Liability of each head paid through credit. */
export const liabilitySettledByHead=(u:CreditUse):Heads=>({igst:round2(u.igst_igst+u.cgst_igst+u.sgst_igst),cgst:round2(u.igst_cgst+u.cgst_cgst),sgst:round2(u.igst_sgst+u.sgst_sgst),cess:round2(u.cess_cess)});
const subUse=(a:CreditUse,b:CreditUse):CreditUse=>Object.fromEntries(Object.keys(a).map(k=>[k,round2(Math.max(0,a[k as keyof CreditUse]-b[k as keyof CreditUse]))])) as CreditUse;
const zeroUse=():CreditUse=>({igst_igst:0,igst_cgst:0,igst_sgst:0,cgst_cgst:0,cgst_igst:0,sgst_sgst:0,sgst_igst:0,cess_cess:0});
const addUse=(a:CreditUse,b:CreditUse):CreditUse=>Object.fromEntries(Object.keys(a).map(k=>[k,round2(a[k as keyof CreditUse]+num(b[k as keyof CreditUse]))])) as CreditUse;

// ---------------------------------------------------------------------------------------------------------------------
// Interest and late fee
// ---------------------------------------------------------------------------------------------------------------------
export const daysBetween=(from:string,to:string)=>Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY);
export function gstr3bDueDate(period:string,dueDay=GSTR3B_DUE_DAY){return`${nextPeriod(period)}-${String(Math.min(28,Math.max(1,Math.floor(dueDay)))).padStart(2,"0")}`;}
/** 18% a year on an amount for the days from `from` (exclusive) to `to` (inclusive), per head. */
export function interestOn(amount:Heads,from:string,to:string){const days=Math.max(0,daysBetween(from,to)),f=INTEREST_RATE_PERCENT/100*days/365;return{days,interest:{igst:round2(amount.igst*f),cgst:round2(amount.cgst*f),sgst:round2(amount.sgst*f),cess:round2(amount.cess*f)} as Heads};}
/** Section 47 late fee per head for a late GSTR-3B (uncapped per-day figure; the cap depends on aggregate turnover). */
export function lateFee(daysLate:number,nilReturn:boolean){const perDay=nilReturn?10:25,days=Math.max(0,daysLate);return{days,perDayPerHead:perDay,fee:{igst:0,cgst:round2(perDay*days),sgst:round2(perDay*days),cess:0} as Heads,capNote:nilReturn?"Nil return: Rs 20 a day, capped at Rs 500.":"Rs 50 a day (Rs 25 CGST + Rs 25 SGST); capped by aggregate turnover (Rs 5,000 for Rs 1.5 to 5 crore)."};}
async function policyDueDay(db:Db,entityId:string,onDate:string){
 const policy=await db.prepare("SELECT policy_json FROM tax_policy_versions WHERE entity_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY version DESC LIMIT 1").bind(entityId,onDate,onDate).first<Row>();
 let json:Row={};try{json=JSON.parse(text(policy?.policy_json)||"{}") as Row;}catch{json={};}
 const day=Number(json.gstr3b_due_day);return Number.isInteger(day)&&day>=1&&day<=28?day:GSTR3B_DUE_DAY;
}

// ---------------------------------------------------------------------------------------------------------------------
// The month's set-off
// ---------------------------------------------------------------------------------------------------------------------
async function latestComputation(db:Db,scope:Scope,period:string){return db.prepare("SELECT * FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code=? ORDER BY version DESC LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();}
async function paymentsFor(db:Db,scope:Scope,where:string,binds:unknown[]){return(await db.prepare(`SELECT * FROM finance_gst_setoff_payments WHERE entity_id=? AND registration_id=? AND ${where} ORDER BY recorded_at`).bind(scope.entityId,scope.registrationId,...binds).all<Row>()).results;}
const parse=(value:unknown)=>{try{return JSON.parse(text(value)||"{}") as Row;}catch{return{} as Row;}};
/**
 * Credit carried into the month: the net ITC of earlier months whose GST is recorded as paid, less the credit their set-offs used.
 * A month whose computation is saved but not paid is listed; its credit is not available until its return is filed.
 */
async function openingCredit(db:Db,scope:Scope,period:string){
 const payments=await paymentsFor(db,scope,"period_code<?",[period]),paidPeriods=[...new Set(payments.map(p=>text(p.period_code)))];
 let credit=zeroHeads();
 for(const p of paidPeriods){const row=await db.prepare("SELECT figures_json FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code=? AND id=?").bind(scope.entityId,scope.registrationId,p,text(payments.find(x=>text(x.period_code)===p)?.computation_id)).first<Row>();const f=computationFigures(row);if(f)credit=addHeads(credit,positive(readHeads(f.netItc)));}
 for(const p of payments)credit=subHeads(credit,creditUsedByHead(parse(p.itc_used_json) as unknown as CreditUse));
 const unpaid=(await db.prepare("SELECT DISTINCT period_code FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code<?").bind(scope.entityId,scope.registrationId,period).all<Row>()).results.map(r=>text(r.period_code)).filter(p=>!paidPeriods.includes(p)).sort();
 return{credit:positive(credit),paidPeriods,unpaidEarlierPeriods:unpaid};
}
export type SetoffWorking={period:string;outwardTax:Heads;reverseCharge:Heads;netItc:Heads;negativeItcAddedToLiability:Heads;openingCredit:Heads;liability:Heads;credit:Heads;
 used:CreditUse;creditUsed:Heads;liabilitySettled:Heads;cash:Heads;reverseChargeCash:Heads;cashDue:Heads;creditCarriedForward:Heads;unpaidEarlierPeriods:string[]};
/** The Rule 88A working for a month from its output tax, its ITC figures and the credit brought forward. */
export async function setoffWorking(db:Db,scope:Scope,period:string,figures:ItcComputation,outwardTax:Heads):Promise<SetoffWorking>{
 const opening=await openingCredit(db,scope,period),net=readHeads(figures.netItc),negative=negativePart(net);
 const liability=addHeads(outwardTax,negative),credit=addHeads(opening.credit,positive(net)),result=rule88aSetOff(liability,credit),rcm=readHeads(figures.reverseCharge.liability);
 return{period,outwardTax,reverseCharge:rcm,netItc:net,negativeItcAddedToLiability:negative,openingCredit:opening.credit,liability,credit,used:result.used,creditUsed:result.creditUsed,liabilitySettled:result.liabilitySettled,cash:result.cash,reverseChargeCash:rcm,cashDue:addHeads(result.cash,rcm),creditCarriedForward:result.creditLeft,unpaidEarlierPeriods:opening.unpaidEarlierPeriods};
}
const table61=(w:SetoffWorking,payments:{cash:Heads;interest:Heads;lateFee:Heads})=>({
 tx_py:[{trans_typ:30002,trans_desc:"Other than reverse charge",...Object.fromEntries(HEADS.map(h=>[h,{tx:w.liability[h]}]))},{trans_typ:30003,trans_desc:"Reverse charge",...Object.fromEntries(HEADS.map(h=>[h,{tx:w.reverseCharge[h]}]))}],
 // pditc: <liability head>_pd<credit head>. Field names follow the GSTN offset-liability API; the CA checks them before any live filing.
 pditc:{i_pdi:w.used.igst_igst,i_pdc:w.used.cgst_igst,i_pds:w.used.sgst_igst,c_pdi:w.used.igst_cgst,c_pdc:w.used.cgst_cgst,s_pdi:w.used.igst_sgst,s_pds:w.used.sgst_sgst,cs_pdcs:w.used.cess_cess},
 pdcash:[{ipd:w.cashDue.igst,cpd:w.cashDue.cgst,spd:w.cashDue.sgst,cspd:w.cashDue.cess,i_intrpd:payments.interest.igst,c_intrpd:payments.interest.cgst,s_intrpd:payments.interest.sgst,cs_intrpd:payments.interest.cess,c_lfeepd:payments.lateFee.cgst,s_lfeepd:payments.lateFee.sgst}]});
function recorded(payments:Row[]){
 let cash=zeroHeads(),interest=zeroHeads(),fee=zeroHeads(),used=zeroUse();
 for(const p of payments){cash=addHeads(cash,readHeads(parse(p.cash_json)));const charges=parse(p.interest_json);interest=addHeads(interest,readHeads(charges.interest));fee=addHeads(fee,readHeads(charges.lateFee));used=addUse(used,parse(p.itc_used_json) as unknown as CreditUse);}
 return{cash,interest,lateFee:fee,used,count:payments.length};
}

/**
 * The GSTR-3B hook (lib/gst-returns.ts calls this once): Table 4 by head from the saved ITC computation (or a live preview when it
 * is not saved yet), 3.1(d) reverse charge, and Table 6.1 from the Rule 88A set-off of the draft's own 3.1(a) output tax.
 */
export async function gstr3bInputTax(db:Db,input:Scope&{period:string;outward:{iamt:number;camt:number;samt:number;csamt:number}}){
 await ensureInputTaxTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},period=text(input.period);
 const latest=await latestComputation(db,scope,period),figures=computationFigures(latest)??await computeItc(db,{...scope,period});
 const outward:Heads={igst:round2(num(input.outward.iamt)),cgst:round2(num(input.outward.camt)),sgst:round2(num(input.outward.samt)),cess:round2(num(input.outward.csamt))};
 const working=await setoffWorking(db,scope,period,figures,outward),paid=recorded(await paymentsFor(db,scope,"period_code=?",[period])),t4=figures.table4;
 const itc_elg={itc_avl:[{ty:"IMPG",...portalHeads(t4.a1_importOfGoods)},{ty:"IMPS",...portalHeads(t4.a2_importOfServices)},{ty:"ISRC",...portalHeads(t4.a3_reverseCharge)},{ty:"ISD",...portalHeads(t4.a4_isd)},{ty:"OTH",...portalHeads(t4.a5_allOther)}],
  itc_rev:[{ty:"RUL",...portalHeads(t4.b1_rules42_43_s17_5)},{ty:"OTH",...portalHeads(t4.b2_others)}],itc_net:portalHeads(t4.c_net),
  // 4(D)(1) re-claimed detail and 4(D)(2) ineligible (section 16(4) / place of supply), as amended by 14/2022-CT.
  itc_inelg:[{ty:"RUL",...portalHeads(t4.d1_reclaimed)},{ty:"OTH",...portalHeads(t4.d2_ineligible)}]};
 const isup_rev={txval:round2(figures.reverseCharge.taxableValue),...portalHeads(figures.reverseCharge.liability)};
 const cashTotal=headsTotal(working.cashDue);
 return{itc_elg,isup_rev,tx_pmt:table61(working,paid),eligibleInputTax:headsTotal(figures.netItc),netTaxPayable:cashTotal,
  summary:{itcComputationId:latest?text(latest.id):null,itcComputationVersion:latest?num(latest.version):null,itcComputationSaved:Boolean(latest),
   itcNote:latest?`Table 4 is the saved ITC computation for ${period} (version ${num(latest.version)}).`:"Table 4 is a live preview: save the month's ITC computation, then generate this draft again before paying.",
   inputTaxByHead:figures.netItc,table4:t4,reverseChargeLiability:figures.reverseCharge.liability,reverseChargeTaxableValue:figures.reverseCharge.taxableValue,
   rule42:{commonCredit:figures.rule42.commonCredit,exemptTurnover:figures.rule42.exemptTurnover,totalTurnover:figures.rule42.totalTurnover,ratio:figures.rule42.ratio,reversal:figures.rule42.reversal,funeralGstTreatment:figures.rule42.funeralGstTreatment},
   rule37:{reversed:figures.rule37.reversed,reclaimed:figures.rule37.reclaimed},blockedCredit:figures.blocked.reported,
   legacyReviewedItcNotClaimed:round2(figures.notCredited.needsComponentSplit.reduce((s,b)=>s+b.legacyReviewedEligible,0)),billsNeedingComponentSplit:figures.notCredited.needsComponentSplit.length,
   setOff:{outwardTax:working.outwardTax,negativeItcAddedToLiability:working.negativeItcAddedToLiability,openingCredit:working.openingCredit,creditUsed:working.creditUsed,used:working.used,cashForwardCharge:working.cash,cashReverseCharge:working.reverseChargeCash,cashDue:working.cashDue,creditCarriedForward:working.creditCarriedForward,paymentsRecorded:paid},
   cashPayable:cashTotal}};
}

/* lib/gst-returns.ts owns gst_return_documents (and calls this module), so a month with no return drafted may have no table yet. */
async function latestGstr3b(db:Db,scope:Scope,period:string){
 if(!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gst_return_documents'").first<Row>())return null;
 return db.prepare("SELECT id,payload_json,summary_json,prepared_at,version FROM gst_return_documents WHERE entity_id=? AND registration_id=? AND return_type='GSTR-3B' AND period_code=? ORDER BY version DESC LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();
}
function outwardFromGstr3b(doc:Row){
 const payload=parse(doc.payload_json),sup=(payload.sup_details??{}) as Row,osup=(sup.osup_det??{}) as Row,zero=(sup.osup_zero??{}) as Row;
 return{igst:round2(num(osup.iamt)+num(zero.iamt)),cgst:round2(num(osup.camt)),sgst:round2(num(osup.samt)),cess:round2(num(osup.csamt)+num(zero.csamt))} as Heads;
}
/** What Finance sees before paying: the working, what is still due, and interest / late fee for a payment date. */
export async function gstSetoffView(db:Db,input:Scope&{periodCode:string;paidOn?:string}){
 await ensureInputTaxTables(db);await ensureTaxPaymentTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},period=text(input.periodCode),paidOn=text(input.paidOn);
 if(!isPeriod(period))throw refuse("The month must be YYYY-MM",400);
 if(paidOn&&!isIsoDate(paidOn))throw refuse("The payment date must be YYYY-MM-DD",400);
 await activeRegistration(db,scope,lastDayOf(period));
 const latest=await latestComputation(db,scope,period),doc=await latestGstr3b(db,scope,period),blockers:string[]=[];
 if(!latest)blockers.push(`Save the input tax credit computation for ${period} first.`);
 if(!doc)blockers.push(`Generate the GSTR-3B draft for ${period}: its output tax is what is paid.`);
 else if(latest&&text(parse(doc.summary_json).itcComputationId)!==text(latest.id))blockers.push(`Generate the GSTR-3B draft again: it was prepared before version ${num(latest.version)} of the ITC computation.`);
 const figures=computationFigures(latest)??await computeItc(db,{...scope,period}),outward=doc?outwardFromGstr3b(doc):zeroHeads();
 const working=await setoffWorking(db,scope,period,figures,outward),payments=await paymentsFor(db,scope,"period_code=?",[period]),paid=recorded(payments);
 if(working.unpaidEarlierPeriods.length)blockers.push(`Record the GST payment for ${working.unpaidEarlierPeriods.join(", ")} first: returns are filed in order.`);
 const legacy=await db.prepare("SELECT COALESCE(SUM(amount),0) amount,COUNT(*) n FROM statutory_tax_payments WHERE tax_kind='gst' AND period_code=?").bind(period).first<Row>();
 if(num(legacy?.n)>0)blockers.push(`A GST payment of ${round2(num(legacy?.amount))} for ${period} was already recorded without the credit set-off (the older "Record tax paid" form); ask Finance to reconcile it before recording here.`);
 const remaining=positive(subHeads(working.cashDue,paid.cash)),creditStillToUse=subUse(working.used,paid.used);
 const dueDay=await policyDueDay(db,scope.entityId,lastDayOf(period)),dueDate=gstr3bDueDate(period,dueDay);
 const charges=paidOn?chargesFor({figures,dueDate,paidOn,cash:remaining,dueDay,nilReturn:headsTotal(working.liability)===0&&headsTotal(working.reverseCharge)===0&&headsTotal(positive(working.netItc))===0}):null;
 return{period,registrationId:scope.registrationId,dueDate,itcComputation:latest?{id:text(latest.id),version:num(latest.version)}:null,gstr3b:doc?{id:text(doc.id),version:num(doc.version),preparedAt:num(doc.prepared_at)}:null,
  working,paymentsRecorded:payments.map(p=>({id:text(p.id),challanReference:text(p.challan_reference),paidOn:text(p.paid_on),cash:readHeads(parse(p.cash_json)),charges:parse(p.interest_json),settlement:parse(p.settlement_json),totalCash:round2(num(p.total_cash)),recordedBy:text(p.recorded_by)})),
  remainingCash:remaining,remainingCashTotal:headsTotal(remaining),creditStillToUse,charges,blockers,ready:blockers.length===0,liveFilingEnabled:false,
  explanation:"IGST credit is used first and in full; CGST credit pays CGST then IGST; SGST credit pays SGST then IGST (after CGST credit); CGST and SGST never pay each other. Reverse-charge tax is paid in cash only."};
}
function chargesFor(input:{figures:ItcComputation;dueDate:string;paidOn:string;cash:Heads;dueDay:number;nilReturn:boolean}){
 const late=interestOn(input.cash,input.dueDate,input.paidOn);
 let rule37=zeroHeads();
 for(const r of input.figures.rule37.reversals){if((r.rule??"rule37")!=="rule37")continue;rule37=addHeads(rule37,interestOn(readHeads(r.amount),gstr3bDueDate(r.claimedIn,input.dueDay),input.paidOn).interest);}
 let trueUp=zeroHeads();
 if(input.figures.trueUp){const shortfall=positive(readHeads(input.figures.trueUp.difference)),startYear=Number(input.figures.trueUp.financialYear.slice(0,4));trueUp=interestOn(shortfall,`${startYear+1}-03-31`,input.paidOn).interest;}
 const fee=lateFee(late.days,input.nilReturn);
 return{daysLate:late.days,lateInterest:late.interest,rule37InterestEstimate:rule37,rule42TrueUpInterest:trueUp,interestDue:addHeads(addHeads(late.interest,rule37),trueUp),lateFee:fee.fee,lateFeeNote:fee.capNote,
  note:late.days>0?`Paid ${late.days} day(s) after the due date: 18% a year on the cash paid (section 50(1), Rule 88B).`:"Paid by the due date: no interest on the cash.",estimateNote:"Rule 37 interest (section 50(3), Rule 88B(3)) assumes the credit was used when it was taken; the CA confirms."};
}
const CPIN=/^\d{14}([A-Z0-9]{4})?$/i;
/**
 * Records a GST payment Finance made on the portal for a month (finance.manage): the credit set-off (the first time) and the cash
 * by head, with interest and late fee, in one balanced journal. Idempotent per challan.
 */
export async function recordGstSetoffPayment(db:Db,input:Scope&{periodCode:string;challanReference:string;paidOn:string;cash?:Partial<Heads>;interest?:Partial<Heads>;lateFee?:Partial<Heads>;reason:string},actor:string){
 await ensureInputTaxTables(db);await ensureTaxPaymentTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},period=text(input.periodCode),challan=text(input.challanReference).toUpperCase(),paidOn=text(input.paidOn),reason=text(input.reason);
 if(!isPeriod(period))throw refuse("The month the tax is for must be YYYY-MM",400);
 if(!isIsoDate(paidOn)||paidOn<`${period}-01`||paidOn>istToday())throw refuse("A real payment date is required: on or after the start of that month, and not in the future",400);
 if(reason.length<8)throw refuse("A clear reason of at least 8 characters is required",400);
 if(await periodLocked(db,paidOn.slice(0,7)))throw refuse(`The payment date falls in a closed month (${paidOn.slice(0,7)}); record it with a date in an open month`);
 const amounts=(value:Partial<Heads>|undefined,label:string)=>{const out=zeroHeads();for(const head of HEADS){const raw=value?.[head];if(raw===undefined||raw===null||(raw as unknown)==="")continue;const n=Number(raw);if(!Number.isFinite(n)||n<0)throw refuse(`${label} must be amounts of zero or more`,400);out[head]=round2(n);}return out;};
 const cash=amounts(input.cash,"Cash paid"),interest=amounts(input.interest,"Interest"),fee=amounts(input.lateFee,"Late fee");
 const cashTotal=headsTotal(cash),chargesTotal=round2(headsTotal(interest)+headsTotal(fee));
 if(cashTotal+chargesTotal>0&&!CPIN.test(challan))throw refuse("The challan reference is the 14-digit CPIN of the PMT-06 challan (or its CIN)",400);
 if(cashTotal+chargesTotal===0&&challan.length<4)throw refuse("With no cash paid, give the GSTR-3B acknowledgement (ARN) as the reference",400);
 const prior=await db.prepare("SELECT * FROM finance_gst_setoff_payments WHERE entity_id=? AND registration_id=? AND challan_reference=?").bind(scope.entityId,scope.registrationId,challan).first<Row>();
 if(prior){const same=text(prior.period_code)===period&&JSON.stringify(readHeads(parse(prior.cash_json)))===JSON.stringify(cash);if(same)return{id:text(prior.id),periodCode:period,challanReference:challan,journalGroup:text(prior.journal_group),duplicatePrevented:true};throw refuse(`Challan ${challan} is already recorded for ${text(prior.period_code)}; a challan is recorded once`);}
 const view=await gstSetoffView(db,{...scope,periodCode:period,paidOn});
 if(!view.ready)throw refuse(view.blockers.join(" "));
 const latest=await latestComputation(db,scope,period),working=view.working;
 for(const head of HEADS)if(cash[head]>view.remainingCash[head]+0.01)throw refuse(`${head.toUpperCase()} cash of ${cash[head]} is more than the ${view.remainingCash[head]} still owed for ${period}`);
 const charges=view.charges!;
 for(const head of HEADS){if(interest[head]>charges.interestDue[head]+1)throw refuse(`${head.toUpperCase()} interest of ${interest[head]} is more than the ${charges.interestDue[head]} due for a payment on ${paidOn}`);if(fee[head]>charges.lateFee[head]+1)throw refuse(`${head.toUpperCase()} late fee of ${fee[head]} is more than the ${charges.lateFee[head]} due for a payment on ${paidOn}`);}
 const useNow=view.creditStillToUse,creditNow=creditUsedByHead(useNow),settledNow=liabilitySettledByHead(useNow),first=view.paymentsRecorded.length===0;
 if(!first&&cashTotal+chargesTotal+headsTotal(creditNow)===0)throw refuse(`Nothing is left to record for ${period}: the set-off and the cash are already recorded`);
 // Cash for a head goes first to its reverse-charge tax (which only cash can pay), then to the forward-charge balance.
 const paidEarlier=recordedCash(view),rcmLeft=positive(subHeads(working.reverseChargeCash,paidEarlier)),toRcm:Heads=zeroHeads(),toForward:Heads=zeroHeads();
 for(const head of HEADS){toRcm[head]=round2(Math.min(cash[head],rcmLeft[head]));toForward[head]=round2(cash[head]-toRcm[head]);}
 // What this payment settles of each head's forward liability goes to the output tax first (Dr 2130); any rest is the head's
 // negative net ITC, which restores its input account (the reversal journals already took it out).
 const priorOutput=view.paymentsRecorded.reduce((sum,p)=>addHeads(sum,readHeads((p.settlement as Row).outputSettled)),zeroHeads()),outputNow=zeroHeads(),restoreNow=zeroHeads();
 for(const head of HEADS){const toward=round2(settledNow[head]+toForward[head]),left=Math.max(0,round2(working.outwardTax[head]-priorOutput[head]));outputNow[head]=round2(Math.min(toward,left));restoreNow[head]=round2(toward-outputNow[head]);}
 const toPayable=headsTotal(outputNow),toRcmPayable=headsTotal(toRcm);
 const[gstOwed,rcmOwed]=await Promise.all([outstanding(db,ACCT.GST_PAYABLE,period),outstanding(db,ACCT.GST_RCM_PAYABLE,period)]);
 if(toPayable>gstOwed+0.01)throw refuse(`The books owe ${gstOwed} of GST (2130) up to ${period}, but this payment settles ${toPayable}: post the missing output GST before recording it`);
 if(toRcmPayable>rcmOwed+0.01)throw refuse(`The books owe ${rcmOwed} of reverse-charge GST (2135) up to ${period}, but this payment settles ${toRcmPayable}`);
 for(const head of HEADS){const balance=await inputBalance(db,INPUT_TAX_ACCOUNTS[head]);if(creditNow[head]>round2(balance+restoreNow[head])+0.01)throw refuse(`The books hold ${balance} of ${INPUT_TAX_ACCOUNTS[head]}, but the set-off uses ${creditNow[head]}: the bills behind this credit are not posted`);}
 const raw:PostingLine[]=[{account:ACCT.GST_PAYABLE,debit:toPayable,credit:0},{account:ACCT.GST_RCM_PAYABLE,debit:toRcmPayable,credit:0},{account:GST_INTEREST_ACCOUNT,debit:chargesTotal,credit:0}];
 for(const head of HEADS)raw.push({account:INPUT_TAX_ACCOUNTS[head],debit:restoreNow[head],credit:creditNow[head]});
 raw.push({account:ACCT.BANK,debit:0,credit:round2(cashTotal+chargesTotal)});
 const lines=deltaLines(netByAccount(raw),new Map());
 const id=`GSTPAY-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now(),doc=view.gstr3b!;
 const after={periodCode:period,challanReference:challan,paidOn,creditUsed:useNow,cash,interest,lateFee:fee,cashTotal,chargesTotal,itcComputationId:text(latest?.id),gstr3bId:doc.id,creditCarriedForward:working.creditCarriedForward};
 const extra=[db.prepare("INSERT INTO finance_gst_setoff_payments (id,entity_id,registration_id,period_code,challan_reference,paid_on,computation_id,gstr3b_id,itc_used_json,cash_json,interest_json,settlement_json,total_cash,journal_group,reason,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,scope.entityId,scope.registrationId,period,challan,paidOn,text(latest?.id),doc.id,JSON.stringify(useNow),JSON.stringify(cash),JSON.stringify({interest,lateFee:fee,daysLate:charges.daysLate}),JSON.stringify({outputSettled:outputNow,negativeItcRestored:restoreNow,toReverseCharge:toRcm,toForwardCharge:toForward}),round2(cashTotal+chargesTotal),`setoff-${id}`,reason,actor,now),
  db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"gst_setoff_payment",id,"gst_paid",JSON.stringify({remainingCash:view.remainingCash,creditStillToUse:view.creditStillToUse,gstPayable:gstOwed,rcmPayable:rcmOwed}),JSON.stringify(after),actor,reason,now)];
 const posting=await postClaimedJournal(db,{claimType:"gst_setoff_payment",claimKey:`${scope.entityId}:${scope.registrationId}:${challan}`,sourceType:"gst_setoff_payment",sourceId:`${scope.entityId}:${scope.registrationId}:${period}`,entityId:scope.entityId,entryDate:paidOn,narration:`GST ${period} paid: challan ${challan}${first?", credit set-off under Rule 88A":""}`,lines,extra});
 return{id,periodCode:period,challanReference:challan,paidOn,creditUsed:useNow,creditUsedByHead:creditNow,liabilitySettledByCredit:settledNow,cash,cashToReverseCharge:toRcm,cashToForwardCharge:toForward,interest,lateFee:fee,totalPaid:round2(cashTotal+chargesTotal),journalGroup:posting.journalGroup,journal:lines.filter(l=>l.debit||l.credit),duplicatePrevented:false};
}
const recordedCash=(view:Awaited<ReturnType<typeof gstSetoffView>>)=>view.paymentsRecorded.reduce((s,p)=>addHeads(s,p.cash),zeroHeads());
/** Balance of a payable up to and including the month, less every payment debited so far (as lib/gst-tax-payments.ts reads it). */
async function outstanding(db:Db,account:string,period:string){const row=await db.prepare("SELECT COALESCE(SUM(CASE WHEN period_code<=? THEN credit ELSE 0 END),0)-COALESCE(SUM(debit),0) owed FROM finance_journal_entries WHERE account_code=?").bind(period,account).first<Row>();return round2(num(row?.owed));}
async function inputBalance(db:Db,account:string){const row=await db.prepare("SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) balance FROM finance_journal_entries WHERE account_code=?").bind(account).first<Row>();return round2(num(row?.balance));}
