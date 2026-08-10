import { computeGoogleRoute, type ProviderPoint } from "./grooming-maps";
import { currentHomeBase } from "./provider-home-base";

type Db=D1Database;
type Row=Record<string,unknown>;

export async function ensureProviderDailyTravelTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS booking_service_addresses (booking_id TEXT PRIMARY KEY,address TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'staff_entered',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_daily_travel_legs (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,travel_date TEXT NOT NULL,leg_sequence INTEGER NOT NULL,leg_type TEXT NOT NULL,booking_id TEXT,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,distance_km REAL,duration_minutes REAL,route_status TEXT NOT NULL,computed_at INTEGER NOT NULL,UNIQUE(provider_id,travel_date,leg_sequence))"),
]);}

function text(v:unknown){return String(v??"").trim();}
const money=(v:number)=>Math.round(v*100)/100;

export async function setBookingServiceAddress(db:Db,input:{bookingId:string;address:string;latitude?:number;longitude?:number;actorId:string}){
 await ensureProviderDailyTravelTables(db);
 if(!text(input.bookingId)||!text(input.address))throw new Error("Booking and a real address are required");
 const booking=await db.prepare("SELECT id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Canonical booking not found");
 const now=Date.now();
 await db.prepare("INSERT INTO booking_service_addresses (booking_id,address,latitude,longitude,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude,updated_at=excluded.updated_at")
   .bind(input.bookingId,input.address.trim(),input.latitude??null,input.longitude??null,"staff_entered",now,now).run();
 return{bookingId:input.bookingId,address:input.address.trim()};
}

type JobStop={bookingId:string;label:string;scheduledStart:string};

async function jobsForProviderOnDate(db:Db,providerId:string,travelDate:string){
 const rows=await db.prepare("SELECT b.id,b.scheduled_start,a.address FROM canonical_bookings b JOIN booking_service_addresses a ON a.booking_id=b.id WHERE b.provider_id=? AND b.service_code IN ('grooming','dog_training') AND date(b.scheduled_start)=? AND b.status NOT IN ('cancelled') ORDER BY b.scheduled_start ASC")
   .bind(providerId,travelDate).all<Row>();
 return rows.results.map(row=>({bookingId:String(row.id),label:String(row.address),scheduledStart:String(row.scheduled_start)} satisfies JobStop));
}

export async function computeDailyTravel(db:Db,input:{providerId:string;travelDate:string;actorId:string}){
 await ensureProviderDailyTravelTables(db);
 if(!text(input.providerId)||!/^\d{4}-\d{2}-\d{2}$/.test(input.travelDate))throw new Error("Provider and a real travel date (YYYY-MM-DD) are required");
 const homeBase=await currentHomeBase(db,input.providerId,new Date(`${input.travelDate}T00:00:00Z`).getTime());
 if(!homeBase)throw new Error("Provider has no home base configured for this date - set one before computing daily travel");
 const jobs=await jobsForProviderOnDate(db,input.providerId,input.travelDate);
 await db.prepare("DELETE FROM provider_daily_travel_legs WHERE provider_id=? AND travel_date=?").bind(input.providerId,input.travelDate).run();
 if(jobs.length===0)return{providerId:input.providerId,travelDate:input.travelDate,jobCount:0,legs:[],totalDistanceKm:0,totalDurationMinutes:0};

 const home:ProviderPoint={lat:homeBase.latitude,lng:homeBase.longitude};
 const stops:{label:string;bookingId:string|null;legType:"home_to_job"|"job_to_job"|"job_to_home"}[]=[];
 for(let i=0;i<jobs.length;i++)stops.push({label:jobs[i].label,bookingId:jobs[i].bookingId,legType:i===0?"home_to_job":"job_to_job"});
 stops.push({label:homeBase.address,bookingId:null,legType:"job_to_home"});

 const legs:Array<{sequence:number;legType:string;bookingId:string|null;origin:string;destination:string;distanceKm:number|null;durationMinutes:number|null;routeStatus:string}>=[];
 let origin=home,originLabel=homeBase.address;
 for(let i=0;i<stops.length;i++){
   const stop=stops[i];
   const route=await computeGoogleRoute(origin,stop.label).catch(error=>({status:"route_unavailable" as const,error:error instanceof Error?error.message:"Route computation failed"}));
   const distanceKm=route.distanceMeters!=null?money(route.distanceMeters/1000):null;
   const durationMinutes=route.durationSeconds!=null?money(route.durationSeconds/60):null;
   legs.push({sequence:i+1,legType:stop.legType,bookingId:stop.bookingId,origin:originLabel,destination:stop.label,distanceKm,durationMinutes,routeStatus:route.status});
   const addressRow=stop.bookingId?await db.prepare("SELECT latitude,longitude FROM booking_service_addresses WHERE booking_id=?").bind(stop.bookingId).first<Row>():null;
   if(addressRow&&addressRow.latitude!=null&&addressRow.longitude!=null){origin={lat:Number(addressRow.latitude),lng:Number(addressRow.longitude)};}
   else if(i<stops.length-1){
     for(let j=i+1;j<stops.length;j++)legs.push({sequence:j+1,legType:stops[j].legType,bookingId:stops[j].bookingId,origin:"unknown - prior stop has no coordinates",destination:stops[j].label,distanceKm:null,durationMinutes:null,routeStatus:"configuration_required"});
     break;
   }
   originLabel=stop.label;
 }

 const now=Date.now();
 for(const leg of legs)await db.prepare("INSERT INTO provider_daily_travel_legs (id,provider_id,travel_date,leg_sequence,leg_type,booking_id,origin_label,destination_label,distance_km,duration_minutes,route_status,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
   .bind(`PDT-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.providerId,input.travelDate,leg.sequence,leg.legType,leg.bookingId,leg.origin,leg.destination,leg.distanceKm,leg.durationMinutes,leg.routeStatus,now).run();

 const totalDistanceKm=money(legs.reduce((sum,l)=>sum+(l.distanceKm||0),0));
 const totalDurationMinutes=money(legs.reduce((sum,l)=>sum+(l.durationMinutes||0),0));
 return{providerId:input.providerId,travelDate:input.travelDate,jobCount:jobs.length,legs,totalDistanceKm,totalDurationMinutes};
}

export async function dailyTravelSummary(db:Db,input:{providerId:string;travelDate:string}){
 await ensureProviderDailyTravelTables(db);
 const rows=await db.prepare("SELECT * FROM provider_daily_travel_legs WHERE provider_id=? AND travel_date=? ORDER BY leg_sequence").bind(input.providerId,input.travelDate).all<Row>();
 const legs=rows.results;
 return{providerId:input.providerId,travelDate:input.travelDate,legCount:legs.length,totalDistanceKm:money(legs.reduce((sum,l)=>sum+Number(l.distance_km||0),0)),totalDurationMinutes:money(legs.reduce((sum,l)=>sum+Number(l.duration_minutes||0),0)),legs:legs.map(l=>({sequence:Number(l.leg_sequence),legType:String(l.leg_type),origin:String(l.origin_label),destination:String(l.destination_label),distanceKm:l.distance_km==null?null:Number(l.distance_km),durationMinutes:l.duration_minutes==null?null:Number(l.duration_minutes),routeStatus:String(l.route_status)}))};
}

export async function monthlyTravelSummary(db:Db,input:{providerId:string;monthStartDate:string;monthEndDate:string}){
 await ensureProviderDailyTravelTables(db);
 const row=await db.prepare("SELECT COUNT(DISTINCT travel_date) days,SUM(distance_km) total_distance,SUM(duration_minutes) total_duration FROM provider_daily_travel_legs WHERE provider_id=? AND travel_date>=? AND travel_date<=? AND route_status='configured'")
   .bind(input.providerId,input.monthStartDate,input.monthEndDate).first<Row>();
 return{providerId:input.providerId,monthStartDate:input.monthStartDate,monthEndDate:input.monthEndDate,daysWithConfiguredRoutes:Number(row?.days||0),totalDistanceKm:money(Number(row?.total_distance||0)),totalDurationMinutes:money(Number(row?.total_duration||0))};
}
