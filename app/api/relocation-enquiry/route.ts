import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{maskName,maskPhone}from"../../../lib/platform-security";
import{customerDataAccessResolver,mayReveal,resolveCustomerDataAccess,type CustomerDataView}from"../../../lib/purpose-based-access";
import{createRelocationEnquiry,listRelocationEnquiries,maskLocation,type RelocationEnquiry,type RelocationEnquiryInput}from"../../../lib/relocation-enquiry";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin relocation-enquiry write blocked",{status:403});}

/*
 * Purpose-based access on the relocation enquiry directory. [PTJA-R3-RELQ-PII]
 *
 * WHAT THIS REPLACED. This route served listRelocationEnquiries() verbatim: raw customerName, raw
 * phonePrimary, raw email and BOTH free-text addresses - the customer's home and where their pet is
 * going - to every actor holding customers.view. Measured, same actor, same second:
 *
 *   GET /api/relocation-enquiry -> {"customerName":"R3C InApp Reloc","phonePrimary":"9811100166",
 *                                   "email":"r3c.inapp@pawspace.test","pickupLocation":"Koramangala, Bengaluru"}
 *   GET /api/crm                -> {"name":"E•• U• C•","primary_phone":"+91 ••••••0111","revealed":false}
 *
 * to an `associate` with no MFA. The file contained no maskName, no maskPhone and no resolver at all.
 *
 * THE CONTRACT IS THE SIBLINGS' CONTRACT, not a new one. app/api/crm and app/api/customer-360 resolve
 * lib/purpose-based-access ONCE per request and serve the masked view; a list read carries no reason
 * and names no record, so under the approved rule it cannot be a reveal - not for an admin, not for a
 * founder. The reveal is per record, with a stated reason, writing a customer_data_reveals row.
 *
 * WHY THE REVEAL IS HERE AND NOT IN app/api/customer-data-reveal. That route resolves its subject from
 * canonical_customers or crm_contacts. A relocation enquiry is pre-contact intake: no canonical
 * customer and no CRM contact exists yet, so there is nothing there for it to find. The DECISION is
 * still not made here - resolveCustomerDataAccess() owns it, exactly as that route does, so this
 * surface can only ask. No permission is widened: mayReveal() answers yes for the same two
 * justifications it always has.
 */
const REVEAL_PURPOSE="sales";
const subjectOf=(enquiry:RelocationEnquiry)=>({
  customerId:enquiry.id,name:enquiry.customerName,phone:enquiry.phonePrimary,email:enquiry.email,
  address:{line1:enquiry.pickupLocation,area:null,city:null,pincode:null},
});

/** One enquiry as this actor may see it. `view` is the resolved decision - masked, or a granted reveal. */
function serve(enquiry:RelocationEnquiry,view:CustomerDataView){
  const full=view.address.precision==="full";
  return{...enquiry,
    customerName:view.revealed?enquiry.customerName:maskName(enquiry.customerName),
    phonePrimary:view.contact.phone,
    phoneSecondary:enquiry.phoneSecondary?(view.revealed?enquiry.phoneSecondary:maskPhone(enquiry.phoneSecondary)):null,
    email:view.contact.email,
    // Both halves of the journey are the same class of data at the same precision.
    pickupLocation:full?enquiry.pickupLocation:maskLocation(enquiry.pickupLocation),
    dropLocation:full?enquiry.dropLocation:maskLocation(enquiry.dropLocation),
    addressPrecision:view.address.precision,revealed:view.revealed};
}

/** Staff-facing directory. Gateway maps GET here to "customers.view". */
export async function GET(request:Request){try{
  const actor=await authorize(request,"customers.view");
  const db=await database();
  const url=new URL(request.url);
  const revealId=String(url.searchParams.get("reveal")||"").trim();
  const reason=String(url.searchParams.get("reason")||"").trim();
  const enquiries=await listRelocationEnquiries(db);
  const viewer={email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions};
  const access=await customerDataAccessResolver(db);
  const revealAvailable=mayReveal(viewer,REVEAL_PURPOSE,null);

  let revealedView:CustomerDataView|null=null;
  if(revealId){
    // Same order of refusals as app/api/customer-data-reveal: reason, then record, then entitlement.
    if(reason.length<5)return json({error:"A reveal needs a reason",code:"reveal_reason_required"},400);
    const target=enquiries.find(entry=>entry.id===revealId);
    // An unknown id is a refusal, never an empty masked record - answering 200 would make this a probe
    // for which enquiry IDs exist.
    if(!target)return json({error:"Relocation enquiry not found"},404);
    if(!revealAvailable){
      await securityAudit(db,actor,"customer.data.reveal","relocation_enquiry",revealId,"denied",{purpose:REVEAL_PURPOSE,reason});
      return json({error:"This record is not assigned to you and you do not hold a reveal grant",code:"reveal_not_permitted"},403);
    }
    revealedView=await resolveCustomerDataAccess(db,{actor:viewer,purpose:REVEAL_PURPOSE,subject:subjectOf(target),reveal:{requested:true,reason}});
    await securityAudit(db,actor,"customer.data.reveal","relocation_enquiry",revealId,"completed",{purpose:REVEAL_PURPOSE,reason,revealed:revealedView.revealed,fields:revealedView.revealedFields??[],addressPrecision:revealedView.address.precision,policyVersion:revealedView.policyVersion});
  }

  const data=enquiries.map(enquiry=>serve(enquiry,
    revealedView&&enquiry.id===revealId?revealedView
      :access.view({actor:viewer,purpose:REVEAL_PURPOSE,subject:subjectOf(enquiry)})));
  return json({data,masked:true,
    // So the screen offers a reveal control only where one would actually succeed.
    revealAvailable,policyVersion:access.policyVersion,productionReady:false});
}catch(error){return authError(error,"Unable to load relocation enquiries");}}

/** Customer-facing, public: no auth required to submit an enquiry (mirrors /api/customer-otp). */
export async function POST(request:Request){try{sameOrigin(request);const db=await database();const body=await request.json() as Row;
 const input:RelocationEnquiryInput={
  customerName:String(body.customerName??""),phonePrimary:String(body.phonePrimary??""),phoneSecondary:body.phoneSecondary==null?undefined:String(body.phoneSecondary),
  email:String(body.email??""),petType:String(body.petType??""),relocationKind:String(body.relocationKind??""),pickupDate:String(body.pickupDate??""),pickupApproxTime:String(body.pickupApproxTime??""),
  pickupLocation:String(body.pickupLocation??""),dropLocation:String(body.dropLocation??""),expectedTravelDate:String(body.expectedTravelDate??""),
 };
 const result=await createRelocationEnquiry(db,input);
 return json({data:result,productionReady:false});}catch(error){if(error instanceof Error)return json({error:error.message},400);return authError(error,"Unable to submit relocation enquiry");}}
