import{authError,database,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{OPERATIONS_MANAGER_DOMAIN,requireManagerDomain,resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";
import{bookingInvoiceDocument,renderBookingInvoiceHtml}from"../../../lib/booking-tax-invoice";

/**
 * The printable customer tax invoice of a booking (lib/booking-tax-invoice.ts): one A4 page for the browser's "Save as PDF".
 *   Customer (V2 booking page): ?bookingId=X. Only the booking's own customer, with the identity checks the V2 booking pages use
 *     (a customer session, its ownership, the booking's customer). Anyone else's booking is the same 404 as a booking with no
 *     invoice, so the reply never shows that another customer's invoice exists.
 *   Finance: ?bookingId=X&view=finance (finance.view). Booking Command Center: ?bookingId=X&view=operations (bookings.manage,
 *     inside the manager's city scope). Staff views are audited.
 * ?format=json answers {data:{invoiceNumber,issueDate,title,amountReceived}|null} so a page offers the link once it exists.
 * Read only: it never issues an invoice and never creates a table.
 */
const text=(value:unknown)=>String(value??"").trim();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const page=(body:string,status:number,nonce="")=>new Response(body,{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex","content-security-policy":`default-src 'none'; style-src 'unsafe-inline'; script-src ${nonce?`'nonce-${nonce}'`:"'none'"}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`}});
const notFound=(asJson:boolean)=>asJson?json({error:"Invoice not found"},404):page("<!doctype html><html lang=\"en-IN\"><head><meta charset=\"utf-8\"><title>Invoice not found</title></head><body><p>No invoice is available for this booking.</p></body></html>",404);

export async function GET(request:Request){
 try{
  const url=new URL(request.url),bookingId=text(url.searchParams.get("bookingId")),view=text(url.searchParams.get("view")),asJson=url.searchParams.get("format")==="json";
  const db=await database(),actor=await resolveActor(request);
  let customerId="";
  if(view==="finance")requirePermission(actor,"finance.view");
  else if(view==="operations")requirePermission(actor,"bookings.manage");
  else{
   const session=await resolvePlatformSession(db,request);
   if(session?.subjectType!=="customer"||!session.subjectId)return json({error:"Sign in to your customer account to see your invoice."},401);
   await requireCustomerOwnership(db,actor,session.subjectId);customerId=session.subjectId;
  }
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(bookingId))return notFound(asJson);
  const bookings=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first<Record<string,unknown>>(),booking=bookings?await db.prepare("SELECT id,customer_id,city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>():null;
  if(!booking||(customerId&&text(booking.customer_id)!==customerId))return notFound(asJson);
  if(view==="operations"){const scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,OPERATIONS_MANAGER_DOMAIN);if(scope&&text(booking.city_id).toLowerCase()!==scope.cityId)return json({error:"Booking is outside the manager's city scope"},403);}
  const doc=await bookingInvoiceDocument(db,bookingId);
  if(doc&&customerId&&doc.customerId!==customerId)return notFound(asJson);
  if(asJson)return json({data:doc?{invoiceNumber:doc.invoiceNumber,issueDate:doc.issueDate,title:doc.title,amountReceived:doc.amountReceived}:null});
  if(!doc)return notFound(false);
  if(!customerId)await securityAudit(db,actor,"booking.invoice.view","finance_invoice",doc.invoiceId,"allowed",{bookingId,view});
  const nonce=crypto.randomUUID().replaceAll("-","");
  return page(renderBookingInvoiceHtml(doc,{nonce}),200,nonce);
 }catch(error){return authError(error,"Unable to open the invoice");}
}
