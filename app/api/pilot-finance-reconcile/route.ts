import{authError,database}from"../../../lib/server-auth";
import{uatAccessCodeValid}from"../../../lib/uat-staging-auth";
import{resolveServiceCompletionFinance}from"../../../lib/service-completion-finance";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

/**
 * Staging-only maintenance endpoint used by the pilot certification workflow.
 *
 * It deliberately repairs ONLY completed bookings whose canonical customer, work order and payment are
 * all still present. Incomplete legacy/demo rows are handled separately by the staging archive cleanup;
 * fabricating journals for those rows would manufacture accounting evidence from missing commercial
 * facts. Each eligible booking goes through the same idempotent completion-finance resolver used by the
 * live lifecycle, preserving payout policy, GST/TCS calculation, double-entry balance and journal keys.
 */
export async function POST(request:Request){try{
 const env=await runtime();
 if(String(env.PAWSPACE_DEPLOYMENT_ENV||"").trim().toLowerCase()!=="staging"||String(env.PAWSPACE_SCHEDULING_ENV||"").trim().toLowerCase()!=="uat")return json({error:"Pilot finance reconciliation is staging-only"},404);
 const body=await request.json().catch(()=>({}))as{code?:string};
 if(!uatAccessCodeValid(env as never,body.code))return json({error:"Invalid UAT access code"},401);
 const db=await database();
 const rows=await db.prepare(`
   SELECT b.id,b.scheduled_end,b.updated_at
   FROM canonical_bookings b
   WHERE b.status='completed'
     AND EXISTS(SELECT 1 FROM canonical_customers c WHERE c.id=b.customer_id)
     AND EXISTS(SELECT 1 FROM provider_work_orders w WHERE w.booking_id=b.id)
     AND EXISTS(SELECT 1 FROM booking_payments p WHERE p.booking_id=b.id)
     AND NOT EXISTS(SELECT 1 FROM finance_journal_entries f WHERE f.booking_id=b.id AND f.posted=1)
   ORDER BY b.updated_at,b.id
 `).all<Row>();
 const repaired:string[]=[],failures:Array<{bookingId:string;error:string}>=[];
 for(const row of rows.results){
   const bookingId=String(row.id),scheduledEnd=Date.parse(String(row.scheduled_end||"")),updated=Number(row.updated_at||0),completedAt=Number.isFinite(scheduledEnd)?scheduledEnd:(updated>0?updated:Date.now());
   try{await resolveServiceCompletionFinance(db,{bookingId,actorId:"pilot_staging_finance_reconcile",completedAt});repaired.push(bookingId);}catch(error){failures.push({bookingId,error:error instanceof Response?await error.clone().text().catch(()=>`HTTP ${error.status}`):error instanceof Error?error.message:String(error)});}
 }
 const remaining=await db.prepare(`SELECT COUNT(*) n FROM canonical_bookings b WHERE b.status='completed' AND EXISTS(SELECT 1 FROM canonical_customers c WHERE c.id=b.customer_id) AND EXISTS(SELECT 1 FROM provider_work_orders w WHERE w.booking_id=b.id) AND EXISTS(SELECT 1 FROM booking_payments p WHERE p.booking_id=b.id) AND NOT EXISTS(SELECT 1 FROM finance_journal_entries f WHERE f.booking_id=b.id AND f.posted=1)`).first<Row>();
 return json({data:{eligible:rows.results.length,repaired:repaired.length,repairedBookingIds:repaired,failures,remaining:Number(remaining?.n||0)}},failures.length?409:200);
}catch(error){return authError(error,"Unable to reconcile staging completion finance");}}
