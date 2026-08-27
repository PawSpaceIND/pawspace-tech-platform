"use client";
import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import{loadBoardingCommercial,quoteBoarding,type BoardingHost,type BoardingPackage,type BoardingQuote}from"../../lib/boarding-commercial-client";
import{reserveUatSchedule}from"../../lib/uat-scheduling-client";
import{Button}from"../components/ui";
import{createCanonicalBoardingBooking,type BoardingBookingResult}from"../../lib/boarding-booking-client";
import{loadCustomerBoardingStay,updateBoardingStay,type BoardingStay}from"../../lib/boarding-stay-client";
import{loadCustomerAccount}from"../../lib/customer-account-client";
import type{CustomerAccountRecord}from"../../lib/customer-account";

// The customer and the pets are the SIGNED-IN ones, read from the platform session — never a fixture.
// This page used to hardcode customer TST-101 with pets TST-PET-BRUNO/TST-PET-PEPPER. Measured on a
// public host, that made the page non-functional for EVERY real customer: an anonymous caller gets
// 401, and a signed-in customer asking for TST-101 is refused by requireCustomerOwnership, because
// /api/uat-scheduling scopes the reservation to body.customerId and refuses a subject the session does
// not own. It only looked right on localhost, where the development-preview actor stands in.
// Same treatment app/training/page.tsx already had. [PTJA-P1-F37]
const box={background:"white",border:"1px solid #e2e2e2",borderRadius:16,padding:18} as const;
const money=(value:number|undefined)=>value==null?"—":`₹${Number(value).toLocaleString("en-IN")}`;
const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");
const todayPlus=(days:number)=>new Date(Date.now()+days*86_400_000).toISOString().slice(0,10);
const plusDays=(date:string,days:number)=>{const[y,m,d]=date.split("-").map(Number);return new Date(Date.UTC(y,m-1,d+days)).toISOString().slice(0,10)};

function stayWindow(packageCode:string,startDate:string,nights:number){
 if(packageCode==="boarding-4h")return{start:`${startDate}T10:00:00+05:30`,end:`${startDate}T14:00:00+05:30`,careMode:"visit" as const};
 if(packageCode==="boarding-10h")return{start:`${startDate}T10:00:00+05:30`,end:`${startDate}T20:00:00+05:30`,careMode:"visit" as const};
 return{start:`${startDate}T10:00:00+05:30`,end:`${plusDays(startDate,nights)}T10:00:00+05:30`,careMode:"overnight" as const};
}

export default function BoardingPage(){
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null);
 const[accountLoading,setAccountLoading]=useState(true);
 const[accountError,setAccountError]=useState("");
 // loadCustomerAccount() sends NO id: the server derives the subject from the platform session, which
 // is the same identity the booking is scoped to, so the two cannot disagree the way a fixture did.
 useEffect(()=>{let active=true;loadCustomerAccount().then(record=>{if(!active)return;setAccount(record);setAccountError("")}).catch(problem=>{if(active)setAccountError(problem instanceof Error?problem.message:"Sign in as a customer to book a Boarding stay")}).finally(()=>{if(active)setAccountLoading(false)});return()=>{active=false}},[]);
 const customer=account?{id:account.customerId,name:account.name,primaryPhone:account.primaryPhone,secondaryPhone:account.secondaryPhone??undefined,email:account.email??undefined}:null;
 const pets=account?.pets??[];

 const[startDate,setStartDate]=useState(()=>todayPlus(5));
 const[nights,setNights]=useState(3);
 const[petCount,setPetCount]=useState(1);
 const[packageCode,setPackageCode]=useState("boarding-24h");
 const[packages,setPackages]=useState<BoardingPackage[]>([]);
 const[hosts,setHosts]=useState<BoardingHost[]>([]);
 const[hostId,setHostId]=useState("");
 const[quote,setQuote]=useState<BoardingQuote|null>(null);
 const[loading,setLoading]=useState(true);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[booking,setBooking]=useState<BoardingBookingResult|null>(null);
 const[stay,setStay]=useState<BoardingStay|null>(null);
 const[careBusy,setCareBusy]=useState(false);
 const window=useMemo(()=>stayWindow(packageCode,startDate,nights),[packageCode,startDate,nights]);
 const selectedHost=useMemo(()=>hosts.find(item=>item.providerId===hostId)||hosts[0],[hosts,hostId]);
 const selectedPackage=useMemo(()=>packages.find(item=>item.package_code===packageCode),[packages,packageCode]);
 const overnight=packageCode==="boarding-24h";

 useEffect(()=>{
  let active=true;
  queueMicrotask(()=>{if(!active)return;setLoading(true);setQuote(null);setError("")});
  void Promise.allSettled([
   loadBoardingCommercial({cityId:"blr",zoneId:"blr-east",scheduledStart:window.start,scheduledEnd:window.end,petCount,species:["dog"]}),
   quoteBoarding({packageCode,petCount,cityId:"blr",zoneId:"blr-east",scheduledStart:window.start,scheduledEnd:window.end,paymentMode:"prepaid"}),
  ]).then(([commercial,nextQuote])=>{
   if(!active)return;
   if(commercial.status==="fulfilled"){
    setPackages(commercial.value.packages);
    setHosts(commercial.value.hosts);
    setHostId(current=>commercial.value.hosts.some(item=>item.providerId===current)?current:commercial.value.hosts[0]?.providerId||"");
   }else{
    setPackages([]);
    setHosts([]);
    setHostId("");
    setError(commercial.reason instanceof Error?commercial.reason.message:"Unable to load canonical Boarding availability");
   }
   if(nextQuote.status==="fulfilled")setQuote(nextQuote.value);
   else setError(current=>current|| (nextQuote.reason instanceof Error?nextQuote.reason.message:"Unable to refresh the canonical Boarding quote"));
  })
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[packageCode,petCount,window.start,window.end]);

 async function confirm(){
  if(!quote||!selectedHost||busy)return;
  setBusy(true);setError("");
  try{
   if(!customer)throw new Error("Sign in as a customer to book a Boarding stay");
   const selectedPets=pets.slice(0,petCount),requestId=`boarding:${quote.quoteId}:${customer.id}`;
   const schedule=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.id,petIds:selectedPets.map(pet=>pet.id),serviceCode:"boarding",zoneId:"blr-east",scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,occurrences:1,careMode:window.careMode,preferredProviderId:selectedHost.providerId});
   const result=await createCanonicalBoardingBooking({idempotencyKey:requestId,scheduleGroupId:schedule.groupId,boardingQuote:quote,customer,pets:selectedPets.map(pet=>({sourceId:pet.sourceId??pet.id,name:pet.name,species:(pet.species==="cat"?"cat":pet.species==="dog"?"dog":"other") as "dog"|"cat"|"other",breed:pet.breed??undefined,vaccinationStatus:pet.vaccinationStatus})),cityId:"blr",zoneId:"blr-east",provider:schedule.provider});
   const canonicalStay=await loadCustomerBoardingStay(result.bookingId);
   if(!canonicalStay)throw new Error("Canonical Boarding stay was not materialized from the booking");
   setBooking(result);setStay(canonicalStay);windowGlobalScroll();
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to create canonical Boarding booking")}
  finally{setBusy(false)}
 }

 async function submitCarePlan(){
  if(!stay||careBusy)return;
  setCareBusy(true);setError("");
  try{
   await updateBoardingStay({stayId:stay.id,action:"submit_care_plan",idempotencyKey:`boarding-care:${stay.id}:${Date.now()}`,carePlan:{feeding:"Use the registered food routine; no unapproved treats.",medication:"Follow only the registered medication instructions.",emergencyContact:"UAT secondary contact +91 98802 22742",vet:"PawSpace UAT vet contact",specialInstructions:"Escalate any health or behaviour concern to PawSpace Operations."}});
   setStay(await loadCustomerBoardingStay(stay.booking_id));
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to save canonical Boarding care plan")}
  finally{setCareBusy(false)}
 }

 function windowGlobalScroll(){if(typeof globalThis!=="undefined"&&typeof globalThis.scrollTo==="function")globalThis.scrollTo(0,0)}

 if(booking&&stay)return <main style={{maxWidth:980,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}><header><Link href="/">PawSpace</Link><p>BOARDING · CANONICAL UAT</p><h1>Boarding stay created</h1><p>The customer booking, governed host assignment and Boarding stay ledger now share the same canonical booking identity.</p></header>{error&&<p role="alert">{error}</p>}<section style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}><article style={box}><small>Booking</small><strong style={{display:"block"}}>{booking.bookingId}</strong><span>{label(stay.booking_status||booking.status)}</span></article><article style={box}><small>Stay</small><strong style={{display:"block"}}>{stay.id}</strong><span>{label(stay.status)}</span></article><article style={box}><small>Host</small><strong style={{display:"block"}}>{stay.provider_name||stay.host_provider_id}</strong><span>Governed scheduler assignment</span></article></section><section style={box}><h2>Stay window and commercial truth</h2><p>{new Date(stay.check_in_at).toLocaleString("en-IN")} → {new Date(stay.check_out_at).toLocaleString("en-IN")}</p><p>{stay.billed_units} billed unit(s) · {stay.pet_count} pet(s) · {money(stay.total_amount)} full prepaid UAT amount.</p><p><small>Live payment is disabled. Production payout, tax/GST, external messaging and production host inventory remain launch/configuration dependencies.</small></p></section><section style={box}><h2>Customer care plan</h2><p>Status: <strong>{label(stay.care_plan_status)}</strong>. Host acceptance is a separate governed provider action; the customer cannot simulate it from this screen.</p>{stay.carePlan?<div><strong>Canonical care plan ready</strong><p>Emergency contact, vet and instructions are stored against this exact stay.</p></div>:<button disabled={careBusy} onClick={()=>void submitCarePlan()}>{careBusy?"Saving care plan…":"Submit UAT care plan"}</button>}</section><section style={box}><h2>What happens next</h2><p>The governed host must accept the stay before check-in. Care events, proof, incidents, extensions, Finance and Operations continue through the existing Boarding lifecycle APIs rather than browser-local state.</p><div style={{display:"flex",gap:10,flexWrap:"wrap"}}><Link href="/mobile-app">My PawSpace</Link><button onClick={()=>{setBooking(null);setStay(null)}}>Book another stay</button></div></section></main>;

 return <main style={{maxWidth:1080,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16,background:"#fafafa",minHeight:"100vh"}}><header><Link href="/">PawSpace</Link><p>HOME BOARDING · CANONICAL UAT</p><h1>Choose a governed stay and verified host</h1><p>Catalogue, pricing, host eligibility and availability come from PawSpace governance. The browser no longer invents host ratings, secure-payment claims or live Care Card events.</p></header>{error&&<p role="alert">{error}</p>}<section style={box}><h2>1. Stay</h2><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}><label>Check-in date<input type="date" value={startDate} onChange={event=>setStartDate(event.target.value)} style={{display:"block",width:"100%",padding:10}}/></label><label>Pets<select value={petCount} onChange={event=>setPetCount(Number(event.target.value))} style={{display:"block",width:"100%",padding:10}}><option value={1}>Bruno · 1 dog</option><option value={2}>Bruno + Pepper · 2 dogs</option></select></label>{overnight&&<label>Nights<select value={nights} onChange={event=>setNights(Number(event.target.value))} style={{display:"block",width:"100%",padding:10}}>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value}</option>)}</select></label>}</div></section><section style={box}><h2>2. Canonical package</h2>{loading?<p>Loading Boarding catalogue…</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>{packages.map(item=><button key={item.package_code} onClick={()=>setPackageCode(item.package_code)} aria-pressed={packageCode===item.package_code} style={{...box,textAlign:"left",outline:packageCode===item.package_code?"2px solid #222":"none"}}><strong>{item.name}</strong><div>{item.care_kind} · up to {item.max_hours}h package</div><b>{money(item.base_price_per_pet)} / pet / unit</b></button>)}</div>}</section><section style={box}><h2>3. Eligible host</h2>{hosts.length===0?<p>No governed Boarding host is available for this window and pet count.</p>:<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>{hosts.map(host=><button key={host.providerId} onClick={()=>setHostId(host.providerId)} aria-pressed={selectedHost?.providerId===host.providerId} style={{...box,textAlign:"left",outline:selectedHost?.providerId===host.providerId?"2px solid #222":"none"}}><strong>{host.name}</strong><div>{host.area} · {host.rating.toFixed(1)} ★ · quality {host.qualityScore}</div><small>{host.homeVerified&&host.kycStatus==="verified"&&host.backgroundCheckStatus==="verified"?"Home + identity checks verified":"Verification incomplete"} · available guest pets {host.availableGuestPets??host.capacity}</small></button>)}</div>}</section><section style={{...box,position:"sticky",bottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}><div><strong>{quote?money(quote.totalAmount):"—"}</strong><div>{quote?`${quote.packageName} · ${quote.stayUnits} billed unit(s) · ${quote.petCount} pet(s)`:selectedPackage?.name||"Canonical quote unavailable"}</div><small>{quote?`${money(quote.amountDueNow)} full prepaid UAT amount · live money disabled`:"Refresh availability to continue"}</small></div>{accountLoading?<p>Loading your pets…</p>:accountError?<p role="alert">{accountError}</p>:!pets.length?<p role="alert">Add a pet to your PawSpace account before booking a Boarding stay.</p>:null}<Button size="lg" disabled={!quote||!selectedHost||busy||loading||!customer||pets.length===0} onClick={()=>void confirm()}>{busy?"Creating canonical stay…":"Reserve host + create stay →"}</Button></section></main>;
}
