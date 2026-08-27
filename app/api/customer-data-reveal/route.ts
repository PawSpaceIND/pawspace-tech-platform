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

type RevealInput={customerId?:string;purpose?:string;reason?:string;fields?:string[];assignment?:{type?:"lead"|"booking";id?:string;assignedTo?:string|null;status?:string|null;scheduledStart?:number|null;completedAt?:number|null}|null};

async function subjectRow(db:D1Database,customerId:string){
  const canonical=await db.prepare("SELECT id,name,primary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(canonical)return{source:"canonical_customers",row:canonical};
  const crm=await db.prepare("SELECT id,name,primary_phone,email,area FROM crm_contacts WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(crm)return{source:"crm_contacts",row:crm};
  return null;
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
    const assignment=body.assignment?.id?{type:body.assignment.type==="lead"?"lead" as const:"booking" as const,id:String(body.assignment.id),
      assignedTo:body.assignment.assignedTo??null,status:body.assignment.status??null,
      scheduledStart:body.assignment.scheduledStart??null,completedAt:body.assignment.completedAt??null}:null;
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
