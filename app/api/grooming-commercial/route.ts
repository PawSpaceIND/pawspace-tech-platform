import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{createGroomingQuote}from"../../../lib/grooming-commercial-governance";
import type {GroomingPetType} from "../../../lib/grooming-governance";

/**
 * Customer-owned Grooming commercial quote. Unlike the training quote route, this one requires the normal
 * authenticated actor and customer ownership: a quote is a customer's offer record, not an anonymous price check.
 * The price itself comes from the canonical live Grooming governance; this route adds no pricing of its own.
 */
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store, private"}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Grooming quote blocked",{status:403});}
async function failure(error:unknown){if(error instanceof Response&&error.status>=400&&error.status<500){const message=await error.text().catch(()=>"");return json({error:message||"Grooming quote request failed"},error.status);}return authError(error,"Grooming quote request failed");}
const readiness={productionReady:false,liveMoney:false,priceSource:"canonical_live_grooming_governance"};
type Body={customerId?:string;packageCode?:string;packageName?:string;pets?:Array<{sourceId?:string;species?:string}>;addOns?:string[];cityId?:string;zoneId?:string;scheduledStart?:string;paymentMode?:string;couponQuoteId?:string};

export async function POST(request:Request){try{
  sameOriginWrite(request);
  const actor=await resolveActor(request),db=await database();
  const body=await request.json() as Body;
  // Authorize before validating: ownership is decided first (an absent id is owned by no customer), so a caller
  // who neither owns nor manages the customer is refused 403 before any payload validation answers.
  const customerId=String(body.customerId||"").trim();
  await requireCustomerOwnership(db,actor,customerId);
  if(!customerId)return json({error:"Customer is required"},400);
  // Declared pets are the customer's SAVED pets (source id); species is taken from the saved row, the client value is only cross-checked.
  const pets=Array.isArray(body.pets)?body.pets.slice(0,8).map(pet=>({sourceId:String(pet?.sourceId||""),...(pet?.species?{species:(["dog","cat","other"].includes(String(pet.species))?String(pet.species):"other") as GroomingPetType}:{})})):[];
  const addOns=Array.isArray(body.addOns)?body.addOns.slice(0,8).map(value=>String(value)):[];
  const quote=await createGroomingQuote(db,{customerId,packageCode:String(body.packageCode||""),packageName:body.packageName?String(body.packageName):undefined,pets,addOns,cityId:String(body.cityId||""),zoneId:body.zoneId?String(body.zoneId):null,scheduledStart:String(body.scheduledStart||""),paymentMode:String(body.paymentMode||"prepaid"),couponQuoteId:body.couponQuoteId?String(body.couponQuoteId):null});
  await securityAudit(db,actor,"grooming_commercial.quote.create","customer",customerId,"completed",{quoteId:quote.quoteId,packageCode:quote.packageCode,finalPayable:quote.finalPayable,addOns:quote.addOns,couponQuoteId:quote.couponQuoteId,paymentMode:quote.paymentMode,expiresAt:quote.expiresAt});
  return json({data:{quote,...readiness}},201);
}catch(error){return failure(error);}}
