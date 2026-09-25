import{authError,database,requireCustomerOwnership,requirePermission,resolveActor}from"../../../lib/server-auth";
import{customerTrackingProjection}from"../../../lib/customer-location-disclosure";
import{resolveBookingDoorstep}from"../../../lib/booking-doorstep";
import{liveStaticMapResponse}from"../../../lib/live-static-map";
import{ensureCanonicalBookingCoreTables}from"../../../lib/canonical-booking-core-schema";
import{ensureUniversalLocationTables}from"../../../lib/universal-location-recovery";
import{ensureCustomerLiveTrackingServiceTables}from"../../../lib/customer-live-tracking-schema";

type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const SUPPORTED=new Set(["dog_walking","pet_taxi"]);
const ACTIVE=["assigned","accepted","on_the_way","arrived","in_service","in_progress","vehicle_assigned","pickup_confirmed","arrived_dropoff","dropoff_confirmed"] as const;
const CLOSED=new Set(["completed","cancelled","canceled","refunded","failed","expired"]);

async function tableExists(db:D1Database,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());}
async function serviceStatus(db:D1Database,serviceCode:string,bookingId:string){
 if(serviceCode==="dog_walking"&&await tableExists(db,"walking_sessions")){
  const row=await db.prepare("SELECT status FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number ASC LIMIT 1").bind(bookingId).first<Row>();
  if(row?.status)return String(row.status);
 }
 if(serviceCode==="pet_taxi"&&await tableExists(db,"taxi_trips")){
  const row=await db.prepare("SELECT status FROM taxi_trips WHERE booking_id=? LIMIT 1").bind(bookingId).first<Row>();
  if(row?.status)return String(row.status);
 }
 return"";
}
function trackingTitle(serviceCode:string,status:string){
 if(serviceCode==="dog_walking")return status==="in_progress"?"Your walk is in progress":"Your walker is on the way";
 if(serviceCode==="pet_taxi")return ["in_progress","arrived_dropoff","dropoff_confirmed"].includes(status)?"Your Pet Taxi trip is moving":"Your driver is approaching";
 return"Live tracking";
}
export async function GET(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");
 const url=new URL(request.url),bookingId=String(url.searchParams.get("bookingId")||"").trim(),mapMode=url.searchParams.get("map")==="1";
 if(!bookingId)return json({error:"Booking ID is required"},400);
 const db=await database();await ensureCanonicalBookingCoreTables(db);await ensureUniversalLocationTables(db);await ensureCustomerLiveTrackingServiceTables(db);
 const booking=await db.prepare("SELECT b.id,b.customer_id,b.service_code,b.status,b.provider_id,b.package_name,b.scheduled_start,b.scheduled_end,w.provider_name,w.status work_order_status FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id AND w.provider_id=b.provider_id WHERE b.id=?").bind(bookingId).first<Row>();
 if(!booking)return json({error:"Booking not found"},404);
 const serviceCode=String(booking.service_code||"");if(!SUPPORTED.has(serviceCode))return json({error:"Live tracking is not enabled for this service"},409);
 await requireCustomerOwnership(db,actor,String(booking.customer_id));
 const specific=await serviceStatus(db,serviceCode,bookingId),workOrder=String(booking.work_order_status||""),canonical=String(booking.status||"");
 const stateKnown=(value:string)=>ACTIVE.includes(value as typeof ACTIVE[number])||CLOSED.has(value);
 const status=stateKnown(specific)?specific:stateKnown(workOrder)?workOrder:canonical;
 const point=await db.prepare("SELECT id,latitude,longitude,server_received_at FROM universal_provider_location_events WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY server_received_at DESC LIMIT 1").bind(bookingId,String(booking.provider_id)).first<Row>();
 const eta=point?await db.prepare("SELECT provider_status,distance_meters,duration_seconds,calculated_at,stale_after,detail_json FROM route_eta_snapshots WHERE booking_id=? AND provider_id=? AND origin_location_event_id=? ORDER BY calculated_at DESC LIMIT 1").bind(bookingId,String(booking.provider_id),String(point.id)).first<Row>():null;
 const tracking=customerTrackingProjection({bookingStatus:status,hasTrustedLocation:Boolean(point),eta:eta?{providerStatus:eta.provider_status,distanceMeters:eta.distance_meters,durationSeconds:eta.duration_seconds,calculatedAt:eta.calculated_at,staleAfter:eta.stale_after}:null,visibleStatuses:ACTIVE});
 if(mapMode){
  if(tracking.state!=="live"||!point)return new Response("Live map is not available yet",{status:409,headers:{"cache-control":"no-store"}});
  const taxiInRide=serviceCode==="pet_taxi"&&["in_progress","arrived_dropoff","dropoff_confirmed"].includes(status);
  if(taxiInRide)return new Response("Pet Taxi destination coordinates are not yet stored canonically for in-ride mapping",{status:409,headers:{"cache-control":"no-store"}});
  const destination=await resolveBookingDoorstep(db,bookingId);
  if(!destination)return new Response("Live map destination is unavailable",{status:409,headers:{"cache-control":"no-store"}});
  return liveStaticMapResponse({provider:{lat:Number(point.latitude),lng:Number(point.longitude)},destination:{lat:destination.latitude,lng:destination.longitude},privacyRounded:true});
 }
 return json({data:{bookingId,serviceCode,status,title:trackingTitle(serviceCode,status),provider:{id:booking.provider_id?String(booking.provider_id):null,name:booking.provider_name?String(booking.provider_name):null},tracking,mapAvailable:tracking.state==="live"&&!(serviceCode==="pet_taxi"&&["in_progress","arrived_dropoff","dropoff_confirmed"].includes(status)),mapVersion:tracking.state==="live"&&eta?Number(eta.calculated_at)||null:null,scheduledStart:booking.scheduled_start,scheduledEnd:booking.scheduled_end}});
}catch(error){return authError(error,"Unable to load customer live tracking");}}
