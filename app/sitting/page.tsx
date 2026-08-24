"use client";
/* eslint-disable @next/next/no-img-element */
import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import{createSittingQuote,loadSittingCatalogue,type SittingPackage,type SittingQuote}from"../../lib/sitting-commercial-client";
import{reserveUatSchedule,type UatScheduleResult}from"../../lib/uat-scheduling-client";
import{captureSittingQuoteSandbox}from"../../lib/sitting-payment-client";
import{createCanonicalSittingBooking,type SittingBookingResult}from"../../lib/sitting-booking-client";
import styles from"./sitting.module.css";

const sitters=[
 {providerId:"sit_sana",name:"Sana F.",initials:"SF",rating:"5.0",reviews:96,repeat:41,area:"HSR Layout",badge:"PawSpace Elite",skills:["Dogs & cats","Medication","Senior pets"],tone:"green"},
 {providerId:"sit_neha",name:"Neha P.",initials:"NP",rating:"4.9",reviews:148,repeat:58,area:"Indiranagar",badge:"Top repeat sitter",skills:["Overnight care","Multiple pets","Puppies"],tone:"purple"},
 {providerId:"sit_asha",name:"Asha R.",initials:"AR",rating:"4.8",reviews:112,repeat:37,area:"Koramangala",badge:"Fast responder",skills:["Cats","Plant care","Daily walks"],tone:"orange"},
];
const uatCustomer={id:"TST-101",name:"PawSpace UAT Customer",primaryPhone:"+919880222741",secondaryPhone:"+919880222742",email:"uat.customer@pawspace.test"};
const uatPets:Array<{sourceId:string;name:string;species:"dog"|"cat";breed:string;vaccinationStatus:string}>=[
 {sourceId:"TST-PET-BRUNO",name:"Bruno",species:"dog",breed:"Golden Retriever",vaccinationStatus:"verified"},
 {sourceId:"TST-PET-COCO",name:"Coco",species:"cat",breed:"Domestic Shorthair",vaccinationStatus:"verified"},
 {sourceId:"TST-PET-PEPPER",name:"Pepper",species:"dog",breed:"Indie",vaccinationStatus:"verified"},
 {sourceId:"TST-PET-MILO",name:"Milo",species:"cat",breed:"Domestic Shorthair",vaccinationStatus:"verified"},
];
const dateOffset=(days:number)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+days*86_400_000));

export default function SittingPage(){
 const[mode,setMode]=useState<"visit"|"overnight">("overnight");
 const[petCount,setPetCount]=useState(2);
 const[chosen,setChosen]=useState(sitters[0]);
 const[stage,setStage]=useState<"book"|"details"|"confirmed"|"live">("book");
 const[meet,setMeet]=useState(true);
 const[startDate,setStartDate]=useState(()=>dateOffset(5));
 const[endDate,setEndDate]=useState(()=>dateOffset(8));
 const[packages,setPackages]=useState<SittingPackage[]>([]);
 const[quote,setQuote]=useState<SittingQuote|null>(null);
 const[quoteError,setQuoteError]=useState("");
 const[quoteLoading,setQuoteLoading]=useState(true);
 const[bookingLoading,setBookingLoading]=useState(false);
 const[bookingError,setBookingError]=useState("");
 const[booking,setBooking]=useState<SittingBookingResult|null>(null);
 const[assignedProvider,setAssignedProvider]=useState<UatScheduleResult["provider"]|null>(null);
 const[paymentReference,setPaymentReference]=useState("");
 const[toast,setToast]=useState("");
 const flash=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2600);};
 const carePreferences=["Dogs & cats","Medication support","Overnight stay","Two daily walks","Plant care","One sitter only"];
 const[selectedPreferences,setSelectedPreferences]=useState<Set<string>>(new Set(carePreferences.slice(0,3)));
 const togglePreference=(x:string)=>setSelectedPreferences(prev=>{const next=new Set(prev);if(next.has(x))next.delete(x);else next.add(x);return next;});

 const packageCode=mode==="overnight"?"sitting-overnight":"sitting-visit-60";
 const activePackage=useMemo(()=>packages.find(item=>item.package_code===packageCode),[packages,packageCode]);
 const scheduledStart=mode==="overnight"?`${startDate}T20:00:00+05:30`:`${startDate}T10:00:00+05:30`;
 const scheduledEnd=mode==="overnight"?`${endDate}T08:00:00+05:30`:`${startDate}T11:00:00+05:30`;

 useEffect(()=>{
  let cancelled=false;
  queueMicrotask(()=>{if(cancelled)return;setQuoteLoading(true);setQuoteError("");setQuote(null);setBookingError("");});
  Promise.all([
   loadSittingCatalogue({scheduledStart}),
   createSittingQuote({packageCode,petCount,cityId:"blr",zoneId:"blr-east",scheduledStart,scheduledEnd,paymentMode:"prepaid"}),
  ]).then(([catalogue,nextQuote])=>{if(cancelled)return;setPackages(catalogue.packages);setQuote(nextQuote);})
   .catch(error=>{if(cancelled)return;setQuoteError(error instanceof Error?error.message:"Unable to refresh canonical Sitting quote");})
   .finally(()=>{if(!cancelled)setQuoteLoading(false);});
  return()=>{cancelled=true;};
 },[packageCode,petCount,scheduledStart,scheduledEnd]);

 const quoteAmount=quote?.totalAmount;
 const priceLabel=quoteLoading?"Refreshing canonical quote…":quoteError?quoteError:quote?`Canonical quote ${quote.quoteId} · expires ${new Date(quote.expiresAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}`:"Canonical quote unavailable";
 const caregiverName=assignedProvider?.name||chosen.name;
 const caregiverInitials=sitters.find(item=>item.providerId===assignedProvider?.id)?.initials||chosen.initials;

 async function finalizeBooking(){
  if(!quote||bookingLoading)return;
  setBookingLoading(true);setBookingError("");
  try{
   const pets=uatPets.slice(0,petCount),groupId=`sit-${quote.quoteId}`,idempotencyKey=`sitting:${quote.quoteId}:${uatCustomer.id}`;
   const schedule=await reserveUatSchedule({clientRequestId:groupId,customerId:uatCustomer.id,petIds:pets.map(pet=>pet.sourceId),serviceCode:"pet_sitting",zoneId:"blr-east",scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,occurrences:1,careMode:mode,preferredProviderId:chosen.providerId});
   const capture=await captureSittingQuoteSandbox({quoteId:quote.quoteId,amount:quote.amountDueNow});
   const result=await createCanonicalSittingBooking({idempotencyKey,groupId:schedule.groupId,sittingQuoteId:quote.quoteId,customer:uatCustomer,pets,cityId:"blr",zoneId:"blr-east",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,provider:schedule.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:"prepaid",detail:`Server-attested Sitting sandbox capture ${capture.reference}`}});
   setAssignedProvider(schedule.provider);setPaymentReference(capture.reference);setBooking(result);
   const canonicalCard=sitters.find(item=>item.providerId===schedule.provider.id);if(canonicalCard)setChosen(canonicalCard);
   setStage("confirmed");window.scrollTo(0,0);
  }catch(error){setBookingError(error instanceof Error?error.message:"Unable to create canonical Sitting booking");}
  finally{setBookingLoading(false);}
 }

 if(stage==="live")return <main className={styles.shell}><header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace"/></Link><span className={styles.livePill}>● Sitting demo in progress</span></header><section className={styles.livePage}><div className={styles.homeVisual}><span>🏠</span><i>🐕</i><i>🐈</i><div><strong>{caregiverName.split(" ")[0]} is at your home</strong><small>Secure check-in demo · 8:02 PM</small></div></div><aside><p className={styles.kicker}>UAT CARE DEMO</p><h1>Bruno and Coco are home, happy.</h1><div className={styles.sitterMini}><b>{caregiverInitials}</b><div><strong>{caregiverName}</strong><small>Canonical Sitting provider · {booking?.bookingId||"UAT"}</small></div><button onClick={()=>flash(`Opening secure chat with ${caregiverName}. UAT does not deliver a live message yet.`)}>Message</button></div><div className={styles.careEvents}>{[["✓","Dinner served","8:14 PM · both pets ate fully"],["✓","Evening walk","8:42 PM · 28 min · toilet logged"],["✓","Medication","9:20 PM · Bruno · photo proof"],["●","Bedtime update","Due by 10:30 PM"],["○","Morning routine","Scheduled 7:00 AM"]].map(e=><article key={e[1]}><i>{e[0]}</i><div><strong>{e[1]}</strong><small>{e[2]}</small></div></article>)}</div><div className={styles.homeSafety}><strong>Home safety demo</strong><span>Check-in/out GPS verification is not live yet</span><span>Primary + secondary contacts are UAT fixtures</span><span>24/7 escalation workflow is not production-connected</span><button onClick={()=>flash("Care Desk notified. In production this connects you to a live agent immediately; this UAT demo does not place a real call or alert.")}>⚠ Get urgent help</button></div><Link href="/mobile-app">Open complete Care Card →</Link></aside></section></main>;

 if(stage==="confirmed")return <main className={styles.shell}><header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace"/></Link><span className={styles.livePill}>✓ Canonical Sitting booking confirmed</span></header><section className={styles.confirmed}><i>✓</i><p className={styles.kicker}>{booking?.bookingId||"SITTING UAT"}</p><h1>Your UAT Sitting booking is confirmed.</h1><p>{startDate}{mode==="overnight"?`–${endDate}`:""} · {quote?.packageName||activePackage?.name||"Pet Sitting"} · {caregiverName}</p><div className={styles.confirmGrid}><article><span>Canonical booking</span><strong>{booking?.bookingId||"—"}</strong><small>One shared booking record · duplicate-safe</small></article><article><span>Assigned sitter</span><strong>{caregiverName}</strong><small>Provider came from canonical UAT scheduling</small></article><article><span>Sandbox payment</span><strong>{quoteAmount!=null?`₹${quoteAmount.toLocaleString("en-IN")}`:"—"}</strong><small>{paymentReference||booking?.paymentId||"Server-attested capture"}</small></article></div><div className={styles.notice}><span>🔐</span><div><strong>Gate 1 booking linkage is now server-owned.</strong><small>Quote, sitter reservation, sandbox payment attestation, booking, work order and payment record are linked. No production money is moved.</small></div></div><button onClick={()=>setStage("live")}>Open live sitting demo</button><button onClick={()=>setStage("book")}>Back to Sitting search</button></section></main>;

 return <main className={styles.shell}>{toast&&<div className={styles.toast}>{toast}</div>}<header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace"/></Link><nav><Link href="/boarding">Home Boarding</Link><Link href="/taxi">Pet Taxi</Link><Link href="/walking">Dog Walking</Link><Link href="/training">Training</Link><Link href="/mobile-app">My PawSpace</Link><Link href="/sitter">Sitter app</Link></nav></header><section className={styles.hero}><div><span>PAWSPACE PET SITTING</span><h1>Their routine stays.<br/><em>You can go.</em></h1><p>A verified sitter cares for your dogs, cats and home—while you follow every meal, walk and check-in from anywhere.</p><div><b>✓ Identity verified</b><b>✓ Home check-in tracked</b><b>✓ Daily Care Cards</b></div></div><aside><span>🏠</span><i>🐕</i><i>🐈</i><div><strong>Evening update received</strong><small>Both pets finished dinner ✓</small></div></aside></section>
 <section className={styles.search}><div className={styles.mode}><button className={mode==="visit"?styles.active:""} onClick={()=>setMode("visit")}><span>☀️</span><strong>Home Visit</strong><small>Single 60-minute service day in Gate 1</small></button><button className={mode==="overnight"?styles.active:""} onClick={()=>setMode("overnight")}><span>🌙</span><strong>Overnight Sitting</strong><small>Sitter stays at your home overnight</small></button></div><div className={styles.fields}><label>Home area<select><option>Indiranagar, Bangalore</option><option>Koramangala, Bangalore</option><option>HSR Layout, Bangalore</option><option>Whitefield, Bangalore</option></select></label><label>{mode==="visit"?"Visit date":"Start date"}<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>{mode==="overnight"&&<label>End date<input type="date" value={endDate} min={startDate} onChange={e=>setEndDate(e.target.value)}/></label>}<label>Pets<select value={petCount} onChange={e=>setPetCount(Number(e.target.value))}><option value="1">Bruno · 1 pet</option><option value="2">Bruno + Coco · 2 pets</option><option value="3">3 registered pets</option><option value="4">4 registered pets</option></select></label></div><p>No login needed to browse. Price below is generated by canonical Sitting governance, not the browser.</p></section>
 <section className={styles.flow}><span><b>1</b>Choose a sitter</span><i></i><span><b>2</b>Meet first</span><i></i><span><b>3</b>Share care & access</span><i></i><span><b>4</b>Follow live updates</span></section>
 <section className={styles.content}><aside className={styles.filters}><p className={styles.kicker}>HOME & PET NEEDS</p><h2>Care preferences</h2>{carePreferences.map((x)=><button className={selectedPreferences.has(x)?styles.on:""} key={x} onClick={()=>togglePreference(x)}><i>{selectedPreferences.has(x)?"✓":""}</i>{x}</button>)}<div><strong>Bruno + Coco</strong><span>Dog & cat · family profile</span><span>Care instructions 85% ready</span><Link href="/mobile-app">Complete pet profiles →</Link></div></aside><div className={styles.results}><div className={styles.resultHead}><div><p className={styles.kicker}>3 UAT SITTER PROFILES</p><h2>Trusted care near your home</h2></div><select><option>Best match</option><option>Top rated</option></select></div>{sitters.map((s,i)=><button className={`${styles.sitter} ${chosen.name===s.name?styles.chosen:""}`} key={s.name} onClick={()=>setChosen(s)}><i className={styles[s.tone]}>{s.initials}</i><div><span>{s.badge}</span><h3>{s.name}</h3><p>📍 {s.area} · replies in {5+i*4} min</p><div>{s.skills.map(skill=><b key={skill}>✓ {skill}</b>)}</div></div><aside><strong>{s.rating} ★</strong><small>{s.reviews} reviews</small><em>{s.repeat} repeat families</em></aside><footer><span>UAT profile · canonical scheduler verifies final assignment</span><strong>{activePackage?`₹${Number(activePackage.base_price_per_pet).toLocaleString("en-IN")}`:"—"}<small> / {mode==="overnight"?"night":"visit"}</small></strong></footer></button>)}</div></section>
 <section className={styles.plan}><div><p className={styles.kicker}>CARE PLAN</p><h2>Everything your sitter needs</h2><p>Food, walks, medication, home access and emergency contacts are confirmed before the first check-in.</p></div><div>{["🍲 Food & water routine","🦮 Walk & toilet routine","💊 Medication & health","🔐 Secure home access","☎ Emergency contacts","📸 Update preferences"].map(x=><button key={x} onClick={()=>flash(`${x} is managed from My PawSpace \u2192 My Pets.`)}>✓ {x}<span>Ready</span></button>)}</div></section><aside className={styles.checkout}><div><span>{quote?.packageName||activePackage?.name||"Canonical Sitting quote"} · {petCount} pets{quote?` · ${quote.billableUnits} unit${quote.billableUnits===1?"":"s"}`:""}</span><strong>{quoteAmount!=null?`₹${quoteAmount.toLocaleString("en-IN")}`:"—"}</strong><small>{priceLabel}</small></div><button disabled={!quote||quoteLoading||Boolean(quoteError)} onClick={()=>quote&&setStage("details")}>{quoteLoading?"Refreshing price…":quoteError?"Fix quote details":"Continue with canonical quote →"}</button></aside>
 {stage==="details"&&<div className={styles.modalBack}><section className={styles.modal}><button className={styles.close} onClick={()=>!bookingLoading&&setStage("book")}>×</button><p className={styles.kicker}>FINAL CARE & HOME DETAILS</p><h2>Help {chosen.name.split(" ")[0]} care like you do</h2><div className={styles.form}><label>Food & walk routine<textarea defaultValue="Bruno: meals at 7:30 AM and 6:30 PM, two walks. Coco: wet food at 8 AM and 7 PM."/></label><label>Medication<textarea defaultValue="Bruno: one tablet after breakfast. Coco: no medication."/></label><label>Home access<select><option>Secure key handover at Meet & Greet</option><option>Building staff access</option><option>Digital lock code</option></select></label><label>Emergency contact<input defaultValue="Rahul · +91 98802 22741"/></label></div><label className={styles.meet}><input type="checkbox" checked={meet} onChange={e=>setMeet(e.target.checked)}/> Meet & Greet before the booking</label><div className={styles.summary}><span>{chosen.name} requested · {quote?.packageName} · {petCount} pets</span><strong>{quoteAmount!=null?`₹${quoteAmount.toLocaleString("en-IN")}`:"—"}</strong></div><button className={styles.confirmBtn} disabled={!quote||bookingLoading} onClick={finalizeBooking}>{bookingLoading?"Reserving sitter & confirming…":"Confirm canonical UAT booking →"}</button>{bookingError&&<small>{bookingError}</small>}<small>Canonical quote {quote?.quoteId}. Confirmation reserves the sitter through UAT scheduling, creates a server-side sandbox payment attestation, then persists one canonical booking bundle. No live money.</small></section></div>}
 </main>;
}
