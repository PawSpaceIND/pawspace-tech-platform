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
import{ensureProviderCommissionTables}from"./provider-commission-governance";
import{ensureProviderCapacityTables}from"./provider-capacity-governance";
import{PHOTO_PROOF_PURPOSE,MEDIA_REF_PREFIX}from"./care-proof-photo-claims";
import{serviceProofRefusal}from"./service-media-security";
import{GOVERNED_CLIENT_ERROR}from"./governed-http-error";
import{chunkedIn}from"./d1-chunked-in";

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


/**
 * A caller-safe refusal. It stays an Error (this module signals with Errors throughout), and it is
 * BRANDED so lib/server-auth's authError bridges it into a 4xx carrying this message instead of the
 * blanket 500 "Provider workspace update failed" the partner used to get for a perfectly explicable
 * refusal. See lib/governed-http-error.ts - the brand is a registry symbol nothing acquires by
 * accident, so an incidental `statusCode` on some fetch/undici error still cannot reach a caller.
 */
function proofRefusal(message:string,status=409){
 return Object.assign(new Error(message),{[GOVERNED_CLIENT_ERROR]:true,statusCode:status});
}

/**
 * A proof may only claim media that is RELEASED and genuinely this provider's, for this booking.
 *
 * "Released" is not this module's opinion. It is lib/service-media-security's serviceProofRefusal -
 * the same predicate assertServiceProofRef enforces on grooming add_proof/complete and the same one
 * app/api/service-media/route.ts reports as proofReady. This function used to carry a PRIVATE COPY of
 * it that still demanded scan_status='clean'. lib/media-upload-boundary's reviewMedia deliberately
 * stopped writing 'clean' when a human approves (a person's approval is not a scan result); release
 * is now recorded as review_status='approved' + access_status='ready' + a release_basis. So a fully
 * approved, released asset read back as scan_status='pending' here and `submit_proof` refused every
 * photo it was ever offered - for grooming before/after, boarding daily_photo and sitting
 * visit_photo alike, since PHOTO_PROOF_PURPOSE covers all four. One authority, three readers; no
 * fourth copy. [PTJA-W3-SC]
 *
 * The scanner floor still applies, because it is inside serviceProofRefusal: a file a scanner
 * condemned cannot be proof even if something else marked it ready.
 *
 * Pass expectedPurpose to require a specific purpose; pass null to verify a reference that rode along
 * on a proof which makes no photo claim, where any stored purpose is acceptable.
 */
async function requireStoredMedia(db:Db,input:{providerId:string;bookingId:string;objectId?:string|null},expectedPurpose:string|null,label:string){
 const ref=text(input.objectId),mediaId=ref.startsWith(MEDIA_REF_PREFIX)?ref.slice(MEDIA_REF_PREFIX.length):"";
 if(!mediaId)throw proofRefusal(`${label} must use a registered private media reference`,400);
 // SELECT * on purpose: the release columns are additive (see ensureServiceMediaTable), and a row
 // read without them must reach the authority as "nothing recorded" - which it refuses - rather than
 // as a query error this function would have to interpret for itself.
 const asset=await db.prepare("SELECT * FROM service_media_assets WHERE id=?").bind(mediaId).first<Row>().catch(()=>null);
 if(!asset)throw proofRefusal(`${label} is not storage-confirmed and scan-approved: no such registered media asset`);
 if(text(asset.booking_id)!==input.bookingId||text(asset.provider_id)!==input.providerId)throw proofRefusal(`${label} is not storage-confirmed and scan-approved: that asset belongs to another booking or provider`,403);
 if(expectedPurpose!==null&&text(asset.purpose)!==expectedPurpose)throw proofRefusal(`${label} is not storage-confirmed and scan-approved: that asset was registered as '${text(asset.purpose)||"unknown"}', not '${expectedPurpose}'`);
 const refusal=serviceProofRefusal(asset);
 if(refusal)throw proofRefusal(`${label} is not storage-confirmed and scan-approved: ${refusal}`);
}

export async function ensureProviderWorkspaceTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS provider_job_offers (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,booking_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',offered_at INTEGER NOT NULL,responded_at INTEGER,expires_at INTEGER,detail_json TEXT NOT NULL DEFAULT '{}',UNIQUE(provider_id,booking_id))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_job_offers_provider ON provider_job_offers(provider_id,status)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_job_proofs (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,proof_type TEXT NOT NULL,object_id TEXT,note TEXT,distance_km REAL,created_at INTEGER NOT NULL,UNIQUE(booking_id,proof_type))"),
 db.prepare("CREATE TABLE IF NOT EXISTS customer_job_updates (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL,update_type TEXT NOT NULL,message TEXT NOT NULL,object_id TEXT,created_at INTEGER NOT NULL)"),
]);}

function jsonList(value:unknown){try{const parsed=JSON.parse(text(value));return Array.isArray(parsed)?parsed.map(text):[];}catch{return new Array<string>();}}

/**
 * The workspace offer is a canonical assignment boundary, not a notification shortcut.  Re-check
 * the governed roster and the booking window here so callers cannot manufacture an offer for an
 * inactive/out-of-scope provider or bypass capacity after the scheduler has made its choice.
 */
async function assertOfferEligibility(db:Db,providerId:string,bookingId:string){
 await ensureProviderCapacityTables(db);
 const booking=await db.prepare("SELECT id,provider_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 if(!booking)throw new Error("Booking not found");
 if(["cancelled","completed"].includes(text(booking.status)))throw new Error("Completed or cancelled booking cannot be offered");
 const assigned=text(booking.provider_id);
 if(assigned&&assigned!=="unassigned"&&assigned!==providerId)throw new Error("Booking is already assigned to another provider");
 const profile=await db.prepare("SELECT city_id,services_json,zones_json,live,status,capacity FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
 if(!profile||num(profile.live)!==1||text(profile.status)!=="active")throw new Error("Provider is not active in the governed roster");
 if(text(profile.city_id)!==text(booking.city_id))throw new Error("Provider is not eligible for this booking city");
 if(!jsonList(profile.services_json).includes(text(booking.service_code)))throw new Error("Provider is not eligible for this booking service");
 if(!jsonList(profile.zones_json).includes(text(booking.zone_id)))throw new Error("Provider is not eligible for this booking zone");
 const unavailable=await db.prepare("SELECT id FROM provider_unavailability WHERE provider_id=? AND status='active' AND starts_at<? AND ends_at>? LIMIT 1")
  .bind(providerId,text(booking.scheduled_end),text(booking.scheduled_start)).first<Row>();
 if(unavailable)throw new Error("Provider is unavailable for this booking window");
 const overlapping=await db.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE provider_id=? AND id!=? AND status NOT IN ('cancelled','completed','draft','failed') AND scheduled_start<? AND scheduled_end>?")
  .bind(providerId,bookingId,text(booking.scheduled_end),text(booking.scheduled_start)).first<Row>();
 if(num(overlapping?.n)>=Math.max(1,num(profile.capacity)))throw new Error("Provider capacity is exhausted for this booking window");
 return booking;
}

/**
 * Resolve the provider bound to this identity. Own-record only.
 *
 * Two identities reach here. A staff login carries an address and is resolved through the legacy
 * provider_identity_links table, which is seeded per environment. A provider-scoped platform session
 * carries no address at all: resolvePrimaryActor sets its email to the session auditId, which is
 * `${subject_type}:${subject_id}`. That binding was already proven active and verified by
 * resolvePlatformSession before the actor existed, so for a provider session the subject IS the link
 * and no table lookup can improve on it -- the seeded table holds staff addresses only, so such a
 * session would otherwise read as unlinked and the Partner App workspace would 403 after a UAT
 * provider switch. Matched before lowercasing, because a provider id is not case-folded.
 */
export async function resolveProviderForActor(db:Db,email:string):Promise<string|null>{
 const raw=text(email);if(!raw)return null;
 const session=/^provider:(.+)$/.exec(raw);
 if(session)return text(session[1])||null;
 const e=raw.toLowerCase();
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
 const expectedPurpose=PHOTO_PROOF_PURPOSE[text(booking.service_code)]?.[text(input.proofType)];
 if(expectedPurpose)await requireStoredMedia(db,input,expectedPurpose,`${text(input.proofType).replace(/_/g," ")} proof`);
 /* A proof type that makes no photo claim may still carry an objectId, and that reference is copied
  * into the customer update verbatim. An unverified one would be a second way to point a customer at
  * an asset that was never stored, so a media reference is checked wherever it appears. */
 else if(text(input.objectId).startsWith(MEDIA_REF_PREFIX))await requireStoredMedia(db,input,null,`${text(input.proofType).replace(/_/g," ")} proof`);
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

/**
 * Where a vertical's OWN completion flow records the proof it collected, and which column answers
 * which PROOF_REQUIREMENTS stage.
 *
 * Grooming is here because that is where the Partner app's real proof path writes: `add_proof` on
 * /api/grooming-lifecycle stores the approved media refs in grooming_service_proof, gated by
 * assertServiceProofRef, and `complete` refuses without both of them. provider_job_proofs is written
 * only by submitJobProof (this module's /api/provider-workspace submit_proof). They are two stores
 * for one fact and nothing reconciled them, so a grooming job completed the normal way - Ops-approved
 * before and after photos, invoice issued - still reported "missing before photo, after photo" on
 * BOTH partner earnings screens, under copy that tells the partner their settlement is held.
 *
 * Read, not written: nothing here moves proof between the stores. A stage counts as posted if EITHER
 * store records it. [partner settlement proof reconciliation]
 */
const LIFECYCLE_PROOF_STORES:Record<string,{table:string;stages:Record<string,string>}>={
 grooming:{table:"grooming_service_proof",stages:{before_photo:"before_photo_ref",after_photo:"after_photo_ref"}},
};

/**
 * Proof stages a provider still owes on these jobs, reconciled across every store that records one.
 * Cold-DB safe (a missing table reads as "nothing recorded there"), and two queries per store rather
 * than one per booking, so it does not get more expensive as a partner's history grows.
 */
export async function outstandingProof(db:Db,jobs:Array<{bookingId:string;serviceCode:string}>){
 const outstanding:Array<{bookingId:string;serviceCode:string;missing:string[]}>=[];
 const scored=jobs.filter(job=>(PROOF_REQUIREMENTS[text(job.serviceCode)]||[]).length>0);
 if(!scored.length)return outstanding;
 const posted=new Map<string,Set<string>>();
 const remember=(bookingId:string,stage:string)=>{if(!bookingId||!stage)return;const seen=posted.get(bookingId)??new Set<string>();seen.add(stage);posted.set(bookingId,seen);};
 // D1 refuses a statement carrying more than ~100 bound parameters. Both reads below go through the
 // one shared chunker (lib/d1-chunked-in.ts) rather than a second hand-rolled pager, so there is a
 // single place where the cap is defined. tests/d1-in-clause-fanout.test.mjs pins that.
 const safeChunked=(ids:string[],sql:(placeholders:string)=>string)=>chunkedIn(ids,(chunk,placeholders)=>db.prepare(sql(placeholders)).bind(...chunk).all<Row>().then(result=>result.results).catch(()=>[] as Row[]));
 for(const row of await safeChunked(scored.map(job=>job.bookingId),placeholders=>`SELECT booking_id,proof_type FROM provider_job_proofs WHERE booking_id IN (${placeholders})`))remember(text(row.booking_id),text(row.proof_type));
 for(const[serviceCode,store]of Object.entries(LIFECYCLE_PROOF_STORES)){
  const stages=Object.entries(store.stages);
  const rows=await safeChunked(scored.filter(job=>text(job.serviceCode)===serviceCode).map(job=>job.bookingId),placeholders=>`SELECT booking_id,${stages.map(([,column])=>column).join(",")} FROM ${store.table} WHERE booking_id IN (${placeholders})`);
  for(const row of rows)for(const[stage,column]of stages)if(text(row[column]))remember(text(row.booking_id),stage);
 }
 for(const job of scored){
  const seen=posted.get(job.bookingId)??new Set<string>();
  const missing=(PROOF_REQUIREMENTS[text(job.serviceCode)]||[]).filter(stage=>!seen.has(stage));
  if(missing.length)outstanding.push({bookingId:job.bookingId,serviceCode:job.serviceCode,missing});
 }
 return outstanding;
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
 await ensureProviderWorkspaceTables(db);await ensureProviderCommissionTables(db);
 const providerId=text(input.providerId),engagement=await resolveEngagementForWorker(db,{providerId}),features=featuresFor(engagement);
 const[bookings,offers,earnings,settlements,incentives,link,commissionOrders,commissionPayouts,partnerStatements]=await Promise.all([
  bookingsForProvider(db,providerId),
  db.prepare("SELECT o.booking_id,o.offered_at,o.expires_at,o.status,b.service_code,b.package_name,b.scheduled_start,b.total_amount FROM provider_job_offers o JOIN canonical_bookings b ON b.id=o.booking_id WHERE o.provider_id=? AND o.status='offered' AND (o.expires_at IS NULL OR o.expires_at>?) ORDER BY o.offered_at DESC LIMIT 50").bind(providerId,Date.now()).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT COALESCE(SUM(provider_net_payout),0) net,COUNT(*) orders,COALESCE(SUM(order_value),0) gross FROM provider_payout_computations WHERE provider_id=?").bind(providerId).first<Row>().catch(()=>null),
  db.prepare("SELECT booking_id,gross_booking_amount,payout_amount,status,eligible_after,rule_version,reason,updated_at FROM provider_settlement_readiness WHERE provider_id=? ORDER BY updated_at DESC LIMIT 100").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT month_start,status,result_json,finalized_at FROM groomer_incentive_results WHERE head_groomer_id=? ORDER BY month_start DESC LIMIT 12").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT status FROM provider_identity_links WHERE provider_id=? LIMIT 1").bind(providerId).first<Row>().catch(()=>null),
  db.prepare("SELECT booking_id,service_code,order_amount,commission_mode,commission_value,commission_amount,commission_source,status,completed_at,due_at FROM provider_order_commissions WHERE provider_id=? ORDER BY completed_at DESC LIMIT 100").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT id,booking_id,amount,status,due_at,provider_reference,created_at,updated_at FROM provider_order_payouts WHERE provider_id=? ORDER BY created_at DESC LIMIT 100").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT id,period_code,earned_amount,adjustment_amount,payable_amount,status,policy_status,source_json,updated_at FROM partner_settlement_statements WHERE provider_id=? ORDER BY period_code DESC LIMIT 24").bind(providerId).all<Row>().catch(()=>({results:[] as Row[]})),
 ]);
 const pendingProof=await outstandingProof(db,bookings.past.slice(0,40));
 const contractEarnings={netPayout:money(earnings?.net),orders:num(earnings?.orders),grossOrderValue:money(earnings?.gross),visible:true,computed:{netPayout:money(earnings?.net),orders:num(earnings?.orders),grossOrderValue:money(earnings?.gross)},settlements:settlements.results.map(row=>({bookingId:text(row.booking_id),grossBookingAmount:money(row.gross_booking_amount),payoutAmount:row.payout_amount==null?null:money(row.payout_amount),status:text(row.status),eligibleAfter:num(row.eligible_after),ruleVersion:row.rule_version?text(row.rule_version):null,reason:text(row.reason),updatedAt:num(row.updated_at)})),incentives:incentives.results.map(row=>{let result:Record<string,unknown>={};try{result=JSON.parse(text(row.result_json)||"{}")}catch{}return{monthStart:text(row.month_start),status:text(row.status),headTotal:money(result.headTotal),helperTotal:money(result.helperTotal),monthTotal:money(result.monthTotal),finalizedAt:row.finalized_at?num(row.finalized_at):null}}),statements:partnerStatements.results,note:"Contract earnings are governed provider earnings, not employee salary payroll. Attendance and leave live in the People view."};
 const commissionRows=commissionOrders.results.map(row=>({bookingId:text(row.booking_id),serviceCode:text(row.service_code),orderAmount:money(row.order_amount),commissionMode:text(row.commission_mode),commissionValue:num(row.commission_value),commissionAmount:money(row.commission_amount),source:text(row.commission_source),status:text(row.status),completedAt:num(row.completed_at),dueAt:num(row.due_at)}));
 const commissionEarnings={visible:true,netPayout:money(commissionRows.reduce((sum,row)=>sum+row.commissionAmount,0)),orders:commissionRows.length,grossOrderValue:money(commissionRows.reduce((sum,row)=>sum+row.orderAmount,0)),computed:{commissionAmount:money(commissionRows.reduce((sum,row)=>sum+row.commissionAmount,0)),orders:commissionRows.length},commissionOrders:commissionRows,payouts:commissionPayouts.results.map(row=>({id:text(row.id),bookingId:text(row.booking_id),amount:money(row.amount),status:text(row.status),dueAt:num(row.due_at),providerReference:row.provider_reference?text(row.provider_reference):null,updatedAt:num(row.updated_at)})),statements:partnerStatements.results,note:"Commission statement is visible to the provider from governed order commissions and payout state; approval and live payout remain Finance-controlled."};
 return{providerId,engagement,features,onboardingStatus:link?text(link.status):"not_linked",bookings,liveAssignments:offers.results.map(o=>({bookingId:text(o.booking_id),serviceCode:text(o.service_code),package:text(o.package_name),start:text(o.scheduled_start),orderValue:money(o.total_amount),offeredAt:num(o.offered_at),expiresAt:o.expires_at?num(o.expires_at):null})),earnings:engagement==="commission"?commissionEarnings:contractEarnings,pendingProof,truth:{ownRecordOnly:true,liveMoney:false,mediaByReference:true,earningsFromGovernedLedgersOnly:true,commissionStatementVisible:engagement==="commission",contractSalaryPayrollExcluded:engagement==="contract",productionReady:false}};
}
