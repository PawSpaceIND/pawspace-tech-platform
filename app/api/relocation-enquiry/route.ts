import{authError,authorize,database}from"../../../lib/server-auth";
import{createRelocationEnquiry,listRelocationEnquiries,type RelocationEnquiry,type RelocationEnquiryInput}from"../../../lib/relocation-enquiry";
import{hasPermission,maskPhone}from"../../../lib/platform-security";
import{maskEmail}from"../../../lib/purpose-based-access";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin relocation-enquiry write blocked",{status:403});}

/**
 * Staff-facing directory. Gateway maps GET here to "customers.view".
 *
 * Contact numbers and email are masked for a role without customers.view_full_phone, the permission the
 * other staff lists (CRM, conversations, subscription customers) mask on, with the same helpers: an
 * associate saw every enquirer's full number and email here while the CRM showed them masked. The
 * masking happens on the server, so the raw values never reach a browser that may not show them.
 */
function maskedEnquiry(enquiry:RelocationEnquiry):RelocationEnquiry{return{...enquiry,phonePrimary:maskPhone(enquiry.phonePrimary),phoneSecondary:enquiry.phoneSecondary?maskPhone(enquiry.phoneSecondary):null,email:maskEmail(enquiry.email)??""};}
export async function GET(request:Request){try{const actor=await authorize(request,"customers.view");const db=await database();const fullContact=hasPermission(actor.permissions,"customers.view_full_phone"),enquiries=await listRelocationEnquiries(db);return json({data:fullContact?enquiries:enquiries.map(maskedEnquiry),contactMasked:!fullContact,productionReady:false});}catch(error){return authError(error,"Unable to load relocation enquiries");}}

/** Customer-facing, public: no auth required to submit an enquiry (mirrors /api/customer-otp). */
export async function POST(request:Request){try{sameOrigin(request);const db=await database();const body=await request.json() as Row;
 const input:RelocationEnquiryInput={
  customerName:String(body.customerName??""),phonePrimary:String(body.phonePrimary??""),phoneSecondary:body.phoneSecondary==null?undefined:String(body.phoneSecondary),
  email:String(body.email??""),petType:String(body.petType??""),relocationKind:String(body.relocationKind??""),pickupDate:String(body.pickupDate??""),pickupApproxTime:String(body.pickupApproxTime??""),
  pickupLocation:String(body.pickupLocation??""),dropLocation:String(body.dropLocation??""),expectedTravelDate:String(body.expectedTravelDate??""),
 };
 const result=await createRelocationEnquiry(db,input);
 return json({data:result,productionReady:false});}catch(error){if(error instanceof Error)return json({error:error.message},400);return authError(error,"Unable to submit relocation enquiry");}}
