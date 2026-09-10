import{authError,database,requireCustomerOwnership,requirePermission,resolveActor}from"../../../lib/server-auth";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
type Row=Record<string,unknown>;
async function optionalRow(db:D1Database,table:string,sql:string,id:string){const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();return exists?db.prepare(sql).bind(id).first<Row>():null;}
export async function GET(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");const bookingId=new URL(request.url).searchParams.get("bookingId");if(!bookingId)return json({error:"Booking ID is required"},400);const db=await database();
 const booking=await db.prepare("SELECT id,customer_id,status FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(bookingId).first<Row>();if(!booking)return json({error:"Grooming booking not found"},404);await requireCustomerOwnership(db,actor,String(booking.customer_id));
 if(booking.status!=="completed")return json({data:{bookingId,status:booking.status,care:null,invoice:null}});
 const proof=await optionalRow(db,"grooming_service_proof","SELECT checklist_json,completion_notes FROM grooming_service_proof WHERE booking_id=?",bookingId);
 let checklist:string[]=[];if(proof){try{const value=JSON.parse(String(proof.checklist_json||"[]"));if(Array.isArray(value))checklist=value.filter((item):item is string=>typeof item==="string");}catch{throw new Error("Completed care checklist is invalid");}}
 const invoice=await optionalRow(db,"booking_invoices","SELECT invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,customer_id FROM booking_invoices WHERE booking_id=?",bookingId);
 const issued=invoice&&invoice.customer_id===booking.customer_id&&["issued","issued_uat"].includes(String(invoice.status));
 return json({data:{bookingId,status:booking.status,care:proof?{checklist,notes:typeof proof.completion_notes==="string"?proof.completion_notes:""}:null,invoice:issued?{number:invoice.invoice_number,status:invoice.status,currency:invoice.currency,total:invoice.gross_amount,tax:invoice.tax_amount,subtotal:invoice.net_amount,issuedAt:invoice.issued_at}:null}});
}catch(error){return authError(error,"Unable to load your completed Grooming care summary");}}
