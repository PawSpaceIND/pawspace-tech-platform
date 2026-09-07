export type SupplyType="intra"|"inter";
export type PosRule="recipient_location"|"training_performance"|"service_location"|"immovable_property"|"transport"|"default_recipient_or_service";
export type TaxComponent={code:string;rate:number};
export type PosInput={
 supplierGstin:string;
 recipientGstin?:string|null;
 recipientState?:string|null;
 serviceState?:string|null;
 placeOfSupplyRule?:string|null;
 recipientRegistered?:boolean;
 recipientCountry?:string|null;
 serviceCountry?:string|null;
};
export type PosResolution={
 supplierGstin:string;
 supplierState:string;
 recipientGstin:string|null;
 recipientState:string|null;
 posState:string;
 posRule:PosRule;
 supplyType:SupplyType;
 legalBasis:"IGST_ACT_S12"|"IGST_ACT_S13";
};

const text=(value:unknown)=>String(value??"").trim();
const STATE_CODE=/^\d{2}$/;
const GSTIN=/^\d{2}[0-9A-Z]{13}$/i;

export function stateCodeFromGstin(gstin:string){const value=text(gstin).toUpperCase();if(!GSTIN.test(value))return null;return value.slice(0,2);}
function normalizedState(value:unknown){const state=text(value).slice(0,2);return STATE_CODE.test(state)?state:null;}
function normalizedRule(value:unknown):PosRule{
 const rule=text(value).toLowerCase();
 if(["recipient_location","recipient","customer_location"].includes(rule))return"recipient_location";
 if(["training_performance","training","performance","training_location"].includes(rule))return"training_performance";
 if(["service_location","location_of_service","physical_performance"].includes(rule))return"service_location";
 if(["immovable_property","property_location"].includes(rule))return"immovable_property";
 if(["transport","transport_location"].includes(rule))return"transport";
 return"default_recipient_or_service";
}

/**
 * Canonical domestic POS resolver for PawSpace service invoices.
 *
 * The configured tax classification chooses the statutory POS rule; this resolver chooses the state and
 * therefore the tax heads. It deliberately does not invent a GST rate. Rates remain Finance/CA governed.
 * For cross-border inputs it records the Section 13 basis but still fails closed unless a valid Indian POS
 * state is supplied by the governed caller; PawSpace must not fabricate an export/import POS.
 */
export function resolveTaxPlaceOfSupply(input:PosInput):PosResolution{
 const supplierGstin=text(input.supplierGstin).toUpperCase();
 const supplierState=stateCodeFromGstin(supplierGstin);
 if(!supplierState)throw new Error("configuration_required:valid_supplier_gstin");
 const recipientGstin=text(input.recipientGstin).toUpperCase()||null;
 const recipientGstinState=recipientGstin?stateCodeFromGstin(recipientGstin):null;
 if(recipientGstin&&!recipientGstinState)throw new Error("configuration_required:valid_recipient_gstin");
 const recipientState=recipientGstinState||normalizedState(input.recipientState);
 const serviceState=normalizedState(input.serviceState);
 const registered=input.recipientRegistered===true||Boolean(recipientGstinState);
 const rule=normalizedRule(input.placeOfSupplyRule);
 const recipientCountry=text(input.recipientCountry||"IN").toUpperCase();
 const serviceCountry=text(input.serviceCountry||"IN").toUpperCase();
 const legalBasis:PosResolution["legalBasis"]=(recipientCountry!=="IN"||serviceCountry!=="IN")?"IGST_ACT_S13":"IGST_ACT_S12";
 let posState:string|null=null;
 if(legalBasis==="IGST_ACT_S13"){
  posState=recipientState||serviceState;
 }else if(rule==="training_performance"){
  // IGST Act s12 training/performance: registered recipient -> recipient location; otherwise place performed.
  posState=registered?recipientState:serviceState;
 }else if(rule==="service_location"||rule==="immovable_property"){
  posState=serviceState;
 }else if(rule==="transport"){
  posState=registered?recipientState:(serviceState||recipientState);
 }else{
  posState=recipientState||serviceState;
 }
 if(!posState)throw new Error("configuration_required:place_of_supply_state");
 return{supplierGstin,supplierState,recipientGstin,recipientState,posState,posRule:rule,supplyType:posState===supplierState?"intra":"inter",legalBasis};
}

/** Re-heads only the GST portion of approved components; cess/other components are preserved unchanged. */
export function componentsForSupply(components:TaxComponent[],supplyType:SupplyType):TaxComponent[]{
 if(!Array.isArray(components)||!components.length)throw new Error("configuration_required:tax_components");
 const gstCodes=new Set(["cgst","sgst","utgst","igst"]),gst=components.filter(c=>gstCodes.has(text(c.code).toLowerCase())),other=components.filter(c=>!gstCodes.has(text(c.code).toLowerCase()));
 const total=Math.round(gst.reduce((sum,c)=>sum+Number(c.rate||0),0)*1000000)/1000000;
 if(!Number.isFinite(total)||total<0)throw new Error("configuration_required:tax_component_rate");
 if(total===0)return other;
 if(supplyType==="inter")return[{code:"IGST",rate:total},...other];
 const cgst=gst.filter(c=>text(c.code).toLowerCase()==="cgst").reduce((s,c)=>s+Number(c.rate||0),0),sgst=gst.filter(c=>["sgst","utgst"].includes(text(c.code).toLowerCase())).reduce((s,c)=>s+Number(c.rate||0),0);
 if(cgst>0&&sgst>0&&Math.abs(cgst+sgst-total)<0.000001)return[{code:"CGST",rate:cgst},{code:"SGST",rate:sgst},...other];
 return[{code:"CGST",rate:total/2},{code:"SGST",rate:total/2},...other];
}
