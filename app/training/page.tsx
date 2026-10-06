"use client";
import TestCoinServicePreview from "../v2/test-coin-service-preview";
import Link from"next/link";
import{isVaccinatedStatus}from"../../lib/pet-vaccination-status";
import{trainingPriceForPets}from"../../lib/training-pricing";
import{TRAINING_FALLBACK_GOALS,recommendTrainingPlan}from"../../lib/training-goals";
import{useEffect,useMemo,useRef,useState}from"react";
import{loadTrainingPackages,loadTrainingTrainers,quoteTraining,type TrainingPackage,type TrainingQuote,type TrainingTrainer}from"../../lib/training-commercial-client";
import{reserveUatSchedule,SchedulingRefusal}from"../../lib/uat-scheduling-client";
import{loadAvailableTrainingTrainers,trainingReservationForChoice}from"../../lib/training-availability-client";
import{Button}from"../components/ui";
import{createCanonicalTrainingBooking,type TrainingBookingResult}from"../../lib/training-booking-client";
import{loadTrainingProgramme,prepareTrainingProgramme,type CustomerTrainingProgramme}from"../../lib/training-programme-client";
import{AUTO_MATCH_COPY,programmeAssignment,trainerAssignmentView}from"../../lib/training-assignment-view";
import{ROLLING_CHECKOUT_COPY,TRAINING_SCHEDULING_MODE,trainingEntitlementSummary,type RollingQuoteInput,type RollingSelection}from"../../lib/training-rolling-checkout";
import AssignedTrainerName,{useAssignedTrainerName}from"./assigned-trainer";
import NextAppointment from"./next-appointment";
import{loadCustomerAccount,type CustomerPet}from"../../lib/customer-account-client";
import type{CustomerAccountRecord}from"../../lib/customer-account";
import{trainingQuoteKey,trainingQuoteSpendable,trainingLocationPincode,trainingLocationZone}from"../../lib/training-booking-guards";
import styles from"./canonical-training.module.css";
import TrainingFamilyChoices from "./training-family-choices";
import BookingPaymentPage from"../mobile-app/booking-payment-page";
import {loadVerifiedTrainingConfirmation,TrainingConfirmationPendingError} from "../../lib/training-confirmation-client";
import{customerScopedHref}from"../../lib/v2/route-scope";
import{formatIndiaRange}from"../../lib/india-time";
import{customerTrainingSessionStatus,trainingSessionCount}from"../../lib/training-session-status";
import{useQueryParameter}from"../../lib/use-query-parameter";
import{serviceAddressText}from"../../lib/service-address-text";
import{checkFirstSessionSelection,earliestFirstSessionDate,firstSessionHours,firstSessionRuleLabel,hourLabel}from"../../lib/training-first-session-rule";

// The customer and the pets are the SIGNED-IN ones, read from the platform session — never a fixture.
// This page used to hardcode customer TST-101 with pets TST-PET-BRUNO/TST-PET-PEPPER. Any other
// signed-in customer got as far as the final button and then hit a 403 from the session gateway
// ("Identity session does not own this customer/provider scope"), because /api/uat-scheduling scopes
// the reservation to body.customerId and refuses a subject the session does not own. The page looked
// complete — real catalogue, real price, real trainers — and simply would not go through.
// The first session may not start before the two full preparation days have passed (lib/training-first-session-rule.ts).
const initialDate=()=>earliestFirstSessionDate();
const money=(value:number)=>`₹${Number(value||0).toLocaleString("en-IN")}`;
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");

export default function TrainingPage({routeScope="legacy"}:{routeScope?:"legacy"|"v2"}={}){
 const pathname=routeScope==="v2"?"/v2/training":"/training",href=(path:string)=>customerScopedHref(pathname,path);
 // [CUST-L-D11] reopening this page with ?bookingId= (from /v2/activity, or a resumed link) rendered
 // the SAME empty catalogue form as a fresh visit, with no acknowledgement of the existing booking —
 // the only actionable control was "Refresh trainer availability". A held booking gets a visible path
 // to its owned booking/payment record instead (reusing the /v2/booking page from CUST-L-D04, which
 // itself renders a Manage link when one exists).
 const recoveryBookingId=useQueryParameter("bookingId");
 // Each route scope keeps its own booking/payment page: V2 uses /v2/booking, legacy the mobile-app confirmation.
 const bookingRecordHref=(bookingId:string)=>routeScope==="v2"?`/v2/booking?bookingId=${encodeURIComponent(bookingId)}`:`/mobile-app/booking-confirmation?bookingId=${encodeURIComponent(bookingId)}`;
 const[date,setDate]=useState(initialDate);
 const[time,setTime]=useState("10:00");
  // Goals and notes the trainer reads as the programme requirements (V2 recorded none before 26 Sep 2026).
  const[goalOptions,setGoalOptions]=useState<string[]>([...TRAINING_FALLBACK_GOALS]),[goals,setGoals]=useState<string[]>([]),[behaviourNotes,setBehaviourNotes]=useState("");
  useEffect(()=>{const controller=new AbortController();void fetch("/api/training-requirements",{signal:controller.signal}).then(response=>response.json()).then((body:{data?:Array<{label:string;active:number}>})=>{const active=body.data?.filter(item=>item.active).map(item=>item.label);if(active?.length)setGoalOptions(active);}).catch(()=>undefined);return()=>controller.abort();},[]);
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null);
 const[accountLoading,setAccountLoading]=useState(true);
 const[accountError,setAccountError]=useState("");
 const[selectedPetIds,setSelectedPetIds]=useState<string[]>([]);
 const[packageCode,setPackageCode]=useState("");
 const[paymentMode,setPaymentMode]=useState<"prepaid"|"split">("split");
 const[packages,setPackages]=useState<TrainingPackage[]>([]);
 const[quote,setQuote]=useState<TrainingQuote|null>(null);
 // The exact input signature the held quote was priced for. A quote is only usable while this still
 // matches the form, so a quote can never outlive the selections that produced it.
 const[quotedKey,setQuotedKey]=useState("");
 // Both stamped with the account they were resolved for, so a result can never be read against a
 // different account than it was fetched for — the derived values below do the invalidating.
 const[resolvedLocation,setResolvedLocation]=useState<{accountId:string;cityId:string;zoneId:string;zoneName:string}|null>(null);
 const[locationRefusal,setLocationRefusal]=useState<{accountId:string;reason:string}|null>(null);
 const[availability,setAvailability]=useState<{key:string;providers:TrainingTrainer[];error?:string}|null>(null);
 const[availabilityRefresh,setAvailabilityRefresh]=useState(0);
 const bookingRequest=useRef(false);
 // Automatic matching only (workbook rows 16-36): the customer never chooses a trainer and no preferredProviderId is sent.
 const providerSelection="auto" as const;
 const[catalogueLoading,setCatalogueLoading]=useState(true);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[booking,setBooking]=useState<TrainingBookingResult|null>(null);
 const[programme,setProgramme]=useState<CustomerTrainingProgramme|null>(null);
 const[paymentVerified,setPaymentVerified]=useState(false);
 const[confirmationError,setConfirmationError]=useState("");
 const confirmationRequest=useRef<AbortController|null>(null);
 useEffect(()=>()=>{confirmationRequest.current?.abort();confirmationRequest.current=null;},[]);
 const[pendingCheckout,setPendingCheckout]=useState<{booking:TrainingBookingResult;programme:CustomerTrainingProgramme|null;total:number;dueNow:number;mode:"prepaid"|"split";summary:{packageName:string;petNames:string;start:string;end:string;address:string}}|null>(null);
 const scheduledStart=`${date}T${time}:00+05:30`;
 // Refused on screen before any reservation: a past slot, a slot inside the two preparation days, or a start off the hour or outside 08:00-20:00 IST.
 const firstSession=checkFirstSessionSelection({date,time});
 const savedAddress=account?.addresses.find(item=>item.isDefault)||account?.addresses[0];
 const savedAddressText=savedAddress?serviceAddressText(savedAddress):"Address not saved";
 const activePackage=useMemo(()=>packages.find(item=>item.package_code===packageCode),[packages,packageCode]);
 // Dog Training is a dogs-only service, so only the customer's dogs can be enrolled.
 const dogs=useMemo(()=>(account?.pets||[]).filter(pet=>pet.species==="dog"),[account]);
 const selectedPets=useMemo(()=>dogs.filter(pet=>selectedPetIds.includes(pet.id)),[dogs,selectedPetIds]);
 // The plan the chosen goals point to, shown on its button only. It never selects it: every package change prices
 // a quote and checks availability for the first appointment, and tapping a goal must not do that.
 const recommendation=useMemo(()=>recommendTrainingPlan({goals,packageCodes:packages.map(item=>item.package_code),dogs:selectedPets}),[goals,packages,selectedPets]);
 const petCount=selectedPets.length;
 const petLabel=(pet:CustomerPet)=>[pet.breed,pet.profile?.ageBand].filter(Boolean).join(" · ")||"Dog";
 const location=account&&resolvedLocation?.accountId===account.customerId?resolvedLocation:null;
 const locationError=account&&locationRefusal?.accountId===account.customerId?locationRefusal.reason:"";
 const locationLoading=Boolean(account)&&!location&&!locationError;
 const effectiveMode=packageCode==="trainer-meet-greet"?"prepaid":paymentMode;
 // Everything that changes the price. The quote is only spendable while its key matches this.
 const quoteKey=trainingQuoteKey({scheduledStart,packageCode,paymentMode:effectiveMode,petIds:selectedPetIds});
 const quoteReady=trainingQuoteSpendable({hasQuote:quote!==null,quotedKey,currentKey:quoteKey});
 // Every consumer reads THIS, never `quote`. The moment any priced input changes, quotedKey no
 // longer matches quoteKey and currentQuote is null — the old price is gone from the UI and from
 // confirm() in the same render, with no state write and therefore no window to race against.
 const currentQuote=quoteReady?quote:null;
 const availabilityKey=JSON.stringify([quoteKey,account?.customerId,location?.cityId,location?.zoneId,availabilityRefresh]);
 const trainers=availability?.key===availabilityKey?availability.providers:[];
 const activeTrainer=trainers[0];
 const availabilityLoading=Boolean(location&&petCount>0&&availability?.key!==availabilityKey);

 // Resolve the signed-in customer from the platform session. loadCustomerAccount() sends no id: the
 // server derives the subject from the session, which is the same identity the booking is scoped to,
 // so the two can never disagree the way a hardcoded fixture did.
 useEffect(()=>{
  let active=true;
  loadCustomerAccount().then(record=>{
   if(!active)return;
   setAccount(record);
   const ownDogs=record.pets.filter(pet=>pet.species==="dog");
   setSelectedPetIds(current=>{const kept=current.filter(id=>ownDogs.some(pet=>pet.id===id));return kept.length?kept:ownDogs[0]?[ownDogs[0].id]:[];});
   setAccountError("");
  }).catch(problem=>{if(active)setAccountError(problem instanceof Error?problem.message:"Sign in as a customer to book a Training programme")})
   .finally(()=>{if(active)setAccountLoading(false)});
  return()=>{active=false};
 },[]);
 const togglePet=(id:string)=>{if(!selectedPetIds.includes(id)&&selectedPetIds.length>=4){setError("Choose up to four dogs for one programme. Contact PawSpace for a larger family.");return;}setError("");setSelectedPetIds(current=>current.includes(id)?current.filter(petId=>petId!==id):[...current,id]);};

 // Where the customer actually is, resolved from the ONE server-owned mapping that exists:
 // lib/service-zones.ts maps a pincode to a governed zone (/api/service-zone). There is deliberately
 // no city→zone mapping invented here — SERVICE_ZONES contains Bengaluru zones only, so a customer
 // outside Bengaluru has no zone to be booked into and the page fails closed and says so. Previously
 // this page hardcoded blr/blr-east for availability, scheduling and the canonical booking, which
 // only stayed correct because it also hardcoded a Bengaluru fixture customer.
 useEffect(()=>{
  if(!account)return;
  let active=true;
  const fail=(reason:string)=>{if(active){setResolvedLocation(null);setLocationRefusal({accountId:account.customerId,reason});}};
  const wanted=trainingLocationPincode(account);
  if(!wanted.ok){fail(wanted.reason);return;}
  const pincode=wanted.pincode;
  void fetch(`/api/service-zone?pincode=${encodeURIComponent(pincode)}`,{cache:"no-store"})
   .then(async response=>{
    const body=await response.json().catch(()=>({})) as {data?:{zone:{zoneId:string;zoneName:string;serviceAvailable:boolean}};error?:string};
    if(!active)return;
    const decided=trainingLocationZone(response.ok&&body.data?body.data.zone:null,pincode);
    if(!decided.ok){fail(decided.reason);return;}
    setResolvedLocation({accountId:account.customerId,cityId:account.cityId,zoneId:decided.zoneId,zoneName:decided.zoneName});
    setLocationRefusal(null);
   })
   .catch(()=>fail("Unable to confirm your training zone right now."));
  return()=>{active=false};
 },[account]);

 // The package catalogue does not depend on the customer's zone, so it loads on its own. Keeping it
 // in the availability effect meant a customer we cannot service sat on "Loading canonical Training
 // catalogue…" forever, because that effect returns early when there is no location.
 useEffect(()=>{
  let active=true;
  loadTrainingPackages()
   .then(catalogue=>{if(active)setPackages(catalogue.packages);})
   .catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to load the Training catalogue");})
   .finally(()=>{if(active)setCatalogueLoading(false);});
  return()=>{active=false};
 },[]);

 // Availability and price are re-fetched whenever any input that drives them changes. The previous
 // quote is dropped on the FIRST line, before the network call, so there is never a window where the
 // form shows new selections while a stale price is still spendable — that window is what let an old
 // quote be submitted against changed dogs or a changed date.
 useEffect(()=>{
  let active=true;const controller=new AbortController();
  const mode=effectiveMode,pricedKey=quoteKey,searchKey=availabilityKey;
  if(!location)return()=>{active=false};
  if(!account)return()=>{active=false};
  void Promise.all([
   // No dog selected yet — there is nothing to price, and a 0-pet quote is not a real quote.
   petCount>0&&packageCode?quoteTraining({packageCode,petCount,scheduledStart,paymentMode:mode,schedulingMode:TRAINING_SCHEDULING_MODE} as RollingQuoteInput):Promise.resolve(null),
   loadTrainingTrainers({cityId:location.cityId,zoneId:location.zoneId,at:scheduledStart}),
  ]).then(async([nextQuote,providerResult])=>{
   if(!active)return;
   setQuote(nextQuote);
   // Stamp the quote with the inputs it was priced for. Belt and braces with `active`: even if a
   // slower earlier response were ever applied, it carries ITS key, not the current one, so
   // quoteReady stays false and confirm() refuses it rather than spending a superseded price.
   setQuotedKey(nextQuote?pricedKey:"");
   const available=nextQuote?await loadAvailableTrainingTrainers({customerId:account.customerId,petIds:selectedPetIds,cityId:location.cityId,zoneId:location.zoneId,scheduledStart,quote:nextQuote,schedulingMode:TRAINING_SCHEDULING_MODE} as RollingSelection,providerResult.providers,controller.signal):[];
   if(!active)return;
   setAvailability({key:searchKey,providers:available});
   setError("");
  }).catch(problem=>{if(active){const message=problem instanceof Error?problem.message:"Unable to load canonical Training availability";setAvailability({key:searchKey,providers:[],error:message});setError(message);}});
  return()=>{active=false;controller.abort()};
 },[date,packageCode,paymentMode,petCount,scheduledStart,effectiveMode,quoteKey,location,account,selectedPetIds,availabilityKey]);

 useEffect(()=>{if(packageCode==="trainer-meet-greet"&&paymentMode!=="prepaid")queueMicrotask(()=>setPaymentMode("prepaid"))},[packageCode,paymentMode]);

 async function hydrateVerifiedBooking(base:TrainingBookingResult){
  if(confirmationRequest.current)return;
  const controller=new AbortController();confirmationRequest.current=controller;
  const timer=window.setTimeout(()=>controller.abort(),30_000);
  setBusy(true);setConfirmationError("");
  try{
   for(let attempt=0;attempt<3;attempt+=1){
    try{
     const verified=await loadVerifiedTrainingConfirmation(base,controller.signal);
     if(confirmationRequest.current!==controller||controller.signal.aborted)return;
     setBooking(verified.booking);setProgramme(verified.programme);
     setPendingCheckout(null);window.scrollTo(0,0);return;
    }catch(problem){
     if(!(problem instanceof TrainingConfirmationPendingError)||attempt===2||controller.signal.aborted)throw problem;
     await new Promise(resolve=>window.setTimeout(resolve,500));
    }
   }
  }catch(problem){
   if(confirmationRequest.current===controller)setConfirmationError(controller.signal.aborted?
    "Confirmation refresh timed out. Refresh confirmation; do not pay again.":
    problem instanceof Error?problem.message:"Unable to refresh Training confirmation. Do not pay again.");
  }finally{
   window.clearTimeout(timer);
   if(confirmationRequest.current===controller){confirmationRequest.current=null;setBusy(false);}
  }
 }

 async function confirm(){
  // quoteReady is the guard that matters: a quote priced for different dogs, a different date,
  // package or payment mode is not spendable, no matter that one is still held in state.
  if(!currentQuote||!activeTrainer||busy||bookingRequest.current||!account||!location||selectedPets.length===0||!firstSession.ok)return;
  bookingRequest.current=true;setBusy(true);setError("");
  let createdBookingId="";
  try{
   const quote=currentQuote;
   const customer={id:account.customerId,name:account.name,primaryPhone:account.primaryPhone,secondaryPhone:account.secondaryPhone??undefined,email:account.email??undefined};
   const bookingPets=selectedPets.map(pet=>({sourceId:pet.sourceId??pet.id,name:pet.name,species:"dog",breed:pet.breed??undefined,vaccinationStatus:pet.vaccinationStatus}));
   const selection:RollingSelection={customerId:customer.id,petIds:selectedPets.map(pet=>pet.id),cityId:location.cityId,zoneId:location.zoneId,scheduledStart,quote,schedulingMode:TRAINING_SCHEDULING_MODE};
   // Frozen rolling contract: the backend-owned helper reserves exactly the first appointment (one occurrence, trainingQuoteId, trainingSchedulingMode) and omits preferredProviderId.
   const request=trainingReservationForChoice(selection,{mode:providerSelection});
   const scheduledEnd=request.scheduledEnd,requestId=request.clientRequestId;
   const schedule=await reserveUatSchedule(request);
   if(!schedule.provider||schedule.groupId!==requestId)throw new Error("PawSpace could not confirm a trainer for this request. No payment has been started.");
   const result=await createCanonicalTrainingBooking({idempotencyKey:requestId,scheduleGroupId:schedule.groupId,trainingQuote:quote,customer,pets:bookingPets,cityId:location.cityId,zoneId:location.zoneId,scheduledStart,scheduledEnd,provider:schedule.provider,requirements:goals,behaviourNotes});
   createdBookingId=result.bookingId;
   const recoveryUrl=new URL(window.location.href);recoveryUrl.searchParams.set("bookingId",result.bookingId);window.history.replaceState(window.history.state,"",recoveryUrl.pathname+recoveryUrl.search);
   const nextProgramme=await prepareTrainingProgramme({bookingId:result.bookingId,packageCode:quote.packageCode});
   setPaymentVerified(false);setConfirmationError("");
   setPendingCheckout({booking:result,programme:nextProgramme,total:quote.totalAmount,dueNow:quote.amountDueNow,mode:quote.paymentMode,summary:{packageName:quote.packageName,petNames:selectedPets.map(pet=>pet.name).join(", "),start:scheduledStart,end:scheduledEnd,address:savedAddressText}});window.scrollTo(0,0);
  }catch(problem){if(createdBookingId){window.location.assign(bookingRecordHref(createdBookingId));return;}const message=problem instanceof Error?problem.message:"Unable to confirm canonical Training programme";setError(message);if(problem instanceof SchedulingRefusal){setAvailability({key:availabilityKey,providers:[],error:message});}}
  finally{bookingRequest.current=false;setBusy(false)}
 }

 const checkoutAssignment=pendingCheckout?trainerAssignmentView({assignment:programmeAssignment(pendingCheckout.programme)}):null;
 const programmeView=programme?trainerAssignmentView({assignment:programmeAssignment(programme)}):null;
 const assignedTrainerName=useAssignedTrainerName(programmeView);
 // An assessment (Meet & Greet) has no prepared programme: its execution assignment is read from the programme ledger,
 // so an immediately assigned full-time trainer shows as assigned, not as pending.
 const[assessment,setAssessment]=useState<{bookingId:string;programme:CustomerTrainingProgramme|null}|null>(null);
 const assessmentBookingId=booking&&!programme?booking.bookingId:"";
 useEffect(()=>{if(!assessmentBookingId)return;let active=true;const controller=new AbortController();void loadTrainingProgramme(assessmentBookingId,controller.signal).then(result=>{if(active)setAssessment({bookingId:assessmentBookingId,programme:result});}).catch(()=>{if(active)setAssessment({bookingId:assessmentBookingId,programme:null});});return()=>{active=false;controller.abort();};},[assessmentBookingId]);
 const assessmentView=trainerAssignmentView({assignment:assessment?.bookingId===assessmentBookingId?programmeAssignment(assessment.programme):null});
 if(pendingCheckout)return <main className={styles.shell}>
  <header><Link href={href("/")}>PawSpace</Link><p>TRAINING - PAYMENT</p>
   <h1>{paymentVerified?"Payment verified. Updating confirmation.":"Complete payment to confirm"}</h1>
   <p>{paymentVerified?"We are reading your booking, trainer assignment and programme from PawSpace. Do not pay again.":"Your session calendar is held while Razorpay verifies the sandbox payment. Your certified trainer is confirmed by the award, not by this hold."}</p>
  </header>
  <section className={styles.card} aria-label="Reserved training details"><h2>{pendingCheckout.summary.packageName}</h2><p>Booking reference: {pendingCheckout.booking.bookingId}</p><p>Trainer: {checkoutAssignment?.label} · {pendingCheckout.summary.petNames}</p><p>{checkoutAssignment?.detail}</p><p>First session: {formatIndiaRange(pendingCheckout.summary.start,pendingCheckout.summary.end)}</p><p>Service address: {pendingCheckout.summary.address}</p><Link href={bookingRecordHref(pendingCheckout.booking.bookingId)}>View your first appointment and payment status</Link></section>
  {confirmationError&&<p role="alert">{confirmationError}</p>}
  {paymentVerified?<section className={styles.card} aria-label="Training confirmation recovery">
   {busy&&<p role="status">Refreshing canonical Training confirmation...</p>}
   <button type="button" disabled={busy} onClick={()=>void hydrateVerifiedBooking(pendingCheckout.booking)}>Refresh confirmation</button>
   <Link href={href("/mobile-app")}>My PawSpace</Link>
  </section>:<BookingPaymentPage serviceName="Dog Training" totalAmount={pendingCheckout.total}
   amountDueNow={pendingCheckout.dueNow} mode={pendingCheckout.mode} bookingId={pendingCheckout.booking.bookingId}
   busy={busy} onVerified={async()=>{setPaymentVerified(true);await hydrateVerifiedBooking(pendingCheckout.booking);}}/>}
 </main>;

 if(booking&&!programme)return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><h1>Trainer Meet &amp; Greet confirmed</h1><p>Your payment is verified. Trainer: <AssignedTrainerName view={assessmentView}/>. {assessmentView.detail}</p></header><section className={styles.card}><h2>{booking.bookingId}</h2><p>{label(booking.status)}</p><Link href={routeScope==="v2"?"/v2/activity":"/mobile-app"}>View your bookings</Link></section></main>;
 if(booking&&programme)return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><p>{routeScope==="v2"?"DOG TRAINING":"TRAINING · CANONICAL UAT"}</p><h1>Training programme confirmed</h1><p>{routeScope==="v2"?"Your first appointment is reserved. The rest of your purchased sessions are scheduled later, one at a time, and your trainer appears below once assigned; manage everything under Activity.":"Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity."}</p></header>{error&&<p role="alert">{error}</p>}<section className={styles.grid3}><article className={styles.card}><small>Booking</small><strong className={styles.block}>{booking.bookingId}</strong><span>{label(booking.status)}</span></article><article className={styles.card}><small>Programme</small><strong className={styles.block}>{programme.programme.id}</strong><span>{routeScope==="v2"?trainingSessionCount(Number(programme.programme.total_sessions)):`${programme.programme.total_sessions} session(s)`}</span></article><article className={styles.card}><small>Trainer</small><strong className={styles.block}>{programmeView&&<AssignedTrainerName view={programmeView}/>}</strong><span>{programmeView?.detail}</span></article></section><section className={styles.card}><h2>Programme sessions</h2>{programme.sessions.map(session=><article key={session.id} className={styles.sessionRow}><strong>Session {session.sequence_no} · {routeScope==="v2"?customerTrainingSessionStatus(session.status):label(session.status)}</strong><div>{formatIndiaRange(session.scheduled_start,session.scheduled_end)}</div>{routeScope!=="v2"&&<small>{session.id}</small>}</article>)}</section><section className={styles.card}><NextAppointment key={booking.bookingId} bookingId={booking.bookingId} assignment={programmeView??trainerAssignmentView({})} trainerName={assignedTrainerName}/></section>{routeScope!=="v2"&&<section className={styles.card}><h2>UAT boundaries</h2><p>Payment is confirmed only from verified Razorpay sandbox evidence. Production media storage/scanning, GST/tax invoicing, payout execution and external messaging remain configuration/launch dependencies.</p><div className={styles.actions}><Link href={href("/mobile-app")}>My PawSpace</Link><button onClick={()=>{window.location.assign(pathname)}}>Book another programme</button></div></section>}</main>;

 if(recoveryBookingId)return <main className={styles.shell}><section className={styles.card} aria-label="Existing training booking"><h1>Your Training booking is saved</h1><p>{recoveryBookingId}</p><p>Resume the same booking to check its first appointment and payment. This page will not create another booking.</p><Link href={bookingRecordHref(recoveryBookingId)}>View booking &amp; payment →</Link><p><Link href={pathname}>Start a separate booking</Link></p></section></main>;
 return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><p>{routeScope==="v2"?"DOG TRAINING":"DOG TRAINING · CANONICAL UAT"}</p><h1>{routeScope==="v2"?"Choose the right training programme":"Choose a server-owned Training programme"}</h1><p>{routeScope==="v2"?"Pick your dogs, a plan and a time. Programme pricing and first-appointment availability are checked live.":"Catalogue, price, trainer eligibility and schedule are read from PawSpace governance. The browser no longer invents a plan, trainer or progress journey."}</p></header>{routeScope==="v2"&&recoveryBookingId&&<section className={styles.card} aria-label="Existing training booking"><p>Already reserved a programme? Your booking, its payment status and Manage link are on its own page.</p><div className={styles.actions}><Link href={bookingRecordHref(recoveryBookingId)}>View booking & payment →</Link></div></section>}{error&&<p role="alert">{error}</p>}<section className={styles.card}><h2>1. Your dogs and service address</h2><div className={styles.grid2}><div role="group" aria-labelledby="training-dogs-label"><span id="training-dogs-label">Dogs</span>{accountLoading?<p>Loading your pets…</p>:accountError?<p role="alert">{accountError} <Link href={href("/mobile-app")}>Sign in →</Link></p>:dogs.length===0?<p>No dogs on your profile yet. <Link href={href("/mobile-app")}>Add one in My PawSpace →</Link></p>:<div className={styles.petList}>{dogs.map(pet=><button key={pet.id} type="button" onClick={()=>togglePet(pet.id)} aria-pressed={selectedPetIds.includes(pet.id)} className={styles.choice}><strong>{pet.name}</strong><small className={styles.block}>{petLabel(pet)}</small></button>)}<small>{petCount} {petCount===1?"dog":"dogs"} selected{account?` · booking as ${account.name}`:""}</small>{packageCode!=="trainer-meet-greet"&&selectedPets.some(pet=>!isVaccinatedStatus(pet.vaccinationStatus))&&<p role="note">Vaccinations for {selectedPets.filter(pet=>!isVaccinatedStatus(pet.vaccinationStatus)).map(pet=>pet.name).join(", ")} must be verified before the first programme session. You can book now and update it in My PawSpace; a Meet &amp; Greet needs no proof.</p>}</div>}</div>{!accountLoading&&!accountError&&dogs.length>0&&<fieldset className={styles.petList}><legend>What should training focus on? (optional)</legend>{goalOptions.map(goal=><button key={goal} type="button" aria-pressed={goals.includes(goal)} className={styles.choice} onClick={()=>setGoals(current=>current.includes(goal)?current.filter(item=>item!==goal):[...current,goal])}>{goal}</button>)}<label>Anything your trainer should know? (optional)<textarea value={behaviourNotes} maxLength={500} onChange={event=>setBehaviourNotes(event.target.value)} className={styles.input} placeholder="For example: pulls on the lead, nervous around other dogs"/></label></fieldset>}</div><section aria-label="Training service address"><strong>Service address</strong><p>{savedAddressText}</p><Link href={routeScope==="v2"?"/v2/account":"/mobile-app"}>Manage saved address</Link><p>The same saved doorstep is used for all sessions. Each session must fit the programme validity.</p></section>{locationLoading?<p>Confirming your training zone…</p>:locationError?<p role="alert">{locationError}</p>:location?<small>Training zone {location.zoneName} · confirmed from your address PIN code</small>:null}</section><section className={styles.card}><h2>2. Programme</h2>{catalogueLoading?<p>{routeScope==="v2"?"Loading training plans…":"Loading canonical Training catalogue…"}</p>:<>{Boolean(routeScope==="v2")?<TrainingFamilyChoices plans={packages} selectedCode={packageCode} recommendation={recommendation} petCount={petCount} renderChoice={item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} className={styles.choice}><strong>{item.name}</strong>{recommendation?.basis==="goals"&&recommendation.packageCode===item.package_code&&<small className={styles.block}>Best match for {recommendation.matchedGoals.join(" + ")}</small>}<div>{routeScope==="v2"?trainingSessionCount(item.sessions):`${item.sessions} session(s)`} · valid {item.validity_days} days</div><b>{money(trainingPriceForPets(item.base_price,Math.max(1,petCount),item.extra_pet_percent))}</b>{petCount>1&&<small className={styles.block}>for {petCount} dogs</small>}<small className={styles.block}>{item.meet_and_greet?(routeScope==="v2"?"Meet & Greet · paid in full":"Meet & Greet · prepaid"):(routeScope==="v2"?"Pay in full, or 50% now":"Programme · prepaid or approved split")}</small></button>}/>:<div className={styles.grid2}>{packages.map(item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} className={styles.choice}><strong>{item.name}</strong>{recommendation?.basis==="goals"&&recommendation.packageCode===item.package_code&&<small className={styles.block}>Best match for {recommendation.matchedGoals.join(" + ")}</small>}<div>{routeScope==="v2"?trainingSessionCount(item.sessions):`${item.sessions} session(s)`} · valid {item.validity_days} days</div><b>{money(trainingPriceForPets(item.base_price,Math.max(1,petCount),item.extra_pet_percent))}</b>{petCount>1&&<small className={styles.block}>for {petCount} dogs</small>}<small className={styles.block}>{item.meet_and_greet?(routeScope==="v2"?"Meet & Greet · paid in full":"Meet & Greet · prepaid"):(routeScope==="v2"?"Pay in full, or 50% now":"Programme · prepaid or approved split")}</small></button>)}</div>}</>}<div className={styles.topGap}><label>Payment mode <select value={paymentMode} disabled={packageCode==="trainer-meet-greet"} onChange={event=>setPaymentMode(event.target.value as "prepaid"|"split")}><option value="split">{routeScope==="v2"?"50% now, the rest before the final session":"Approved split"}</option><option value="prepaid">{routeScope==="v2"?"Pay in full":"Full prepaid"}</option></select></label></div></section><section className={styles.card} aria-label="First session"><h2>3. First session</h2><p>{firstSessionRuleLabel()}</p><p>{ROLLING_CHECKOUT_COPY}</p>{!packageCode&&<p role="note">Choose a programme above first; the first session belongs to the programme you pick.</p>}<div className={styles.grid2}>{(accountLoading||catalogueLoading)&&<p role="status">Loading your account and training plans before choosing a session…</p>}<label>First session date (earliest {earliestFirstSessionDate()})<input type="date" min={earliestFirstSessionDate()} disabled={accountLoading||catalogueLoading} value={date} onChange={event=>setDate(event.target.value)} className={styles.input}/></label><label>First session start (IST, on the hour)<select disabled={accountLoading||catalogueLoading} value={time} onChange={event=>setTime(event.target.value)} className={styles.input}>{firstSessionHours().map(hour=><option key={hour} value={hourLabel(hour)}>{hourLabel(hour)}</option>)}</select></label></div>{!firstSession.ok&&<p role="alert">{firstSession.reason}</p>}</section><section className={styles.card}><h2>4. Available trainer</h2><p>Availability is checked for your first appointment. Later sessions are scheduled one at a time after your trainer is assigned. A search does not reserve a trainer.</p><button type="button" disabled={!location||petCount===0||busy||availabilityLoading} onClick={()=>{setError("");setAvailabilityRefresh(value=>value+1);}}>Refresh trainer availability</button>{availabilityLoading?<p role="status">Checking availability for your first appointment…</p>:!location?<p>Your training zone must be confirmed before trainers can be listed.</p>:trainers.length===0?<p>No available trainer has been confirmed in {location.zoneName} for this programme. Refresh availability or choose another date.</p>:<div><p><strong>PawSpace certified trainer</strong> · {trainers.length} {trainers.length===1?"trainer is":"trainers are"} available for your first appointment in {location.zoneName}. {AUTO_MATCH_COPY}</p></div>}</section><section className={styles.card} aria-label="Your programme entitlement"><h2>What you are buying</h2><p>{currentQuote?trainingEntitlementSummary(currentQuote):"Choose a programme to see its sessions, minutes and validity."}</p><p>First appointment: {firstSession.ok&&currentQuote?formatIndiaRange(scheduledStart,new Date(Date.parse(scheduledStart)+currentQuote.minutesPerSession*60_000).toISOString()):"choose a valid first session above"}. {ROLLING_CHECKOUT_COPY}</p></section>{routeScope==="v2"&&<TestCoinServicePreview serviceName="Dog Training" customerId={account?.customerId} eligibleAmount={currentQuote?.totalAmount??null} actualPayable={currentQuote?.amountDueNow??null}/>}<section className={styles.stickyCard} aria-label="Programme price"><div><strong>{currentQuote?money(currentQuote.totalAmount):"—"}</strong><div>{currentQuote?(routeScope==="v2"?`${currentQuote.packageName} · ${trainingSessionCount(currentQuote.sessions)} · ${currentQuote.minutesPerSession} min each`:`${currentQuote.packageName} · ${currentQuote.sessions} session(s) · ${currentQuote.minutesPerSession} min/session`):activePackage?.name||(routeScope==="v2"?"Choose a plan to see its price":"Canonical quote unavailable")}</div><small>{currentQuote?(routeScope==="v2"?(currentQuote.amountDueNow<currentQuote.totalAmount?`${money(currentQuote.amountDueNow)} due now · ${money(currentQuote.totalAmount-currentQuote.amountDueNow)} before your final session`:`${money(currentQuote.amountDueNow)} due now`):`${money(currentQuote.amountDueNow)} sandbox amount due now · live money disabled`):locationError?"Booking unavailable for your location":locationLoading?"Confirming your training zone…":petCount===0?"Select at least one of your dogs to continue":"Repricing for your current selections…"}</small></div><Button data-v2-action={routeScope==="v2"?"primary":undefined} size="lg" disabled={!currentQuote||!activeTrainer||busy||!account||!location||petCount===0||!firstSession.ok} onClick={()=>void confirm()}>{busy?"Reserving trainer…":"Reserve trainer & continue to payment →"}</Button></section></main>;
}
