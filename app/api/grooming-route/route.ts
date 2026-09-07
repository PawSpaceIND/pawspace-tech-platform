import{authError,database,requirePermission,requireProviderOwnership,resolveActor}from"../../../lib/server-auth";
import{computeGoogleRoute,ensureGroomingMapTables,mapsNavigationUrl,type ProviderPoint}from"../../../lib/grooming-maps";
import{existingGroomingTelemetry,prepareGroomingTelemetry,commitGroomingTelemetry,ensureGroomingGpsPipelineTables}from"../../../lib/grooming-gps-pipeline";
import{gpsIngestionKey,validGpsCoordinates}from"../../../lib/gps-telemetry-policy";
import{LocationConfigurationRequired}from"../../../lib/universal-location-recovery";

type Input={bookingId:string;providerId:string;latitude:number;longitude:number;accuracyMeters:number;capturedAt:number;idempotencyKey?:string};
type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const activeTravelStates=new Set(["assigned","on_the_way","arrived"]);

async function assignedBooking(db:Awaited<ReturnType<typeof database>>,bookingId:string,providerId:string){return db.prepare("SELECT b.id,b.customer_id,b.provider_id,b.status booking_status,w.status work_order_status,l.address_text,l.latitude destination_latitude,l.longitude destination_longitude FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id AND w.provider_id=b.provider_id JOIN booking_service_locations l ON l.booking_id=b.id AND l.status='active' WHERE b.id=? AND b.provider_id=? AND b.service_code='grooming'").bind(bookingId,providerId).first<Row>();}
function canShareLocation(booking:Row){return activeTravelStates.has(String(booking.work_order_status||booking.booking_status));}
function validInput(input:Input){return Boolean(input.bookingId&&input.providerId)&&validGpsCoordinates(Number(input.latitude),Number(input.longitude))&&Number.isFinite(Number(input.accuracyMeters))&&Number(input.accuracyMeters)>=0&&Number.isFinite(Number(input.capturedAt))&&Number(input.capturedAt)>0;}

async function latestAcceptedPoint(db:Awaited<ReturnType<typeof database>>,bookingId:string,providerId:string){
 await ensureGroomingGpsPipelineTables(db);
 const row=await db.prepare("SELECT latitude,longitude,accuracy_meters,client_captured_at,server_received_at,id FROM universal_provider_location_events WHERE booking_id=? AND provider_id=? AND trust_state='accepted' ORDER BY server_received_at DESC LIMIT 1").bind(bookingId,providerId).first<Row>();
 return row?{lat:Number(row.latitude),lng:Number(row.longitude),accuracyMeters:Number(row.accuracy_meters),capturedAt:Number(row.client_captured_at),serverReceivedAt:Number(row.server_received_at),eventId:String(row.id)}:null;
}

export async function GET(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"bookings.view");
 const url=new URL(request.url),bookingId=String(url.searchParams.get("bookingId")||"").trim(),providerId=String(url.searchParams.get("providerId")||"").trim();
 if(!bookingId||!providerId)return json({error:"Booking and provider are required"},400);
 const db=await database();await ensureGroomingMapTables(db);await ensureGroomingGpsPipelineTables(db);await requireProviderOwnership(db,actor,providerId);
 const booking=await assignedBooking(db,bookingId,providerId);if(!booking)return json({error:"Assigned booking location is unavailable"},404);if(!canShareLocation(booking))return json({error:"Route access is unavailable outside an active provider travel state"},409);
 const point=await latestAcceptedPoint(db,bookingId,providerId),destination=String(booking.address_text);
 const snapshot=point?await db.prepare("SELECT provider_status,distance_meters,duration_seconds,detail_json FROM route_eta_snapshots WHERE booking_id=? AND provider_id=? AND origin_location_event_id=? ORDER BY calculated_at DESC LIMIT 1").bind(bookingId,providerId,point.eventId).first<Row>():null;
 const detail=snapshot?JSON.parse(String(snapshot.detail_json||"{}")) as Record<string,unknown>:{};
 return json({data:{bookingId,providerId,destinationAddress:destination,destinationCoordinates:booking.destination_latitude!=null&&booking.destination_longitude!=null?{lat:Number(booking.destination_latitude),lng:Number(booking.destination_longitude)}:null,providerLocation:point,navigationUrl:mapsNavigationUrl(destination,point||undefined),travelState:String(booking.work_order_status||booking.booking_status),route:snapshot?{status:String(snapshot.provider_status),distanceMeters:snapshot.distance_meters==null?undefined:Number(snapshot.distance_meters),durationSeconds:snapshot.duration_seconds==null?undefined:Number(snapshot.duration_seconds),error:detail.error?String(detail.error):undefined}:undefined}});
}catch(error){return authError(error,"Unable to load Grooming route");}}

export async function POST(request:Request){try{
 const actor=await resolveActor(request);requirePermission(actor,"bookings.view");const input=await request.json() as Input;
 if(!validInput(input))return json({error:"Booking, provider, valid GPS coordinates, non-negative accuracy and capture timestamp are required"},400);
 const db=await database();await ensureGroomingMapTables(db);await ensureGroomingGpsPipelineTables(db);await requireProviderOwnership(db,actor,input.providerId);
 const booking=await assignedBooking(db,input.bookingId,input.providerId);if(!booking)return json({error:"Assigned booking location is unavailable"},404);if(!canShareLocation(booking))return json({error:"GPS capture is disabled outside assigned, on-the-way or arrived states"},409);
 if(booking.destination_latitude==null||booking.destination_longitude==null)return json({error:"Booking doorstep coordinates are required before provider GPS tracking can start"},409);
 const key=String(input.idempotencyKey||gpsIngestionKey(input)),prior=await existingGroomingTelemetry(db,key);if(prior)return json({data:{...prior,duplicate:true}},200);
 const telemetry={...input,idempotencyKey:key},prepared=await prepareGroomingTelemetry(db,telemetry,actor.email);
 const destination=String(booking.address_text),origin:ProviderPoint={lat:Number(input.latitude),lng:Number(input.longitude),accuracyMeters:Number(input.accuracyMeters),capturedAt:Number(input.capturedAt)};
 const route=prepared.verdict.trustState==="accepted"?await computeGoogleRoute(origin,destination):null;
 let data:Record<string,unknown>;
 try{data=await commitGroomingTelemetry(db,{telemetry,prepared,destinationAddress:destination,route,actor,travelState:String(booking.work_order_status||booking.booking_status)}) as Record<string,unknown>;}catch(error){
  const duplicate=await existingGroomingTelemetry(db,key);if(duplicate)return json({data:{...duplicate,duplicate:true}},200);throw error;
 }
 const response={...data,destinationAddress:destination,destinationCoordinates:{lat:Number(booking.destination_latitude),lng:Number(booking.destination_longitude)},navigationUrl:mapsNavigationUrl(destination,origin)};
 if(prepared.verdict.trustState!=="accepted")return json({error:`GPS observation rejected: ${prepared.verdict.reason||prepared.verdict.trustState}`,data:response},422);
 return json({data:response},201);
}catch(error){if(error instanceof LocationConfigurationRequired)return json({error:"configuration_required",configurationKey:error.key,productionReady:false},409);return authError(error,"Unable to update Grooming route");}}
