import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{customerDataAccessResolver}from"../../../lib/purpose-based-access";
import{buildCustomer360,ensureCustomer360Tables}from"../../../lib/customer-360";

type Body={action?:string;customerId?:string;duplicateCustomerId?:string;matchReason?:string;marketing?:boolean;service?:boolean;whatsapp?:boolean;sms?:boolean;email?:boolean;reviewId?:string;status?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Customer 360 write blocked",{status:403});}

/*
 * Purpose-based access, applied through lib/purpose-based-access.ts. [PTJA-W2-B2-R01]
 *
 * What this replaced: `const reveal = hasPermission(actor.permissions,"customers.view_full_phone")`
 * followed by maskPhone/maskName. That boolean masked the NAME and the PHONE and nothing else, so the
 * EMAIL and the full home address - line 1 and postcode included - were served to every actor who could
 * open this screen, and anyone holding the permission received a hundred raw numbers in one list read
 * with no reason asked and no record kept.
 *
 * Masked in the ROUTE rather than inside buildCustomer360: that function is also called by the AI
 * conversation orchestrator, marketing and promotion governance, which need real contact details to
 * actually reach a customer. Masking the shared builder would have broken outbound messaging.
 *
 * A list read carries no reason and names no record, so under the approved rule it cannot be a reveal.
 * The reveal moves to app/api/customer-data-reveal: per record, with a reason, writing a
 * customer_data_reveals row. The area survives here so an associate arranging a home visit can still
 * recognise where they are going.
 */
export async function GET(request:Request){try{const actor=await authorize(request,"customers.view");const db=await database();const id=new URL(request.url).searchParams.get("customerId")||undefined;const built=await buildCustomer360(db,id);
  const access=await customerDataAccessResolver(db);
  const records=built.map(record=>{
    const primary=record.addresses.find(entry=>entry.isDefault)??record.addresses[0]??null;
    const view=access.view({actor:{email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions},purpose:"operations",
      subject:{customerId:record.customerId,name:record.name,phone:record.primaryPhone,email:record.email,
        address:primary?{line1:primary.line1,area:primary.area,city:primary.city,pincode:primary.postalCode}:null}});
    const full=view.address.precision==="full";
    return{...record,primaryPhone:view.contact.phone,email:view.contact.email,
      // Only the precision the policy allows. `line1` and the postcode are the doorstep; the area is not.
      addresses:record.addresses.map(entry=>full?entry:{...entry,line1:"",line2:null,postalCode:null}),
      contactChannel:view.contact.channel,addressPrecision:view.address.precision,revealed:view.revealed};
  });
  return json({data:{records,count:records.length,source:"canonical_customer_360",policyVersion:access.policyVersion}});}catch(error){return authError(error,"Unable to load Customer 360");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"customers.manage");const body=await request.json() as Body,db=await database();await ensureCustomer360Tables(db);const now=Date.now();
  if(body.action==="update_consent"){
    if(!body.customerId)return json({error:"Customer ID is required"},400);
    await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=excluded.marketing_consent,service_consent=excluded.service_consent,whatsapp_consent=excluded.whatsapp_consent,sms_consent=excluded.sms_consent,email_consent=excluded.email_consent,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(body.customerId,body.marketing?1:0,body.service===false?0:1,body.whatsapp?1:0,body.sms?1:0,body.email?1:0,"staff_review",actor.email,now).run();
    await securityAudit(db,actor,"customer.consent.update","customer",body.customerId,"completed",{marketing:Boolean(body.marketing),service:body.service!==false,whatsapp:Boolean(body.whatsapp),sms:Boolean(body.sms),email:Boolean(body.email)});
    return json({ok:true,customerId:body.customerId});
  }
  if(body.action==="flag_duplicate"){
    if(!body.customerId||!body.duplicateCustomerId||body.customerId===body.duplicateCustomerId)return json({error:"Two distinct customer IDs are required"},400);
    const id=`MERGE-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
    await db.prepare("INSERT OR IGNORE INTO customer_merge_reviews (id,primary_customer_id,duplicate_customer_id,match_reason,status,created_at) VALUES (?,?,?,?, 'open',?)").bind(id,body.customerId,body.duplicateCustomerId,body.matchReason||"manual_review",now).run();
    await securityAudit(db,actor,"customer.duplicate.flag","customer",body.customerId,"completed",{duplicateCustomerId:body.duplicateCustomerId,matchReason:body.matchReason||"manual_review"});
    return json({ok:true,id,status:"open"},201);
  }
  if(body.action==="review_duplicate"){
    if(!body.reviewId||!["dismissed","approved_for_merge"].includes(String(body.status)))return json({error:"Review ID and supported status are required"},400);
    await db.prepare("UPDATE customer_merge_reviews SET status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='open'").bind(body.status,actor.email,now,body.reviewId).run();
    await securityAudit(db,actor,"customer.duplicate.review","customer_merge_review",body.reviewId,"completed",{status:body.status});
    return json({ok:true,id:body.reviewId,status:body.status,note:body.status==="approved_for_merge"?"Approved for a separately audited merge; no destructive merge is executed by this endpoint.":undefined});
  }
  return json({error:"Unsupported Customer 360 action"},400);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to update Customer 360");}}
