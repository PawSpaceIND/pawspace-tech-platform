"use client";
import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import{loadTrainingPackages,loadTrainingTrainers,quoteTraining,type TrainingPackage,type TrainingQuote,type TrainingTrainer}from"../../lib/training-commercial-client";
import{reserveUatSchedule}from"../../lib/uat-scheduling-client";
import{Button}from"../components/ui";
import{createCanonicalTrainingBooking,type TrainingBookingResult}from"../../lib/training-booking-client";
import{materializeTrainingProgramme,type CustomerTrainingProgramme}from"../../lib/training-programme-client";

const customer={id:"TST-101",name:"PawSpace UAT Customer",primaryPhone:"+919880222741",secondaryPhone:"+919880222742",email:"uat.customer@pawspace.test"};
const pets=[
 {sourceId:"TST-PET-BRUNO",name:"Bruno",species:"dog",breed:"Golden Retriever",vaccinationStatus:"verified"},
 {sourceId:"TST-PET-PEPPER",name:"Pepper",species:"dog",breed:"Indie",vaccinationStatus:"verified"},
];
const box={background:"white",border:"1px solid #e2e2e2",borderRadius:16,padding:18} as const;
const day=86_400_000;
const initialDate=()=>new Date(Date.now()+3*day).toISOString().slice(0,10);
const money=(value:number)=>`₹${Number(value||0).toLocaleString("en-IN")}`;
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");

export default function TrainingPage(){
 const[date,setDate]=useState(initialDate);
 const[petCount,setPetCount]=useState(1);
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

 useEffect(()=>{
  let active=true;
  const mode=packageCode==="trainer-meet-greet"?"prepaid":paymentMode;
  void Promise.all([
   loadTrainingPackages(),
   quoteTraining({packageCode,petCount,scheduledStart,paymentMode:mode}),
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
  if(!quote||!activeTrainer||busy)return;
  setBusy(true);setError("");
  try{
   const selectedPets=pets.slice(0,petCount),duration=quote.minutesPerSession*60_000,scheduledEnd=new Date(new Date(scheduledStart).getTime()+duration).toISOString(),requestId=`training:${quote.quoteId}:${customer.id}`;
   const schedule=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.id,petIds:selectedPets.map(pet=>pet.sourceId),serviceCode:"dog_training",cityId:"blr",zoneId:"blr-east",scheduledStart,scheduledEnd,occurrences:quote.meetAndGreet?1:quote.sessions,cadenceDays:7,preferredProviderId:activeTrainer.id});
   const result=await createCanonicalTrainingBooking({idempotencyKey:requestId,scheduleGroupId:schedule.groupId,trainingQuote:quote,customer,pets:selectedPets,cityId:"blr",zoneId:"blr-east",scheduledStart,scheduledEnd,provider:schedule.provider});
   const nextProgramme=await materializeTrainingProgramme({bookingId:result.bookingId});
   setBooking(result);setProgramme(nextProgramme);window.scrollTo(0,0);
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to confirm canonical Training programme")}
  finally{setBusy(false)}
 }

 if(booking&&programme)return <main style={{maxWidth:980,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}><header><Link href="/">PawSpace</Link><p>TRAINING · CANONICAL UAT</p><h1>Training programme confirmed</h1><p>Booking, trainer assignment, payment ledger and programme sessions now share one canonical identity.</p></header>{error&&<p role="alert">{error}</p>}<section style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}><article style={box}><small>Booking</small><strong style={{display:"block"}}>{booking.bookingId}</strong><span>{label(booking.status)}</span></article><article style={box}><small>Programme</small><strong style={{display:"block"}}>{programme.programme.id}</strong><span>{programme.programme.total_sessions} session(s)</span></article><article style={box}><small>Trainer</small><strong style={{display:"block"}}>{activeTrainer?.name||programme.programme.provider_id}</strong><span>Canonical scheduler assignment</span></article></section><section style={box}><h2>Programme sessions</h2>{programme.sessions.map(session=><article key={session.id} style={{padding:"12px 0",borderBottom:"1px solid #eee"}}><strong>Session {session.sequence_no} · {label(session.status)}</strong><div>{new Date(session.scheduled_start).toLocaleString("en-IN")} → {new Date(session.scheduled_end).toLocaleTimeString("en-IN")}</div><small>{session.id} · trainer {session.provider_id}</small></article>)}</section><section style={box}><h2>UAT boundaries</h2><p>Payment status is an internal sandbox capture marker only. Live payment, production media storage/scanning, GST/tax invoicing, payout execution and external messaging remain configuration/launch dependencies.</p><div style={{display:"flex",gap:10,flexWrap:"wrap"}}><Link href="/mobile-app">My PawSpace</Link><button onClick={()=>{setBooking(null);setProgramme(null)}}>Book another programme</button></div></section></main>;

 return <main style={{maxWidth:1080,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16,background:"#fafafa",minHeight:"100vh"}}><header><Link href="/">PawSpace</Link><p>DOG TRAINING · CANONICAL UAT</p><h1>Choose a server-owned Training programme</h1><p>Catalogue, price, trainer eligibility and schedule are read from PawSpace governance. The browser no longer invents a plan, trainer or progress journey.</p></header>{error&&<p role="alert">{error}</p>}<section style={box}><h2>1. Pet and first session</h2><div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}><label>Dogs<select value={petCount} onChange={event=>setPetCount(Number(event.target.value))} style={{display:"block",width:"100%",padding:10}}><option value={1}>Bruno · 1 dog</option><option value={2}>Bruno + Pepper · 2 dogs</option></select></label><label>First session date<input type="date" value={date} onChange={event=>setDate(event.target.value)} style={{display:"block",width:"100%",padding:10}}/></label></div></section><section style={box}><h2>2. Programme</h2>{loading?<p>Loading canonical Training catalogue…</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>{packages.map(item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} style={{...box,textAlign:"left",outline:packageCode===item.package_code?"2px solid #222":"none"}}><strong>{item.name}</strong><div>{item.sessions} session(s) · valid {item.validity_days} days</div><b>{money(item.base_price)}</b><small style={{display:"block"}}>{item.meet_and_greet?"Meet & Greet · prepaid":"Programme · prepaid or approved split"}</small></button>)}</div>}<div style={{marginTop:12}}><label>Payment mode <select value={paymentMode} disabled={packageCode==="trainer-meet-greet"} onChange={event=>setPaymentMode(event.target.value as "prepaid"|"split")}><option value="split">Approved split</option><option value="prepaid">Full prepaid</option></select></label></div></section><section style={box}><h2>3. Eligible trainer</h2>{trainers.length===0?<p>No governed trainer is available for this UAT window.</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>{trainers.map(item=><button key={item.id} onClick={()=>setTrainerId(item.id)} aria-pressed={activeTrainer?.id===item.id} style={{...box,textAlign:"left",outline:activeTrainer?.id===item.id?"2px solid #222":"none"}}><strong>{item.name}</strong><div>{item.rating.toFixed(1)} ★ · quality {item.qualityScore}</div><small>{item.model.replaceAll("_"," ")} · capacity {item.capacity}</small></button>)}</div>}</section><section style={{...box,position:"sticky",bottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}><div><strong>{quote?money(quote.totalAmount):"—"}</strong><div>{quote?`${quote.packageName} · ${quote.sessions} session(s) · ${quote.minutesPerSession} min/session`:activePackage?.name||"Canonical quote unavailable"}</div><small>{quote?`${money(quote.amountDueNow)} sandbox amount due now · live money disabled`:"Refresh availability to continue"}</small></div><Button size="lg" disabled={!quote||!activeTrainer||busy||loading} onClick={()=>void confirm()}>{busy?"Creating canonical programme…":"Reserve trainer + create programme →"}</Button></section></main>;
}
