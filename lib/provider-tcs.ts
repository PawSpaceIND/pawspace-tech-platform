/**
 * s.52 GST TCS on commission providers - owner decision 5 (26 Sept 2026): PawSpace withholds 0.5% ONLY from a
 * provider who holds an active GSTIN tax profile. A provider without one is paid in full and is never blocked
 * (no 409, no configuration_required) for lacking a GSTIN. Completion finance (every commission vertical,
 * taxi owner vehicles included), the Finance payout preview and the monthly GSTR-8 all use this one rule.
 * The TCS base is the value of the provider's supply: the amount the customer paid. An exempt supply (funeral /
 * memorial, owner decision 4) is not a taxable supply, so s.52 TCS never applies to it, registered or not.
 */
import{stateCodeFromGstin}from"./tax-pos-resolver";
import{tcsRateS52For}from"./tcs-rate";
import{COMMISSION_ENGAGEMENT_MODELS}from"./provider-commercial-terms";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
export type ProviderGstRegistration={gstin:string;state:string};
/** The provider's active GSTIN tax profile, or null when they are not GST-registered with PawSpace. */
export async function activeProviderGstRegistration(db:Db,providerId:string):Promise<ProviderGstRegistration|null>{
 const row=await db.prepare("SELECT gstin,state_code FROM finance_provider_tax_profiles WHERE provider_id=? AND status='active'").bind(providerId).first<Row>().catch(()=>null);
 const gstin=text(row?.gstin).toUpperCase(),profileState=text(row?.state_code).slice(0,2),state=/^\d{2}$/.test(profileState)?profileState:stateCodeFromGstin(gstin);
 return gstin&&state?{gstin,state}:null;
}
/** The TCS decision completion recorded when it finalised the booking's payout row, or null before that. A re-run, the
 * Finance payout preview and GSTR-8 follow it rather than re-deciding from today's tax profile, so what is filed and
 * what is paid stay what completion withheld and posted. */
export async function recordedTcsDecision(db:Db,bookingId:string){
 const row=await db.prepare("SELECT finalized_at,computed_at,provider_gst_registered,supplier_gstin FROM provider_payout_computations WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!row||!(Number(row.finalized_at)>0))return null;const gstin=text(row.supplier_gstin).toUpperCase(),state=stateCodeFromGstin(gstin);
 return{computedAt:Number(row.computed_at)||Date.now(),registration:Number(row.provider_gst_registered)===1&&state?{gstin,state} as ProviderGstRegistration:null};
}
/** TCS on one commission supply. Zero for own supply, exempt supplies and unregistered providers. */
export function providerTcs(input:{engagementModel:string;registration:ProviderGstRegistration|null;supplyValue:number;at:number|string|Date;placeOfSupplyState:string;exempt?:boolean}){
 const rate=tcsRateS52For(input.at),applicable=COMMISSION_ENGAGEMENT_MODELS.has(text(input.engagementModel).toLowerCase())&&Boolean(input.registration)&&!input.exempt,base=applicable?Math.max(0,round2(input.supplyValue)):0,intra=!input.registration||input.registration.state===text(input.placeOfSupplyState);
 const cgst=applicable&&intra?round2(base*rate.cgst):0,sgst=applicable&&intra?round2(base*rate.sgst):0,igst=applicable&&!intra?round2(base*rate.igst):0;
 return{applicable,registered:Boolean(input.registration),supplierGstin:input.registration?.gstin??null,supplierState:input.registration?.state??null,base,cgst,sgst,igst,total:applicable?round2(base*rate.total):0,supplyType:(intra?"intra":"inter") as "intra"|"inter",rate};
}
