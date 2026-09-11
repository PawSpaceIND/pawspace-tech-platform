import { groomingCatalogue } from "./grooming-governance";
import { ensureGroomingInvoiceTables } from "./grooming-invoice";
import { createBookingPaymentOrder } from "./payment-order-intent";

type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const round2=(value:number)=>Math.round(value*100)/100;

export async function generateCanonicalSalesQuote(db:D1Database,input:{packageCode:string;petCount:number;cityId:string}){
  const item=groomingCatalogue.find(row=>row.active&&row.code===text(input.packageCode));
  if(!item)throw new Error("Active governed package not found");
  const petCount=Number(input.petCount),maxPets=item.maxPetsPerBooking??4;
  if(!Number.isInteger(petCount)||petCount<1||petCount>maxPets)throw new Error(`Quote pet count must be a whole number between 1 and ${maxPets}`);
  const baseUnit=Number(item.singlePrice),multiUnit=Number(item.multiPetPrice??item.singlePrice);
  if(!Number.isFinite(baseUnit)||baseUnit<=0||!Number.isFinite(multiUnit)||multiUnit<=0||multiUnit>baseUnit)throw new Error("Governed multi-pet catalogue pricing is invalid");
  const cityId=text(input.cityId)||"blr",baseSubtotal=round2(baseUnit*petCount),discountedSubtotal=round2((petCount===1?baseUnit:multiUnit)*petCount),multiPetDiscount=round2(baseSubtotal-discountedSubtotal);
  await ensureGroomingInvoiceTables(db);
  const policy=await db.prepare("SELECT tax_mode,tax_rate,version FROM grooming_tax_policies WHERE city_id=? AND status='published' LIMIT 1").bind(cityId).first<Row>();
  if(!policy||!["inclusive","exclusive"].includes(text(policy.tax_mode))||!Number.isFinite(Number(policy.tax_rate))||Number(policy.tax_rate)<0)throw new Error("Quote is blocked until a published city GST policy is configured");
  const taxRate=Number(policy.tax_rate),inclusive=text(policy.tax_mode)==="inclusive",taxableAmount=inclusive?round2(discountedSubtotal/(1+taxRate/100)):discountedSubtotal,gstAmount=inclusive?round2(discountedSubtotal-taxableAmount):round2(taxableAmount*taxRate/100),total=round2(inclusive?discountedSubtotal:taxableAmount+gstAmount);
  return{serviceCode:"grooming",packageCode:item.code,packageName:item.name,petCount,baseUnitPrice:baseUnit,baseSubtotal,multiPetUnitPrice:petCount>1?multiUnit:baseUnit,multiPetDiscount,taxMode:text(policy.tax_mode),gstRatePercent:taxRate,taxableAmount,gstAmount,totalAmount:total,currency:"INR",catalogueVersion:item.version,taxPolicyVersion:Number(policy.version||0),serverAuthoritative:true,liveMoney:false};
}

export async function createCanonicalSalesPaymentLink(db:D1Database,env:Record<string,unknown>,input:{bookingId:string;customerId:string;actorId:string}){
  return createBookingPaymentOrder(db,env,input);
}
