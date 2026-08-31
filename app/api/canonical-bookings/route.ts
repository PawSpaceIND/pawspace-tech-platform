import {subscriptionExpiry} from "../../../lib/grooming-governance";
import{sameInstant}from"../../../lib/booking-window-instant";
import{sandboxCapabilitiesUnlocked}from"../../../lib/payment-environment";
import {governGroomingBookingWithLiveMultiPet} from "../../../lib/live-grooming-governance";
import {authError,requireCustomerOwnership,requirePermission,resolveActor} from "../../../lib/server-auth";
import {hasPermission} from "../../../lib/platform-security";
import {policySnapshot,policyVersion,resolveGroomingPolicy} from "../../../lib/grooming-policy-governance";
import {consumeTrainingQuote,governTrainingBooking,trainingQuoteLinkStatement} from "../../../lib/training-commercial-governance";
import {boardingQuoteLinkStatement,boardingStayStatement,consumeBoardingQuote,governBoardingBooking} from "../../../lib/boarding-governance";
import {consumeSittingQuote,governSittingBooking,sittingQuoteLinkStatement} from "../../../lib/sitting-governance";
import {requireSittingQuoteSandboxCapture} from "../../../lib/sitting-payment-governance";
import {ensureStayPaymentTables,splitPaymentPlan,staySplitScheduleStatement} from "../../../lib/stay-split-payments";
import {prepareReferralBooking,referralBookingLinkStatement,referralClaimBoundStatement,type ReferralBookingPreparation} from "../../../lib/referral-booking-governance";
import {attributeBookingToOpenLead} from "../../../lib/lead-conversion-attribution";
import {PENDING_PAYMENT_STATUS} from "../../../lib/subscription-payment-activation";
import {BOOKING_REPLAY_CONFLICT,BOOKING_WRITE_CONFLICT,SCHEDULING_GROUP_OWNERSHIP_CONFLICT,findCustomerReplay,hasForeignReplayConflict,hasReplayConflict,isUniqueConstraintError,schedulingGroupBelongsToCustomer} from "../../../lib/booking-replay-governance";
import {prepareCouponBooking,type CouponBookingPreparation} from "../../../lib/coupon-governance";
import {ensureProviderBookingGuard,providerUnavailableForWindow} from "../../../lib/provider-capacity-governance";
import {cleanupExpiredReservationLeases,ensureSchedulingReservationLeaseGovernance} from "../../../lib/scheduling-reservation-leases";
import {postCollectionEvent} from "../../../lib/collection-ledger";
import {cityBookingVerdict} from "../../../lib/city-status-authority";

type LifecycleInput={
  idempotencyKey:string;scheduleGroupId:string;customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  // medicationRequired is a PET fact the customer declares at booking. Boarding host matching needs it:
  // medication handling is a hard constraint only when a pet actually needs medication, so without the
  // signal the constraint can never fire and a host who cannot give medication is matched anyway.
  // [PTJA-W3-BH]
  pets:Array<{sourceId:string;name:string;species?:string;breed?:string;vaccinationStatus?:string;medicationRequired?:boolean}>;cityId:string;zoneId:string;
  serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting";packageCode:string;packageName:string;scheduledStart:string;scheduledEnd:string;
  provider:{id:string;name:string;model:"full_time"|"commission"};totalAmount:number;amountDueNow:number;
  payment:{method:string;mode:string;status:string;detail:string};pricing:{discount:number;couponCode?:string;couponQuoteId?:string;addOns?:string[];subscription?:string;requirements?:string[];trainingQuoteId?:string;trainingCategory?:string;healthSafetyNotes?:string;behaviourNotes?:string;boardingQuoteId?:string;sittingQuoteId?:string;referralClaimId?:string};
};

type SubscriptionPlan={planCode:string;sessions:number;validityValue:number;validityUnit:"days"|"months";reserveSessions:number;servicePackageCode:string;cityId:string;zoneId?:string|null;familyWallet:boolean;pauseDays:number;graceDays:number;renewalWindowDays:number;benefits:unknown[];terms:Record<string,unknown>};
const services=new Set(["grooming","dog_training","boarding","pet_sitting"]);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
// Live UNLESS sandbox is explicitly declared. The verify-first exemption - recording a client-asserted
// {status:"captured"} as collected money - is a sandbox CAPABILITY, and an absent variable is not a
// declaration. Credential and webhook-secret selection keep their documented "unset -> sandbox" default
// (lib/razorpay-client.ts, lib/payment-webhook-gate.ts), so unsetting still takes live money off.
async function liveModePayments(){const {env}=await import("cloudflare:workers");return !sandboxCapabilitiesUnlocked(env as unknown as Record<string,unknown>);}
// Verify-first (LIVE only): an ONLINE booking payment may NOT self-declare "captured"; it is recorded
// "created" and only a signature-verified Razorpay webhook may mark it captured. Sandbox/UAT unchanged.
//
// It FAILS CLOSED on the method. It used to demote only when the mode was one of two spellings, then
// only when the method was on an ONLINE_METHODS allowlist — either way a client-supplied string decided
// whether gateway proof was necessary, so an off-list/unrecognised method (or a different mode) still
// persisted a captured online payment in LIVE. Now, in LIVE, a submitted "captured" is NEVER financial
// truth on the strength of the client's own labels: it is recorded "created" (awaiting verification)
// unless the server has authorized this as an offline collection. `offlineAuthorized` is computed
// server-side from the actor's permission, so no method string a caller can invent — known, unknown or
// blank — can make gateway proof unnecessary. Mode/method are still recorded as submitted.
//
// Nor does it exempt subscriptions any more (that carve-out let a LIVE subscription self-declare capture
// and claim its sessions for one HTTP request). The gate and entitlement were restructured instead (see
// the subscription block below and lib/subscription-payment-activation.ts).
const ONLINE_METHODS=new Set(["upi","card","netbanking","payment_link"]);
// Genuinely offline collections have no gateway to verify against. Keeping their "captured" is a
// server-authorized action (a staff actor holding payments.manage recording e.g. cash), never something
// a client can assert for itself; a customer-app caller never holds the permission, so its submitted
// captured is demoted whatever method it names.
const OFFLINE_METHODS=new Set(["cash"]);
function recordedPaymentStatus(liveMode:boolean,payment:{status:string},offlineAuthorized:boolean){if(liveMode&&payment.status==="captured"&&!offlineAuthorized)return "created";return payment.status;}
// ONE normalizer, shared by the identity check and the resolver, so validation can never accept a
// pair the resolver would then treat as colliding.
const petKey=(value:unknown)=>String(value??"").trim().toLowerCase();
// A source id is identity material, and identity material is hashed with a separator. A caller able
// to embed the separator — or any other control character — could shape one identity's digest into
// another's, so control characters are refused outright rather than escaped.
const CONTROL_CHARACTERS=/[\u0000-\u001F\u007F]/;
/**
 * Pet identity rules for a NEW booking. Deliberately NOT part of validate(): validate() runs before
 * any database access, and these rules must run AFTER the idempotency lookup. Bookings created before
 * these rules existed stay replayable — a matching idempotency key returns its original booking even
 * though its payload would be refused today.
 */
function petIdentityProblem(pets:LifecycleInput["pets"]){
  if(pets.some(pet=>!petKey(pet.sourceId)))return "Every pet needs a source id";
  // The TYPE is checked, not coerced. Everything downstream reaches a source id through String(...),
  // so a non-string arrives at the digest as one identity while the database's type affinity stores a
  // DIFFERENT text for it — 7 hashes as "7" but persists as "7.0". The next booking's identity lookup
  // then misses its own row, mints again, and the occupancy check pushes it to the next variant until
  // the attempt budget is spent and every later booking for that pet fails permanently. Coercing here
  // would paper over that; refusing keeps a malformed request a loud, harmless 400 instead of silent,
  // persistent duplication — exactly what this route exists to prevent.
  //
  // It runs AFTER the blank check on purpose, so null/undefined/[] keep their existing "needs a source
  // id" answer, and BEFORE the control-character and duplicate rules, which both read the value as text.
  if(pets.some(pet=>typeof pet.sourceId!=="string"))return "A pet source id must be text";
  if(pets.some(pet=>CONTROL_CHARACTERS.test(String(pet.sourceId??""))))return "A pet source id cannot contain control characters";
  const sourceKeys=pets.map(pet=>petKey(pet.sourceId));
  // Two entries sharing a source id name the same animal twice: binding both to one row makes a
  // two-pet booking record one animal, minting a second fabricates a pet the customer does not own.
  if(new Set(sourceKeys).size!==sourceKeys.length)return "Each pet in this booking needs its own source id";
  return null;
}
const PET_ID_SEPARATOR="\u0000";
/** How many deterministic ids one pet may be offered before the booking fails closed. */
const MAX_PET_ID_ATTEMPTS=8;
/**
 * A NEW pet's canonical id, derived purely from the normalized customer and source identity.
 *
 * Suffix-on-collision needed a read before the write, which is check-then-act: two concurrent bookings
 * both saw a candidate free, both took it, and one pet was silently absorbed into the other. A digest
 * needs no read to be CORRECT — the same identity always yields the same id, so concurrent bookings
 * converge, and different identities differ even when they sanitize alike.
 *
 * attempt 0 is the primary id. Later attempts are domain-separated by PREFIX, not by appending, so a
 * variant hashes "alt<n>", the separator, the customer and the source. That prefix is a convention for
 * spreading retries, NOT a security boundary, and it must not be read as one: refusing control
 * characters in a new booking's source ids removes the obvious way to reproduce a variant's material,
 * but the customer id is identity material too and reaches this function unfiltered, so a crafted
 * identity can still land on an id another identity would derive.
 *
 * Nothing here needs to prevent that. The AUTHORITATIVE protection against an occupied id is the
 * global occupancy check in PHASE 4: whatever an id was derived from, it is only ever reused when the
 * row already holding it belongs to the same customer AND the same normalized source id, and the
 * booking fails closed when no safe id is left. Collision resistance is that check's job, not the
 * digest's.
 */
async function mintPetId(customerId:string,sourceId:string,attempt=0){
  const identity=`${petKey(customerId)}${PET_ID_SEPARATOR}${petKey(sourceId)}`;
  const material=attempt===0?identity:`alt${attempt}${PET_ID_SEPARATOR}${identity}`;
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(material)));
  const readable=customerId.replace(/[^A-Za-z0-9]/g,"").toUpperCase().slice(0,12);
  return `PET-${readable}-${Array.from(digest.slice(0,10)).map(byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase()}`;
}
/**
 * The conflict clause for canonical_pets.
 *
 * The upsert used to overwrite unconditionally, so a booking carrying no breed or vaccination status
 * ERASED what the customer had already saved. A booking may now FILL a blank field and nothing else:
 * it may not overwrite a stored value, and it may not renormalize one either. A stored value that is
 * merely padded or oddly cased is still the customer's own value, so blankness is TESTED with a trim
 * while the ORIGINAL column is what gets written back.
 *
 * 'not_provided' is the vaccination column's own sentinel for "unknown", so it counts as blank —
 * matched case-insensitively on BOTH sides, because the sentinel has been written in more than one
 * casing. A genuinely recorded status is preserved byte for byte, spacing and casing included, and a
 * sentinel is only ever displaced by a real status, never rewritten into another sentinel spelling.
 *
 * updated_at moves only when a gap was genuinely filled, so a booking against an already-complete row
 * leaves that row untouched down to its timestamp — nothing downstream sees a phantom edit.
 *
 * The WHERE guard is the last line of defence: an update proposed against a row owned by another
 * customer is skipped rather than applied.
 */
const PET_FIELDS=["name","species","breed","source_pet_id"] as const;
// SQL's bare TRIM() strips spaces ONLY, while the resolver's petKey() uses JS trim(). A tab-only value
// was therefore blank to the resolver and non-blank to this clause, so it could never be healed. The
// explicit character set — space, tab, LF, VT, FF, CR — brings SQL into line for ASCII whitespace.
const BLANK_CHARS="' '||CHAR(9)||CHAR(10)||CHAR(11)||CHAR(12)||CHAR(13)";
const blank=(expression:string)=>`TRIM(COALESCE(${expression},''),${BLANK_CHARS})`;
// A write happens ONLY where the stored side is blank AND the payload actually carries something, so
// "the column changed" and "updated_at moved" are the same condition — there is no write that leaves
// the timestamp behind, and no timestamp bump without a write.
const petFills=(column:string)=>`(${blank(`canonical_pets.${column}`)}='' AND ${blank(`excluded.${column}`)}<>'')`;
const petKeep=(column:string)=>`${column}=CASE WHEN ${petFills(column)} THEN excluded.${column} ELSE canonical_pets.${column} END`;
const VACCINATION_FILLS=`(LOWER(${blank("canonical_pets.vaccination_status")}) IN ('','not_provided') AND LOWER(${blank("excluded.vaccination_status")}) NOT IN ('','not_provided'))`;
const PET_UPSERT=`INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ${PET_FIELDS.map(petKeep).join(",")},vaccination_status=CASE WHEN ${VACCINATION_FILLS} THEN excluded.vaccination_status ELSE canonical_pets.vaccination_status END,updated_at=CASE WHEN ${[...PET_FIELDS.map(petFills),VACCINATION_FILLS].join(" OR ")} THEN excluded.updated_at ELSE canonical_pets.updated_at END WHERE canonical_pets.customer_id=excluded.customer_id`;
async function ensureTables(db:Awaited<ReturnType<typeof database>>){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_subscription_purchase_snapshots (subscription_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,city_id TEXT NOT NULL,zone_id TEXT,plan_code TEXT NOT NULL,catalogue_version TEXT NOT NULL,config_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  // Indexes for the GET lifecycle read (per-booking events, per-customer pets) so its per-row lookups
  // stay index scans instead of table scans as bookings accumulate.
  db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_lifecycle_events_booking ON booking_lifecycle_events(booking_id,occurred_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_canonical_pets_customer ON canonical_pets(customer_id)"),
]);}
/*
 * The service-wide window guard, and the three verticals that re-state it, all ask ONE question: is the
 * booking window the window that was reserved? A window is an instant, not a string - see
 * lib/booking-window-instant.ts for what was measured. The verticals compared strings and refused every
 * Training, Boarding and Sitting booking the customer app made, after its reservation had already been
 * committed. They now share this one predicate with the guard above them. [PTJA-P1-F31]
 */
function bookingWindowMatchesReservation(reserved:Record<string,unknown>,input:Pick<LifecycleInput,"scheduledStart"|"scheduledEnd">){
  return sameInstant(reserved.scheduled_start,input.scheduledStart)&&sameInstant(reserved.scheduled_end,input.scheduledEnd);
}
/*
 * A governance module refuses by THROWING a Response, and it does so in two shapes: a plain sentence
 * (lib/training-commercial-governance.ts, lib/boarding-governance.ts) and a JSON envelope
 * (lib/sitting-governance.ts and the auth layer, via governedJsonError). Reading both as plain text put
 * the envelope itself into the field the UI renders, and the customer was shown, verbatim:
 *   {"error":"{\"error\":\"Authentication required\"}"}
 * Take the sentence out of the envelope when there is one, and leave a plain sentence alone. Same class
 * as PTJA-P1-01: a machine artifact reaching a customer as copy. [PTJA-P1-F33]
 */
async function governedRefusalBody(refusal:Response){
  const text=await refusal.text().catch(()=>"");
  const trimmed=text.trim();
  if(trimmed.startsWith("{")){
    try{
      const parsed=JSON.parse(trimmed) as Record<string,unknown>;
      // Re-emit the governance module's OWN envelope, so the fields it authored for a client -
      // lib/grooming-policy-governance.ts sends code/cityId/zoneId - stay at the top level where a
      // client can read them, instead of being flattened into a string.
      if(parsed&&typeof parsed.error==="string"&&parsed.error.trim())return parsed;
    }catch{/* not an envelope after all; fall through to the plain sentence */}
  }
  return text?{error:text}:null;
}
function validate(input:LifecycleInput){if(!input.idempotencyKey||!input.scheduleGroupId||!input.customer?.id||!input.customer?.name||!input.customer?.primaryPhone)return "Customer and request identity are required";if(!Array.isArray(input.pets)||input.pets.length<1)return "At least one pet is required";if(!services.has(input.serviceCode)||!input.packageCode||!input.scheduledStart||!input.scheduledEnd)return "Complete service and schedule details are required";if(!input.provider?.id||!input.provider?.name||!Number.isFinite(input.totalAmount)||input.totalAmount<0||!Number.isFinite(input.amountDueNow)||input.amountDueNow<0)return "Provider and valid payment amounts are required";return null;}
async function readBundle(db:Awaited<ReturnType<typeof database>>,booking:Record<string,unknown>,duplicatePrevented:boolean){const [workOrder,payment]=await Promise.all([db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(booking.id).first<Record<string,unknown>>(),db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(booking.id).first<Record<string,unknown>>()]);return {bookingId:String(booking.id),customerId:String(booking.customer_id),petIds:JSON.parse(String(booking.pet_ids_json)),scheduleGroupId:String(booking.schedule_group_id),workOrderId:String(workOrder?.id||""),paymentId:String(payment?.id||""),status:String(booking.status),duplicatePrevented};}

export async function GET(request:Request){try{const actor=await resolveActor(request);requirePermission(actor,"bookings.manage");const db=await database();await ensureTables(db);const rows=await db.prepare("SELECT b.*,c.name customer_name,w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,p.id payment_id,p.status payment_status,p.amount_due_now,p.gateway FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id ORDER BY b.created_at DESC LIMIT 100").all<Record<string,unknown>>();const bookings=[];for(const row of rows.results){const [pets,events]=await Promise.all([db.prepare("SELECT id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.customer_id,row.pet_ids_json).all(),db.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at ASC").bind(row.id).all()]);bookings.push({...row,pets:pets.results,events:events.results});}return json({bookings});}catch(error){return authError(error,"Unable to load lifecycle records");}}

export async function POST(request:Request){try{const db=await database();await ensureSchedulingReservationLeaseGovernance(db);await cleanupExpiredReservationLeases(db);const actor=await resolveActor(request);requirePermission(actor,"scheduling.book");const input=await request.json() as LifecycleInput;const problem=validate(input);if(problem)return json({error:problem},400);await ensureTables(db);await requireCustomerOwnership(db,actor,input.customer.id);const replayInput={customerId:input.customer.id,serviceCode:input.serviceCode,idempotencyKey:input.idempotencyKey,scheduleGroupId:input.scheduleGroupId};const prior=await findCustomerReplay(db,replayInput);if(prior)return json({data:await readBundle(db,prior,true)});if(await hasForeignReplayConflict(db,replayInput))return json({error:BOOKING_REPLAY_CONFLICT},409);
  /*
   * THE CITY MATRIX. [PTJA-W1-F38]
   *
   * Checked AFTER the replay lookup on purpose: a replay is not a new booking, and answering a customer's
   * retry with "the city is paused" would strand a booking that was already accepted while the market was
   * open. Everything past this point IS a new booking, on whatever channel it arrived through - the app,
   * an ops-assisted manual booking via /api/assisted-orders, a wait-list conversion, an automatic
   * subscription renewal. A gate only the app passes through is one an operator walks around by accident.
   *
   * Draft and Closed take nothing; Paused takes nothing new while leaving every existing booking alone;
   * Pilot takes only the pincodes, services and channels somebody explicitly enabled.
   */
  const cityVerdict=await cityBookingVerdict(db,{cityId:input.cityId,serviceCode:input.serviceCode,pincode:(input as{pincode?:string}).pincode??null,channel:(input as{channel?:string}).channel??"customer_app"});
  if(!cityVerdict.allowed)return json({error:"PawSpace is not taking new bookings in this city right now",code:cityVerdict.reason,cityId:cityVerdict.cityId,cityStatus:cityVerdict.status,existingBookingsUnaffected:cityVerdict.existingWorkHandling==="continue"},409);if(await hasReplayConflict(db,replayInput))return json({error:BOOKING_WRITE_CONFLICT},409);
  // Identity rules apply to NEW bookings only, and are checked here — after the replay path above, so
  // history stays replayable, and before governance, quote/referral consumption, reservation reads and
  // every write, so a bad new payload costs nothing.
  const identityProblem=petIdentityProblem(input.pets);if(identityProblem)return json({error:identityProblem},400);
  const groomingAddOnPrices:Record<string,number>={"Tick & flea treatment":499,"Full-body oil massage":299};
  const submittedAddOns=(input.pricing.addOns??[]).map(value=>String(value));
  if(input.serviceCode!=="grooming"&&submittedAddOns.length)return json({error:"Add-ons are only supported for Grooming bookings"},409);
  if(submittedAddOns.some(value=>groomingAddOnPrices[value]===undefined)||new Set(submittedAddOns).size!==submittedAddOns.length)return json({error:"The Grooming add-on selection is invalid"},409);
  const groomingAddOnTotal=submittedAddOns.reduce((sum,value)=>sum+groomingAddOnPrices[value],0);
  let couponCommercial:CouponBookingPreparation|null=null;
  const couponQuoteId=String(input.pricing.couponQuoteId||"").trim();
  if(couponQuoteId){
    if(input.pricing.referralClaimId)return json({error:"A coupon and referral offer cannot be combined"},409);
    couponCommercial=await prepareCouponBooking(db,{quoteId:couponQuoteId,bookingId:"pending",customerId:input.customer.id,serviceCode:input.serviceCode,cityId:input.cityId,packageCode:input.packageCode,submittedTotal:input.totalAmount,submittedDiscount:Number(input.pricing.discount||0),idempotencyKey:`coupon:${input.idempotencyKey}:${couponQuoteId}`,now:Date.now()});
  }else if(input.serviceCode==="grooming"&&(Number(input.pricing.discount||0)>0||input.pricing.couponCode))return json({error:"A governed coupon quote is required for a Grooming booking discount"},409);
  let governed:{packageCode:string;packageName:string;catalogueVersion?:string;offerType?:string;petCount:number;totalAmount:number;amountDueNow:number;subscriptionPlan?:SubscriptionPlan}={packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,totalAmount:input.totalAmount,amountDueNow:input.amountDueNow};
  // Resolved before the subscription gate, because in LIVE the gate has to reason about what the payment
  // will be RECORDED as (verify-first), not what the client claimed it already was.
  // Authorization to keep a submitted "captured" without gateway proof is a SERVER decision, never the
  // client's: only a staff actor holding payments.manage may record an offline collection (cash) as
  // captured. A customer-app caller never holds it, so its captured is demoted whatever method it sends,
  // and no unknown/blank method can slip through — the method is not what decides.
  const offlineAuthorized=OFFLINE_METHODS.has(input.payment.method)&&hasPermission(actor.permissions,"payments.manage");
  const liveMode=await liveModePayments(),paymentStatusRecorded=recordedPaymentStatus(liveMode,input.payment,offlineAuthorized);
  const commercialPolicy=input.serviceCode==="grooming"?await resolveGroomingPolicy(db,input.cityId,input.zoneId):null;
  if(commercialPolicy?.enforcementMode==="enforce"&&input.pets.length>commercialPolicy.multiPetMax)return json({error:`This city policy supports up to ${commercialPolicy.multiPetMax} pets per Grooming booking`,policyVersion:policyVersion(commercialPolicy)},409);
  if(input.serviceCode==="grooming"){
    await ensureProviderBookingGuard(db);
    const governedGross=couponCommercial?.orderValue??input.totalAmount;
    try{governed=await governGroomingBookingWithLiveMultiPet(db,{packageCode:input.packageCode,packageName:input.packageName,pets:input.pets.map(pet=>({species:(pet.species??"other") as "dog"|"cat"|"other"})),submittedTotal:governedGross-groomingAddOnTotal,submittedAmountDueNow:input.payment.mode==="prepaid"?governedGross-groomingAddOnTotal:0,paymentMode:input.payment.mode,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart});}catch(error){return json({error:error instanceof Error?error.message:"Invalid Grooming package or price"},409);}
    const gross=governed.totalAmount+groomingAddOnTotal,finalAmount=couponCommercial?.finalAmount??gross;
    if(Math.round(gross)!==Math.round(governedGross))return json({error:"The Grooming total does not match the governed package and add-ons"},409);
    governed={...governed,totalAmount:finalAmount,amountDueNow:input.payment.mode==="prepaid"?finalAmount:0};
    // A subscription is still prepay-only — no split, no pay-after-service — but it no longer has to be
    // CAPTURED at purchase time. Requiring that was what forced the verify-first exemption. It may now be
    // an online payment awaiting gateway verification; the entitlement simply stays pending until the
    // verified capture arrives, so an unpaid purchase yields no usable credits either way.
    if(governed.subscriptionPlan){
      if(input.payment.mode!=="prepaid")return json({error:"Grooming subscription purchases must be prepaid"},409);
      const awaitingGateway=ONLINE_METHODS.has(input.payment.method)&&paymentStatusRecorded==="created";
      if(paymentStatusRecorded!=="captured"&&!awaitingGateway)return json({error:"A Grooming subscription purchase needs a captured payment, or an online payment awaiting gateway verification"},409);
    }
  }
  const assignment=await db.prepare("SELECT selected_provider_id,status,shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").bind(input.scheduleGroupId).first<Record<string,unknown>>();if(!assignment||assignment.status!=="assigned")return json({error:"Scheduling must be assigned before booking confirmation"},409);if(String(assignment.selected_provider_id)!==input.provider.id)return json({error:"The provider does not match the scheduling decision"},409);const reservations=await db.prepare("SELECT id,provider_id,customer_id,service_code,city_id,zone_id,scheduled_start,scheduled_end,occurrence_number,status FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY occurrence_number").bind(input.scheduleGroupId).all<Record<string,unknown>>();if(!schedulingGroupBelongsToCustomer(reservations.results,input.customer.id))return json({error:SCHEDULING_GROUP_OWNERSHIP_CONFLICT},409);if(!reservations.results.length||reservations.results.some(row=>String(row.provider_id)!==input.provider.id))return json({error:"A valid provider reservation is required"},409);if(reservations.results.some(row=>String(row.service_code)!==input.serviceCode))return json({error:"The booking service does not match the scheduling reservation"},409);
  // The booking window must be the window that is actually held. dog_training, boarding and pet_sitting
  // each check this against their own first reservation; nothing checked it for anything else, so a
  // GROOMING booking could be confirmed and PAID for a day on which no capacity was reserved.
  //
  // Measured on the audit branch: reserve 2026-11-20, ask to reserve 2026-11-27 under the same
  // clientRequestId (answered "assigned"), then book 11-27 -> 201 confirmed with 1899 captured, against a
  // reservation still sitting on 11-20. The customer holds a paid booking for a day nobody holds and the
  // groomer is not coming. The companion refusal on the reserve replay path is in
  // app/api/uat-scheduling/route.ts. Same check the three governed verticals already carry, applied to
  // every service, before any write. [PTJA-P1-F28]
  const heldWindow=reservations.results[0];
  if(heldWindow&&!bookingWindowMatchesReservation(heldWindow,input))
    return json({error:"The booking window does not match the scheduling reservation"},409);
  // City/zone integrity invariant: the provider equality above is not enough. The booking persists the
  // CLIENT-supplied cityId/zoneId, but the reservation it confirms was made for a specific city and zone.
  // Trust the reservation, never the client: a Bengaluru reservation must never be confirmable into a
  // booking labelled — and therefore routed, priced and reported as — Chennai. Checked here, after the
  // idempotency replay above so history stays replayable, and before every booking, pet, payment,
  // work-order and lifecycle write, so a mismatched payload costs nothing.
  if(reservations.results.some(row=>String(row.city_id)!==input.cityId||String(row.zone_id)!==input.zoneId))return json({error:"The booking city/zone does not match the reserved provider's city and zone"},409);
  if(input.serviceCode==="grooming"){
    const unavailable=(await Promise.all(reservations.results.map(row=>providerUnavailableForWindow(db,{providerId:String(row.provider_id),scheduledStart:String(row.scheduled_start),scheduledEnd:String(row.scheduled_end)})))).some(Boolean);
    if(unavailable){
      const unavailableAt=Date.now(),reason="Provider became unavailable before booking confirmation";
      await db.batch([
        db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status!='cancelled'").bind(input.scheduleGroupId),
        db.prepare("UPDATE scheduling_assignment_decisions SET status='reassignment_needed',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(actor.email,reason,unavailableAt,input.scheduleGroupId),
      ]);
      return json({error:reason,code:"provider_unavailable_before_booking",reassignmentRequired:true},409);
    }
  }
  let trainingCommercial:Awaited<ReturnType<typeof governTrainingBooking>>|null=null;
  if(input.serviceCode==="dog_training"){
    const quoteId=String(input.pricing.trainingQuoteId||"").trim();if(!quoteId)return json({error:"A server Training quote is required before booking confirmation"},409);const first=reservations.results[0];if(!bookingWindowMatchesReservation(first,input))return json({error:"Training booking window does not match the first reserved session"},409);
    trainingCommercial=await governTrainingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,scheduledStart:input.scheduledStart,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:input.payment.status,reservationCount:reservations.results.length});governed={packageCode:trainingCommercial.packageCode,packageName:trainingCommercial.packageName,catalogueVersion:trainingCommercial.catalogueVersion,petCount:trainingCommercial.petCount,totalAmount:trainingCommercial.totalAmount,amountDueNow:trainingCommercial.amountDueNow};
  }
  let boardingCommercial:Awaited<ReturnType<typeof governBoardingBooking>>|null=null;
  if(input.serviceCode==="boarding"){
    const quoteId=String(input.pricing.boardingQuoteId||"").trim();if(!quoteId)return json({error:"A server Boarding quote is required before booking confirmation"},409);const first=reservations.results[0];if(!bookingWindowMatchesReservation(first,input))return json({error:"Boarding booking window does not match the continuous stay reservation"},409);
    boardingCommercial=await governBoardingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:input.payment.status,reservationCount:reservations.results.length,providerId:input.provider.id,cityId:input.cityId,zoneId:input.zoneId,medicationRequired:input.pets.some(pet=>pet.medicationRequired===true),customerId:input.customer.id,species:input.pets.map(pet=>String(pet.species||"other")),vaccinationStatuses:input.pets.map(pet=>String(pet.vaccinationStatus||"not_provided"))});governed={packageCode:boardingCommercial.packageCode,packageName:boardingCommercial.packageName,catalogueVersion:boardingCommercial.catalogueVersion,petCount:boardingCommercial.petCount,totalAmount:boardingCommercial.totalAmount,amountDueNow:boardingCommercial.amountDueNow};
  }
  let sittingCommercial:Awaited<ReturnType<typeof governSittingBooking>>|null=null;
  let sittingCapture:Awaited<ReturnType<typeof requireSittingQuoteSandboxCapture>>|null=null;
  if(input.serviceCode==="pet_sitting"){
    const quoteId=String(input.pricing.sittingQuoteId||"").trim();
    if(!quoteId)return json({error:"A server Sitting quote is required before booking confirmation"},409);
    const first=reservations.results[0];
    if(reservations.results.length!==1||!bookingWindowMatchesReservation(first,input))return json({error:"Sitting booking window does not match the canonical care reservation"},409);
    if(paymentStatusRecorded==="captured")sittingCapture=await requireSittingQuoteSandboxCapture(db,{quoteId,amount:input.amountDueNow});
    sittingCommercial=await governSittingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:sittingCapture?.status??paymentStatusRecorded,reservationCount:reservations.results.length});
    governed={packageCode:sittingCommercial.packageCode,packageName:sittingCommercial.packageName,catalogueVersion:sittingCommercial.catalogueVersion,petCount:sittingCommercial.petCount,totalAmount:sittingCommercial.totalAmount,amountDueNow:sittingCommercial.amountDueNow};
  }
  let referralCommercial:ReferralBookingPreparation|null=null;
  const referralClaimId=String(input.pricing.referralClaimId||"").trim();
  if(referralClaimId){
    const existingDiscount=Number(trainingCommercial?.discount??input.pricing.discount??0);
    referralCommercial=await prepareReferralBooking(db,{claimId:referralClaimId,customer:{id:input.customer.id,primaryPhone:input.customer.primaryPhone,email:input.customer.email},serviceCode:input.serviceCode,cityId:input.cityId,baseAmount:governed.totalAmount,baseAmountDueNow:governed.amountDueNow,hasOtherOffer:Boolean(trainingCommercial?.couponCode||input.pricing.couponCode||existingDiscount>0),isSubscription:Boolean(governed.subscriptionPlan||input.pricing.subscription)});
    governed={...governed,totalAmount:referralCommercial.totalAmount,amountDueNow:referralCommercial.amountDueNow};
  }
  const now=Date.now(),bookingId=`PS-UAT-${now.toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,4).toUpperCase()}`,workOrderId=`WO-${crypto.randomUUID().slice(0,8).toUpperCase()}`,paymentId=`PAY-${crypto.randomUUID().slice(0,8).toUpperCase()}`,subscriptionId=governed.subscriptionPlan?`GSUB-${crypto.randomUUID().slice(0,10).toUpperCase()}`:null;
  if(couponCommercial)couponCommercial=await prepareCouponBooking(db,{quoteId:couponCommercial.quoteId,bookingId,customerId:input.customer.id,serviceCode:input.serviceCode,cityId:input.cityId,packageCode:input.packageCode,submittedTotal:input.totalAmount,submittedDiscount:Number(input.pricing.discount||0),idempotencyKey:`coupon:${input.idempotencyKey}:${couponCommercial.quoteId}`,now});
  // A booking used to mint its own canonical_pets row keyed by the pet NAME, so a pet the customer had
  // already saved got a SECOND, empty row and pet_ids_json pointed at that one. Every reader resolving
  // pets through pet_ids_json — Booking Command Center, canonical-bookings GET, partner job feed,
  // boarding host-replacement eligibility — then showed an empty profile for a filled-in pet.
  //
  // Resolution runs in PHASES rather than per pet, because identity has to be settled for the whole
  // payload before any weaker rule may claim a row. Deciding pet-by-pet made the outcome depend on
  // payload order: a name-only or legacy entry listed first could take the row a later entry named by
  // its exact source id.
  // This read is a PRECONDITION, not an optimisation. Treating a failure as "no pets exist" was worse
  // than failing: the booking would mint a fresh empty row beside the customer's saved profile and bind
  // to it — precisely the defect this route is fixing — while reporting success. Nothing has been
  // written to canonical_bookings, canonical_pets, booking_payments, provider_work_orders or
  // booking_lifecycle_events at this point, so returning here leaves no partial booking behind.
  // Ordered by a STABLE TOTAL order. It used to be updated_at DESC, which made an ambiguous same-name
  // fallback depend on which row had been edited most recently: an unrelated profile edit could move a
  // later booking onto a different row, and equal timestamps left the choice to engine order — a real
  // divergence risk between D1 and any other SQLite. created_at breaks by age, id (the primary key)
  // breaks every remaining tie, so the same rows always yield the same candidate order. The identity
  // and profile rules below still decide WHICH candidate wins; this only fixes the order they see.
  const existingPets=await db.prepare("SELECT id,source_pet_id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? ORDER BY created_at ASC,id ASC").bind(input.customer.id).all<Record<string,unknown>>().catch(()=>null);
  if(!existingPets)return json({error:"Unable to read this customer's pets right now"},503);
  const petText=(value:unknown)=>petKey(value)?String(value).trim():null;
  // 'not_provided' is the column's own sentinel for "unknown", so it counts as blank on both sides.
  const petVaccination=(value:unknown)=>petKey(value)&&petKey(value)!=="not_provided"?String(value).trim():null;
  const petHasProfile=(row:Record<string,unknown>)=>Boolean(petText(row.breed))||Boolean(petVaccination(row.vaccination_status));
  // The ONLY row a pre-fix booking could mint carries a specific fingerprint: those bookings passed the
  // pet's NAME as the source id, so source_pet_id equals the row's own name, and they never wrote a
  // profile. Nothing the account flow saves looks like this. Naming the legacy condition this precisely
  // keeps duplicate-healing without opening the door to arbitrary same-name substitution.
  const isLegacyBookingArtifact=(row:Record<string,unknown>)=>petKey(row.source_pet_id)===petKey(row.name)&&!petHasProfile(row);
  const identityRowsFor=(sourceId:string)=>existingPets.results.filter(row=>petKey(row.source_pet_id)&&petKey(row.source_pet_id)===petKey(sourceId));
  const assignedRowIds=new Set<string>();
  const matches:Array<Record<string,unknown>|undefined>=new Array(input.pets.length);
  const take=(index:number,row:Record<string,unknown>)=>{matches[index]=row;assignedRowIds.add(String(row.id));};

  // PHASE 1 — reserve genuine exact source_pet_id identities across the WHOLE payload first. Any pet
  // already saved keeps its existing row and its existing id, whatever format that id is in; nothing is
  // reminted or rewritten. No later phase can take a row this phase holds.
  input.pets.forEach((pet,index)=>{
    const genuine=identityRowsFor(pet.sourceId).filter(row=>!isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)));
    const claim=genuine.find(petHasProfile)??genuine[0];
    if(claim)take(index,claim);
  });
  // PHASE 2 — legacy healing, deferred until identity is settled. A pet whose only identity match is a
  // pre-fix artifact may adopt the saved pet of that name if one is still unclaimed; otherwise it keeps
  // its own artifact.
  //
  // The adoption target is chosen by the ARTIFACT's own name — which, by the definition above, IS its
  // source_pet_id — and never by the payload's name. Using the payload's name let one animal's booking
  // reach another's row: a payload naming the "Rex" artifact by source id while calling the pet "Bruno"
  // adopted Bruno's saved row and wrote Rex's details onto it. The source id is the identity the
  // artifact was found by, so it is the identity the adoption must follow.
  input.pets.forEach((pet,index)=>{
    if(matches[index])return;
    const artifact=identityRowsFor(pet.sourceId).find(row=>isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)));
    if(!artifact)return;
    take(index,existingPets.results.find(row=>petKey(row.name)===petKey(artifact.name)&&petHasProfile(row)&&!isLegacyBookingArtifact(row)&&!assignedRowIds.has(String(row.id)))??artifact);
  });
  // PHASE 3 — the legacy name-as-source-id fallback, and ONLY that. It exists for one flow: the apps
  // that send the pet's NAME as its source id, so the name is the only identity the payload carries.
  //
  // It used to run for any pet without an identity match, which quietly absorbed a genuinely new pet
  // into an existing pet of the same name — a second dog also called Bruno, booked with its own account
  // source id, was bound to the first Bruno's row and lost its own profile. A source id that does not
  // exactly match an existing row denotes a DISTINCT pet, even when another pet shares its name; such a
  // pet is minted in PHASE 4. A duplicate row is recoverable, binding a booking to the wrong animal is
  // not, so the gate deliberately fails towards minting.
  input.pets.forEach((pet,index)=>{
    if(matches[index]||petKey(pet.sourceId)!==petKey(pet.name))return;
    const named=existingPets.results.filter(row=>petKey(row.name)===petKey(pet.name)&&!assignedRowIds.has(String(row.id)));
    const claim=named.find(petHasProfile)??named[0];
    if(claim)take(index,claim);
  });
  // PHASE 4 — mint the rest, then CHECK the proposed ids globally.
  //
  // The digest makes an id correct for a given identity, but it cannot know whether some unrelated row
  // already occupies that id. Left unchecked, the guarded upsert silently no-ops against a row owned by
  // another customer and the booking ends up referencing a stranger's pet. So every proposed id is
  // looked up across canonical_pets (not just this customer's rows), in bounded chunks. An occupied id
  // is reusable only when the holder is the SAME pet — same customer and same normalized source id.
  // Otherwise the next deterministic, domain-separated variant is tried, and the booking fails closed
  // before the write batch if the attempt budget runs out.
  const unresolved=input.pets.map((pet,index)=>({pet,index})).filter(entry=>!matches[entry.index]);
  const candidatesByIndex=new Map<number,string[]>();
  for(const entry of unresolved){
    const candidates:string[]=[];
    for(let attempt=0;attempt<MAX_PET_ID_ATTEMPTS;attempt++)candidates.push(await mintPetId(input.customer.id,entry.pet.sourceId,attempt));
    candidatesByIndex.set(entry.index,candidates);
  }
  const holders=new Map<string,{customerId:string;sourceKey:string}>();
  const allCandidates=[...new Set([...candidatesByIndex.values()].flat())];
  for(let offset=0;offset<allCandidates.length;offset+=80){
    const slice=allCandidates.slice(offset,offset+80);
    // An unread chunk is NOT an empty chunk. Treating a failed lookup as "nothing occupies these ids"
    // disables the very check this loop exists for, and the booking would then bind an id belonging to
    // a stranger while the guarded upsert silently refused to write the customer a row of their own.
    const rows=await db.prepare(`SELECT id,customer_id,source_pet_id FROM canonical_pets WHERE id IN (${slice.map(()=>"?").join(",")})`).bind(...slice).all<Record<string,unknown>>().catch(()=>null);
    if(!rows)return json({error:"Unable to verify canonical pet identifiers right now"},503);
    for(const row of rows.results)holders.set(String(row.id),{customerId:String(row.customer_id),sourceKey:petKey(row.source_pet_id)});
  }
  const mintedIds=new Map<number,string>();
  const takenThisBooking=new Set<string>(assignedRowIds);
  for(const entry of unresolved){
    const sourceKey=petKey(entry.pet.sourceId);
    const chosen=(candidatesByIndex.get(entry.index)??[]).find(candidate=>{
      if(takenThisBooking.has(candidate))return false;              // already assigned within THIS booking
      const holder=holders.get(candidate);
      return !holder||(holder.customerId===input.customer.id&&holder.sourceKey===sourceKey);
    });
    // Fail closed: a booking that cannot be given a safe identifier must not be written at all.
    if(!chosen)return json({error:"Unable to allocate a canonical pet identifier for this booking"},409);
    takenThisBooking.add(chosen);mintedIds.set(entry.index,chosen);
  }
  // Stored values win wherever they are non-blank; the payload may only populate what is missing.
  const resolvedPets=input.pets.map((pet,index)=>{const match=matches[index];return {
    id:match?String(match.id):String(mintedIds.get(index)),
    name:(match&&petText(match.name))??petText(pet.name)??String(pet.name),
    species:(match&&petText(match.species))??petText(pet.species)??"dog",
    breed:(match&&petText(match.breed))??petText(pet.breed),
    vaccinationStatus:(match&&petVaccination(match.vaccination_status))??petVaccination(pet.vaccinationStatus)??"not_provided",
    sourceId:pet.sourceId,
  };});
  const ids=resolvedPets.map(pet=>pet.id);
  const pricingJson={...input.pricing,discount:couponCommercial?.discount??referralCommercial?.discountAmount??trainingCommercial?.discount??input.pricing.discount,couponCode:couponCommercial?.code??trainingCommercial?.couponCode??input.pricing.couponCode,couponQuoteId:couponCommercial?.quoteId,addOns:submittedAddOns,addOnTotal:groomingAddOnTotal,referralClaimId:referralCommercial?.claimId,referralCode:referralCommercial?.code,referralPolicy:referralCommercial?.policySnapshot,referralBaseAmount:referralCommercial?.baseAmount,catalogueVersion:governed.catalogueVersion,offerType:governed.offerType,subscription:subscriptionId??input.pricing.subscription,subscriptionPlanCode:governed.subscriptionPlan?.planCode,subscriptionConfig:governed.subscriptionPlan,commercialPolicy:commercialPolicy?policySnapshot(commercialPolicy):undefined,trainingCommercial:trainingCommercial??undefined,boardingCommercial:boardingCommercial??undefined,sittingQuoteId:sittingCommercial?.quoteId??input.pricing.sittingQuoteId,sittingCommercial:sittingCommercial??undefined,sittingPaymentReference:sittingCapture?.reference};
  const paymentStatusPersisted=sittingCapture?.status??paymentStatusRecorded;
  const paymentModePersisted=sittingCommercial?.paymentMode??input.payment.mode;
  // The entitlement is only live money's to grant. Captured (sandbox, or an offline capture) creates it
  // active; anything awaiting gateway verification creates it pending with zero sessions reserved.
  const entitlementActive=paymentStatusPersisted==="captured";
  const statements=[
    db.prepare("INSERT INTO booking_reservation_confirmation_guards (group_id,checked_at) VALUES (?,?)").bind(input.scheduleGroupId,now),
    ...(input.serviceCode==="grooming"?[db.prepare("INSERT INTO provider_booking_confirmation_guards (group_id,created_at) VALUES (?,?)").bind(input.scheduleGroupId,now)]:[]),
    db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?,?) ON CONFLICT(id) DO UPDATE SET city_id=excluded.city_id,name=excluded.name,primary_phone=excluded.primary_phone,secondary_phone=excluded.secondary_phone,email=excluded.email,updated_at=excluded.updated_at").bind(input.customer.id,input.cityId,input.customer.name,input.customer.primaryPhone,input.customer.secondaryPhone??null,input.customer.email??null,"uat_customer_app",JSON.stringify({serviceUpdates:true,marketing:false}),now,now),
    ...resolvedPets.map(pet=>db.prepare(PET_UPSERT).bind(pet.id,input.customer.id,pet.name,pet.species,pet.breed,pet.vaccinationStatus,pet.sourceId,now,now)),
    db.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(bookingId,input.idempotencyKey,input.customer.id,JSON.stringify(ids),JSON.stringify(input.pets.map(p=>p.sourceId)),input.cityId,input.zoneId,input.serviceCode,governed.packageCode,governed.packageName,input.scheduleGroupId,input.provider.id,input.scheduledStart,input.scheduledEnd,"confirmed","customer_app",governed.totalAmount,"INR",JSON.stringify(pricingJson),input.customer.id,now,now),
    db.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(workOrderId,bookingId,input.scheduleGroupId,input.provider.id,input.provider.name,input.provider.model,input.serviceCode,input.scheduledStart,input.scheduledEnd,reservations.results.length,input.provider.model==="commission"?"awaiting_acceptance":"assigned",JSON.stringify({reservations:reservations.results,decision:assignment,customerSelection:{requirements:input.pricing.requirements??[],healthSafetyNotes:input.pricing.healthSafetyNotes??null,behaviourNotes:input.pricing.behaviourNotes??null}}),now,now),
    db.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(paymentId,bookingId,input.customer.id,governed.totalAmount,governed.amountDueNow,"INR",input.payment.method,paymentModePersisted,paymentStatusPersisted,"uat_sandbox",`${input.idempotencyKey}:payment`,JSON.stringify({detail:input.payment.detail,liveMoney:false,catalogueVersion:governed.catalogueVersion,trainingQuoteId:trainingCommercial?.quoteId,boardingQuoteId:boardingCommercial?.quoteId,sittingQuoteId:sittingCommercial?.quoteId,sittingPaymentReference:sittingCapture?.reference,referralClaimId:referralCommercial?.claimId,referralDiscount:referralCommercial?.discountAmount}),now,now),
  ];
  if(trainingCommercial)statements.push(trainingQuoteLinkStatement(db,trainingCommercial.quoteId,bookingId));
  if(boardingCommercial)statements.push(boardingQuoteLinkStatement(db,boardingCommercial.quoteId,bookingId),boardingStayStatement(db,{bookingId,customerId:input.customer.id,providerId:input.provider.id,cityId:input.cityId,zoneId:input.zoneId,packageCode:boardingCommercial.packageCode,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,stayUnits:boardingCommercial.stayUnits,petCount:boardingCommercial.petCount}));
  if(sittingCommercial)statements.push(sittingQuoteLinkStatement(db,sittingCommercial.quoteId,bookingId));
  if(boardingCommercial&&boardingCommercial.paymentMode==="split_50_50"){await ensureStayPaymentTables(db);const plan=splitPaymentPlan({totalAmount:boardingCommercial.totalAmount,scheduledStart:input.scheduledStart});statements.push(staySplitScheduleStatement(db,{bookingId,serviceCode:"boarding",customerId:input.customer.id,totalAmount:boardingCommercial.totalAmount,paidNowAmount:boardingCommercial.amountDueNow,balanceAmount:plan.balance,balanceDueAt:plan.balanceDueAt}));}
  if(sittingCommercial&&sittingCommercial.paymentMode==="split_50_50"){await ensureStayPaymentTables(db);const plan=splitPaymentPlan({totalAmount:sittingCommercial.totalAmount,scheduledStart:sittingCommercial.scheduledStart});statements.push(staySplitScheduleStatement(db,{bookingId,serviceCode:"pet_sitting",customerId:input.customer.id,totalAmount:sittingCommercial.totalAmount,paidNowAmount:sittingCommercial.amountDueNow,balanceAmount:plan.balance,balanceDueAt:plan.balanceDueAt}));}
  if(referralCommercial)statements.push(referralBookingLinkStatement(db,{preparation:referralCommercial,bookingId,now}),referralClaimBoundStatement(db,{claimId:referralCommercial.claimId,now}));
  if(couponCommercial)statements.push(couponCommercial.redemptionStatement,couponCommercial.claimStatement);
  if(subscriptionId&&governed.subscriptionPlan){const expiresAt=subscriptionExpiry(now,governed.subscriptionPlan.validityValue,governed.subscriptionPlan.validityUnit);
    // Pending is not a label — mutateSubscriptionWallet only moves credits for a subscription in
    // ('active','exhausted'), and coupon/reminder/BI reads filter on 'active'. Zero reserved sessions on
    // top of it means an unverified purchase holds nothing a customer could redeem.
    const subscriptionStatus=entitlementActive?"active":PENDING_PAYMENT_STATUS;
    const sessionsReserved=entitlementActive?governed.subscriptionPlan.reserveSessions:0;
    statements.push(
    db.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?)").bind(subscriptionId,input.customer.id,governed.subscriptionPlan.planCode,governed.subscriptionPlan.servicePackageCode,governed.subscriptionPlan.sessions,sessionsReserved,subscriptionStatus,now,expiresAt,bookingId,governed.catalogueVersion??"unknown",now,now),
    db.prepare("INSERT INTO booking_subscription_usage (id,booking_id,customer_id,plan_code,sessions_reserved,sessions_consumed,status,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?)").bind(crypto.randomUUID(),bookingId,input.customer.id,subscriptionId,sessionsReserved,entitlementActive?"reserved":PENDING_PAYMENT_STATUS,now,now),
    db.prepare("INSERT INTO grooming_subscription_purchase_snapshots (subscription_id,booking_id,city_id,zone_id,plan_code,catalogue_version,config_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(subscriptionId,bookingId,input.cityId,input.zoneId,governed.subscriptionPlan.planCode,governed.catalogueVersion??"unknown",JSON.stringify(governed.subscriptionPlan),now)
  );}
  const events:Array<readonly[string,string,string,Record<string,unknown>]>=[["scheduling_linked","schedule_group",input.scheduleGroupId,{providerId:input.provider.id,occurrences:reservations.results.length}],["booking_created","booking",bookingId,{serviceCode:input.serviceCode,packageName:governed.packageName,catalogueVersion:governed.catalogueVersion,commercialPolicyVersion:commercialPolicy?policyVersion(commercialPolicy):undefined,trainingSessions:trainingCommercial?.sessions,trainingValidityDays:trainingCommercial?.validityDays,trainingQuoteId:trainingCommercial?.quoteId,boardingQuoteId:boardingCommercial?.quoteId,boardingStayUnits:boardingCommercial?.stayUnits,boardingHostProfileVersion:boardingCommercial?.host.profileVersion,sittingQuoteId:sittingCommercial?.quoteId,sittingMode:sittingCommercial?.mode,sittingBillableUnits:sittingCommercial?.billableUnits,sittingPaymentReference:sittingCapture?.reference,referralClaimId:referralCommercial?.claimId,referralDiscount:referralCommercial?.discountAmount}],["work_order_created","work_order",workOrderId,{status:input.provider.model==="commission"?"awaiting_acceptance":"assigned"}],// the RECORDED status, not the submitted claim: the lifecycle trail must not read "captured" for a
// payment the platform persisted as awaiting gateway verification
["payment_recorded","payment",paymentId,{status:paymentStatusPersisted,submittedStatus:input.payment.status,gateway:"uat_sandbox",liveMoney:false,amount:governed.totalAmount,amountDueNow:governed.amountDueNow,sittingQuoteId:sittingCommercial?.quoteId,sittingPaymentReference:sittingCapture?.reference}]];
  if(referralCommercial)events.push(["referral_claim_bound","referral_claim",referralCommercial.claimId,{programmeId:referralCommercial.programmeId,code:referralCommercial.code,baseAmount:referralCommercial.baseAmount,discountAmount:referralCommercial.discountAmount,totalAmount:referralCommercial.totalAmount,testOnly:true,liveMoney:false}]);
  if(subscriptionId&&governed.subscriptionPlan)events.push([entitlementActive?"subscription_reserved":"subscription_pending_payment","subscription",subscriptionId,{planCode:governed.subscriptionPlan.planCode,sessionsReserved:entitlementActive?governed.subscriptionPlan.reserveSessions:0,totalSessions:governed.subscriptionPlan.sessions,validityValue:governed.subscriptionPlan.validityValue,validityUnit:governed.subscriptionPlan.validityUnit,cityId:governed.subscriptionPlan.cityId,zoneId:governed.subscriptionPlan.zoneId,awaitingGatewayVerification:!entitlementActive}]);
  for(const [eventType,entityType,entityId,detail] of events)statements.push(db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,entityType,entityId,input.customer.id,JSON.stringify(detail),now));
  try{await db.batch(statements)}catch(error){const message=error instanceof Error?error.message:String(error);if(/reservation_lease_expired_before_booking/.test(message)){await cleanupExpiredReservationLeases(db);return json({error:"The scheduling reservation expired before booking confirmation",code:"reservation_expired"},409);}if(/provider_unavailable_before_booking/.test(message)){const reason="Provider became unavailable before booking confirmation",blockedAt=Date.now();await db.batch([db.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=? AND status!='cancelled'").bind(input.scheduleGroupId),db.prepare("UPDATE scheduling_assignment_decisions SET status='reassignment_needed',actor_id=?,reason=?,updated_at=? WHERE group_id=?").bind(actor.email,reason,blockedAt,input.scheduleGroupId)]);return json({error:reason,code:"provider_unavailable_before_booking",reassignmentRequired:true},409);}if(couponCommercial&&/coupon_redemptions\.campaign_id|coupon quote/i.test(message))return json({error:"Coupon quote is no longer available; refresh the quote and try again"},409);if(!isUniqueConstraintError(error))throw error;const raced=await findCustomerReplay(db,replayInput);if(raced)return json({data:await readBundle(db,raced,true)});if(await hasForeignReplayConflict(db,replayInput))return json({error:BOOKING_REPLAY_CONFLICT},409);return json({error:BOOKING_WRITE_CONFLICT},409)};/*
   * The collection ledger. [PTJA-W2-B2-R04]
   *
   * Measured before this call existed: a month holding a completed booking with a captured Rs 5,000
   * payment produced GET /api/cash-flow-statement -> closingCash 0, reconciled TRUE, and zero rows in
   * finance_journal_entries. No booking-payment capture path anywhere called postJournal, so the
   * statement's only input was empty and its reconciliation check was satisfied by 0 = 0.
   *
   * Posted AFTER the booking batch commits, and only for a payment that actually reached `captured` -
   * the approved rule is that a collection posts on capture, never on booking creation. The posting is
   * idempotent on the payment id, so the replay paths above cannot double-count the money, and a
   * ledger failure is contained: the booking is already committed and the customer is not told their
   * confirmed booking failed because a journal line did not write.
   */
  if(String(paymentStatusPersisted)==="captured"){
    await postCollectionEvent(db,{
      event:String(input.payment.method).toLowerCase()==="cash"?"cash_collected_confirmed":"online_payment_captured",
      bookingId,customerId:input.customer.id,cityId:input.cityId,serviceCode:input.serviceCode,
      paymentId,amount:Number(governed.amountDueNow||governed.totalAmount||0),
      paymentMethod:String(input.payment.method),collectorId:String(input.payment.method).toLowerCase()==="cash"?actor.email:null,
      entryDate:new Date().toISOString().slice(0,10),transactionAt:Date.now(),actorId:actor.email,
    }).catch(error=>{console.warn("[collection-ledger] posting deferred",error instanceof Error?error.message:String(error));});
  }
  if(trainingCommercial)await consumeTrainingQuote(db,trainingCommercial.quoteId,bookingId);if(boardingCommercial)await consumeBoardingQuote(db,boardingCommercial.quoteId,bookingId);if(sittingCommercial)await consumeSittingQuote(db,sittingCommercial.quoteId,bookingId);await attributeBookingToOpenLead(db,{customerId:input.customer.id,bookingId});const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();return json({data:await readBundle(db,booking!,false)},201);
}catch(error){if(error instanceof Response){const body=await governedRefusalBody(error);return json(body??{error:"Canonical booking validation failed"},error.status||409);}return json({error:error instanceof Error?error.message:"Unable to create shared booking lifecycle"},500);}}
