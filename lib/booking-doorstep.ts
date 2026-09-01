type Row=Record<string,unknown>;
type Db={prepare:(sql:string)=>{bind:(...args:unknown[])=>{first:<T>()=>Promise<T|null>};first:<T>()=>Promise<T|null>}};

/*
 * One resolver for "where is the customer doorstep for this booking", shared by every arrival/start
 * geofence: Grooming ARRIVED, Training ARRIVED, Sitting check-in and Walking start.
 *
 * Two tables hold a booking coordinate, and only one of them is written by a customer flow:
 *
 *  - booking_service_locations (DDL in lib/grooming-maps.ts) is written by
 *    /api/grooming-service-location when the customer sets the address their pet is served at. This is
 *    the authoritative doorstep, and `status='active'` is the row that currently applies.
 *  - booking_service_addresses (DDL in lib/provider-daily-travel.ts) belongs to the travel/petrol
 *    allowance feature. Its only writer, setBookingServiceAddress(), has no call sites anywhere in the
 *    app, so on a real database it is empty.
 *
 * Every geofence read only the second table. A booking whose customer HAD set their service address was
 * therefore still refused with "doorstep coordinates are not configured", making arrival unreachable on
 * all four verticals; the suites passed only because their fixtures inserted the travel table directly.
 * Both are consulted here, authoritative table first, so a staff-entered travel address still works and
 * the four surfaces cannot drift apart on which table counts.
 */
async function tableExists(db:Db,name:string){
 return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>().catch(()=>null));
}
const coordinate=(value:unknown)=>{const n=Number(value);return value==null||!Number.isFinite(n)?null:n;};

export type BookingDoorstep={latitude:number;longitude:number;source:"booking_service_locations"|"booking_service_addresses"};

export async function resolveBookingDoorstep(db:Db,bookingId:string):Promise<BookingDoorstep|null>{
 if(await tableExists(db,"booking_service_locations")){
  // status='active' because a superseded location row must not keep geofencing arrivals at an old address.
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
