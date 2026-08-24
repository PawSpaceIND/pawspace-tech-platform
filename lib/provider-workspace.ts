/**
 * Provider workspace - the data behind the PARTNER app (contract workers) and the COMMISSION dashboard
 * (pure commission providers). Everything here resolves to the signed-in provider's OWN record and shows
 * only their own jobs, offers, payments and (for contract workers) earnings. What renders is decided by
 * the workforce engagement kind:
 *   - contract   : earnings + payslip/leave/advance/incentive live in the employee side; here they also get
 *                  jobs, live assignments, proof/tracking duties, petrol + cash stats.
 *   - commission : NO payslip/leave/advance. Only their dashboard - bookings, future bookings, payment
 *                  pending/status, onboarding status, live assignments to accept - plus proof/tracking.
 *
 * Live assignments: a job is OFFERED to a provider; they accept or decline (first accept wins). Proof:
 * the provider uploads stage proof (before/after photo, medication, food, walk route, reached, completed)
 * which is MIRRORED to a customer-visible update so the customer app shows the same thing, and drives the
 * "proof still pending" reminders. Sandbox/UAT - no live money, media stored by reference only.
 */
import{resolveEngagementForWorker,featuresFor}from"./workforce-classification";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/** Proof each service expects. Config-driven so a service's required stages can change without code edits elsewhere. */
export const PROOF_REQUIREMENTS:Record<string,string[]>={
 grooming:["before_photo","after_photo"],
 dog_training:["reached","completed"],
 boarding:["medication","food","daily_photo"],
 pet_sitting:["medication","food","visit_photo"],
 dog_walking:["walk_route","completed"],
 pet_taxi:["reached","completed"],
};

export async function ensureProviderWorkspaceTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS provider_job_offers (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,booking_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',offered_at INTEGER NOT NULL,responded_at INTEGER,expires_at INTEGER,detail_json TEXT NOT NULL DEFAULT '{}',UNIQUE(provider_id,booking_id))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_job_offers_provider ON provider_job_offers(provider_id,status)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_job_proofs (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,proof_type TEXT NOT NULL,object_id TEXT,note TEXT,distance_km REAL,created_at INTEGER NOT NULL,UNIQUE(booking_id,proof_type))"),
 db.prepare("CREATE TABLE IF NOT EXISTS customer_job_updates (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL,update_type TEXT NOT NULL,message TEXT NOT NULL,object_id TEXT,created_at INTEGER NOT NULL)"),
]);}

function jsonList(value:unknown){try{const parsed=JSON.parse(text(value));return Array.isArray(parsed)?parsed.map(text):[];}catch{return[];}}

/**
 * The workspace offer is a canonical assignment boundary, not a notification shortcut.  Re-check
 * the governed roster and the booking window here so callers cannot manufacture an offer for an
 * inactive/out-of-scope provider or bypass capacity after the scheduler has made its choice.
 */
async function assertOfferEligibility(db:Db,providerId:string,bookingId:string){
 const booking=await db.prepare("SELECT id,provider_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 if(!booking)throw new Error("Booking not found");
 if(["cancelled","completed"].includes(text(booking.status)))throw new Error("Completed or cancelled booking cannot be offered");
 const assigned=text(booking.provider_id);
 if(assigned&&assigned!=="unassigned"&&assigned!==providerId)throw new Error("Booking is already assigned to another provider");
 const profile=await db.prepare("SELECT city_id,services_json,zones_json,live,status,capacity FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>().catch(()=>null);
 if(!profile||num(profile.live)!==1||text(profile.status)!=="active")throw new Error("Provider is not active in the governed roster");
 if(text(profile.city_id)!==text(booking.city_id))throw new Error("Provider is not eligible for this booking city");
 if(!jsonList(profile.services_json).includes(text(booking.service_code)))throw new Error("Provider is not eligible for this booking service");
 if(!jsonList(profile.zones_json).includes(text(booking.zone_id)))throw new Error("Provider is not eligible for this booking zone");
 const unavailable=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1")
  .bind(providerId,text(booking.scheduled_end),text(booking.scheduled_start)).first<Row>().catch(()=>null);
 if(unavailable)throw new Error("Provider is unavailable for this booking window");
 const overlapping=await db.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE provider_id=? AND id!=? AND status NOT IN ('cancelled','completed','draft','failed') AND scheduled_start<? AND scheduled_end>?")
  .bind(providerId,bookingId,text(booking.scheduled_end),text(booking.scheduled_start)).first<Row>();
 if(num(overlapping?.n)>=Math.max(1,num(profile.capacity)))throw new Error("Provider capacity is exhausted for this booking window");
 return booking;
}

/** Resolve the provider bound to this identity (legacy provider_identity_links). Own-record only. */
export async function resolveProviderForActor(db:Db,email:string):Promise<string|null>{
 const e=text(email).toLowerCase();if(!e)return null;
 const link=await db.prepare("SELECT provider_id,status FROM provider_identity_links WHERE email=? AND status='active'").bind(e).first<Row>().catch(()=>null);
 return link?text(link.provider_id):null;
}

const CUSTOMER_MESSAGE:Record<string,string>={
 before_photo:"Your groomer has shared a before photo.",after_photo:"Grooming complete - your after photo is ready.",
 reached:"Your service provider has reached the location.",completed:"Your service is complete.",
 medication:"Medication has been given and logged.",food:"Your pet has been fed and it's logged.",
 daily_photo:"A new daily photo of your pet is available.",visit_photo:"A visit photo has been shared.",
 walk_route:"Your dog's walk route has been recorded.",
};

/** Provider submits stage proof; it is mirrored to a customer-visible update so the customer app shows the same. */
export async function submitJobProof(db:Db,input:{providerId:string;bookingId:string;proofType:string;objectId?:string|null;note?:string|null;distanceKm?:number|null}){
 await ensureProviderWorkspaceTables(db);
 const booking=await db.prepare("SELECT id,customer_id,provider_id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Booking not found");
 if(text(booking.provider_id)!==text(input.providerId))throw new Error("This booking is not assigned to you");
 const allowed=PROOF_REQUIREMENTS[text(booking.service_code)]||["reached","completed"];
 if(!allowed.includes(text(input.proofType)))throw new Error(`Proof type '${input.proofType}' is not expected for ${text(booking.service_code)}`);
 if(text(booking.service_code)==="grooming"&&["before_photo","after_photo"].includes(text(input.proofType))){
  const expectedPurpose=text(input.proofType)==="before_photo"?"before_service":"after_service",ref=text(input.objectId),mediaId=ref.startsWith("media://asset/")?ref.slice("media://asset/".length):"";
  if(!mediaId)throw new Error("Grooming photo proof must use a registered private media reference");
  const asset=await db.prepare("SELECT booking_id,provider_id,purpose,scan_status,access_status,retention_status,synthetic FROM service_media_assets WHERE id=?").bind(mediaId).first<Row>().catch(()=>null);
  if(!asset||text(asset.booking_id)!==input.bookingId||text(asset.provider_id)!==input.providerId||text(asset.purpose)!==expectedPurpose||text(asset.scan_status)!=="clean"||text(asset.access_status)!=="ready"||text(asset.retention_status)!=="active"||num(asset.synthetic)!==0)throw new Error("Grooming photo proof is not storage-confirmed and scan-approved");
 }
 const now=Date.now();
 await db.prepare("INSERT INTO provider_job_proofs (id,booking_id,provider_id,proof_type,object_id,note,distance_km,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(booking_id,proof_type) DO UPDATE SET object_id=excluded.object_id,note=excluded.note,distance_km=excluded.distance_km,created_at=excluded.created_at")
  .bind(uid("PRF"),input.bookingId,input.providerId,text(input.proofType),text(input.objectId)||null,text(input.note)||null,input.distanceKm==null?null:Number(input.distanceKm),now).run();
 await db.prepare("INSERT INTO customer_job_updates (id,customer_id,booking_id,update_type,message,object_id,created_at) VALUES (?,?,?,?,?,?,?)")
  .bind(uid("CJU"),text(booking.customer_id),input.bookingId,text(input.proofType),CUSTOMER_MESSAGE[text(input.proofType)]||"Your service provider posted an update.",text(input.objectId)||null,now).run();
 return{bookingId:input.bookingId,proofType:input.proofType,mirroredToCustomer:true};
}

/** Offer a job to a provider (live assignment). */
export async function offerJobToProvider(db:Db,input:{providerId:string;bookingId:string;expiresAt?:number|null}){
 await ensureProviderWorkspaceTables(db);
 await assertOfferEligibility(db,text(input.providerId),text(input.bookingId));
 const now=Date.now();
 const inserted=await db.prepare("INSERT INTO provider_job_offers (id,provider_id,booking_id,status,offered_at,expires_at) VALUES (?,?,?,'offered',?,?) ON CONFLICT(provider_id,booking_id) DO NOTHING")
  .bind(uid("OFR"),input.providerId,input.bookingId,now,input.expiresAt??null).run();
 if(num(inserted.meta?.changes)===0){
  const prior=await db.prepare("SELECT status FROM provider_job_offers WHERE provider_id=? AND booking_id=?").bind(input.providerId,input.bookingId).first<Row>();
  if(text(prior?.status)!=="offered")throw new Error("Provider has already responded to this job offer");
 }
 return{providerId:input.providerId,bookingId:input.bookingId,status:"offered",duplicatePrevented:num(inserted.meta?.changes)===0};
}

/** Provider accepts or declines a live assignment. First accept wins; a decline frees it. */
export async function respondToJobOffer(db:Db,input:{providerId:string;bookingId:string;accept:boolean}){
 await ensureProviderWorkspaceTables(db);
 const offer=await db.prepare("SELECT * FROM provider_job_offers WHERE provider_id=? AND booking_id=? AND status='offered'").bind(input.providerId,input.bookingId).first<Row>();
 if(!offer)throw new Error("No open offer for this job");
 const now=Date.now();
 if(offer.expires_at!=null&&num(offer.expires_at)<=now){
  await db.prepare("UPDATE provider_job_offers SET status='expired',responded_at=? WHERE provider_id=? AND booking_id=? AND status='offered'").bind(now,input.providerId,input.bookingId).run();
  throw new Error("This job offer has expired");
 }
 if(input.accept){
  const already=await db.prepare("SELECT id FROM provider_job_offers WHERE booking_id=? AND status='accepted'").bind(input.bookingId).first<Row>();
  if(already)throw new Error("This job has already been accepted by another provider");
  const booking=await db.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if(!booking)throw new Error("Booking not found");
  const assigned=text(booking.provider_id);
  if(assigned&&assigned!=="unassigned"&&assigned!==text(input.providerId))throw new Error("Booking is already assigned to another provider");
  await assertOfferEligibility(db,text(input.providerId),text(input.bookingId));
  const results=await db.batch([
   db.prepare("UPDATE provider_job_offers SET status='accepted',responded_at=? WHERE provider_id=? AND booking_id=? AND status='offered' AND (expires_at IS NULL OR expires_at>?) AND NOT EXISTS (SELECT 1 FROM provider_job_offers winner WHERE winner.booking_id=? AND winner.status='accepted') AND EXISTS (SELECT 1 FROM canonical_bookings b WHERE b.id=? AND (b.provider_id IS NULL OR b.provider_id='' OR b.provider_id='unassigned'))").bind(now,input.providerId,input.bookingId,now,input.bookingId,input.bookingId),
   db.prepare("UPDATE canonical_bookings SET provider_id=?,updated_at=? WHERE id=? AND (provider_id IS NULL OR provider_id='' OR provider_id='unassigned') AND EXISTS (SELECT 1 FROM provider_job_offers o WHERE o.booking_id=? AND o.provider_id=? AND o.status='accepted')").bind(input.providerId,now,input.bookingId,input.bookingId,input.providerId),
  ]);
  if(num(results[0]?.meta?.changes)!==1||num(results[1]?.meta?.changes)!==1)throw new Error("This job has already been accepted or assigned");
  return{bookingId:input.bookingId,status:"accepted"};
 }
 await db.prepare("UPDATE provider_job_offers SET status='declined',responded_at=? WHERE provider_id=? AND booking_id=? AND status='offered'").bind(now,input.providerId,input.bookingId).run();
 return{bookingId:input.bookingId,status:"declined"};
}

async function bookingsForProvider(db:Db,providerId:string){
 const rows=await db.prepare("SELECT b.id,b.customer_id,b.service_code,b.package_name,b.scheduled_start,b.scheduled_end,b.status,b.total_amount,p.status pay_status,p.amount_due_now,p.method pay_method FROM canonical_bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id WHERE b.provider_id=? ORDER BY b.scheduled_start DESC LIMIT 100").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]}));
 const nowIso=new Date().toISOString();
 const map=(r:Row)=>({bookingId:text(r.id),customerId:text(r.customer_id),serviceCode:text(r.service_code),package:text(r.package_name),start:text(r.scheduled_start),end:text(r.scheduled_end),status:text(r.status),orderValue:money(r.total_amount),paymentStatus:r.pay_status?text(r.pay_status):"none",paymentDueNow:money(r.amount_due_now),paymentMethod:r.pay_method?text(r.pay_method):null});
 const all=rows.results.map(map);
 return{
  upcoming:all.filter(b=>b.start>=nowIso&&!["completed","cancelled"].includes(b.status)),
  today:all.filter(b=>b.start.slice(0,10)===nowIso.slice(0,10)),
  past:all.filter(b=>b.start<nowIso||["completed","cancelled"].includes(b.status)),
  paymentPending:all.filter(b=>["created","pending","failed","partial"].includes(b.paymentStatus)||b.paymentDueNow>0),
 };
}

/** The full workspace payload for a provider (partner app / commission dashboard). Cold-DB safe. */
export async function providerWorkspace(db:Db,input:{providerId:string}){
 await ensureProviderWorkspaceTables(db);
 const providerId=text(input.providerId);
 const engagement=await resolveEngagementForWorker(db,{providerId});
 const features=featuresFor(engagement);
 const[bookings,offers,earnings,settlements,incentives,link]=await Promise.all([
  bookingsForProvider(db,providerId),
  db.prepare("SELECT o.booking_id,o.offered_at,o.expires_at,o.status,b.service_code,b.package_name,b.scheduled_start,b.total_amount FROM provider_job_offers o JOIN canonical_bookings b ON b.id=o.booking_id WHERE o.provider_id=? AND o.status='offered' AND (o.expires_at IS NULL OR o.expires_at>?) ORDER BY o.offered_at DESC LIMIT 50").bind(providerId,Date.now()).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT COALESCE(SUM(provider_net_payout),0) net,COUNT(*) orders,COALESCE(SUM(order_value),0) gross FROM provider_payout_computations WHERE provider_id=?").bind(providerId).first<Row>().catch(()=>null),
  db.prepare("SELECT booking_id,gross_booking_amount,payout_amount,status,eligible_after,rule_version,reason,updated_at FROM provider_settlement_readiness WHERE provider_id=? ORDER BY updated_at DESC LIMIT 100").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT month_start,status,result_json,finalized_at FROM groomer_incentive_results WHERE head_groomer_id=? ORDER BY month_start DESC LIMIT 12").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT status FROM provider_identity_links WHERE provider_id=? LIMIT 1").bind(providerId).first<Row>().catch(()=>null),
 ]);
 // proof still pending on completed/past jobs → the customer-reminder source
 const pendingProof:Array<{bookingId:string;serviceCode:string;missing:string[]}>=[];
 for(const b of bookings.past.slice(0,40)){
  const required=PROOF_REQUIREMENTS[b.serviceCode]||[];
  if(!required.length)continue;
  const done=await db.prepare("SELECT proof_type FROM provider_job_proofs WHERE booking_id=?").bind(b.bookingId).all<Row>().catch(()=>({results:[] as Row[]}));
  const have=new Set(done.results.map(r=>text(r.proof_type)));
  const missing=required.filter(r=>!have.has(r));
  if(missing.length)pendingProof.push({bookingId:b.bookingId,serviceCode:b.serviceCode,missing});
 }
 return{
  providerId,engagement,features,
  onboardingStatus:link?text(link.status):"not_linked",
  bookings,
  liveAssignments:offers.results.map(o=>({bookingId:text(o.booking_id),serviceCode:text(o.service_code),package:text(o.package_name),start:text(o.scheduled_start),orderValue:money(o.total_amount),offeredAt:num(o.offered_at),expiresAt:o.expires_at?num(o.expires_at):null})),
  earnings:features.payslip?{netPayout:money(earnings?.net),orders:num(earnings?.orders),grossOrderValue:money(earnings?.gross),visible:true,computed:{netPayout:money(earnings?.net),orders:num(earnings?.orders),grossOrderValue:money(earnings?.gross)},settlements:settlements.results.map(row=>({bookingId:text(row.booking_id),grossBookingAmount:money(row.gross_booking_amount),payoutAmount:row.payout_amount==null?null:money(row.payout_amount),status:text(row.status),eligibleAfter:num(row.eligible_after),ruleVersion:row.rule_version?text(row.rule_version):null,reason:text(row.reason),updatedAt:num(row.updated_at)})),incentives:incentives.results.map(row=>{let result:Record<string,unknown>={};try{result=JSON.parse(text(row.result_json)||"{}")}catch{}return{monthStart:text(row.month_start),status:text(row.status),headTotal:money(result.headTotal),helperTotal:money(result.helperTotal),monthTotal:money(result.monthTotal),finalizedAt:row.finalized_at?num(row.finalized_at):null}}),note:"Computed payouts and finalized incentive results; payslip, advance and leave remain in the employee portal."}:{visible:false,netPayout:0,orders:0,grossOrderValue:0,computed:{netPayout:0,orders:0,grossOrderValue:0},settlements:[],incentives:[],note:"Commission providers see only their booking dashboard; governed payouts remain Finance-only."},
  pendingProof,
  truth:{ownRecordOnly:true,liveMoney:false,mediaByReference:true,earningsFromGovernedLedgersOnly:true,productionReady:false},
 };
}
