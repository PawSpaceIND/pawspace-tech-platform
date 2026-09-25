import{resolveBookingDoorstep}from "./booking-doorstep";
import{ensureCustomerLiveTrackingServiceTables}from "./customer-live-tracking-schema";

type Row=Record<string,unknown>;
export type LiveJourneyDestination={latitude:number;longitude:number;phase:"service_doorstep"|"pickup"|"dropoff"};

const point=(latitude:unknown,longitude:unknown)=>{
 const lat=Number(latitude),lng=Number(longitude);
 return Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180?{latitude:lat,longitude:lng}:null;
};

export async function serviceJourneyStatus(db:D1Database,serviceCode:string,bookingId:string){
 await ensureCustomerLiveTrackingServiceTables(db);
 if(serviceCode==="dog_walking"){
  const row=await db.prepare("SELECT status FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number ASC LIMIT 1").bind(bookingId).first<Row>();
  return row?.status?String(row.status):"";
 }
 if(serviceCode==="pet_taxi"){
  const row=await db.prepare("SELECT status FROM taxi_trips WHERE booking_id=? LIMIT 1").bind(bookingId).first<Row>();
  return row?.status?String(row.status):"";
 }
 return"";
}

export async function resolveLiveJourneyDestination(db:D1Database,input:{bookingId:string;serviceCode:string;status?:string}):Promise<LiveJourneyDestination|null>{
 await ensureCustomerLiveTrackingServiceTables(db);
 if(input.serviceCode==="pet_taxi"){
  const row=await db.prepare("SELECT d.origin_latitude,d.origin_longitude,d.destination_latitude,d.destination_longitude FROM taxi_ride_booking_details d WHERE d.booking_id=? LIMIT 1").bind(input.bookingId).first<Row>();
  if(!row)return null;
  const inRide=["in_progress","arrived_dropoff","dropoff_confirmed"].includes(String(input.status||""));
  const selected=inRide?point(row.destination_latitude,row.destination_longitude):point(row.origin_latitude,row.origin_longitude);
  return selected?{...selected,phase:inRide?"dropoff":"pickup"}:null;
 }
 if(input.serviceCode==="dog_walking"){
  const doorstep=await resolveBookingDoorstep(db,input.bookingId);
  return doorstep?{latitude:doorstep.latitude,longitude:doorstep.longitude,phase:"service_doorstep"}:null;
 }
 return null;
}
