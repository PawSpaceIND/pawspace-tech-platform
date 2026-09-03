import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{customerDataAccessResolver,mayReveal,resolveCustomerDataAccess,type Assignment}from"../../../lib/purpose-based-access";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});
type RevealInput={customerId?:string;purpose?:string;reason?:string;fields?:string[];assignmentId?:string;assignmentType?:"lead"|"booking";[key:string]:unknown};

async function subjectRow(db:D1Database,customerId:string){
  const canonical=await db.prepare("SELECT id,name,primary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(canonical)return{source:"canonical_customers",row:canonical};
  const crm=await db.prepare("SELECT id,name,primary_phone,email,area FROM crm_contacts WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(crm)return{source:"crm_contacts",row:crm};
  return null;
}

const epoch=(value:unknown)=>{if(value==null||value==="")return null;const numeric=Number(value);if(Number.isFinite(numeric)&&numeric>0)return numeric;const parsed=Date.parse(String(value));return Number.isFinite(parsed)?parsed:null;};

/**
 * Resolve assignment authority from canonical server state. The client may name only the assignment
 * identifier/type; ownership, customer linkage, lifecycle state and schedule are never accepted from
 * request JSON.
 */
async function canonicalAssignment(db:D1Database,input:{assignmentId?:string;assignmentType?:"lead"|"booking";customerId:string;actorProviderId?:string|null}):Promise<Assignment|null>{
  const id=String(input.assignmentId||"").trim();
  if(!id)return null;
  if(input.assignmentType==="lead"){
    const lead=await db.prepare("SELECT id,customer_id,owner,status FROM lead_work_items WHERE id=?").bind(id).first<Row>().catch(()=>null);
    if(!lead)throw new Response("Lead assignment not found",{status:404});
    if(String(lead.customer_id||"")!==input.customerId)throw new Response("Assignment does not belong to this customer",{status:403});
    return{type:"lead",id:String(lead.id),assignedTo:lead.owner?String(lead.owner):null,status:lead.status?String(lead.status):null,scheduledStart:null,completedAt:null};
  }
  if(input.assignmentType==="booking"){
    const booking=await db.prepare("SELECT id,customer_id,provider_id,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").bind(id).first<Row>().catch(()=>null);
    if(!booking)throw new Response("Booking assignment not found",{status:404});
    if(String(booking.customer_id||"")!==input.customerId)throw new Response("Assignment does not belong to this customer",{status:403});
    const staffAssignment=await db.prepare("SELECT ca.assigned_to FROM communication_threads t JOIN conversation_assignments ca ON ca.thread_id=t.id AND ca.status='active' WHERE t.booking_id=? ORDER BY ca.created_at DESC LIMIT 1").bind(id).first<Row>().catch(()=>null);
    const completion=String(booking.status||"")==="completed"?await db.prepare("SELECT MAX(occurred_at) completed_at FROM booking_lifecycle_events WHERE booking_id=? AND event_type IN ('completed','booking_completed','service_completed')").bind(id).first<Row>().catch(()=>null):null;
    const assignedTo=input.actorProviderId&&String(booking.provider_id||"")===input.actorProviderId?String(booking.provider_id):staffAssignment?.assigned_to?String(staffAssignment.assigned_to):null;
    return{type:"booking",id:String(booking.id),assignedTo,status:booking.status?String(booking.status):null,scheduledStart:epoch(booking.scheduled_start),completedAt:epoch(completion?.completed_at)??(String(booking.status||"")==="completed"?epoch(booking.scheduled_end):null)};
  }
  throw new Response("Assignment type must be lead or booking",{status:400});
}

function rejectsClientAuthority(body:RevealInput){
  return Object.prototype.hasOwnProperty.call(body,"assignment")||Object.prototype.hasOwnProperty.call(body,"assignedTo")||Object.prototype.hasOwnProperty.call(body,"status")||Object.prototype.hasOwnProperty.call(body,"scheduledStart")||Object.prototype.hasOwnProperty.call(body,"completedAt");
}

export async function POST(request:Request){
  try{
    const actor=await authorize(request,"customers.view");
    const db=await database();
    const body=await request.json() as RevealInput;
    if(rejectsClientAuthority(body))return json({error:"Assignment authority is server-resolved; client assignment fields are not accepted",code:"client_assignment_not_accepted"},400);
    const customerId=String(body.customerId||"").trim();
    if(!customerId)return json({error:"A customer ID is required"},400);
    const purpose=String(body.purpose||"operations").trim()||"operations";
    const reason=String(body.reason||"").trim();
    if(reason.length<5)return json({error:"A reveal needs a reason",code:"reveal_reason_required"},400);
    const assignmentId=String(body.assignmentId||"").trim();
    const assignmentType=body.assignmentType;
    if(Boolean(assignmentId)!==Boolean(assignmentType))return json({error:"Assignment ID and type must be supplied together",code:"assignment_identifier_incomplete"},400);

    const found=await subjectRow(db,customerId);
    if(!found)return json({error:"Customer not found"},404);

    const address=await db.prepare("SELECT line1,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,created_at LIMIT 1").bind(customerId).first<Row>().catch(()=>null);
    const providerId=actor.subjectType==="provider"?actor.principalKey:null;
    const assignment=await canonicalAssignment(db,{assignmentId,assignmentType,customerId,actorProviderId:providerId});
    const accessActor={email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions,...(providerId?{providerId}:{})};

    if(!mayReveal(accessActor,purpose,assignment)){
      await securityAudit(db,actor,"customer.data.reveal","customer",customerId,"denied",{purpose,reason,assignmentId:assignment?.id??null,assignmentType:assignment?.type??null});
      return json({error:"This record is not assigned to you and you do not hold a reveal grant",code:"reveal_not_permitted"},403);
    }

    const view=await resolveCustomerDataAccess(db,{actor:accessActor,purpose,assignment,
      subject:{customerId,name:String(found.row.name||""),phone:found.row.primary_phone?String(found.row.primary_phone):null,
        email:found.row.email?String(found.row.email):null,
        address:address?{line1:String(address.line1||""),area:address.area?String(address.area):null,city:address.city?String(address.city):null,pincode:address.postal_code?String(address.postal_code):null}
          :found.row.area?{area:String(found.row.area)}:null},
      reveal:{requested:true,reason,fields:Array.isArray(body.fields)?body.fields.filter((field):field is "phone"|"email"|"address"=>field==="phone"||field==="email"||field==="address"):null}});
    await securityAudit(db,actor,"customer.data.reveal","customer",customerId,"completed",{purpose,reason,revealed:view.revealed,fields:view.revealedFields??[],revealExpiresAt:view.revealExpiresAt??null,addressPrecision:view.address.precision,policyVersion:view.policyVersion,assignmentId:assignment?.id??null,assignmentType:assignment?.type??null});
    return json({data:{...view,source:found.source}});
  }catch(error){return authError(error,"Unable to reveal customer data");}
}

export async function GET(request:Request){
  try{
    const actor=await authorize(request,"customers.view");
    const db=await database();
    const customerId=(new URL(request.url).searchParams.get("customerId")||"").trim();
    if(!customerId)return json({error:"A customer ID is required"},400);
    const found=await subjectRow(db,customerId);
    if(!found)return json({error:"Customer not found"},404);
    const access=await customerDataAccessResolver(db);
    const view=access.view({actor:{email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions},purpose:"operations",
      subject:{customerId,name:String(found.row.name||""),phone:found.row.primary_phone?String(found.row.primary_phone):null,email:found.row.email?String(found.row.email):null}});
    return json({data:{...view,revealAvailable:mayReveal({email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions},"operations",null),source:found.source}});
  }catch(error){return authError(error,"Unable to load customer data access");}
}
