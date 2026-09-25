"use client";
import Link from"next/link";
import{useEffect,useMemo,useRef,useState}from"react";
import{loadTrainingPackages,loadTrainingTrainers,quoteTraining,type TrainingPackage,type TrainingQuote,type TrainingTrainer}from"../../lib/training-commercial-client";
import{reserveUatSchedule,SchedulingRefusal}from"../../lib/uat-scheduling-client";
import{loadAvailableTrainingTrainers,trainingScheduleRequest}from"../../lib/training-availability-client";
import{Button}from"../components/ui";
import{createCanonicalTrainingBooking,type TrainingBookingResult}from"../../lib/training-booking-client";
import{prepareTrainingProgramme,type CustomerTrainingProgramme}from"../../lib/training-programme-client";
import{loadCustomerAccount,type CustomerPet}from"../../lib/customer-account-client";
import type{CustomerAccountRecord}from"../../lib/customer-account";
import{trainingQuoteKey,trainingQuoteSpendable,trainingLocationPincode,trainingLocationZone}from"../../lib/training-booking-guards";
import styles from"./canonical-training.module.css";
import BookingPaymentPage from"../mobile-app/booking-payment-page";
import {loadVerifiedTrainingConfirmation,TrainingConfirmationPendingError} from "../../lib/training-confirmation-client";
import{customerScopedHref}from"../../lib/v2/route-scope";
import{formatIndiaRange}from"../../lib/india-time";
import{useQueryParameter}from"../../lib/use-query-parameter";
import{trainingCalendarWindows}from"../../lib/training-calendar-policy";
import{serviceAddressText}from"../../lib/service-address-text";

// The customer and the pets are the SIGNED-IN ones, read from the platform session — never a fixture.
// This page used to hardcode customer TST-101 with pets TST-PET-BRUNO/TST-PET-PEPPER. Any other
// signed-in customer got as far as the final button and then hit a 403 from the session gateway
// ("Identity session does not own this customer/provider scope"), because /api/uat-scheduling scopes
// the reservation to body.customerId and refuses a subject the session does not own. The page looked
// complete — real catalogue, real price, real trainers — and simply would not go through.
const day=86_400_000;
const initialDate=()=>new Date(Date.now()+3*day+330*60_000).toISOString().slice(0,10);
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
 const[date,setDate]=useState(initialDate);
 const[time,setTime]=useState("10:00"),[cadenceDays,setCadenceDays]=useState(7);
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null);
 const[accountLoading,setAccountLoading]=useState(true);
 const[accountError,setAccountError]=useState("");
 const[selectedPetIds,setSelectedPetIds]=useState<string[]>([]);
 const[packageCode,setPackageCode]=useState("training-4-puppy");
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
 const[trainerId,setTrainerId]=useState("");
 const[catalogueLoading,setCatalogueLoading]=useState(true);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[booking,setBooking]=useState<TrainingBookingResult|null>(null);
 const[programme,setProgramme]=useState<CustomerTrainingProgramme|null>(null);
 const[paymentVerified,setPaymentVerified]=useState(false);
 const[confirmationError,setConfirmationError]=useState("");
 const[confirmedProviderName,setConfirmedProviderName]=useState("");
 const confirmationRequest=useRef<AbortController|null>(null);
 useEffect(()=>()=>{confirmationRequest.current?.abort();confirmationRequest.current=null;},[]);
 const[pendingCheckout,setPendingCheckout]=useState<{booking:TrainingBookingResult;programme:CustomerTrainingProgramme|null;total:number;dueNow:number;mode:"prepaid"|"split";summary:{packageName:string;providerName:string;petNames:string;start:string;end:string;address:string}}|null>(null);
 const scheduledStart=`${date}T${time}:00+05:30`;
 const savedAddress=account?.addresses.find(item=>item.isDefault)||account?.addresses[0];
 const savedAddressText=savedAddress?serviceAddressText(savedAddress):"Address not saved";
 const activePackage=useMemo(()=>packages.find(item=>item.package_code===packageCode),[packages,packageCode]);
 // Dog Training is a dogs-only service, so only the customer's dogs can be enrolled.
 const dogs=useMemo(()=>(account?.pets||[]).filter(pet=>pet.species==="dog"),[account]);
 const selectedPets=useMemo(()=>dogs.filter(pet=>selectedPetIds.includes(pet.id)),[dogs,selectedPetIds]);
 const petCount=selectedPets.length;
 const petLabel=(pet:CustomerPet)=>[pet.breed,pet.profile?.ageBand].filter(Boolean).join(" · ")||"Dog";
 const location=account&&resolvedLocation?.accountId===account.customerId?resolvedLocation:null;
 const locationError=account&&locationRefusal?.accountId===account.customerId?locationRefusal.reason:"";
 const locationLoading=Boolean(account)&&!location&&!locationError;
 const effectiveMode=packageCode==="trainer-meet-greet"?"prepaid":paymentMode;
 // Everything that changes the price. The quote is only spendable while its key matches this.
 const quoteKey=trainingQuoteKey({scheduledStart,packageCode,paymentMode:effectiveMode,petIds:selectedPetIds,cadenceDays});
 const quoteReady=trainingQuoteSpendable({hasQuote:quote!==null,quotedKey,currentKey:quoteKey});
 // Every consumer reads THIS, never `quote`. The moment any priced input changes, quotedKey no
 // longer matches quoteKey and currentQuote is null — the old price is gone from the UI and from
 // confirm() in the same render, with no state write and therefore no window to race against.
 const currentQuote=quoteReady?quote:null;
 const calendar=useMemo(()=>{if(!currentQuote)return[];try{return trainingCalendarWindows(scheduledStart,currentQuote,cadenceDays);}catch{return[];}},[currentQuote,scheduledStart,cadenceDays]);
 const availabilityKey=JSON.stringify([quoteKey,account?.customerId,location?.cityId,location?.zoneId,availabilityRefresh]);
 const trainers=availability?.key===availabilityKey?availability.providers:[];
 const activeTrainer=trainers.find(item=>item.id===trainerId)||trainers[0];
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
   petCount>0?quoteTraining({packageCode,petCount,scheduledStart,paymentMode:mode}):Promise.resolve(null),
   loadTrainingTrainers({cityId:location.cityId,zoneId:location.zoneId,at:scheduledStart}),
  ]).then(async([nextQuote,providerResult])=>{
   if(!active)return;
   setQuote(nextQuote);
   // Stamp the quote with the inputs it was priced for. Belt and braces with `active`: even if a
   // slower earlier response were ever applied, it carries ITS key, not the current one, so
   // quoteReady stays false and confirm() refuses it rather than spending a superseded price.
   setQuotedKey(nextQuote?pricedKey:"");
   const available=nextQuote?await loadAvailableTrainingTrainers({customerId:account.customerId,petIds:selectedPetIds,cityId:location.cityId,zoneId:location.zoneId,scheduledStart,quote:nextQuote,cadenceDays},providerResult.providers,controller.signal):[];
   if(!active)return;
   setAvailability({key:searchKey,providers:available});
   setTrainerId(current=>available.some(item=>item.id===current)?current:available[0]?.id||"");
   setError("");
  }).catch(problem=>{if(active){const message=problem instanceof Error?problem.message:"Unable to load canonical Training availability";setAvailability({key:searchKey,providers:[],error:message});setError(message);}});
  return()=>{active=false;controller.abort()};
 },[date,packageCode,paymentMode,petCount,scheduledStart,effectiveMode,quoteKey,location,account,selectedPetIds,availabilityKey,cadenceDays]);

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
     setBooking(verified.booking);setProgramme(verified.programme);setConfirmedProviderName(verified.providerName);
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
  if(!currentQuote||!activeTrainer||busy||bookingRequest.current||!account||!location||selectedPets.length===0)return;
  bookingRequest.current=true;setBusy(true);setError("");
  let createdBookingId="";
  try{
   const quote=currentQuote;
   const customer={id:account.customerId,name:account.name,primaryPhone:account.primaryPhone,secondaryPhone:account.secondaryPhone??undefined,email:account.email??undefined};
   const bookingPets=selectedPets.map(pet=>({sourceId:pet.sourceId??pet.id,name:pet.name,species:"dog",breed:pet.breed??undefined,vaccinationStatus:pet.vaccinationStatus}));
   const request=trainingScheduleRequest({customerId:customer.id,petIds:selectedPets.map(pet=>pet.id),cityId:location.cityId,zoneId:location.zoneId,scheduledStart,quote,cadenceDays});
   const scheduledEnd=request.scheduledEnd,requestId=request.clientRequestId;
   const schedule=await reserveUatSchedule({...request,preferredProviderId:activeTrainer.id});
   if(schedule.provider.id!==activeTrainer.id)throw new Error("Your selected trainer changed. Refresh availability before continuing.");
   const result=await createCanonicalTrainingBooking({idempotencyKey:requestId,scheduleGroupId:schedule.groupId,trainingQuote:quote,customer,pets:bookingPets,cityId:location.cityId,zoneId:location.zoneId,scheduledStart,scheduledEnd,provider:schedule.provider});
   createdBookingId=result.bookingId;
   const recoveryUrl=new URL(window.location.href);recoveryUrl.searchParams.set("bookingId",result.bookingId);window.history.replaceState(window.history.state,"",recoveryUrl.pathname+recoveryUrl.search);
   const nextProgramme=await prepareTrainingProgramme({bookingId:result.bookingId,packageCode:quote.packageCode});
   setPaymentVerified(false);setConfirmationError("");setConfirmedProviderName("");
   setPendingCheckout({booking:result,programme:nextProgramme,total:quote.totalAmount,dueNow:quote.amountDueNow,mode:quote.paymentMode,summary:{packageName:quote.packageName,providerName:schedule.provider.name,petNames:selectedPets.map(pet=>pet.name).join(", "),start:scheduledStart,end:scheduledEnd,address:savedAddressText}});window.scrollTo(0,0);
  }catch(problem){if(createdBookingId){window.location.assign(`/v2/booking?bookingId=${encodeURIComponent(createdBookingId)}`);return;}const message=problem instanceof Error?problem.message:"Unable to confirm canonical Training programme";setError(message);if(problem instanceof SchedulingRefusal){setAvailability({key:availabilityKey,providers:[],error:message});setTrainerId("");}}
  finally{bookingRequest.current=false;setBusy(false)}
 }

 if(pendingCheckout)return <main className={styles.shell}>
  <header><Link href={href("/")}>PawSpace</Link><p>TRAINING - PAYMENT</p>
   <h1>{paymentVerified?"Payment verified. Updating confirmation.":"Complete payment to confirm"}</h1>
   <p>{paymentVerified?"We are reading your booking, assigned trainer and programme from PawSpace. Do not pay again.":"Your trainer and session calendar are held while Razorpay verifies the sandbox payment."}</p>
  </header>
  <section className={styles.card} aria-label="Reserved training details"><h2>{pendingCheckout.summary.packageName}</h2><p>Booking reference: {pendingCheckout.booking.bookingId}</p><p>Trainer: {pendingCheckout.summary.providerName} · {pendingCheckout.summary.petNames}</p><p>First session: {formatIndiaRange(pendingCheckout.summary.start,pendingCheckout.summary.end)}</p><p>Service address: {pendingCheckout.summary.address}</p><Link href={`/v2/booking?bookingId=${encodeURIComponent(pendingCheckout.booking.bookingId)}`}>View reserved sessions and payment status</Link></section>
  {confirmationError&&<p role="alert">{confirmationError}</p>}
  {paymentVerified?<section className={styles.card} aria-label="Training confirmation recovery">
   {busy&&<p role="status">Refreshing canonical Training confirmation...</p>}
   <button type="button" disabled={busy} onClick={()=>void hydrateVerifiedBooking(pendingCheckout.booking)}>Refresh confirmation</button>
   <Link href={href("/mobile-app")}>My PawSpace</Link>
  </section>:<BookingPaymentPage serviceName="Dog Training" totalAmount={pendingCheckout.total}
   amountDueNow={pendingCheckout.dueNow} mode={pendingCheckout.mode} bookingId={pendingCheckout.booking.bookingId}
   busy={busy} onVerified={async()=>{setPaymentVerified(true);await hydrateVerifiedBooking(pendingCheckout.booking);}}/>}
 </main>;

 if(booking&&!programme)return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><h1>Trainer Meet &amp; Greet confirmed</h1><p>Your payment is verified and your assessment is assigned to {confirmedProviderName}.</p></header><section className={styles.card}><h2>{booking.bookingId}</h2><p>{label(booking.status)}</p><Link href={routeScope==="v2"?"/v2/activity":"/mobile-app"}>View your bookings</Link></section></main>;
 if(booking&&programme)return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><p>TRAINING · CANONICAL UAT</p><h1>Training programme confirmed</h1><p>Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity.</p></header>{error&&<p role="alert">{error}</p>}<section className={styles.grid3}><article className={styles.card}><small>Booking</small><strong className={styles.block}>{booking.bookingId}</strong><span>{label(booking.status)}</span></article><article className={styles.card}><small>Programme</small><strong className={styles.block}>{programme.programme.id}</strong><span>{programme.programme.total_sessions} session(s)</span></article><article className={styles.card}><small>Trainer</small><strong className={styles.block}>{confirmedProviderName||programme.programme.provider_id}</strong><span>Canonical scheduler assignment</span></article></section><section className={styles.card}><h2>Programme sessions</h2>{programme.sessions.map(session=><article key={session.id} className={styles.sessionRow}><strong>Session {session.sequence_no} · {label(session.status)}</strong><div>{formatIndiaRange(session.scheduled_start,session.scheduled_end)}</div><small>{session.id} · trainer {session.provider_id}</small></article>)}</section><section className={styles.card}><h2>UAT boundaries</h2><p>Payment is confirmed only from verified Razorpay sandbox evidence. Production media storage/scanning, GST/tax invoicing, payout execution and external messaging remain configuration/launch dependencies.</p><div className={styles.actions}><Link href={href("/mobile-app")}>My PawSpace</Link><button onClick={()=>{window.location.assign(pathname)}}>Book another programme</button></div></section></main>;

 if(recoveryBookingId)return <main className={styles.shell}><section className={styles.card} aria-label="Existing training booking"><h1>Your Training booking is saved</h1><p>{recoveryBookingId}</p><p>Resume the same booking to check its reserved sessions and payment. This page will not create another booking.</p><Link href={`/v2/booking?bookingId=${encodeURIComponent(recoveryBookingId)}`}>View booking &amp; payment →</Link><p><Link href={pathname}>Start a separate booking</Link></p></section></main>;
 return <main className={styles.shell}><header><Link href={href("/")}>PawSpace</Link><p>DOG TRAINING · CANONICAL UAT</p><h1>Choose a server-owned Training programme</h1><p>Catalogue, price, trainer eligibility and schedule are read from PawSpace governance. The browser no longer invents a plan, trainer or progress journey.</p></header>{routeScope==="v2"&&recoveryBookingId&&<section className={styles.card} aria-label="Existing training booking"><p>Already reserved a programme? Your booking, its payment status and Manage link are on its own page.</p><div className={styles.actions}><Link href={`/v2/booking?bookingId=${encodeURIComponent(recoveryBookingId)}`}>View booking & payment →</Link></div></section>}{error&&<p role="alert">{error}</p>}<section className={styles.card}><h2>1. Pet and first session</h2><div className={styles.grid2}><div role="group" aria-labelledby="training-dogs-label"><span id="training-dogs-label">Dogs</span>{accountLoading?<p>Loading your pets…</p>:accountError?<p role="alert">{accountError} <Link href={href("/mobile-app")}>Sign in →</Link></p>:dogs.length===0?<p>No dogs on your profile yet. <Link href={href("/mobile-app")}>Add one in My PawSpace →</Link></p>:<div className={styles.petList}>{dogs.map(pet=><button key={pet.id} type="button" onClick={()=>togglePet(pet.id)} aria-pressed={selectedPetIds.includes(pet.id)} className={styles.choice}><strong>{pet.name}</strong><small className={styles.block}>{petLabel(pet)}</small></button>)}<small>{petCount} dog(s) selected{account?` · booking as ${account.name}`:""}</small></div>}</div><label>First session date<input type="date" value={date} onChange={event=>setDate(event.target.value)} className={styles.input}/></label><label>First session time (IST)<input type="time" value={time} step={900} onChange={event=>setTime(event.target.value)} className={styles.input}/></label><label>Days between sessions<select value={cadenceDays} disabled={packageCode==="trainer-meet-greet"} onChange={event=>setCadenceDays(Number(event.target.value))}>{[1,2,3,4,5,6,7].map(value=><option key={value} value={value}>{value===7?"Every week":`Every ${value} day${value===1?"":"s"}`}</option>)}</select></label></div><section aria-label="Training service address"><strong>Service address</strong><p>{savedAddressText}</p><Link href={routeScope==="v2"?"/v2/account":"/mobile-app"}>Manage saved address</Link><p>The same saved doorstep is used for all sessions. Each session must fit the programme validity.</p></section>{locationLoading?<p>Confirming your training zone…</p>:locationError?<p role="alert">{locationError}</p>:location?<small>Training zone {location.zoneName} · confirmed from your address PIN code</small>:null}</section><section className={styles.card}><h2>2. Programme</h2>{catalogueLoading?<p>Loading canonical Training catalogue…</p>:<div className={styles.grid2}>{packages.map(item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} className={styles.choice}><strong>{item.name}</strong><div>{item.sessions} session(s) · valid {item.validity_days} days</div><b>{money(item.base_price)}</b><small className={styles.block}>{item.meet_and_greet?"Meet & Greet · prepaid":"Programme · prepaid or approved split"}</small></button>)}</div>}<div className={styles.topGap}><label>Payment mode <select value={paymentMode} disabled={packageCode==="trainer-meet-greet"} onChange={event=>setPaymentMode(event.target.value as "prepaid"|"split")}><option value="split">Approved split</option><option value="prepaid">Full prepaid</option></select></label></div></section><section className={styles.card}><h2>3. Available trainer</h2><p>Availability is checked for every session in this programme. A search does not reserve a trainer.</p><button type="button" disabled={!location||petCount===0||busy||availabilityLoading} onClick={()=>{setError("");setAvailabilityRefresh(value=>value+1);}}>Refresh trainer availability</button>{availabilityLoading?<p role="status">Checking availability for every programme session...</p>:!location?<p>Your training zone must be confirmed before trainers can be listed.</p>:trainers.length===0?<p>No available trainer has been confirmed in {location.zoneName} for this programme. Refresh availability or choose another date.</p>:<div className={styles.grid3}>{trainers.map(item=><button key={item.id} onClick={()=>setTrainerId(item.id)} aria-pressed={activeTrainer?.id===item.id} className={styles.choice}><strong>{item.name}</strong><div>{item.rating.toFixed(1)} ★ · quality {item.qualityScore}</div><small>{item.model.replaceAll("_"," ")} · capacity {item.capacity}</small></button>)}</div>}</section><section className={styles.card} aria-label="Proposed training calendar"><h2>Review your session calendar</h2>{calendar.length?<ol>{calendar.map((window,index)=><li key={window.start}>Session {index+1}: {formatIndiaRange(window.start,window.end)}</li>)}</ol>:<p>Choose a valid start time and frequency to preview every session before reserving.</p>}</section><section className={styles.stickyCard}><div><strong>{currentQuote?money(currentQuote.totalAmount):"—"}</strong><div>{currentQuote?`${currentQuote.packageName} · ${currentQuote.sessions} session(s) · ${currentQuote.minutesPerSession} min/session`:activePackage?.name||"Canonical quote unavailable"}</div><small>{currentQuote?`${money(currentQuote.amountDueNow)} sandbox amount due now · live money disabled`:locationError?"Booking unavailable for your location":locationLoading?"Confirming your training zone…":petCount===0?"Select at least one of your dogs to continue":"Repricing for your current selections…"}</small></div><Button size="lg" disabled={!currentQuote||!activeTrainer||busy||!account||!location||petCount===0} onClick={()=>void confirm()}>{busy?"Reserving trainer…":"Reserve trainer & continue to payment →"}</Button></section></main>;
}
