import{resolveBookingDoorstep}from "./booking-doorstep";
import{ensureCustomerLiveTrackingServiceTables}from "./customer-live-tracking-schema";

type Row=Record<string,unknown>;
export type LiveJourneyDestination={latitude:number;longitude:number;phase:"service_doorstep"|"pickup"|"dropoff"};

/*
 * The lifecycle states that still have somewhere to go. Callers pass the service row's status (the taxi trip, the
 * current walking session) or, when there is none, the work order or canonical booking status, so each list speaks
 * all of those vocabularies. Any other state - completed, cancelled, refunded, a recovery hand-off, or one this file
 * has never seen - has no destination, so it can never be given an ETA or a live map.
 */
const BEFORE_SERVICE=["confirmed","scheduled","assigned","accepted","on_the_way","arrived"];
const TAXI_PICKUP=new Set([...BEFORE_SERVICE,"vehicle_assigned","pickup_confirmed"]);
const TAXI_DROPOFF=["in_progress","arrived_dropoff","dropoff_confirmed"];
const WALK_LIVE=new Set([...BEFORE_SERVICE,"ready_to_start","in_progress"]);

/** Whether a journey in this lifecycle state is still live, i.e. has a destination an ETA can be routed to. */
export function journeyIsLive(serviceCode:string,status:string){
 if(serviceCode==="pet_taxi")return TAXI_PICKUP.has(status)||TAXI_DROPOFF.includes(status);
 if(serviceCode==="dog_walking")return WALK_LIVE.has(status);
 return false;
}

const point=(latitude:unknown,longitude:unknown)=>{
 const lat=Number(latitude),lng=Number(longitude);
 return Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180?{latitude:lat,longitude:lng}:null;
};

export async function serviceJourneyStatus(db:D1Database,serviceCode:string,bookingId:string){
 await ensureCustomerLiveTrackingServiceTables(db);
 if(serviceCode==="dog_walking"){
  // A Walking booking is a programme of occurrences and the journey is ONE walk: the one in progress, else the next
  // one not yet completed or cancelled. Reading the earliest occurrence reported a completed first walk for the whole
  // programme, which ended live tracking and ETA for every later walk. Only once every walk is closed does the latest
  // one speak for the booking.
  const row=await db.prepare("SELECT status FROM walking_sessions WHERE booking_id=? ORDER BY CASE WHEN status='in_progress' THEN 0 WHEN status IN ('completed','cancelled') THEN 2 ELSE 1 END,CASE WHEN status IN ('completed','cancelled') THEN -occurrence_number ELSE occurrence_number END LIMIT 1").bind(bookingId).first<Row>();
  return row?.status?String(row.status):"";
 }
 if(serviceCode==="pet_taxi"){
  const row=await db.prepare("SELECT status FROM taxi_trips WHERE booking_id=? LIMIT 1").bind(bookingId).first<Row>();
  return row?.status?String(row.status):"";
 }
 return"";
}

export async function resolveLiveJourneyDestination(db:D1Database,input:{bookingId:string;serviceCode:string;status:string}):Promise<LiveJourneyDestination|null>{
 const status=String(input.status||"");
 // Only a live journey has somewhere to go; a completed, cancelled or unknown Taxi state used to fall through to the pickup.
 if(!journeyIsLive(input.serviceCode,status))return null;
 await ensureCustomerLiveTrackingServiceTables(db);
 if(input.serviceCode==="pet_taxi"){
  const row=await db.prepare("SELECT d.origin_latitude,d.origin_longitude,d.destination_latitude,d.destination_longitude FROM taxi_ride_booking_details d WHERE d.booking_id=? LIMIT 1").bind(input.bookingId).first<Row>();
  if(!row)return null;
  const inRide=TAXI_DROPOFF.includes(status);
  const selected=inRide?point(row.destination_latitude,row.destination_longitude):point(row.origin_latitude,row.origin_longitude);
  return selected?{...selected,phase:inRide?"dropoff":"pickup"}:null;
 }
 if(input.serviceCode==="dog_walking"){
  const doorstep=await resolveBookingDoorstep(db,input.bookingId);
  return doorstep?{latitude:doorstep.latitude,longitude:doorstep.longitude,phase:"service_doorstep"}:null;
 }
 return null;
}
