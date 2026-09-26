import {hostMeetsRequirements,requireBoardingRequirements,type BoardingRequirements} from "./stay-host-requirements";
import{ensureBoardingStayLifecycleTables}from"./boarding-stay-lifecycle";
import{chunkedIn}from"./d1-chunked-in";

type Row=Record<string,unknown>;
export type BoardingHostDiscoveryInput={cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;petCount:number;species:string[];requirements?:BoardingRequirements};
export type BoardingDiscoveredHost={providerId:string;name:string;model:"full_time"|"commission";area:string;rating:number;qualityScore:number;capacity:number;availableGuestPets:number;species:string[];oneFamilyOnly:boolean;medicationSupport:boolean;residentPets:string;homeVerified:boolean;kycStatus:string;backgroundCheckStatus:string;profileVersion:number;availabilityVerified:boolean;availabilityMode:"uat_canonical";commitments:number};
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}};
const overlaps=(start:string,end:string,row:Row)=>String(row.scheduled_start??row.starts_at)<end&&String(row.scheduled_end??row.ends_at)>start;

/*
 * Host search speed (staging: 7-15 s with 4 hosts, 22-65 s with 7+ hosts per zone). The schema set-up ran on
 * every search and every host cost five sequential D1 reads (leave, two table probes, locks, reservations),
 * so the search grew by ~1.25 s per host at staging's ~250 ms per call. Now the set-up runs once per isolate
 * and the per-host reads are ONE read per concern for the whole shortlist, in one parallel wave (as the
 * grooming preview's providers were in #1105). Every host still gets exactly the same checks with the same
 * SQL predicates, and the same sort decides the order.
 */
const discoveryTablesReady=new WeakSet<object>();
async function ensureDiscoveryTables(db:D1Database){if(discoveryTablesReady.has(db))return;await ensureBoardingStayLifecycleTables(db);discoveryTablesReady.add(db);}
// Tables are never dropped at runtime: once seen they stay seen for this isolate; absence is re-checked.
const tablesSeen=new WeakMap<object,Set<string>>();
async function presentTables(db:D1Database,names:string[]){let seen=tablesSeen.get(db);if(!seen){seen=new Set();tablesSeen.set(db,seen);}const missing=names.filter(name=>!seen!.has(name));if(missing.length){const rows=await chunkedIn(missing,async(chunk,placeholders)=>(await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).bind(...chunk).all<Row>()).results);for(const row of rows)seen.add(String(row.name));}return new Set(names.filter(name=>seen!.has(name)));}
const byProvider=(rows:Row[])=>{const grouped=new Map<string,Row[]>();for(const row of rows){const id=String(row.provider_id);const list=grouped.get(id);if(list)list.push(row);else grouped.set(id,[row]);}return grouped;};

export async function discoverBoardingHosts(db:D1Database,input:BoardingHostDiscoveryInput){
 await ensureDiscoveryTables(db);
 const startMs=new Date(input.scheduledStart).getTime(),endMs=new Date(input.scheduledEnd).getTime();
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw new Response("A valid Boarding stay window is required for host discovery",{status:400});
 // Effective dates compare against the calendar date the customer booked, the same way the quote's
 // activePackage() reads it. Only the instants are normalised to UTC, for the lock/reservation range checks,
 // so an IST window such as 01:00+05:30 is not moved to the previous day.
 const bookedDate=String(input.scheduledStart).slice(0,10);
 input={...input,scheduledStart:new Date(startMs).toISOString(),scheduledEnd:new Date(endMs).toISOString()};
 const requirements=requireBoardingRequirements(input.requirements);
 const petCount=Number(input.petCount);if(!Number.isInteger(petCount)||petCount<1||petCount>4)throw new Response("Boarding host discovery supports 1-4 pets",{status:400});
 const requestedSpecies=[...new Set(input.species.map(value=>String(value).trim().toLowerCase()).filter(Boolean))];if(!requestedSpecies.length)throw new Response("Pet species are required for Boarding host discovery",{status:400});
 const candidates=await db.prepare("SELECT h.provider_id,h.area,h.species_json,h.max_guest_pets,h.one_family_only,h.medication_support,h.resident_pets,h.home_verified,h.kyc_status,h.background_check_status,h.version,p.name,p.provider_model,p.rating,p.quality_score,p.capacity,p.status,p.live,p.services_json,p.zones_json,p.effective_from,p.effective_to FROM boarding_host_profiles h JOIN provider_capacity_profiles p ON p.id=h.provider_id WHERE h.city_id=? AND h.zone_id=? AND h.active=1 AND p.live=1 AND p.status='active'").bind(input.cityId,input.zoneId).all<Row>();
 const date=bookedDate,result:BoardingDiscoveredHost[]=[];
 // Every check that needs no further read, in the original order, for every candidate.
 const shortlisted:Array<{row:Row;supported:string[];maxCapacity:number}>=[];
 for(const row of candidates.results){
  if(!hostMeetsRequirements({medicationSupport:Number(row.medication_support)===1,residentPets:String(row.resident_pets||""),oneFamilyOnly:Number(row.one_family_only)===1},requirements))continue;
  if(date<String(row.effective_from||"0000-00-00")||(row.effective_to&&date>String(row.effective_to)))continue;
  if(Number(row.home_verified)!==1||String(row.kyc_status)!=="verified"||String(row.background_check_status)!=="verified")continue;
  const services=parse<string[]>(row.services_json,[]),zones=parse<string[]>(row.zones_json,[]),supported=parse<string[]>(row.species_json,[]).map(value=>value.toLowerCase());
  if(!services.includes("boarding")||!zones.includes(input.zoneId)||requestedSpecies.some(species=>!supported.includes(species)))continue;
  const maxCapacity=Math.max(0,Math.min(Number(row.max_guest_pets||0),Number(row.capacity||row.max_guest_pets||0)));if(maxCapacity<petCount)continue;
  shortlisted.push({row,supported,maxCapacity});
 }
 if(!shortlisted.length)return result;
 const ids=[...new Set(shortlisted.map(item=>String(item.row.provider_id)))];
 // Public host discovery must also work on a cold UAT database before the first canonical booking
 // exists. Joining a table that has not been created yet made the otherwise public catalogue return
 // 500 and left the customer with no hosts. When the booking table is absent there cannot be a
 // reliable schedule-group link, so existing locks are counted conservatively without that join.
 const tables=await presentTables(db,["canonical_bookings","scheduling_reservations"]);
 const[blockedRows,lockRows,reservationRows]=await Promise.all([
  chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT id,starts_at,ends_at,provider_id FROM provider_unavailability WHERE provider_id IN (${placeholders}) AND status='active' AND starts_at<? AND ends_at>?`).bind(...chunk,input.scheduledEnd,input.scheduledStart).all<Row>()).results),
  chunkedIn(ids,async(chunk,placeholders)=>(tables.has("canonical_bookings")
   ?await db.prepare(`SELECT l.booking_id,l.capacity_units,l.starts_at,l.ends_at,b.schedule_group_id,l.provider_id FROM boarding_capacity_locks l LEFT JOIN canonical_bookings b ON b.id=l.booking_id WHERE l.provider_id IN (${placeholders}) AND l.status='active' AND l.starts_at<? AND l.ends_at>?`).bind(...chunk,input.scheduledEnd,input.scheduledStart).all<Row>()
   :await db.prepare(`SELECT booking_id,capacity_units,starts_at,ends_at,NULL schedule_group_id,provider_id FROM boarding_capacity_locks WHERE provider_id IN (${placeholders}) AND status='active' AND starts_at<? AND ends_at>?`).bind(...chunk,input.scheduledEnd,input.scheduledStart).all<Row>()).results),
  tables.has("scheduling_reservations")?chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT group_id,capacity_units,scheduled_start,scheduled_end,provider_id FROM scheduling_reservations WHERE provider_id IN (${placeholders}) AND service_code='boarding' AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?`).bind(...chunk,input.scheduledEnd,input.scheduledStart).all<Row>()).results):Promise.resolve([] as Row[]),
 ]);
 const blocked=new Set(blockedRows.map(row=>String(row.provider_id))),locksBy=byProvider(lockRows),reservationsBy=byProvider(reservationRows);
 for(const{row,supported,maxCapacity}of shortlisted){
  const providerId=String(row.provider_id);
  if(blocked.has(providerId))continue;
  const locks=locksBy.get(providerId)??[];
  const reservations=(reservationsBy.get(providerId)??[]).filter(item=>overlaps(input.scheduledStart,input.scheduledEnd,item)).map(item=>({group_id:String(item.group_id),capacity_units:Number(item.capacity_units||0),scheduled_start:String(item.scheduled_start),scheduled_end:String(item.scheduled_end)}));
  const lockedGroups=new Set(locks.map(item=>String(item.schedule_group_id||"")).filter(Boolean)),lockedUnits=locks.reduce((sum,item)=>sum+Number(item.capacity_units||0),0),pendingUnits=reservations.filter(item=>!lockedGroups.has(item.group_id)).reduce((sum,item)=>sum+item.capacity_units,0),used=lockedUnits+pendingUnits,commitments=locks.length+reservations.filter(item=>!lockedGroups.has(item.group_id)).length,available=Math.max(0,maxCapacity-used);
  if(Number(row.one_family_only)===1&&commitments>0)continue;if(available<petCount)continue;
  result.push({providerId,name:String(row.name),model:String(row.provider_model)==="full_time"?"full_time":"commission",area:String(row.area),rating:Number(row.rating||0),qualityScore:Number(row.quality_score||0),capacity:maxCapacity,availableGuestPets:available,species:supported,oneFamilyOnly:Boolean(row.one_family_only),medicationSupport:Boolean(row.medication_support),residentPets:String(row.resident_pets||"none"),homeVerified:true,kycStatus:String(row.kyc_status),backgroundCheckStatus:String(row.background_check_status),profileVersion:Number(row.version||1),availabilityVerified:true,availabilityMode:"uat_canonical",commitments});
 }
 return result.sort((a,b)=>b.qualityScore-a.qualityScore||b.rating-a.rating||a.name.localeCompare(b.name));
}
