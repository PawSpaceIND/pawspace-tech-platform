import{chunkedIn}from"./d1-chunked-in";
// Partner Job Feed: one unified, chronological feed of a provider's confirmed customer bookings
// across ALL services, aggregated read-only from the real canonical tables. Founder requirement:
// "once the booking is done the same info has to be updated in the partner app".
// This module NEVER creates tables and NEVER exposes customer contact data (phone/mail/address) —
// the service_provider role sees assigned jobs only (see lib/platform-security.ts).
type Db=D1Database;
type Row=Record<string,unknown>;
const rows=<T=Row>(result:{results?:unknown[]})=>(result.results||[]) as T[];
const DAY_MS=86400000,COMPLETED_WINDOW_MS=14*DAY_MS;

export type PartnerJobGroup="needs_action"|"today"|"upcoming"|"completed";
export type PartnerJob={
  bookingId:string;
  serviceCode:string;
  packageName:string;
  scheduledStart:string;
  scheduledEnd:string;
  petCount:number;
  status:string;
  customerFirstName:string;
  group:PartnerJobGroup;
  needsActionReason:string|null;
  stayId:string|null;
  carePlanStatus:string|null;
  nextSlotStart:string|null;
};
export type PartnerJobFeed={providerId:string;needsAction:PartnerJob[];today:PartnerJob[];upcoming:PartnerJob[];completed:PartnerJob[]};
export type PartnerJobCounts={needsAction:number;today:number;upcoming:number;completed:number;total:number};

// Optional service tables may not exist in every environment — same .catch fallback pattern as
// lib/host-badges.ts. A missing table degrades that enrichment, never the whole feed.
async function safeAll(db:Db,sql:string,bindings:unknown[]=[]){
  try{
    let statement=db.prepare(sql);
    if(bindings.length)statement=statement.bind(...bindings);
    return rows(await statement.all<Row>()).slice();
  }catch{return[] as Row[];}
}

const firstName=(value:unknown)=>{const name=String(value||"").trim();return name?name.split(/\s+/)[0]:"Customer";};
const ts=(value:unknown)=>{const parsed=Date.parse(String(value||""));return Number.isFinite(parsed)?parsed:null;};
const petCountFromJson=(value:unknown)=>{try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)&&parsed.length?parsed.length:1;}catch{return 1;}};

export async function listProviderJobs(db:Db,providerId:string,now=Date.now()):Promise<PartnerJobFeed>{
  const id=String(providerId||"").trim();
  if(!id)throw new Error("providerId is required");

  // Base: canonical bookings assigned to this provider. Read-only — no DDL in this module.
  const bookings=await safeAll(db,"SELECT id,customer_id,service_code,package_code,package_name,schedule_group_id,scheduled_start,scheduled_end,status,pet_ids_json FROM canonical_bookings WHERE provider_id=? ORDER BY scheduled_start ASC LIMIT 500",[id]);

  // Enrichments, each optional. Boarding stays carry the host-facing status + care plan state.
  const stays=await safeAll(db,"SELECT booking_id,id,status,check_in_at,check_out_at,care_plan_status,pet_count FROM boarding_stays WHERE host_provider_id=?",[id]);
  const stayByBooking=new Map<string,Row>();for(const stay of stays)stayByBooking.set(String(stay.booking_id),stay);

  // Walking / taxi occurrence tables: earliest not-yet-finished slot per booking, where they exist.
  const walkRows=await safeAll(db,"SELECT booking_id,scheduled_start FROM walking_sessions WHERE provider_id=? AND status NOT IN ('completed','cancelled') ORDER BY scheduled_start ASC",[id]);
  const taxiRows=await safeAll(db,"SELECT booking_id,scheduled_start FROM taxi_trips WHERE provider_id=? AND status NOT IN ('completed','cancelled') ORDER BY scheduled_start ASC",[id]);
  const nextSlotByBooking=new Map<string,string>();
  for(const row of[...walkRows,...taxiRows]){const key=String(row.booking_id);if(!nextSlotByBooking.has(key))nextSlotByBooking.set(key,String(row.scheduled_start));}

  // Scheduling reservations (keyed by schedule_group_id) as the generic upcoming-slot fallback.
  const reservations=await safeAll(db,"SELECT group_id,scheduled_start FROM scheduling_reservations WHERE provider_id=? AND status NOT IN ('completed','cancelled') ORDER BY scheduled_start ASC",[id]);
  const nextSlotByGroup=new Map<string,string>();
  for(const row of reservations){const key=String(row.group_id);if(!nextSlotByGroup.has(key))nextSlotByGroup.set(key,String(row.scheduled_start));}

  // Customer first names only — this SELECT deliberately reads the name column and nothing else.
  // Partner surfaces must never receive customer contact details (platform rule, service_provider role).
  const customerIds=[...new Set(bookings.map(row=>String(row.customer_id)))].filter(Boolean);
  const nameByCustomer=new Map<string,string>();
  if(customerIds.length){
    for(const row of await chunkedIn(customerIds,(chunk,placeholders)=>safeAll(db,`SELECT id,name FROM canonical_customers WHERE id IN (${placeholders})`,chunk)))nameByCustomer.set(String(row.id),firstName(row.name));
  }

  const reference=new Date(now),startOfToday=new Date(reference.getFullYear(),reference.getMonth(),reference.getDate()).getTime(),endOfToday=startOfToday+DAY_MS;
  const feed:PartnerJobFeed={providerId:id,needsAction:[],today:[],upcoming:[],completed:[]};

  for(const booking of bookings){
    const bookingStatus=String(booking.status||"");
    if(bookingStatus==="cancelled")continue;
    const stay=stayByBooking.get(String(booking.id))||null;
    const stayStatus=stay?String(stay.status||""):null;
    const carePlanStatus=stay?String(stay.care_plan_status||""):null;
    const start=ts(booking.scheduled_start),end=ts(booking.scheduled_end)??start;

    const job:PartnerJob={
      bookingId:String(booking.id),
      serviceCode:String(booking.service_code||""),
      packageName:String(booking.package_name||booking.package_code||""),
      scheduledStart:String(booking.scheduled_start||""),
      scheduledEnd:String(booking.scheduled_end||""),
      petCount:stay?Number(stay.pet_count||1):petCountFromJson(booking.pet_ids_json),
      status:stayStatus||bookingStatus,
      customerFirstName:nameByCustomer.get(String(booking.customer_id))||"Customer",
      group:"upcoming",
      needsActionReason:null,
      stayId:stay?String(stay.id):null,
      carePlanStatus,
      nextSlotStart:nextSlotByBooking.get(String(booking.id))||nextSlotByGroup.get(String(booking.schedule_group_id))||null,
    };

    const stayFinished=stayStatus==="completed"||stayStatus==="cancelled";
    if(bookingStatus==="completed"||stayStatus==="completed"){
      // Completed feed keeps only the last 14 days; older history belongs to reporting, not the job feed.
      const finishedAt=end??start;
      if(finishedAt!==null&&finishedAt>=now-COMPLETED_WINDOW_MS){job.group="completed";feed.completed.push(job);}
      continue;
    }
    if(stayStatus==="cancelled")continue;
    if(stayStatus==="awaiting_host_acceptance"){job.group="needs_action";job.needsActionReason="awaiting_host_acceptance";feed.needsAction.push(job);continue;}
    if(carePlanStatus==="required"&&!stayFinished){job.group="needs_action";job.needsActionReason="care_plan_required";feed.needsAction.push(job);continue;}
    // Today = anything not strictly in the future: starts today, already in progress, or started
    // earlier and never completed — the partner must still see an active/overdue job.
    if(start!==null&&start>=endOfToday){job.group="upcoming";feed.upcoming.push(job);continue;}
    job.group="today";feed.today.push(job);
  }

  const asc=(a:PartnerJob,b:PartnerJob)=>String(a.scheduledStart).localeCompare(String(b.scheduledStart));
  feed.needsAction.sort(asc);feed.today.sort(asc);feed.upcoming.sort(asc);
  feed.completed.sort((a,b)=>String(b.scheduledEnd).localeCompare(String(a.scheduledEnd)));
  return feed;
}

export async function jobCounts(db:Db,providerId:string,now=Date.now()):Promise<PartnerJobCounts>{
  const feed=await listProviderJobs(db,providerId,now);
  return{
    needsAction:feed.needsAction.length,
    today:feed.today.length,
    upcoming:feed.upcoming.length,
    completed:feed.completed.length,
    total:feed.needsAction.length+feed.today.length+feed.upcoming.length+feed.completed.length,
  };
}
