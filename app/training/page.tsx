"use client";
import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import{loadTrainingPackages,loadTrainingTrainers,quoteTraining,type TrainingPackage,type TrainingQuote,type TrainingTrainer}from"../../lib/training-commercial-client";
import{reserveUatSchedule}from"../../lib/uat-scheduling-client";
import{Button}from"../components/ui";
import{createCanonicalTrainingBooking,type TrainingBookingResult}from"../../lib/training-booking-client";
import{materializeTrainingProgramme,type CustomerTrainingProgramme}from"../../lib/training-programme-client";
import{loadCustomerAccount,type CustomerPet}from"../../lib/customer-account-client";
import type{CustomerAccountRecord}from"../../lib/customer-account";

// The customer and the pets are the SIGNED-IN ones, read from the platform session — never a fixture.
// This page used to hardcode customer TST-101 with pets TST-PET-BRUNO/TST-PET-PEPPER. Any other
// signed-in customer got as far as the final button and then hit a 403 from the session gateway
// ("Identity session does not own this customer/provider scope"), because /api/uat-scheduling scopes
// the reservation to body.customerId and refuses a subject the session does not own. The page looked
// complete — real catalogue, real price, real trainers — and simply would not go through.
const box={background:"white",border:"1px solid #e2e2e2",borderRadius:16,padding:18} as const;
const day=86_400_000;
const initialDate=()=>new Date(Date.now()+3*day).toISOString().slice(0,10);
const money=(value:number)=>`₹${Number(value||0).toLocaleString("en-IN")}`;
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");

export default function TrainingPage(){
 const[date,setDate]=useState(initialDate);
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null);
 const[accountLoading,setAccountLoading]=useState(true);
 const[accountError,setAccountError]=useState("");
 const[selectedPetIds,setSelectedPetIds]=useState<string[]>([]);
 const[packageCode,setPackageCode]=useState("training-4-puppy");
 const[paymentMode,setPaymentMode]=useState<"prepaid"|"split">("split");
 const[packages,setPackages]=useState<TrainingPackage[]>([]);
 const[quote,setQuote]=useState<TrainingQuote|null>(null);
 const[trainers,setTrainers]=useState<TrainingTrainer[]>([]);
 const[trainerId,setTrainerId]=useState("");
 const[loading,setLoading]=useState(true);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[booking,setBooking]=useState<TrainingBookingResult|null>(null);
 const[programme,setProgramme]=useState<CustomerTrainingProgramme|null>(null);
 const scheduledStart=`${date}T10:00:00+05:30`;
 const activePackage=useMemo(()=>packages.find(item=>item.package_code===packageCode),[packages,packageCode]);
 const activeTrainer=useMemo(()=>trainers.find(item=>item.id===trainerId)||trainers[0],[trainers,trainerId]);
 // Dog Training is a dogs-only service, so only the customer's dogs can be enrolled.
 const dogs=useMemo(()=>(account?.pets||[]).filter(pet=>pet.species==="dog"),[account]);
 const selectedPets=useMemo(()=>dogs.filter(pet=>selectedPetIds.includes(pet.id)),[dogs,selectedPetIds]);
 const petCount=selectedPets.length;
 const petLabel=(pet:CustomerPet)=>[pet.breed,pet.profile?.ageBand].filter(Boolean).join(" · ")||"Dog";

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
 const togglePet=(id:string)=>setSelectedPetIds(current=>current.includes(id)?current.filter(petId=>petId!==id):[...current,id]);

 useEffect(()=>{
  let active=true;
  const mode=packageCode==="trainer-meet-greet"?"prepaid":paymentMode;
  void Promise.all([
   loadTrainingPackages(),
   // No dog selected yet — there is nothing to price, and a 0-pet quote is not a real quote.
   petCount>0?quoteTraining({packageCode,petCount,scheduledStart,paymentMode:mode}):Promise.resolve(null),
   loadTrainingTrainers({cityId:"blr",zoneId:"blr-east",at:scheduledStart}),
  ]).then(([catalogue,nextQuote,providerResult])=>{
   if(!active)return;
   setPackages(catalogue.packages);
   setQuote(nextQuote);
   setTrainers(providerResult.providers);
   setTrainerId(current=>providerResult.providers.some(item=>item.id===current)?current:providerResult.providers[0]?.id||"");
   setError("");
  }).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to load canonical Training availability")})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[date,packageCode,paymentMode,petCount,scheduledStart]);

 useEffect(()=>{if(packageCode==="trainer-meet-greet"&&paymentMode!=="prepaid")queueMicrotask(()=>setPaymentMode("prepaid"))},[packageCode,paymentMode]);

 async function confirm(){
  if(!quote||!activeTrainer||busy||!account||selectedPets.length===0)return;
  setBusy(true);setError("");
  try{
   const customer={id:account.customerId,name:account.name,primaryPhone:account.primaryPhone,secondaryPhone:account.secondaryPhone??undefined,email:account.email??undefined};
   const bookingPets=selectedPets.map(pet=>({sourceId:pet.sourceId??pet.id,name:pet.name,species:"dog",breed:pet.breed??undefined,vaccinationStatus:pet.vaccinationStatus}));
   const duration=quote.minutesPerSession*60_000,scheduledEnd=new Date(new Date(scheduledStart).getTime()+duration).toISOString(),requestId=`training:${quote.quoteId}:${customer.id}`;
   const schedule=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.id,petIds:selectedPets.map(pet=>pet.id),serviceCode:"dog_training",zoneId:"blr-east",scheduledStart,scheduledEnd,occurrences:quote.meetAndGreet?1:quote.sessions,cadenceDays:7,preferredProviderId:activeTrainer.id});
   const result=await createCanonicalTrainingBooking({idempotencyKey:requestId,scheduleGroupId:schedule.groupId,trainingQuote:quote,customer,pets:bookingPets,cityId:"blr",zoneId:"blr-east",scheduledStart,scheduledEnd,provider:schedule.provider});
   const nextProgramme=await materializeTrainingProgramme({bookingId:result.bookingId});
   setBooking(result);setProgramme(nextProgramme);window.scrollTo(0,0);
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to confirm canonical Training programme")}
  finally{setBusy(false)}
 }

 if(booking&&programme)return <main style={{maxWidth:980,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}><header><Link href="/">PawSpace</Link><p>TRAINING · CANONICAL UAT</p><h1>Training programme confirmed</h1><p>Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity.</p></header>{error&&<p role="alert">{error}</p>}<section style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}><article style={box}><small>Booking</small><strong style={{display:"block"}}>{booking.bookingId}</strong><span>{label(booking.status)}</span></article><article style={box}><small>Programme</small><strong style={{display:"block"}}>{programme.programme.id}</strong><span>{programme.programme.total_sessions} session(s)</span></article><article style={box}><small>Trainer</small><strong style={{display:"block"}}>{activeTrainer?.name||programme.programme.provider_id}</strong><span>Canonical scheduler assignment</span></article></section><section style={box}><h2>Programme sessions</h2>{programme.sessions.map(session=><article key={session.id} style={{padding:"12px 0",borderBottom:"1px solid #eee"}}><strong>Session {session.sequence_no} · {label(session.status)}</strong><div>{new Date(session.scheduled_start).toLocaleString("en-IN")} → {new Date(session.scheduled_end).toLocaleTimeString("en-IN")}</div><small>{session.id} · trainer {session.provider_id}</small></article>)}</section><section style={box}><h2>UAT boundaries</h2><p>Payment status is an internal sandbox capture marker only. Live payment, production media storage/scanning, GST/tax invoicing, payout execution and external messaging remain configuration/launch dependencies.</p><div style={{display:"flex",gap:10,flexWrap:"wrap"}}><Link href="/mobile-app">My PawSpace</Link><button onClick={()=>{setBooking(null);setProgramme(null)}}>Book another programme</button></div></section></main>;

 return <main style={{maxWidth:1080,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16,background:"#fafafa",minHeight:"100vh"}}><header><Link href="/">PawSpace</Link><p>DOG TRAINING · CANONICAL UAT</p><h1>Choose a server-owned Training programme</h1><p>Catalogue, price, trainer eligibility and schedule are read from PawSpace governance. The browser no longer invents a plan, trainer or progress journey.</p></header>{error&&<p role="alert">{error}</p>}<section style={box}><h2>1. Pet and first session</h2><div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}><div><span>Dogs</span>{accountLoading?<p>Loading your pets…</p>:accountError?<p role="alert">{accountError} <Link href="/mobile-app">Sign in →</Link></p>:dogs.length===0?<p>No dogs on your profile yet. <Link href="/mobile-app">Add one in My PawSpace →</Link></p>:<div style={{display:"grid",gap:6,marginTop:6}}>{dogs.map(pet=><button key={pet.id} onClick={()=>togglePet(pet.id)} aria-pressed={selectedPetIds.includes(pet.id)} style={{...box,padding:10,textAlign:"left",outline:selectedPetIds.includes(pet.id)?"2px solid #222":"none"}}><strong>{pet.name}</strong><small style={{display:"block"}}>{petLabel(pet)}</small></button>)}<small>{petCount} dog(s) selected{account?` · booking as ${account.name}`:""}</small></div>}</div><label>First session date<input type="date" value={date} onChange={event=>setDate(event.target.value)} style={{display:"block",width:"100%",padding:10}}/></label></div></section><section style={box}><h2>2. Programme</h2>{loading?<p>Loading canonical Training catalogue…</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>{packages.map(item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} style={{...box,textAlign:"left",outline:packageCode===item.package_code?"2px solid #222":"none"}}><strong>{item.name}</strong><div>{item.sessions} session(s) · valid {item.validity_days} days</div><b>{money(item.base_price)}</b><small style={{display:"block"}}>{item.meet_and_greet?"Meet & Greet · prepaid":"Programme · prepaid or approved split"}</small></button>)}</div>}<div style={{marginTop:12}}><label>Payment mode <select value={paymentMode} disabled={packageCode==="trainer-meet-greet"} onChange={event=>setPaymentMode(event.target.value as "prepaid"|"split")}><option value="split">Approved split</option><option value="prepaid">Full prepaid</option></select></label></div></section><section style={box}><h2>3. Eligible trainer</h2>{trainers.length===0?<p>No governed trainer is available for this UAT window.</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>{trainers.map(item=><button key={item.id} onClick={()=>setTrainerId(item.id)} aria-pressed={activeTrainer?.id===item.id} style={{...box,textAlign:"left",outline:activeTrainer?.id===item.id?"2px solid #222":"none"}}><strong>{item.name}</strong><div>{item.rating.toFixed(1)} ★ · quality {item.qualityScore}</div><small>{item.model.replaceAll("_"," ")} · capacity {item.capacity}</small></button>)}</div>}</section><section style={{...box,position:"sticky",bottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}><div><strong>{quote?money(quote.totalAmount):"—"}</strong><div>{quote?`${quote.packageName} · ${quote.sessions} session(s) · ${quote.minutesPerSession} min/session`:activePackage?.name||"Canonical quote unavailable"}</div><small>{quote?`${money(quote.amountDueNow)} sandbox amount due now · live money disabled`:petCount===0?"Select at least one of your dogs to continue":"Refresh availability to continue"}</small></div><Button size="lg" disabled={!quote||!activeTrainer||busy||loading||!account||petCount===0} onClick={()=>void confirm()}>{busy?"Creating canonical programme…":"Reserve trainer + create programme →"}</Button></section></main>;
}
