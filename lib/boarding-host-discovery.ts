import{ensureBoardingStayLifecycleTables}from"./boarding-stay-lifecycle";

type Row=Record<string,unknown>;
export type BoardingHostDiscoveryInput={cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;petCount:number;species:string[]};
export type BoardingDiscoveredHost={providerId:string;name:string;model:"full_time"|"commission";area:string;rating:number;qualityScore:number;capacity:number;availableGuestPets:number;species:string[];oneFamilyOnly:boolean;medicationSupport:boolean;residentPets:string;homeVerified:boolean;kycStatus:string;backgroundCheckStatus:string;profileVersion:number;availabilityVerified:boolean;availabilityMode:"uat_canonical";commitments:number};
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T;}catch{return fallback;}};
const overlaps=(start:string,end:string,row:Row)=>String(row.scheduled_start??row.starts_at)<end&&String(row.scheduled_end??row.ends_at)>start;

export async function discoverBoardingHosts(db:D1Database,input:BoardingHostDiscoveryInput){
 await ensureBoardingStayLifecycleTables(db);
 const startMs=new Date(input.scheduledStart).getTime(),endMs=new Date(input.scheduledEnd).getTime();
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw new Response("A valid Boarding stay window is required for host discovery",{status:400});
 const petCount=Math.floor(Number(input.petCount));if(petCount<1||petCount>4)throw new Response("Boarding host discovery supports 1-4 pets",{status:400});
 const requestedSpecies=[...new Set(input.species.map(value=>String(value).trim().toLowerCase()).filter(Boolean))];if(!requestedSpecies.length)throw new Response("Pet species are required for Boarding host discovery",{status:400});
 const candidates=await db.prepare("SELECT h.provider_id,h.area,h.species_json,h.max_guest_pets,h.one_family_only,h.medication_support,h.resident_pets,h.home_verified,h.kyc_status,h.background_check_status,h.version,p.name,p.provider_model,p.rating,p.quality_score,p.capacity,p.status,p.live,p.services_json,p.zones_json,p.effective_from,p.effective_to FROM boarding_host_profiles h JOIN provider_capacity_profiles p ON p.id=h.provider_id WHERE h.city_id=? AND h.zone_id=? AND h.active=1 AND p.live=1 AND p.status='active'").bind(input.cityId,input.zoneId).all<Row>();
 const date=input.scheduledStart.slice(0,10),result:BoardingDiscoveredHost[]=[];
 for(const row of candidates.results){
  if(date<String(row.effective_from||"0000-00-00")||(row.effective_to&&date>String(row.effective_to)))continue;
  if(Number(row.home_verified)!==1||String(row.kyc_status)!=="verified"||String(row.background_check_status)!=="verified")continue;
  const services=parse<string[]>(row.services_json,[]),zones=parse<string[]>(row.zones_json,[]),supported=parse<string[]>(row.species_json,[]).map(value=>value.toLowerCase());
  if(!services.includes("boarding")||!zones.includes(input.zoneId)||requestedSpecies.some(species=>!supported.includes(species)))continue;
  const maxCapacity=Math.max(0,Math.min(Number(row.max_guest_pets||0),Number(row.capacity||row.max_guest_pets||0)));if(maxCapacity<petCount)continue;
  const blocked=await db.prepare("SELECT id,starts_at,ends_at FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1").bind(row.provider_id,input.scheduledEnd,input.scheduledStart).first<Row>();if(blocked)continue;
  // Public host discovery must also work on a cold UAT database before the first canonical booking
  // exists. Joining a table that has not been created yet made the otherwise public catalogue return
  // 500 and left the customer with no hosts. When the booking table is absent there cannot be a
  // reliable schedule-group link, so existing locks are counted conservatively without that join.
  const bookingTable=await db.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first<Row>();
  const locks=bookingTable
   ?await db.prepare("SELECT l.booking_id,l.capacity_units,l.starts_at,l.ends_at,b.schedule_group_id FROM boarding_capacity_locks l LEFT JOIN canonical_bookings b ON b.id=l.booking_id WHERE l.provider_id=? AND l.status='active' AND l.starts_at<? AND l.ends_at>?").bind(row.provider_id,input.scheduledEnd,input.scheduledStart).all<Row>()
   :await db.prepare("SELECT booking_id,capacity_units,starts_at,ends_at,NULL schedule_group_id FROM boarding_capacity_locks WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>?").bind(row.provider_id,input.scheduledEnd,input.scheduledStart).all<Row>();
  let reservations:{group_id:string;capacity_units:number;scheduled_start:string;scheduled_end:string}[]=[];try{const scheduled=await db.prepare("SELECT group_id,capacity_units,scheduled_start,scheduled_end FROM scheduling_reservations WHERE provider_id=? AND service_code='boarding' AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?").bind(row.provider_id,input.scheduledEnd,input.scheduledStart).all<Row>();reservations=scheduled.results.filter(item=>overlaps(input.scheduledStart,input.scheduledEnd,item)).map(item=>({group_id:String(item.group_id),capacity_units:Number(item.capacity_units||0),scheduled_start:String(item.scheduled_start),scheduled_end:String(item.scheduled_end)}));}catch{}
  const lockedGroups=new Set(locks.results.map(item=>String(item.schedule_group_id||"")).filter(Boolean)),lockedUnits=locks.results.reduce((sum,item)=>sum+Number(item.capacity_units||0),0),pendingUnits=reservations.filter(item=>!lockedGroups.has(item.group_id)).reduce((sum,item)=>sum+item.capacity_units,0),used=lockedUnits+pendingUnits,commitments=locks.results.length+reservations.filter(item=>!lockedGroups.has(item.group_id)).length,available=Math.max(0,maxCapacity-used);
  if(Number(row.one_family_only)===1&&commitments>0)continue;if(available<petCount)continue;
  result.push({providerId:String(row.provider_id),name:String(row.name),model:String(row.provider_model)==="full_time"?"full_time":"commission",area:String(row.area),rating:Number(row.rating||0),qualityScore:Number(row.quality_score||0),capacity:maxCapacity,availableGuestPets:available,species:supported,oneFamilyOnly:Boolean(row.one_family_only),medicationSupport:Boolean(row.medication_support),residentPets:String(row.resident_pets||"none"),homeVerified:true,kycStatus:String(row.kyc_status),backgroundCheckStatus:String(row.background_check_status),profileVersion:Number(row.version||1),availabilityVerified:true,availabilityMode:"uat_canonical",commitments});
 }
 return result.sort((a,b)=>b.qualityScore-a.qualityScore||b.rating-a.rating||a.name.localeCompare(b.name));
}
