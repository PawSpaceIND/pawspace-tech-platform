import {ensureServiceInvoiceOwnershipTables,ServiceInvoiceOwnershipRequired,type ServiceInvoiceScope} from "./service-invoice-ownership";
// Service-vertical (booking_invoices) output-tax split — the ONE place that decides how much of the GST
// collected on the five service verticals is PawSpace's OWN statutory output tax versus GST it merely
// collected on the service provider's behalf. Every consumer (monthly close, statutory package, GSTR-9,
// GSTR-1/3B/9C) must use this so every "output tax" figure means the same thing.
//
// Owner decisions of 26 Sept 2026: PawSpace's own GST is the one GST setting applied to its COMMISSION on a
// commission job and to the whole paid amount on its own supply; nothing is carved off the order for the
// provider any more. provider_payout_computations records exactly that (platform_gst + taxable_commission,
// pawspace_gst_on_order + own_supply_taxable_value), but THIS function still reads the older signal:
//   - provider_gst_deducted>0  => a LEGACY carve row: PawSpace own = platform_gst (commission);
//                                 provider supply = provider_gst_deducted - platform_gst (-> TCS/GSTR-8).
//   - provider_gst_deducted=0  => every row written since the carve was retired: the FULL invoice tax is
//                                 counted as PawSpace output (conservative, never understated). Filing 54 on
//                                 a 300 commission from the payout row is the filing work package (audit G6).
// Who is the supplier of record on the customer invoice is not decided yet (owner decision 9).
// A booking with an invoice but no payout computation cannot be split, so its full tax is counted as
// PawSpace output (never understates the statutory liability). Cold-DB safe: a missing booking_invoices or
// provider_payout_computations table degrades to the full booking-invoice tax (or 0 when there are none).
// Import-safe for `node --experimental-strip-types` (no TS parameter properties).

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(v:number)=>Math.round(v*100)/100;
const num=(v:unknown)=>Number(v??0);
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export type ServiceOutputTaxSplit={
 totalTaxCollected:number;grossTotal:number;invoiceCount:number;
 pawspaceOwnOutputTax:number;pawspaceOwnTaxableValue:number;
 providerSupplyGstOnBehalf:number;costedCount:number;uncostedTax:number;
};

/** Split the service-vertical output tax for the [startMs,endMs) epoch-ms window into PawSpace's own
 * output GST (commission/principal) and the provider-supply GST collected on the provider's behalf. */
export async function serviceVerticalOutputTax(db:Db,startMs:number,endMs:number,scope?:ServiceInvoiceScope):Promise<ServiceOutputTaxSplit>{
 let ownershipJoin="",ownershipWhere="";const binds:unknown[]=[startMs,endMs];
 if(scope){
  await ensureServiceInvoiceOwnershipTables(db);
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='booking_invoices'").first<Row>();
  if(exists){const unassigned=await db.prepare("SELECT COUNT(*) n FROM booking_invoices bi LEFT JOIN service_invoice_ownership o ON o.invoice_id=bi.id WHERE bi.issued_at>=? AND bi.issued_at<? AND bi.status!='cancelled' AND o.invoice_id IS NULL").bind(startMs,endMs).first<Row>();if(Number(unassigned?.n)>0)throw new ServiceInvoiceOwnershipRequired();}
  ownershipJoin=" JOIN service_invoice_ownership o ON o.invoice_id=bi.id";ownershipWhere=" AND o.entity_id=? AND o.registration_id=?";binds.push(scope.entityId,scope.registrationId);
 }
 const total=await tableExists(db,"booking_invoices")?await db.prepare(`SELECT COALESCE(SUM(bi.tax_amount),0) tax,COALESCE(SUM(bi.gross_amount),0) gross,COUNT(*) n FROM booking_invoices bi${ownershipJoin} WHERE bi.issued_at>=? AND bi.issued_at<? AND bi.status!='cancelled'${ownershipWhere}`).bind(...binds).first<Row>():null;
 const totalTax=round2(num(total?.tax)),grossTotal=round2(num(total?.gross)),invoiceCount=num(total?.n);
 const costed=invoiceCount&&await tableExists(db,"provider_payout_computations")?await db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.platform_gst ELSE bi.tax_amount END),0) ownTax,COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.provider_gst_deducted-p.platform_gst ELSE 0 END),0) providerSupply,COALESCE(SUM(CASE WHEN p.provider_gst_deducted>0 THEN p.platform_fee ELSE bi.gross_amount-bi.tax_amount END),0) ownTaxable,COALESCE(SUM(bi.tax_amount),0) costedTax,COALESCE(SUM(bi.gross_amount),0) costedGross,COUNT(*) n FROM booking_invoices bi JOIN provider_payout_computations p ON p.booking_id=bi.booking_id${ownershipJoin} WHERE bi.issued_at>=? AND bi.issued_at<? AND bi.status!='cancelled'${ownershipWhere}`).bind(...binds).first<Row>():null;
 const ownTaxCosted=round2(num(costed?.ownTax)),providerSupply=round2(num(costed?.providerSupply)),ownTaxableCosted=round2(num(costed?.ownTaxable)),costedTax=round2(num(costed?.costedTax)),costedGross=round2(num(costed?.costedGross));
 const uncostedTax=round2(totalTax-costedTax),uncostedTaxable=round2((grossTotal-costedGross)-uncostedTax);
 return{totalTaxCollected:totalTax,grossTotal,invoiceCount,
  pawspaceOwnOutputTax:round2(ownTaxCosted+uncostedTax),
  pawspaceOwnTaxableValue:round2(ownTaxableCosted+uncostedTaxable),
  providerSupplyGstOnBehalf:round2(providerSupply),
  costedCount:num(costed?.n),uncostedTax};
}
