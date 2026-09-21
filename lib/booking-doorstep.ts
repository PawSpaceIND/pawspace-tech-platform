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

export type BookingDoorstep={latitude:number;longitude:number;source:"booking_service_locations"|"booking_service_addresses"|"scheduling_assignment_decisions"};

export async function resolveBookingDoorstep(db:Db,bookingId:string):Promise<BookingDoorstep|null>{
 if(await tableExists(db,"booking_service_locations")){
  // status='active' because a superseded location row must not keep geofencing arrivals at an old address.
  const row=await db.prepare("SELECT latitude,longitude FROM booking_service_locations WHERE booking_id=? AND status='active'").bind(bookingId).first<Row>().catch(()=>null);
  if(row){
   /*
    * An active customer location DECIDES, coordinates or not. Falling through to the travel table when
    * this row exists but has no coordinates would geofence the arrival against a different, older
    * address the customer has already replaced - the provider would be marked "at the doorstep" while
    * standing somewhere else. Refusing is the safe answer; the travel table is only consulted when the
    * customer has set no active location at all.
    */
   const latitude=coordinate(row.latitude),longitude=coordinate(row.longitude);
   return latitude!==null&&longitude!==null?{latitude,longitude,source:"booking_service_locations"}:null;
  }
 }
 if(await tableExists(db,"booking_service_addresses")){
  const row=await db.prepare("SELECT latitude,longitude FROM booking_service_addresses WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
  const latitude=coordinate(row?.latitude),longitude=coordinate(row?.longitude);
  if(latitude!==null&&longitude!==null)return{latitude,longitude,source:"booking_service_addresses"};
 }
 // Non-Grooming booking flows reserve a server-geocoded service address through the scheduler.
 // Read that immutable reservation snapshot, never the customer's subsequently edited address.
 if(await tableExists(db,"canonical_bookings")&&await tableExists(db,"scheduling_assignment_decisions")){
  const row=await db.prepare("SELECT b.customer_id,b.service_code,d.shortlist_json FROM canonical_bookings b JOIN scheduling_assignment_decisions d ON d.group_id=b.schedule_group_id WHERE b.id=?").bind(bookingId).first<Row>().catch(()=>null);
  if(row){
   try{
    const request=JSON.parse(String(row.shortlist_json)).request as Row;
    const latitude=coordinate(request.latitude),longitude=coordinate(request.longitude);
    if(String(request.customerId)===String(row.customer_id)&&String(request.serviceCode)===String(row.service_code)&&latitude!==null&&longitude!==null&&Math.abs(latitude)<=90&&Math.abs(longitude)<=180)
     return{latitude,longitude,source:"scheduling_assignment_decisions"};
   }catch{/* An absent/malformed snapshot is not location evidence. */}
  }
 }
 return null;
}
