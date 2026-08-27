import{loadGovernedProviders}from"./provider-capacity-governance";
import{listAuthoritativeAvailability}from"./scheduling-roster-authority";
type Row=Record<string,unknown>;
function parse<T>(v:unknown,f:T):T{try{return JSON.parse(String(v??"")) as T}catch{return f}}
function localDate(value:string){const d=new Date(new Date(value).getTime()+330*60_000);return d.toISOString().slice(0,10)}
function windowCovers(window:string,start:number,end:number){const m=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(!m)return false;const from=Number(m[1])*60+Number(m[2]),to=Number(m[3])*60+Number(m[4]);return start>=from&&end<=to}
export async function selectCapacitySafeReplacement(db:D1Database,input:{bookingId:string;excludeProviderId:string}){const b=await db.prepare("SELECT id,provider_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,schedule_group_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();if(!b)throw new Error("booking_not_found");const start=new Date(String(b.scheduled_start)),end=new Date(String(b.scheduled_end)),providers=await loadGovernedProviders(db,String(b.city_id),String(b.zone_id),String(b.service_code),start);
// The booking row already says who is being replaced. The exclusion used to be driven entirely by what
// the caller passed, so with excludeProviderId absent, undefined or blank the provider being recovered
// FROM was a candidate for recovering TO - returned with checks {service, zone, availability,
// collisionFree, capacity} all true, a clean bill of health for the provider that had just declined or
// no-showed. provider_id is authoritative about that, whatever the caller passed; the caller's own
// exclusion is still honoured on top of it. [PTJA-P1-F31]
const failing=String(b.provider_id||""),excluded=new Set([failing,String(input.excludeProviderId||"")].filter(Boolean));
for(const p of providers){if(excluded.has(p.id))continue;const date=localDate(start.toISOString()),ls=new Date(start.getTime()+330*60_000),le=new Date(end.getTime()+330*60_000),sm=ls.getUTCHours()*60+ls.getUTCMinutes(),em=le.getUTCHours()*60+le.getUTCMinutes();// Authored availability wins over synthetic uat_roster rows for the same provider-date. [PTJA-W1-F27]
const availability=await listAuthoritativeAvailability(db,p.id,date);if(!availability.some(r=>String(r.zone_id)===String(b.zone_id)&&parse<string[]>(r.windows_json,[]).some(w=>windowCovers(w,sm,em))))continue;const buffer=(p.travelBufferMinutes??30)*60_000,from=new Date(start.getTime()-buffer).toISOString(),to=new Date(end.getTime()+buffer).toISOString();const conflict=await db.prepare("SELECT id FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>? LIMIT 1").bind(p.id,String(b.schedule_group_id),to,from).first<Row>();if(conflict)continue;// The daily cap must count the SERVICE day, which is the IST day this function already resolved
// availability against - not the UTC calendar day. `substr(scheduled_start,1,10)` took the UTC date,
// so for any booking between 18:30 and 23:59 UTC (00:00-05:29 IST the next day) the two are different
// dates and the cap was measured against a day the booking is not on: a provider already full on the
// real service day was returned with capacity:true. Expressed as a half-open UTC range over the IST
// day rather than as SQL date arithmetic, so it does not depend on SQLite parsing an ISO-8601 string
// with a T separator and a Z suffix. [PTJA-W3C]
const istDayStartMs=new Date(`${date}T00:00:00.000Z`).getTime()-330*60_000;
const dayFrom=new Date(istDayStartMs).toISOString(),dayTo=new Date(istDayStartMs+86_400_000).toISOString();
const daily=await db.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE provider_id=? AND group_id!=? AND status!='cancelled' AND scheduled_start>=? AND scheduled_start<?").bind(p.id,String(b.schedule_group_id),dayFrom,dayTo).first<{n:number}>();if(Number(daily?.n||0)>=(p.maxDailyJobs??6))continue;return{provider:p,checks:{service:true,zone:true,availability:true,collisionFree:true,capacity:true},requiresAcceptance:p.model==="commission"}}
return null}
