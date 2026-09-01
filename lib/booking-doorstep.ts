type Row=Record<string,unknown>;
type Db={prepare:(sql:string)=>{bind:(...args:unknown[])=>{first:<T>()=>Promise<T|null>};first:<T>()=>Promise<T|null>}};

/*
 * One resolver for "where is the customer doorstep for this booking", used by every arrival/start
 * geofence (Grooming ARRIVED, Training ARRIVED, Sitting check-in, Walking start).
 *
 * There are two tables, and only one of them is ever written by a real customer flow:
 *
 *  - booking_service_locations (lib/grooming-maps.ts) is what /api/grooming-service-location writes when
 *    the customer sets the address their pet is served at. This is the authoritative doorstep.
 *  - booking_service_addresses (lib/provider-daily-travel.ts) is the travel/petrol-allowance table. Its
 *    only writer, setBookingServiceAddress(), has no call sites, so on a real database it is empty.
 *
 * Every geofence read only the second one, which meant a booking whose customer HAD set their service
 * address was still refused with "doorstep coordinates are not configured" - arrival was unreachable on
 * every vertical. Both are consulted here, authoritative table first, so a staff-entered travel address
 * still works and the four surfaces cannot drift apart on which table counts.
 */
async function tableExists(db:Db,name:string){
 return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());
}
const coordinate=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n:null;};

export type BookingDoorstep={latitude:number;longitude:number;source:"booking_service_locations"|"booking_service_addresses"};

export async function resolveBookingDoorstep(db:Db,bookingId:string):Promise<BookingDoorstep|null>{
 if(await tableExists(db,"booking_service_locations")){
  // status='active' because a superseded location row must not silently keep geofencing arrivals.
  const row=await db.prepare("SELECT latitude,longitude FROM booking_service_locations WHERE booking_id=? AND status='active'").bind(bookingId).first<Row>().catch(()=>null);
  const latitude=coordinate(row?.latitude),longitude=coordinate(row?.longitude);
  if(latitude!==null&&longitude!==null)return{latitude,longitude,source:"booking_service_locations"};
 }
 if(await tableExists(db,"booking_service_addresses")){
  const row=await db.prepare("SELECT latitude,longitude FROM booking_service_addresses WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
  const latitude=coordinate(row?.latitude),longitude=coordinate(row?.longitude);
  if(latitude!==null&&longitude!==null)return{latitude,longitude,source:"booking_service_addresses"};
 }
 return null;
}
