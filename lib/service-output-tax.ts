// Service-vertical (booking_invoices) output-tax split — the ONE place that decides how much of the GST
// collected on the five service verticals is PawSpace's OWN statutory output tax versus GST it merely
// collected on the service provider's behalf. Every consumer (monthly close, statutory package, GSTR-9,
// GSTR-1/3B/9C) must use this so every "output tax" figure means the same thing.
//
// Confirmed commercial model: all customer prices are GST-INCLUSIVE. On a MARKETPLACE supply
// (commission_standard) only the COMMISSION GST is PawSpace's own output tax; the provider's supply GST
// (carved from the inclusive order) is the PROVIDER's liability, remitted via s52 GST TCS / GSTR-8 - never
// in PawSpace's own GSTR-1/3B. The engagement-model-aware split already lives in
// provider_payout_computations:
//   - provider_gst_deducted>0  => marketplace commission_standard: PawSpace own = platform_gst (commission);
//                                 provider supply = provider_gst_deducted - platform_gst (-> TCS/GSTR-8).
//   - provider_gst_deducted=0  => groomer / direct-employee / principal: PawSpace is the supplier of record,
//                                 so the FULL invoice tax is PawSpace output (conservative).
// A booking with an invoice but no payout computation cannot be split, so its full tax is counted as
// PawSpace output (never understates the statutory liability). Cold-DB safe: a missing booking_invoices or
// provider_payout_computations table degrades to the full booking-invoice tax (or 0 when there are none).
// Import-safe for `node --experimental-strip-types` (no TS parameter properties, no cross-module imports).

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(v:number)=>Math.round(v*100)/100;
const num=(v:unknown)=>Number(v??0);
async function safeFirst(db:Db,sql:string,b:unknown[]):Promise<Row|null>{try{return await db.prepare(sql).bind(...b).first<Row>();}catch{return null;}}

export type ServiceOutputTaxSplit={
 totalTaxCollected:number;grossTotal:number;invoiceCount:number;
 pawspaceOwnOutputTax:number;pawspaceOwnTaxableValue:number;
 providerSupplyGstOnBehalf:number;costedCount:number;uncostedTax:number;
 trainingOutputTax:number;trainingInvoiceCount:number;
};

/** Split the service-vertical output tax for the [startMs,endMs) epoch-ms window into PawSpace's own
 * output GST (commission/principal) and the provider-supply GST collected on the provider's behalf. */
export async function serviceVerticalOutputTax(db:Db,startMs:number,endMs:number):Promise<ServiceOutputTaxSplit>{
 const total=await safeFirst(db,"SELECT COALESCE(SUM(tax_amount),0) tax,COALESCE(SUM(gross_amount),0) gross,COUNT(*) n FROM booking_invoices WHERE issued_at>=? AND issued_at<? AND status!='cancelled'",[startMs,endMs]);
 const totalTax=round2(num(total?.tax)),grossTotal=round2(num(total?.gross)),invoiceCount=num(total?.n);
 /* [R3-D/F9] Training is the SIXTH service vertical and it does not write booking_invoices.
  *
  * Sitting, boarding, walking, taxi and grooming all issue into booking_invoices; Training issues into
  * training_finance_invoices (lib/training-finance.ts issueTrainingInvoice), which nothing in the tax
  * stack read. Because EVERY PawSpace output-tax figure is derived from this one function, the GST on
  * every training package was missing from the monthly close, the statutory package, GSTR-1, GSTR-3B and
  * GSTR-9 alike - an understatement of output tax, which is the direction that matters. Counted only
  * once a number has actually been allocated (status issued_uat), against the issue date, exactly like
  * the other five. There is no provider-supply split to make here: trainer compensation is a COST
  * (training_session_earnings), not a marketplace supply carved out of the customer's payment, so the
  * whole invoice tax is PawSpace's own output tax - the same conservative treatment an uncosted booking
  * invoice already gets. The two tables are disjoint (no training booking writes booking_invoices), so
  * nothing is counted twice. Cold-DB safe: a database with no training tables degrades to 0. */
 const training=await safeFirst(db,"SELECT COALESCE(SUM(tax_amount),0) tax,COALESCE(SUM(taxable_amount),0) taxable,COALESCE(SUM(invoice_total),0) gross,COUNT(*) n FROM training_finance_invoices WHERE invoice_number IS NOT NULL AND status='issued_uat' AND issued_at>=? AND issued_at<?",[startMs,endMs]);
 const trainingTax=round2(num(training?.tax)),trainingTaxable=round2(num(training?.taxable)),trainingGross=round2(num(training?.gross)),trainingCount=num(training?.n);
 const costed=await safeFirst(db,"SELECT COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.platform_gst ELSE bi.tax_amount END),0) ownTax,COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.provider_gst_deducted-p.platform_gst ELSE 0 END),0) providerSupply,COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.platform_fee ELSE bi.gross_amount-bi.tax_amount END),0) ownTaxable,COALESCE(SUM(bi.tax_amount),0) costedTax,COALESCE(SUM(bi.gross_amount),0) costedGross,COUNT(*) n FROM booking_invoices bi JOIN provider_payout_computations p ON p.booking_id=bi.booking_id WHERE bi.issued_at>=? AND bi.issued_at<? AND bi.status!='cancelled'",[startMs,endMs]);
 const ownTaxCosted=round2(num(costed?.ownTax)),providerSupply=round2(num(costed?.providerSupply)),ownTaxableCosted=round2(num(costed?.ownTaxable)),costedTax=round2(num(costed?.costedTax)),costedGross=round2(num(costed?.costedGross));
 const uncostedTax=round2(totalTax-costedTax),uncostedTaxable=round2((grossTotal-costedGross)-uncostedTax);
 return{totalTaxCollected:round2(totalTax+trainingTax),grossTotal:round2(grossTotal+trainingGross),invoiceCount:invoiceCount+trainingCount,
  pawspaceOwnOutputTax:round2(ownTaxCosted+uncostedTax+trainingTax),
  pawspaceOwnTaxableValue:round2(ownTaxableCosted+uncostedTaxable+trainingTaxable),
  providerSupplyGstOnBehalf:round2(providerSupply),
  costedCount:num(costed?.n),uncostedTax,
  trainingOutputTax:trainingTax,trainingInvoiceCount:trainingCount};
}
