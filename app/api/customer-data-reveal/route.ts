import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{customerDataAccessResolver,mayReveal,resolveCustomerDataAccess}from"../../../lib/purpose-based-access";

/**
 * The one place a masked customer record becomes an unmasked one. [PTJA-W2-B2-R01/C01/C07]
 *
 * The approved rule says every reveal is logged with the user, the reason, the record and the time. A
 * list read satisfies none of that - it carries no reason and names no record - so the staff surfaces
 * (CRM, Customer 360, subscription customers, conversations) now serve the masked view and the reveal
 * lives here: one record, one stated reason, one customer_data_reveals row, one security_audit_events
 * row. Holding customers.view_full_phone no longer means a hundred numbers arrive unasked.
 *
 * The decision itself is NOT made here. lib/purpose-based-access.ts owns it, so this surface cannot be
 * more generous than the policy - it can only ask.
 */
type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});

/**
 * What a caller may say. NOTE WHAT IS ABSENT: assignedTo, status, scheduledStart and completedAt.
 *
 * Those four used to be read straight off the body and handed to mayReveal(), which answers yes when
 * `assignment.assignedTo === actor.email`. The caller therefore supplied the input to its own
 * authorization check, and "this record is assigned to me" was never looked up anywhere. An associate
 * holding customers.view (and NOT customers.view_full_phone) could name itself the assignee of a
 * booking id it had invented and receive the raw phone and email; adding status:"confirmed" and a
 * scheduledStart an hour out also opened the full doorstep address, because those are the two other
 * inputs to the address rule and they arrived in the same object. A restated completedAt re-opened a
 * provider dispute window that had correctly closed.
 *
 * `assignment` survives only as a POINTER - which record are we talking about - because an id by itself
 * confers nothing. Every attribute that DECIDES anything is now read from the database below.
 *
 * Nothing legitimate is lost: app/control/customer-reveal.tsx, the only first-party caller, posts
 * {customerId, purpose, reason, fields} and has never sent an assignment at all.
 */
type RevealInput={customerId?:string;purpose?:string;reason?:string;fields?:string[];assignment?:{type?:"lead"|"booking";id?:string}|null};

async function subjectRow(db:D1Database,customerId:string){
  const canonical=await db.prepare("SELECT id,name,primary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(canonical)return{source:"canonical_customers",row:canonical};
  const crm=await db.prepare("SELECT id,name,primary_phone,email,area FROM crm_contacts WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(crm)return{source:"crm_contacts",row:crm};
  return null;
}

const millis=(value:unknown)=>{const at=Date.parse(String(value??""));return Number.isFinite(at)?at:null;};

/**
 * The assignment for this record, READ FROM THE DATABASE, or null when there is no verifiable one.
 *
 * The sources are not new. app/api/conversations already builds exactly this object from
 * communication_threads.assigned_to, and app/api/crm from crm_contacts.owner - those two surfaces
 * derive it server-side and always have. This route is the one that took the caller's word for it.
 *
 * Returns null - meaning "no assignment justifies anything here" - whenever the claim cannot be
 * verified: the record does not exist, no table exists to check it against, or the record belongs to a
 * DIFFERENT customer than the one being revealed. That last check matters on its own: without it a
 * caller genuinely assigned to one customer's booking could cite it while asking about somebody else.
 *
 * Fails closed by construction. Every branch that cannot prove an assignment returns null, and null is
 * what mayReveal() treats as no justification.
 */
async function resolvedAssignment(db:D1Database,customerId:string,pointer:RevealInput["assignment"]){
  const id=String(pointer?.id??"").trim();
  if(!id)return null;

  if(pointer?.type==="lead"){
    const lead=await db.prepare("SELECT id,owner,stage FROM crm_contacts WHERE id=?").bind(id).first<Row>().catch(()=>null);
    // A lead justifies a reveal of ITS OWN contact record and no other.
    if(!lead||String(lead.id)!==customerId)return null;
    // crm_contacts.owner defaults to the literal "Unassigned", which is not a person - but it is also
    // not special-cased here, deliberately. assignedToActor() compares the owner to the ACTOR'S EMAIL,
    // so an unowned lead can only match an actor literally called "Unassigned". A guard for that is
    // dead code, and dead code in an authorization path reads as protection that is not there. The
    // property is covered where it actually lives: a lead owned by anyone but the caller is refused.
    const owner=String(lead.owner??"").trim();
    return{type:"lead" as const,id,assignedTo:owner||null,
      status:lead.stage?String(lead.stage):null,scheduledStart:null,completedAt:null};
  }

  const thread=await db.prepare("SELECT assigned_to FROM communication_threads WHERE booking_id=? AND customer_id=? ORDER BY updated_at DESC LIMIT 1").bind(id,customerId).first<Row>().catch(()=>null);
  const booking=await db.prepare("SELECT customer_id,status,scheduled_start,scheduled_end FROM canonical_bookings WHERE id=?").bind(id).first<Row>().catch(()=>null);
  if(!thread&&!booking)return null;
  if(booking&&String(booking.customer_id??"")!==customerId)return null;
  const status=booking?.status?String(booking.status):null;
  return{type:"booking" as const,id,
    assignedTo:thread?.assigned_to?String(thread.assigned_to):null,
    status,
    scheduledStart:millis(booking?.scheduled_start),
    // There is no completed_at column; a completed booking's scheduled end is when its window started
    // running down. Derived rather than accepted, which is the whole point.
    completedAt:status==="completed"?millis(booking?.scheduled_end):null};
}

export async function POST(request:Request){
  try{
    // AUTHORIZE BEFORE ANY BODY WORK, the ordering tests/route-authorization-class.test.mjs enforces.
    const actor=await authorize(request,"customers.view");
    const db=await database();
    const body=await request.json() as RevealInput;
    const customerId=String(body.customerId||"").trim();
    if(!customerId)return json({error:"A customer ID is required"},400);
    const purpose=String(body.purpose||"operations").trim()||"operations";
    const reason=String(body.reason||"").trim();
    if(reason.length<5)return json({error:"A reveal needs a reason",code:"reveal_reason_required"},400);

    const found=await subjectRow(db,customerId);
    // An unknown customer is a refusal, never an empty masked record: answering 200 with nulls would
    // let this surface be used to probe which customer IDs exist, and would read as "nothing to show".
    if(!found)return json({error:"Customer not found"},404);

    const address=await db.prepare("SELECT line1,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,created_at LIMIT 1").bind(customerId).first<Row>().catch(()=>null);
    // Verified against the database, never copied from the body. See resolvedAssignment.
    const assignment=await resolvedAssignment(db,customerId,body.assignment);
    const accessActor={email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions};

    if(!mayReveal(accessActor,purpose,assignment)){
      await securityAudit(db,actor,"customer.data.reveal","customer",customerId,"denied",{purpose,reason});
      return json({error:"This record is not assigned to you and you do not hold a reveal grant",code:"reveal_not_permitted"},403);
    }

    const view=await resolveCustomerDataAccess(db,{actor:accessActor,purpose,assignment,
      subject:{customerId,name:String(found.row.name||""),phone:found.row.primary_phone?String(found.row.primary_phone):null,
        email:found.row.email?String(found.row.email):null,
        address:address?{line1:String(address.line1||""),area:address.area?String(address.area):null,city:address.city?String(address.city):null,pincode:address.postal_code?String(address.postal_code):null}
          :found.row.area?{area:String(found.row.area)}:null},
      // Which fields the caller asked for. Absent means all of them, which is what a screen with a
      // single "reveal contact" control sends. [PTJA-W3-RU]
      reveal:{requested:true,reason,fields:Array.isArray(body.fields)?body.fields.filter((field):field is "phone"|"email"|"address"=>field==="phone"||field==="email"||field==="address"):null}});
    await securityAudit(db,actor,"customer.data.reveal","customer",customerId,"completed",{purpose,reason,revealed:view.revealed,fields:view.revealedFields??[],revealExpiresAt:view.revealExpiresAt??null,addressPrecision:view.address.precision,policyVersion:view.policyVersion});
    return json({data:{...view,source:found.source}});
  }catch(error){return authError(error,"Unable to reveal customer data");}
}

/** What the caller WOULD see without asking for a reveal - the masked view, and nothing logged. */
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
