import type { Booking, Pet, PlatformRepository, Provider } from "./domain.js";

export type SchedulingService = "grooming" | "dog_training" | "boarding" | "pet_sitting" | "pet_taxi" | "dog_walking";
export type CareMode = "visit" | "overnight";
export interface CustomScheduleRule { code:string; field:"rating"|"qualityScore"|"model"|"providerId"|"zone"|"capacity"; operator:"eq"|"neq"|"gte"|"lte"|"in"|"not_in"; value:string|number|string[]; }

export interface ScheduleRequest {
  cityId: string;
  zoneId: string;
  serviceCode: SchedulingService;
  petIds: string[];
  scheduledStart: string;
  scheduledEnd: string;
  latitude?: number;
  longitude?: number;
  serviceRadiusKm?: number;
  occurrences?: number;
  cadenceDays?: number;
  weekdays?: number[];
  careMode?: CareMode;
  preferredProviderId?: string;
  repeatProviderId?: string;
  excludeProviderIds?: string[];
  manualProviderId?: string;
  manualOverrideReason?: string;
  customRules?: CustomScheduleRule[];
}

export interface ScheduleOccurrence { start: string; end: string; occurrenceNumber: number; }
export interface ProviderEvaluation { providerId: string; providerName: string; eligible: boolean; score: number; reasons: string[]; }
export interface ScheduleDecision {
  provider: Provider | null;
  mode: "automatic" | "offer" | "manual_review";
  occurrences: ScheduleOccurrence[];
  evaluations: ProviderEvaluation[];
  shortlist: Array<{provider:Provider;score:number;reasons:string[]}>;
  explanation: string[];
  offerExpiresAt?: string;
}

export const scheduleRules = {
  grooming: { label:"Grooming", durationMinutes:120, bufferMinutes:30, maxOccurrences:1, capacityMode:"appointment" },
  dog_training: { label:"Training", durationMinutes:60, bufferMinutes:30, maxOccurrences:12, capacityMode:"appointment" },
  boarding: { label:"Boarding", durationMinutes:1440, bufferMinutes:0, maxOccurrences:1, capacityMode:"overnight" },
  pet_sitting: { label:"Pet Sitting", durationMinutes:60, bufferMinutes:30, maxOccurrences:1, capacityMode:"care_mode" },
  pet_taxi: { label:"Pet Taxi", durationMinutes:45, bufferMinutes:20, maxOccurrences:1, capacityMode:"appointment" },
  dog_walking: { label:"Dog Walking", durationMinutes:30, bufferMinutes:20, maxOccurrences:12, capacityMode:"appointment" },
} as const;

const activeStatuses = new Set<Booking["status"]>(["confirmed","assigned","on_the_way","arrived","in_service"]);
const msMinute = 60_000;
const addDays = (value:string, days:number) => new Date(new Date(value).getTime()+days*24*60*msMinute).toISOString();
/**
 * Canonical scheduling UTC offsets for the currently operational PawSpace cities.
 *
 * The old implementation treated every city except Bengaluru as UTC, shifting roster windows,
 * recurring weekdays and daily-job limits by 5h30m for Mumbai, Pune, Hyderabad and Chennai. Keep the
 * operational city registry explicit and fail closed for an unknown city rather than silently inventing
 * UTC semantics. When an international city is launched, its governed offset must be added alongside
 * the launch configuration before scheduling can accept it.
 */
export const SCHEDULING_CITY_UTC_OFFSETS:Readonly<Record<string,number>>=Object.freeze({
  blr:330,bengaluru:330,
  mum:330,mumbai:330,bom:330,
  pnq:330,pune:330,
  hyd:330,hyderabad:330,
  maa:330,chennai:330,chn:330,
});
export const cityOffsetMinutes=(cityId:string)=>{
  const normalized=String(cityId||"").trim().toLowerCase();
  const offset=SCHEDULING_CITY_UTC_OFFSETS[normalized];
  if(offset===undefined)throw Object.assign(new Error(`Scheduling timezone is not configured for city ${normalized||"<empty>"}`),{statusCode:422});
  return offset;
};
const localDate=(value:string,cityId:string)=>new Date(new Date(value).getTime()+cityOffsetMinutes(cityId)*msMinute);
const dateKey = (value:string,cityId:string) => localDate(value,cityId).toISOString().slice(0,10);
const minutesOfDay = (value:string,cityId:string) => { const d=localDate(value,cityId); return d.getUTCHours()*60+d.getUTCMinutes(); };
const overlaps = (aStart:number,aEnd:number,bStart:number,bEnd:number) => aStart < bEnd && bStart < aEnd;
const windowCovers=(window:string,start:number,end:number)=>{const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(!match)return false;const from=Number(match[1])*60+Number(match[2]);const to=Number(match[3])*60+Number(match[4]);return start>=from&&end<=to;};

export function haversineDistanceKm(a:{latitude:number;longitude:number},b:{latitude:number;longitude:number}){
  const valid=(lat:number,lng:number)=>Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;
  if(!valid(a.latitude,a.longitude)||!valid(b.latitude,b.longitude))return Number.POSITIVE_INFINITY;
  const rad=(value:number)=>value*Math.PI/180,R=6371,dLat=rad(b.latitude-a.latitude),dLng=rad(b.longitude-a.longitude),lat1=rad(a.latitude),lat2=rad(b.latitude);
  const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}

function buildOccurrences(input:ScheduleRequest):ScheduleOccurrence[] {
  const rule=scheduleRules[input.serviceCode],recurring=input.serviceCode==="dog_training"||input.serviceCode==="dog_walking";
  const requested=recurring?(input.occurrences??1):1;
  if(requested<1||requested>rule.maxOccurrences)throw Object.assign(new Error(`Occurrences must be between 1 and ${rule.maxOccurrences}`),{statusCode:422});
  if(recurring&&(input.cadenceDays??7)<1)throw Object.assign(new Error("Recurring cadence must be at least one day"),{statusCode:422});
  if(input.weekdays&&(input.weekdays.length<1||input.weekdays.some(day=>day<0||day>6)))throw Object.assign(new Error("Recurring weekdays must use values 0–6"),{statusCode:422});
  const startMs=new Date(input.scheduledStart).getTime(); const endMs=new Date(input.scheduledEnd).getTime();
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw Object.assign(new Error("Scheduled end must be after start"),{statusCode:422});
  const hasAnyGeo=input.latitude!==undefined||input.longitude!==undefined||input.serviceRadiusKm!==undefined;
  if(hasAnyGeo){if(!Number.isFinite(input.latitude)||Number(input.latitude)<-90||Number(input.latitude)>90||!Number.isFinite(input.longitude)||Number(input.longitude)<-180||Number(input.longitude)>180||!Number.isFinite(input.serviceRadiusKm)||Number(input.serviceRadiusKm)<=0)throw Object.assign(new Error("Scheduling geofence requires valid latitude, longitude and a positive serviceRadiusKm"),{statusCode:422});}
  if(input.serviceCode!=="boarding"&&!(input.serviceCode==="pet_sitting"&&input.careMode==="overnight")){
    const duration=(endMs-startMs)/msMinute;
    const required=input.serviceCode==="grooming"?(input.petIds.length>=4?240:input.petIds.length===3?150:120):input.serviceCode==="dog_training"?Math.max(60,input.petIds.length*60):rule.durationMinutes;
    if(duration<required)throw Object.assign(new Error(`${rule.label} requires at least ${required} minutes for ${input.petIds.length} pet${input.petIds.length===1?"":"s"}`),{statusCode:422});
  }
  if(recurring&&input.weekdays?.length){const wanted=new Set(input.weekdays);const result:ScheduleOccurrence[]=[];let offset=0;while(result.length<requested&&offset<180){const candidate=addDays(input.scheduledStart,offset);if(wanted.has(localDate(candidate,input.cityId).getUTCDay()))result.push({start:candidate,end:addDays(input.scheduledEnd,offset),occurrenceNumber:result.length+1});offset++;}if(result.length!==requested)throw Object.assign(new Error("Unable to generate the requested recurring calendar"),{statusCode:422});return result;}
  return Array.from({length:requested},(_,index)=>({start:addDays(input.scheduledStart,index*(input.cadenceDays??7)),end:addDays(input.scheduledEnd,index*(input.cadenceDays??7)),occurrenceNumber:index+1}));
}

function datesTouched(start:string,end:string,cityId:string){
  const dates:string[]=[]; const cursor=new Date(`${dateKey(start,cityId)}T00:00:00.000Z`); const last=new Date(`${dateKey(end,cityId)}T00:00:00.000Z`);
  while(cursor<=last){dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);} return dates;
}

async function petsFor(repository:PlatformRepository,petIds:string[]):Promise<Pet[]> {
  return (await Promise.all(petIds.map(id=>repository.getPet(id)))).filter((pet):pet is Pet=>Boolean(pet));
}

async function evaluateProvider(repository:PlatformRepository,provider:Provider,input:ScheduleRequest,occurrences:ScheduleOccurrence[],pets:Pet[]):Promise<ProviderEvaluation>{
  const reasons:string[]=[]; let eligible=true; const existing=(await repository.listBookings(input.cityId,provider.id)).filter(b=>activeStatuses.has(b.status));
  const overnight=input.serviceCode==="boarding"||(input.serviceCode==="pet_sitting"&&input.careMode==="overnight");
  if(input.excludeProviderIds?.includes(provider.id)){eligible=false;reasons.push("Provider excluded after decline or Ops action");}
  if(input.manualProviderId&&provider.id!==input.manualProviderId){eligible=false;reasons.push("Another provider selected by Ops override");}
  if(input.serviceRadiusKm!==undefined){const located=provider as Provider&{latitude?:number;longitude?:number};const distance=haversineDistanceKm({latitude:Number(input.latitude),longitude:Number(input.longitude)},{latitude:Number(located.latitude),longitude:Number(located.longitude)});if(!Number.isFinite(distance)){eligible=false;reasons.push("Provider has no active geocoded home base for radius verification");}else if(distance>Number(input.serviceRadiusKm)){eligible=false;reasons.push(`Provider is ${distance.toFixed(2)} km from booking, outside ${Number(input.serviceRadiusKm).toFixed(2)} km service radius`);}else reasons.push(`Provider is ${distance.toFixed(2)} km from booking, inside service radius`);}
  for(const rule of input.customRules??[]){const actual=rule.field==="zone"?input.zoneId:rule.field==="capacity"?(provider.capacity??1):rule.field==="providerId"?provider.id:provider[rule.field];const expected=rule.value;const values=Array.isArray(expected)?expected:[expected];const passed=rule.operator==="eq"?actual===expected:rule.operator==="neq"?actual!==expected:rule.operator==="gte"?Number(actual)>=Number(expected):rule.operator==="lte"?Number(actual)<=Number(expected):rule.operator==="in"?values.includes(String(actual)):!values.includes(String(actual));if(!passed){eligible=false;reasons.push(`Custom rule ${rule.code} rejected provider (${rule.field} ${rule.operator} ${String(expected)})`);}}
  if(input.serviceCode==="boarding"&&pets.some(p=>p.vaccinationStatus!=="verified")){eligible=false;reasons.push("Boarding requires verified vaccination");}
  for(const occurrence of occurrences){
    const dates=datesTouched(occurrence.start,occurrence.end,input.cityId);
    for(const date of dates){
      const roster=await repository.listAvailability(provider.id,date);
      if(!roster.length){eligible=false;reasons.push(`No published availability on ${date}`);continue;}
      if(!overnight){
        const start=minutesOfDay(occurrence.start,input.cityId); const end=minutesOfDay(occurrence.end,input.cityId);
        const covered=roster.some(r=>r.zoneId===input.zoneId&&r.windows.some(w=>windowCovers(w,start,end)));
        if(!covered){eligible=false;reasons.push(`Requested time is outside roster on ${date}`);}
      }
    }
    if(overnight){
      const used=existing.filter(b=>overlaps(new Date(occurrence.start).getTime(),new Date(occurrence.end).getTime(),new Date(b.scheduledStart).getTime(),new Date(b.scheduledEnd).getTime())).reduce((sum,b)=>sum+(b.capacityUnits??b.petIds.length),0);
      if(used+input.petIds.length>(provider.capacity??1)){eligible=false;reasons.push(`Capacity ${provider.capacity??1} exceeded for the stay range`);}
    } else {
      const buffer=(provider.travelBufferMinutes??scheduleRules[input.serviceCode].bufferMinutes)*msMinute;
      const conflict=existing.some(b=>overlaps(new Date(occurrence.start).getTime()-buffer,new Date(occurrence.end).getTime()+buffer,new Date(b.scheduledStart).getTime(),new Date(b.scheduledEnd).getTime()));
      if(conflict){eligible=false;reasons.push("Existing booking conflicts with travel/service buffer");}
      const sameDay=existing.filter(b=>dateKey(b.scheduledStart,input.cityId)===dateKey(occurrence.start,input.cityId)).length;
      if(sameDay>=(provider.maxDailyJobs??6)){eligible=false;reasons.push(`Daily job limit ${provider.maxDailyJobs??6} reached`);}
    }
  }
  if(eligible)reasons.push(overnight?"Availability and date-range capacity locked":"Roster, conflicts, travel buffer and daily limit passed");
  const score=provider.qualityScore+(provider.model==="full_time"?5:0)+(provider.id===input.preferredProviderId?20:0)+(provider.id===input.repeatProviderId?12:0);
  return {providerId:provider.id,providerName:provider.name,eligible,score,reasons};
}

export async function schedule(repository:PlatformRepository,input:ScheduleRequest):Promise<ScheduleDecision>{
  const occurrences=buildOccurrences(input); const candidates=await repository.listEligibleProviders(input.cityId,input.zoneId,input.serviceCode); const pets=await petsFor(repository,input.petIds);
  const evaluations=await Promise.all(candidates.map(p=>evaluateProvider(repository,p,input,occurrences,pets)));
  const ranked=evaluations.filter(e=>e.eligible).sort((a,b)=>b.score-a.score); const selectedEval=ranked[0]; const provider=selectedEval?candidates.find(p=>p.id===selectedEval.providerId)??null:null;
  const shortlist=ranked.slice(0,3).map(item=>({provider:candidates.find(p=>p.id===item.providerId)!,score:item.score,reasons:item.reasons}));
  if(!provider)return {provider:null,mode:"manual_review",occurrences,evaluations,shortlist:[],explanation:["No provider passed every scheduling rule","Booking retained for Ops intervention"]};
  const override=Boolean(input.manualProviderId&&input.manualOverrideReason); const mode=override?"automatic":provider.model==="full_time"?"automatic":"offer";
  return {provider,mode,occurrences,evaluations,shortlist,offerExpiresAt:mode==="offer"?new Date(Date.now()+3*msMinute).toISOString():undefined,explanation:[`${scheduleRules[input.serviceCode].label} rule pack passed`,`${occurrences.length} occurrence${occurrences.length===1?"":"s"} reserved with one provider`,...selectedEval!.reasons,override?`Ops override: ${input.manualOverrideReason}`:provider.model==="full_time"?"Full-time provider auto-assigned":"Commission provider receives a 3-minute offer"]};
}

export async function listScheduleSlots(repository:PlatformRepository,input:Omit<ScheduleRequest,"petIds"|"scheduledStart"|"scheduledEnd">&{date:string;petIds?:string[]}):Promise<Array<{start:string;end:string;available:boolean;eligibleProviders:number;reason?:string}>>{
  const duration=scheduleRules[input.serviceCode].durationMinutes; const slots=[];
  for(let hour=9;hour<19;hour+=input.serviceCode==="grooming"?2:1){
    const localStart=new Date(`${input.date}T${String(hour).padStart(2,"0")}:00:00.000Z`); const start=new Date(localStart.getTime()-cityOffsetMinutes(input.cityId)*msMinute).toISOString(); const end=new Date(new Date(start).getTime()+duration*msMinute).toISOString();
    const decision=await schedule(repository,{...input,petIds:input.petIds??[],scheduledStart:start,scheduledEnd:end}); const eligible=decision.evaluations.filter(e=>e.eligible).length;
    slots.push({start,end,available:eligible>0,eligibleProviders:eligible,reason:eligible?undefined:"Roster, conflict, radius or capacity unavailable"});
  }
  return slots;
}
