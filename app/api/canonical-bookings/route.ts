import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import {subscriptionExpiry} from "../../../lib/grooming-governance";
import {governGroomingBookingWithLiveMultiPet} from "../../../lib/live-grooming-governance";
import{authError,requireCustomerOwnership,resolveActor}from"../../../lib/server-auth";
import{releaseReservationForRefusedBooking}from"../../../lib/reservation-compensation";
import{schedulingGroupOwnership}from"../../../lib/scheduling-group-ownership";
import {hasPermission} from "../../../lib/platform-security";
import {policySnapshot,policyVersion,resolveGroomingPolicy} from "../../../lib/grooming-policy-governance";
import {consumeTrainingQuote,governTrainingBooking,trainingQuoteLinkStatement} from "../../../lib/training-commercial-governance";
import {boardingQuoteLinkStatement,boardingStayStatement,consumeBoardingQuote,governBoardingBooking} from "../../../lib/boarding-governance";
import {ensureStayPaymentTables,splitPaymentPlan,staySplitScheduleStatement} from "../../../lib/stay-split-payments";
import {prepareReferralBooking,referralBookingLinkStatement,referralClaimBoundStatement,type ReferralBookingPreparation} from "../../../lib/referral-booking-governance";
import {attributeBookingToOpenLead} from "../../../lib/lead-conversion-attribution";
import {PENDING_PAYMENT_STATUS} from "../../../lib/subscription-payment-activation";

type LifecycleInput={
  idempotencyKey:string;scheduleGroupId:string;customer:{id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string};
  pets:Array<{sourceId:string;name:string;species?:string;breed?:string;vaccinationStatus?:string}>;cityId:string;zoneId:string;
  serviceCode:"grooming"|"dog_training"|"boarding"|"pet_sitting";packageCode:string;packageName:string;scheduledStart:string;scheduledEnd:string;
  provider:{id:string;name:string;model:"full_time"|"commission"};totalAmount:number;amountDueNow:number;
  payment:{method:string;mode:string;status:string;detail:string};pricing:{discount:number;couponCode?:string;subscription?:string;requirements?:string[];trainingQuoteId?:string;boardingQuoteId?:string;referralClaimId?:string};
};

type SubscriptionPlan={planCode:string;sessions:number;validityValue:number;validityUnit:"days"|"months";reserveSessions:number;servicePackageCode:string;cityId:string;zoneId?:string|null;familyWallet:boolean;pauseDays:number;graceDays:number;renewalWindowDays:number;benefits:unknown[];terms:Record<string,unknown>};
const services=new Set(["grooming","dog_training","boarding","pet_sitting"]);
const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
async function paymentEnv(){const {env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_PAYMENT_ENV||"sandbox").toLowerCase();}
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
const petId=(customerId:string,sourceId:string)=>`PET-${customerId.replace(/[^A-Za-z0-9]/g,"").toUpperCase()}-${sourceId.replace(/[^A-Za-z0-9]/g,"").toUpperCase()}`;
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
function validate(input:LifecycleInput){if(!input.idempotencyKey||!input.scheduleGroupId||!input.customer?.id||!input.customer?.name||!input.customer?.primaryPhone)return "Customer and request identity are required";if(!Array.isArray(input.pets)||input.pets.length<1)return "At least one pet is required";if(!services.has(input.serviceCode)||!input.packageCode||!input.scheduledStart||!input.scheduledEnd)return "Complete service and schedule details are required";if(!input.provider?.id||!input.provider?.name||!Number.isFinite(input.totalAmount)||input.totalAmount<0||!Number.isFinite(input.amountDueNow)||input.amountDueNow<0)return "Provider and valid payment amounts are required";return null;}
async function readBundle(db:Awaited<ReturnType<typeof database>>,booking:Record<string,unknown>,duplicatePrevented:boolean){const [workOrder,payment]=await Promise.all([db.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").bind(booking.id).first<Record<string,unknown>>(),db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(booking.id).first<Record<string,unknown>>()]);return {bookingId:String(booking.id),customerId:String(booking.customer_id),petIds:JSON.parse(String(booking.pet_ids_json)),scheduleGroupId:String(booking.schedule_group_id),workOrderId:String(workOrder?.id||""),paymentId:String(payment?.id||""),status:String(booking.status),duplicatePrevented};}

export async function GET(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{const db=await database();await ensureTables(db);const rows=await db.prepare("SELECT b.*,c.name customer_name,w.id work_order_id,w.provider_name,w.provider_model,w.status work_order_status,w.occurrence_count,p.id payment_id,p.status payment_status,p.amount_due_now,p.gateway FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id ORDER BY b.created_at DESC LIMIT 100").all<Record<string,unknown>>();const bookings=[];for(const row of rows.results){const [pets,events]=await Promise.all([db.prepare("SELECT id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY name").bind(row.customer_id,row.pet_ids_json).all(),db.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at ASC").bind(row.id).all()]);bookings.push({...row,pets:pets.results,events:events.results});}return json({bookings});}catch(error){return authError(error,"Unable to load lifecycle records");}}

export async function POST(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{const input=await request.json() as LifecycleInput;const problem=validate(input);if(problem)return json({error:problem},400);const db=await database();await ensureTables(db);const actor=await resolveActor(request);await requireCustomerOwnership(db,actor,input.customer.id);
  // ---- scheduling-group authority gate ---------------------------------------------------------
  // requireCustomerOwnership above proved the caller owns the customer id in the BODY. It proves
  // nothing about the scheduleGroupId in that same body, and nothing else here compared the two - so a
  // byte-identical valid request with only the group swapped confirmed a booking, captured a payment and
  // raised a work order against a stranger's reserved slot. This is an AUTHORITY refusal (403), not a
  // state conflict (409), and it runs before ANY mutation and before the replay lookup below - that
  // lookup matches on schedule_group_id, so without this gate it would hand the victim's booking bundle
  // straight back to the attacker. It also runs before the compensation path is reachable, so a refused
  // attacker cannot release the victim's hold: the victim's rows are not touched at all.
  const groupOwnership=await schedulingGroupOwnership(db,{groupId:input.scheduleGroupId,customerId:input.customer.id});
  if(groupOwnership.state==="foreign")return json({error:"This scheduling group belongs to a different customer"},403);
  // The replay lookup is scoped to the authenticated customer. The group gate above closes the
  // scheduleGroupId door, but this query has a SECOND door: `OR idempotency_key=?`. Unscoped, a caller
  // holding a perfectly legitimate group of their own and quoting somebody else's idempotency key was
  // handed that customer's bundle — booking id, pet ids, group id, work order id and payment id. That
  // was reachable without an attacker: the Training flow built its key from a hardcoded literal rather
  // than the customer, so two customers booking the same package/slot/frequency collided on one key.
  const prior=await db.prepare("SELECT * FROM canonical_bookings WHERE (idempotency_key=? OR schedule_group_id=?) AND customer_id=?").bind(input.idempotencyKey,input.scheduleGroupId,input.customer.id).first<Record<string,unknown>>();if(prior)return json({data:await readBundle(db,prior,true)});
  // Scoping the lookup means a FOREIGN key no longer short-circuits into a replay — so it would reach
  // the INSERT and hit `idempotency_key TEXT NOT NULL UNIQUE`, which is global, not per-customer. That
  // constraint makes "let B book independently under the same key" impossible at the schema level, so
  // the only safe outcomes are: never leak, never 500. This is the explicit, controlled refusal — read
  // -only, before any statement is built, so a probe mutates nothing and learns nothing but a conflict.
  const foreignKey=await db.prepare("SELECT 1 taken FROM canonical_bookings WHERE (idempotency_key=? OR schedule_group_id=?) AND customer_id<>? LIMIT 1").bind(input.idempotencyKey,input.scheduleGroupId,input.customer.id).first<Record<string,unknown>>().catch(()=>null);
  if(foreignKey)return json({error:"This idempotency key or scheduling group is already in use"},409);
  // ---- ownership boundary ----------------------------------------------------------------------
  // requireCustomerOwnership above has proven this caller owns input.customer.id. EVERY refusal below
  // this line releases the hold the booking was for; NOTHING above it may, because validate()'s 400 and
  // any auth failure happen before we know who the caller is - compensating there would let an unproven
  // caller free a hold. The release is additionally scoped to this proven customer inside
  // releaseReservationForRefusedBooking, so quoting somebody else's group mutates nothing.
  // The replay above returns BEFORE this point, so a duplicate confirm never releases a live booking's hold.
  const refuse=async(message:string,status:number,extra:Record<string,unknown>={})=>{
    const compensation=await releaseReservationForRefusedBooking(db,{groupId:input.scheduleGroupId,ownershipProvenCustomerId:input.customer.id});
    // Report the cleanup honestly: if it failed, say so rather than implying the slot is free.
    const capacity=compensation.ok?{capacityReleased:compensation.released}:{capacityReleased:null,capacityReleaseFailed:true};
    return json({error:message,...extra,...capacity},status);
  };
  let governed:{packageCode:string;packageName:string;catalogueVersion?:string;offerType?:string;petCount:number;totalAmount:number;amountDueNow:number;subscriptionPlan?:SubscriptionPlan}={packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,totalAmount:input.totalAmount,amountDueNow:input.amountDueNow};
  // Resolved before the subscription gate, because in LIVE the gate has to reason about what the payment
  // will be RECORDED as (verify-first), not what the client claimed it already was.
  // Authorization to keep a submitted "captured" without gateway proof is a SERVER decision, never the
  // client's: only a staff actor holding payments.manage may record an offline collection (cash) as
  // captured. A customer-app caller never holds it, so its captured is demoted whatever method it sends,
  // and no unknown/blank method can slip through — the method is not what decides.
  const offlineAuthorized=OFFLINE_METHODS.has(input.payment.method)&&hasPermission(actor.permissions,"payments.manage");
  const liveMode=(await paymentEnv())!=="sandbox",paymentStatusRecorded=recordedPaymentStatus(liveMode,input.payment,offlineAuthorized);
  let commercialPolicy=null as Awaited<ReturnType<typeof resolveGroomingPolicy>>|null;
  if(input.serviceCode==="grooming"){
    // A city with no active Grooming commercial policy (Chennai on this candidate) is a configuration
    // refusal, not an outage. It threw a bare Error from OUTSIDE the governance try/catch below, so it
    // reached the outer catch unclassified and was answered 500 - and, being an exception, it also
    // skipped every compensation path and stranded the hold. Both halves are fixed here: the refusal is
    // answered with the 409 the surrounding commercial contract already uses, and the hold is released.
    try{commercialPolicy=await resolveGroomingPolicy(db,input.cityId,input.zoneId);}
    catch(error){return refuse(error instanceof Error?error.message:"No active Grooming commercial policy is configured for this city/zone",409);}
  }
  if(commercialPolicy?.enforcementMode==="enforce"&&input.pets.length>commercialPolicy.multiPetMax)return refuse(`This city policy supports up to ${commercialPolicy.multiPetMax} pets per Grooming booking`,409,{policyVersion:policyVersion(commercialPolicy)});
  if(input.serviceCode==="grooming"){
    try{governed=await governGroomingBookingWithLiveMultiPet(db,{packageCode:input.packageCode,packageName:input.packageName,pets:input.pets.map(pet=>({species:(pet.species??"other") as "dog"|"cat"|"other"})),submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart});}catch(error){return refuse(error instanceof Error?error.message:"Invalid Grooming package or price",409);}
    // A subscription is still prepay-only — no split, no pay-after-service — but it no longer has to be
    // CAPTURED at purchase time. Requiring that was what forced the verify-first exemption. It may now be
    // an online payment awaiting gateway verification; the entitlement simply stays pending until the
    // verified capture arrives, so an unpaid purchase yields no usable credits either way.
    if(governed.subscriptionPlan){
      if(input.payment.mode!=="prepaid")return refuse("Grooming subscription purchases must be prepaid",409);
      const awaitingGateway=ONLINE_METHODS.has(input.payment.method)&&paymentStatusRecorded==="created";
      if(paymentStatusRecorded!=="captured"&&!awaitingGateway)return refuse("A Grooming subscription purchase needs a captured payment, or an online payment awaiting gateway verification",409);
    }
  }
  const assignment=await db.prepare("SELECT selected_provider_id,status,shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").bind(input.scheduleGroupId).first<Record<string,unknown>>();if(!assignment||assignment.status!=="assigned")return refuse("Scheduling must be assigned before booking confirmation",409);if(String(assignment.selected_provider_id)!==input.provider.id)return refuse("The provider does not match the scheduling decision",409);const reservations=await db.prepare("SELECT id,provider_id,city_id,zone_id,scheduled_start,scheduled_end,occurrence_number,status FROM scheduling_reservations WHERE group_id=? AND status!='cancelled' ORDER BY occurrence_number").bind(input.scheduleGroupId).all<Record<string,unknown>>();if(!reservations.results.length||reservations.results.some(row=>String(row.provider_id)!==input.provider.id))return refuse("A valid provider reservation is required",409);
  // City/zone integrity invariant (finding #7): the provider equality above is not enough. The booking
  // is persisted with the CLIENT-supplied cityId/zoneId, but the reservation it confirms was made for a
  // specific city and zone. Trust the reservation, never the client: reject if the booking's city or
  // zone does not match the reserved provider's city/zone, so a Bengaluru reservation can never be
  // confirmed into a booking labelled (and routed/priced as) Chennai.
  if(reservations.results.some(row=>String(row.city_id)!==input.cityId||String(row.zone_id)!==input.zoneId))return refuse("The booking city/zone does not match the reserved provider's city and zone",409);
  let trainingCommercial:Awaited<ReturnType<typeof governTrainingBooking>>|null=null;
  if(input.serviceCode==="dog_training"){
    const quoteId=String(input.pricing.trainingQuoteId||"").trim();if(!quoteId)return refuse("A server Training quote is required before booking confirmation",409);const first=reservations.results[0];if(String(first.scheduled_start)!==input.scheduledStart||String(first.scheduled_end)!==input.scheduledEnd)return refuse("Training booking window does not match the first reserved session",409);
    trainingCommercial=await governTrainingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,scheduledStart:input.scheduledStart,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:input.payment.status,reservationCount:reservations.results.length});governed={packageCode:trainingCommercial.packageCode,packageName:trainingCommercial.packageName,catalogueVersion:trainingCommercial.catalogueVersion,petCount:trainingCommercial.petCount,totalAmount:trainingCommercial.totalAmount,amountDueNow:trainingCommercial.amountDueNow};
  }
  let boardingCommercial:Awaited<ReturnType<typeof governBoardingBooking>>|null=null;
  if(input.serviceCode==="boarding"){
    const quoteId=String(input.pricing.boardingQuoteId||"").trim();if(!quoteId)return refuse("A server Boarding quote is required before booking confirmation",409);const first=reservations.results[0];if(String(first.scheduled_start)!==input.scheduledStart||String(first.scheduled_end)!==input.scheduledEnd)return refuse("Boarding booking window does not match the continuous stay reservation",409);
    boardingCommercial=await governBoardingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:input.payment.status,reservationCount:reservations.results.length,providerId:input.provider.id,cityId:input.cityId,zoneId:input.zoneId,species:input.pets.map(pet=>String(pet.species||"other")),vaccinationStatuses:input.pets.map(pet=>String(pet.vaccinationStatus||"not_provided"))});governed={packageCode:boardingCommercial.packageCode,packageName:boardingCommercial.packageName,catalogueVersion:boardingCommercial.catalogueVersion,petCount:boardingCommercial.petCount,totalAmount:boardingCommercial.totalAmount,amountDueNow:boardingCommercial.amountDueNow};
  }
  let referralCommercial:ReferralBookingPreparation|null=null;
  const referralClaimId=String(input.pricing.referralClaimId||"").trim();
  if(referralClaimId){
    const existingDiscount=Number(trainingCommercial?.discount??input.pricing.discount??0);
    referralCommercial=await prepareReferralBooking(db,{claimId:referralClaimId,customer:{id:input.customer.id,primaryPhone:input.customer.primaryPhone,email:input.customer.email},serviceCode:input.serviceCode,cityId:input.cityId,baseAmount:governed.totalAmount,baseAmountDueNow:governed.amountDueNow,hasOtherOffer:Boolean(trainingCommercial?.couponCode||input.pricing.couponCode||existingDiscount>0),isSubscription:Boolean(governed.subscriptionPlan||input.pricing.subscription)});
    governed={...governed,totalAmount:referralCommercial.totalAmount,amountDueNow:referralCommercial.amountDueNow};
  }
  const now=Date.now(),bookingId=`PS-UAT-${now.toString(36).toUpperCase()}-${crypto.randomUUID().slice(0,4).toUpperCase()}`,workOrderId=`WO-${crypto.randomUUID().slice(0,8).toUpperCase()}`,paymentId=`PAY-${crypto.randomUUID().slice(0,8).toUpperCase()}`,subscriptionId=governed.subscriptionPlan?`GSUB-${crypto.randomUUID().slice(0,10).toUpperCase()}`:null;
  // A booking used to mint its own canonical_pets row keyed by the pet NAME. A pet the customer had
  // already saved lives under a different source id (the account flow uses `account-<hash>`), so the
  // booking created a SECOND, empty row for the same animal — and pet_ids_json pointed at that one.
  // Every reader that resolves pets through pet_ids_json (Booking Command Center, canonical-bookings
  // GET, partner job feed) therefore showed "Breed not recorded · Vaccine Not Provided" for a pet
  // whose profile was filled in. Most booking flows send only sourceId/name/species, so the profile
  // could not arrive on the request either.
  //
  // Resolve each booking pet against THIS CUSTOMER's own pets first — by source id, then by name —
  // and reuse that row rather than minting a duplicate, inheriting whatever the caller did not send.
  // The query is scoped to input.customer.id, so two customers using the same pet name or source id
  // can never resolve onto each other's row.
  const existingPets=await db.prepare("SELECT id,source_pet_id,name,species,breed,vaccination_status FROM canonical_pets WHERE customer_id=? ORDER BY updated_at DESC").bind(input.customer.id).all<Record<string,unknown>>().catch(()=>({results:[] as Record<string,unknown>[]}));
  const petKey=(value:unknown)=>String(value??"").trim().toLowerCase();
  // A pet already booked before this fix left an empty duplicate behind whose source id IS the pet
  // name, so an id-only match would keep selecting the blank row and the card would stay empty for
  // exactly the customers who hit the bug. Prefer a candidate that actually carries a profile.
  const petHasProfile=(row:Record<string,unknown>)=>Boolean(petKey(row.breed))||(Boolean(petKey(row.vaccination_status))&&petKey(row.vaccination_status)!=="not_provided");
  const resolvedPets=input.pets.map(pet=>{
    const candidates=[
      ...existingPets.results.filter(row=>petKey(row.source_pet_id)&&petKey(row.source_pet_id)===petKey(pet.sourceId)),
      ...existingPets.results.filter(row=>petKey(row.name)===petKey(pet.name)),
    ];
    const match=candidates.find(petHasProfile)??candidates[0];
    // 'not_provided' is the column's own sentinel for "unknown", and several booking flows send it
    // (or an empty breed) as a literal rather than omitting the field. Treat both as absent, so a
    // caller with nothing to say cannot out-rank the profile the customer actually saved.
    const suppliedBreed=petKey(pet.breed)?String(pet.breed):null;
    const suppliedVaccination=petKey(pet.vaccinationStatus)&&petKey(pet.vaccinationStatus)!=="not_provided"?String(pet.vaccinationStatus):null;
    const inheritedBreed=match&&petKey(match.breed)?String(match.breed):null;
    const inheritedVaccination=match&&petKey(match.vaccination_status)&&petKey(match.vaccination_status)!=="not_provided"?String(match.vaccination_status):null;
    return {
      id:match?String(match.id):petId(input.customer.id,pet.sourceId),
      name:pet.name,
      species:pet.species??(match?String(match.species):undefined)??"dog",
      breed:suppliedBreed??inheritedBreed,
      vaccinationStatus:suppliedVaccination??inheritedVaccination??"not_provided",
      sourceId:pet.sourceId,
    };
  });
  const ids=resolvedPets.map(pet=>pet.id);
  const pricingJson={...input.pricing,discount:referralCommercial?.discountAmount??trainingCommercial?.discount??input.pricing.discount,couponCode:trainingCommercial?.couponCode??input.pricing.couponCode,referralClaimId:referralCommercial?.claimId,referralCode:referralCommercial?.code,referralPolicy:referralCommercial?.policySnapshot,referralBaseAmount:referralCommercial?.baseAmount,catalogueVersion:governed.catalogueVersion,offerType:governed.offerType,subscription:subscriptionId??input.pricing.subscription,subscriptionPlanCode:governed.subscriptionPlan?.planCode,subscriptionConfig:governed.subscriptionPlan,commercialPolicy:commercialPolicy?policySnapshot(commercialPolicy):undefined,trainingCommercial:trainingCommercial??undefined,boardingCommercial:boardingCommercial??undefined};
  // The entitlement is only live money's to grant. Captured (sandbox, or an offline capture) creates it
  // active; anything awaiting gateway verification creates it pending with zero sessions reserved.
  const entitlementActive=paymentStatusRecorded==="captured";
  const statements=[
    db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?,?) ON CONFLICT(id) DO UPDATE SET city_id=excluded.city_id,name=excluded.name,primary_phone=excluded.primary_phone,secondary_phone=excluded.secondary_phone,email=excluded.email,updated_at=excluded.updated_at").bind(input.customer.id,input.cityId,input.customer.name,input.customer.primaryPhone,input.customer.secondaryPhone??null,input.customer.email??null,"uat_customer_app",JSON.stringify({serviceUpdates:true,marketing:false}),now,now),
    // The conflict clause must not overwrite a stored profile with the blanks a booking payload
    // carries: breed only moves when a value is actually supplied, and 'not_provided' never demotes a
    // vaccination status that is already recorded. Without this, booking the same pet a second time
    // erased the breed and vaccination the customer had entered. The customer_id guard keeps a
    // booking from ever writing over another customer's pet row.
    ...resolvedPets.map(pet=>db.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,species=excluded.species,breed=COALESCE(excluded.breed,canonical_pets.breed),vaccination_status=CASE WHEN excluded.vaccination_status='not_provided' THEN canonical_pets.vaccination_status ELSE excluded.vaccination_status END,source_pet_id=COALESCE(canonical_pets.source_pet_id,excluded.source_pet_id),updated_at=excluded.updated_at WHERE canonical_pets.customer_id=excluded.customer_id").bind(pet.id,input.customer.id,pet.name,pet.species,pet.breed,pet.vaccinationStatus,pet.sourceId,now,now)),
    db.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(bookingId,input.idempotencyKey,input.customer.id,JSON.stringify(ids),JSON.stringify(input.pets.map(p=>p.sourceId)),input.cityId,input.zoneId,input.serviceCode,governed.packageCode,governed.packageName,input.scheduleGroupId,input.provider.id,input.scheduledStart,input.scheduledEnd,"confirmed","customer_app",governed.totalAmount,"INR",JSON.stringify(pricingJson),input.customer.id,now,now),
    db.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(workOrderId,bookingId,input.scheduleGroupId,input.provider.id,input.provider.name,input.provider.model,input.serviceCode,input.scheduledStart,input.scheduledEnd,reservations.results.length,input.provider.model==="commission"?"awaiting_acceptance":"assigned",JSON.stringify({reservations:reservations.results,decision:assignment}),now,now),
    db.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(paymentId,bookingId,input.customer.id,governed.totalAmount,governed.amountDueNow,"INR",input.payment.method,input.payment.mode,paymentStatusRecorded,"uat_sandbox",`${input.idempotencyKey}:payment`,JSON.stringify({detail:input.payment.detail,liveMoney:false,catalogueVersion:governed.catalogueVersion,trainingQuoteId:trainingCommercial?.quoteId,boardingQuoteId:boardingCommercial?.quoteId,referralClaimId:referralCommercial?.claimId,referralDiscount:referralCommercial?.discountAmount}),now,now),
  ];
  if(trainingCommercial)statements.push(trainingQuoteLinkStatement(db,trainingCommercial.quoteId,bookingId));
  if(boardingCommercial)statements.push(boardingQuoteLinkStatement(db,boardingCommercial.quoteId,bookingId),boardingStayStatement(db,{bookingId,customerId:input.customer.id,providerId:input.provider.id,cityId:input.cityId,zoneId:input.zoneId,packageCode:boardingCommercial.packageCode,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,stayUnits:boardingCommercial.stayUnits,petCount:boardingCommercial.petCount}));
  if(boardingCommercial&&boardingCommercial.paymentMode==="split_50_50"){await ensureStayPaymentTables(db);const plan=splitPaymentPlan({totalAmount:boardingCommercial.totalAmount,scheduledStart:input.scheduledStart});statements.push(staySplitScheduleStatement(db,{bookingId,serviceCode:"boarding",customerId:input.customer.id,totalAmount:boardingCommercial.totalAmount,paidNowAmount:boardingCommercial.amountDueNow,balanceAmount:plan.balance,balanceDueAt:plan.balanceDueAt}));}
  // Pet Sitting on this path is client-priced (no server quote yet); record the split schedule from
  // the submitted amounts so the balance is tracked and collectable, requiring a real outstanding
  // balance and a stay that starts more than 24h out (splitPaymentPlan enforces the lead time).
  if(input.serviceCode==="pet_sitting"&&input.payment.mode==="split_50_50"){if(!(input.totalAmount>input.amountDueNow))return refuse("Split payment requires an outstanding balance below the total",409);await ensureStayPaymentTables(db);const plan=splitPaymentPlan({totalAmount:input.totalAmount,scheduledStart:input.scheduledStart});statements.push(staySplitScheduleStatement(db,{bookingId,serviceCode:"pet_sitting",customerId:input.customer.id,totalAmount:input.totalAmount,paidNowAmount:input.amountDueNow,balanceAmount:Math.round((input.totalAmount-input.amountDueNow)*100)/100,balanceDueAt:plan.balanceDueAt}));}
  if(referralCommercial)statements.push(referralBookingLinkStatement(db,{preparation:referralCommercial,bookingId,now}),referralClaimBoundStatement(db,{claimId:referralCommercial.claimId,now}));
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
  const events:Array<readonly[string,string,string,Record<string,unknown>]>=[["scheduling_linked","schedule_group",input.scheduleGroupId,{providerId:input.provider.id,occurrences:reservations.results.length}],["booking_created","booking",bookingId,{serviceCode:input.serviceCode,packageName:governed.packageName,catalogueVersion:governed.catalogueVersion,commercialPolicyVersion:commercialPolicy?policyVersion(commercialPolicy):undefined,trainingSessions:trainingCommercial?.sessions,trainingValidityDays:trainingCommercial?.validityDays,trainingQuoteId:trainingCommercial?.quoteId,boardingQuoteId:boardingCommercial?.quoteId,boardingStayUnits:boardingCommercial?.stayUnits,boardingHostProfileVersion:boardingCommercial?.host.profileVersion,referralClaimId:referralCommercial?.claimId,referralDiscount:referralCommercial?.discountAmount}],["work_order_created","work_order",workOrderId,{status:input.provider.model==="commission"?"awaiting_acceptance":"assigned"}],// the RECORDED status, not the submitted claim: the lifecycle trail must not read "captured" for a
// payment the platform persisted as awaiting gateway verification
["payment_recorded","payment",paymentId,{status:paymentStatusRecorded,submittedStatus:input.payment.status,gateway:"uat_sandbox",liveMoney:false,amount:governed.totalAmount,amountDueNow:governed.amountDueNow}]];
  if(referralCommercial)events.push(["referral_claim_bound","referral_claim",referralCommercial.claimId,{programmeId:referralCommercial.programmeId,code:referralCommercial.code,baseAmount:referralCommercial.baseAmount,discountAmount:referralCommercial.discountAmount,totalAmount:referralCommercial.totalAmount,testOnly:true,liveMoney:false}]);
  if(subscriptionId&&governed.subscriptionPlan)events.push([entitlementActive?"subscription_reserved":"subscription_pending_payment","subscription",subscriptionId,{planCode:governed.subscriptionPlan.planCode,sessionsReserved:entitlementActive?governed.subscriptionPlan.reserveSessions:0,totalSessions:governed.subscriptionPlan.sessions,validityValue:governed.subscriptionPlan.validityValue,validityUnit:governed.subscriptionPlan.validityUnit,cityId:governed.subscriptionPlan.cityId,zoneId:governed.subscriptionPlan.zoneId,awaitingGatewayVerification:!entitlementActive}]);
  for(const [eventType,entityType,entityId,detail] of events)statements.push(db.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,entityType,entityId,input.customer.id,JSON.stringify(detail),now));
  await db.batch(statements);if(trainingCommercial)await consumeTrainingQuote(db,trainingCommercial.quoteId,bookingId);if(boardingCommercial)await consumeBoardingQuote(db,boardingCommercial.quoteId,bookingId);await attributeBookingToOpenLead(db,{customerId:input.customer.id,bookingId});const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();return json({data:await readBundle(db,booking!,false)},201);
}catch(error){if(error instanceof Response){const message=await error.text().catch(()=>"");return json({error:message||"Canonical booking validation failed"},error.status||409);}return json({error:error instanceof Error?error.message:"Unable to create shared booking lifecycle"},500);}}
