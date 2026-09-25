import{authError,database,requireCustomerOwnership,requirePermission,resolveActor}from"../../../lib/server-auth";
import{customerTrackingProjection}from"../../../lib/customer-location-disclosure";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
type Row=Record<string,unknown>;
async function tableExists(db:D1Database,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());}
async function optionalRow(db:D1Database,table:string,sql:string,bindings:unknown[]){if(!(await tableExists(db,table)))return null;let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return statement.first<Row>();}
function parseIds(value:unknown){try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)?parsed.map(String):[];}catch{return[];}}
function finiteCoordinate(value:unknown,min:number,max:number){const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function roundedProviderPoint(value:number){return Math.round(value*1000)/1000;}
async function mapsServerKey(){const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;return String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();}
async function liveMapResponse(db:D1Database,booking:Row,bookingId:string,tracking:{state:string}){
 if(tracking.state!=="live")return new Response("Live map is not available yet",{status:409,headers:{"cache-control":"no-store"}});
 const point=await optionalRow(db,"universal_provider_location_events","SELECT latitude,longitude,server_received_at FROM universal_provider_location_events WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY server_received_at DESC LIMIT 1",[bookingId,String(booking.provider_id)]);
 const destination=await optionalRow(db,"booking_service_locations","SELECT latitude,longitude FROM booking_service_locations WHERE booking_id=? AND customer_id=? AND provider_id=? AND status='active'",[bookingId,String(booking.customer_id),String(booking.provider_id)]);
 const providerLat=finiteCoordinate(point?.latitude,-90,90),providerLng=finiteCoordinate(point?.longitude,-180,180),destLat=finiteCoordinate(destination?.latitude,-90,90),destLng=finiteCoordinate(destination?.longitude,-180,180);
 if(providerLat===null||providerLng===null||destLat===null||destLng===null)return new Response("Live map coordinates are unavailable",{status:409,headers:{"cache-control":"no-store"}});
 const key=await mapsServerKey();if(!key)return new Response("Google Maps is not configured",{status:503,headers:{"cache-control":"no-store"}});
 const pLat=roundedProviderPoint(providerLat),pLng=roundedProviderPoint(providerLng),url=new URL("https://maps.googleapis.com/maps/api/staticmap");
 url.searchParams.set("size","640x320");url.searchParams.set("scale","2");url.searchParams.set("maptype","roadmap");
 url.searchParams.append("markers","color:0x1f8f5f|label:P|"+pLat+","+pLng);
 url.searchParams.append("markers","color:0xc7962d|label:H|"+destLat+","+destLng);
 url.searchParams.set("key",key);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{const response=await fetch(url.toString(),{signal:controller.signal});if(!response.ok)return new Response("Google map is temporarily unavailable",{status:502,headers:{"cache-control":"no-store"}});const bytes=await response.arrayBuffer();return new Response(bytes,{status:200,headers:{"content-type":response.headers.get("content-type")||"image/png","cache-control":"private, no-store, max-age=0","x-pawspace-map-source":"google-static-maps","x-pawspace-location-privacy":"provider-rounded-3dp"}});}catch{return new Response("Google map is temporarily unavailable",{status:502,headers:{"cache-control":"no-store"}});}finally{clearTimeout(timer);}
}
/**
 * Provider recovery moves only the WORK ORDER to reassignment_needed; canonical_bookings keeps
 * status 'confirmed' and the failed provider_id so the customer's slot and booking id survive the
 * handover. Reading the booking row alone therefore told the customer their booking was confirmed
 * with the groomer who had just declined it. The slot is still theirs - the groomer is not.
 */
const RECOVERY_WORK_ORDER_STATUSES=new Set(["reassignment_needed","recovery_pending"]);
const CLOSED_BOOKING_STATUSES=new Set(["completed","cancelled","refunded"]);
export async function GET(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");const requestUrl=new URL(request.url),bookingId=requestUrl.searchParams.get("bookingId"),mapMode=requestUrl.searchParams.get("map")==="1";if(!bookingId)return json({error:"Booking ID is required"},400);const db=await database();
 const booking=await db.prepare("SELECT b.id,b.customer_id,b.status,b.package_name,b.scheduled_start,b.scheduled_end,b.total_amount,b.currency,b.provider_id,b.pet_ids_json,w.provider_name,w.provider_model,w.status work_order_status,p.status payment_status,p.mode payment_mode,p.method payment_method,p.amount payment_amount FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.id=? AND b.service_code='grooming'").bind(bookingId).first<Row>();
 if(!booking)return json({error:"Grooming booking not found"},404);await requireCustomerOwnership(db,actor,String(booking.customer_id));
 const petIds=parseIds(booking.pet_ids_json),pets:Row[]=[];for(const id of petIds){const pet=await db.prepare("SELECT id,name,species,breed FROM canonical_pets WHERE id=? AND customer_id=?").bind(id,booking.customer_id).first<Row>();if(pet)pets.push(pet);}
 const proof=await optionalRow(db,"grooming_service_proof","SELECT checklist_json,completion_notes FROM grooming_service_proof WHERE booking_id=?",[bookingId]);
 const invoice=await optionalRow(db,"booking_invoices","SELECT invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,customer_id FROM booking_invoices WHERE booking_id=?",[bookingId]);
 const point=await optionalRow(db,"universal_provider_location_events","SELECT id FROM universal_provider_location_events WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY server_received_at DESC LIMIT 1",[bookingId,String(booking.provider_id)]);
 const eta=point?await optionalRow(db,"route_eta_snapshots","SELECT provider_status,distance_meters,duration_seconds,calculated_at,stale_after FROM route_eta_snapshots WHERE booking_id=? AND provider_id=? AND origin_location_event_id=? ORDER BY calculated_at DESC LIMIT 1",[bookingId,String(booking.provider_id),String(point.id)]):null;
 let checklist:string[]=[];if(proof){try{const value=JSON.parse(String(proof.checklist_json||"[]"));if(Array.isArray(value))checklist=value.filter((item):item is string=>typeof item==="string");}catch{throw new Error("Completed care checklist is invalid");}}
 const issued=String(booking.status)==="completed"&&invoice&&invoice.customer_id===booking.customer_id&&["issued","issued_uat"].includes(String(invoice.status));
 const awaitingReassignment=RECOVERY_WORK_ORDER_STATUSES.has(String(booking.work_order_status||""))&&!CLOSED_BOOKING_STATUSES.has(String(booking.status));
 const reportedStatus=awaitingReassignment?"awaiting_reassignment":booking.status;
 const tracking=customerTrackingProjection({bookingStatus:reportedStatus,hasTrustedLocation:Boolean(point),eta:eta?{providerStatus:eta.provider_status,distanceMeters:eta.distance_meters,durationSeconds:eta.duration_seconds,calculatedAt:eta.calculated_at,staleAfter:eta.stale_after}:null});
 if(mapMode)return liveMapResponse(db,booking,bookingId,tracking);
 return json({data:{bookingId,status:reportedStatus,awaitingReassignment,packageName:booking.package_name,scheduledStart:booking.scheduled_start,scheduledEnd:booking.scheduled_end,total:booking.total_amount,currency:booking.currency,provider:awaitingReassignment?{id:null,name:null,model:null}:{id:booking.provider_id,name:booking.provider_name,model:booking.provider_model},pets:pets.map(p=>({id:p.id,name:p.name,species:p.species,breed:p.breed})),payment:{status:booking.payment_status,mode:booking.payment_mode,method:booking.payment_method,amount:booking.payment_amount},tracking,mapVersion:tracking.state==="live"&&eta?Number(eta.calculated_at)||null:null,care:String(booking.status)==="completed"&&proof?{checklist,notes:typeof proof.completion_notes==="string"?proof.completion_notes:""}:null,invoice:issued?{number:invoice.invoice_number,status:invoice.status,currency:invoice.currency,total:invoice.gross_amount,tax:invoice.tax_amount,subtotal:invoice.net_amount,issuedAt:invoice.issued_at}:null}});
}catch(error){return authError(error,"Unable to load your Grooming booking summary");}}
