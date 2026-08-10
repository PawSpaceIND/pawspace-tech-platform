"use client";
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import {loadBoardingCommercial,type BoardingHost} from "../../lib/boarding-commercial-client";
import {loadOwnBoardingStays,updateBoardingStay,type BoardingStay,type BoardingStayAction} from "../../lib/boarding-stay-client";
import styles from "./host.module.css";

type Tab="today"|"requests"|"calendar"|"earnings"|"profile";
type Workspace={stays:BoardingStay[];providerId:string|null;cityId:string|null;zoneId:string|null;profile:BoardingHost|null};
const terminalStatuses=new Set(["completed","cancelled"]);

function formatDate(value:string){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric"}).format(date):value;}
function formatDateTime(value:string|number){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(date):String(value);}
function stayWindow(stay:BoardingStay){return `${formatDateTime(stay.check_in_at)} → ${formatDateTime(stay.check_out_at)}`;}
function statusLabel(value:string){return value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());}
function initials(value:string){return value.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()).join("")||"PH";}

async function loadWorkspace():Promise<Workspace>{const scoped=await loadOwnBoardingStays();let profile:BoardingHost|null=null;if(scoped.providerId&&scoped.cityId&&scoped.zoneId){const commercial=await loadBoardingCommercial({cityId:scoped.cityId,zoneId:scoped.zoneId});profile=commercial.hosts.find(item=>item.providerId===scoped.providerId)??null;}return{...scoped,profile};}

export default function HostPage(){
 const[tab,setTab]=useState<Tab>("today"),[stays,setStays]=useState<BoardingStay[]>([]),[profile,setProfile]=useState<BoardingHost|null>(null),[providerId,setProviderId]=useState<string|null>(null),[selectedId,setSelectedId]=useState(""),[busy,setBusy]=useState(""),[toast,setToast]=useState(""),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;void loadWorkspace().then(data=>{if(!active)return;setStays(data.stays);setProfile(data.profile);setProviderId(data.providerId);setSelectedId(current=>current&&data.stays.some(item=>item.id===current)?current:data.stays.find(item=>item.status==="awaiting_host_acceptance")?.id??data.stays[0]?.id??"");setError("");}).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to load Boarding workspace");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 const refresh=async()=>{const data=await loadWorkspace();setStays(data.stays);setProfile(data.profile);setProviderId(data.providerId);setSelectedId(current=>current&&data.stays.some(item=>item.id===current)?current:data.stays.find(item=>item.status==="awaiting_host_acceptance")?.id??data.stays[0]?.id??"");};
 const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2400);};
 const act=async(stay:BoardingStay,action:BoardingStayAction,input:Partial<{reason:string;careEventType:string;detail:Record<string,unknown>}>= {})=>{const key=action==="care_event"?`boarding:${stay.id}:${action}:${crypto.randomUUID()}`:`boarding:${stay.id}:${action}`;setBusy(`${stay.id}:${action}`);setError("");try{const result=await updateBoardingStay({stayId:stay.id,action,idempotencyKey:key,...input});notify(String(result.status||action).replaceAll("_"," "));await refresh();}catch(problem){setError(problem instanceof Error?problem.message:"Boarding action failed");}finally{setBusy("");}};
 const pending=useMemo(()=>stays.filter(item=>item.status==="awaiting_host_acceptance"),[stays]);
 const active=useMemo(()=>stays.filter(item=>["confirmed","in_progress"].includes(item.status)).sort((a,b)=>new Date(a.check_in_at).getTime()-new Date(b.check_in_at).getTime()),[stays]);
 const recovery=useMemo(()=>stays.filter(item=>item.status==="recovery_pending"),[stays]);
 const completed=useMemo(()=>stays.filter(item=>item.status==="completed"),[stays]);
 const upcoming=useMemo(()=>stays.filter(item=>!terminalStatuses.has(item.status)).sort((a,b)=>new Date(a.check_in_at).getTime()-new Date(b.check_in_at).getTime()),[stays]);
 const selected=stays.find(item=>item.id===selectedId)??pending[0]??active[0]??stays[0];
 const liveStay=active.find(item=>item.status==="in_progress")??active[0];
 const currentGuests=active.filter(item=>item.status==="in_progress").reduce((sum,item)=>sum+Number(item.pet_count||0),0);
 const hostName=profile?.name||selected?.provider_name||"Boarding host",hostInitials=initials(hostName),today=new Intl.DateTimeFormat("en-IN",{weekday:"long",day:"numeric",month:"long"}).format(new Date());
 const isBusy=(stay:BoardingStay,action:BoardingStayAction)=>busy===`${stay.id}:${action}`;
 const decline=async(stay:BoardingStay)=>{const reason=window.prompt("Reason for declining this stay");if(!reason)return;await act(stay,"decline",{reason});};
 const unavailable=async(stay:BoardingStay)=>{const reason=window.prompt("Why are you unavailable for this stay?");if(!reason)return;await act(stay,"host_unavailable",{reason});};
 const care=async(stay:BoardingStay,eventType:"meal"|"walk")=>{await act(stay,"care_event",{careEventType:eventType,detail:{source:"host_workspace"}});};
 return <main className={styles.shell}>
  <aside>
   <Link href="/boarding"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /></Link>
   <div className={styles.host}><span>{hostInitials}</span><div><strong>{hostName}</strong><small>{profile?`${profile.area} · ${profile.rating.toFixed(1)} ★`:providerId?"Canonical Boarding host":"Provider identity required"}</small></div></div>
   <nav>{[["today","⌂","Today"],["requests","▤","Requests"],["calendar","▦","Capacity"],["earnings","₹","Settlement"],["profile","♙","Home profile"]].map(([id,icon,label])=><button key={id} className={tab===id?styles.active:""} onClick={()=>setTab(id as Tab)}><i>{icon}</i>{label}{id==="requests"&&pending.length>0&&<b>{pending.length}</b>}</button>)}</nav>
   <div className={styles.sideFoot}><Link href="/boarding">← Customer marketplace</Link><button onClick={()=>notify("Host support remains UAT-routed")}>◎ Host support</button></div>
  </aside>
  <section className={styles.main}>
   <header><div><p>{today.toUpperCase()}</p><h1>{tab==="today"?`Hello, ${hostName.split(" ")[0]}`:tab==="requests"?"Canonical stay requests":tab==="calendar"?"Stay capacity":tab==="earnings"?"Settlement readiness":"Governed home profile"}</h1></div><span className={styles.live}>● UAT · canonical stays</span></header>
   {error&&<section className={styles.panel}><strong>Action required</strong><p>{error}</p></section>}
   {loading&&<section className={styles.panel}><p>Loading governed Boarding stays…</p></section>}
   {!loading&&tab==="today"&&<>
    <section className={styles.metrics}>
     <article><span>Current guests</span><strong>{currentGuests}</strong><small>Checked-in pets only</small></article>
     <article><span>Accepted stays</span><strong>{active.length}</strong><small>{pending.length} awaiting response</small></article>
     <article><span>Home capacity</span><strong>{profile?.capacity??"—"}</strong><small>{profile?.oneFamilyOnly?"One family at a time":"Governed pet capacity"}</small></article>
     <article><span>Recovery queue</span><strong>{recovery.length}</strong><small>Ops escalation when non-zero</small></article>
    </section>
    <section className={styles.todayGrid}>
     <div className={styles.panel}>
      <div className={styles.panelHead}><div><span>{liveStay?`${liveStay.status==="in_progress"?"LIVE STAY":"ACCEPTED STAY"} · ${liveStay.booking_id}`:"NO ACTIVE STAY"}</span><h2>{liveStay?"Canonical Care Card":"No accepted stay"}</h2></div>{liveStay&&<button onClick={()=>refresh().catch(problem=>setError(problem instanceof Error?problem.message:"Refresh failed"))}>↻ Refresh</button>}</div>
      {liveStay?<>
       <div className={styles.petHero}><span>{liveStay.pet_count}</span><div><h3>{liveStay.pet_count} pet{liveStay.pet_count===1?"":"s"}</h3><p>{stayWindow(liveStay)}</p></div><button onClick={()=>notify("Live customer messaging is not connected in Boarding UAT")}>Messaging status</button></div>
       <div className={styles.tasks}>
        <button><i>{liveStay.care_plan_status==="ready"?"✓":"!"}</i><div><strong>Care plan</strong><small>{statusLabel(liveStay.care_plan_status)}</small></div><span>›</span></button>
        <button><i>{liveStay.check_in_status==="complete"?"✓":"○"}</i><div><strong>Check-in</strong><small>{statusLabel(liveStay.check_in_status)}</small></div><span>›</span></button>
        <button><i>{liveStay.extension_status==="none"?"○":"!"}</i><div><strong>Extension</strong><small>{statusLabel(liveStay.extension_status)}</small></div><span>›</span></button>
        <button><i>{liveStay.check_out_status==="complete"?"✓":"○"}</i><div><strong>Check-out</strong><small>{statusLabel(liveStay.check_out_status)}</small></div><span>›</span></button>
       </div>
       <div className={styles.quick}>
        {liveStay.status==="confirmed"&&<button disabled={liveStay.care_plan_status!=="ready"||isBusy(liveStay,"check_in")} onClick={()=>act(liveStay,"check_in")}>✓ Check in</button>}
        {liveStay.status==="in_progress"&&<><button onClick={()=>care(liveStay,"meal")}>🍲 Log meal</button><button onClick={()=>care(liveStay,"walk")}>🦮 Log walk</button><Link href={`/host/proof?stayId=${encodeURIComponent(liveStay.id)}`}>📷 Proof · medication · incident</Link><button disabled={isBusy(liveStay,"check_out")} onClick={()=>window.confirm("Complete checkout for this stay?")&&void act(liveStay,"check_out")}>✓ Check out</button></>}
       </div>
       {liveStay.status==="in_progress"&&<div className={styles.marketSync}><b>Evidence workflow</b><span>Medication, photo proof and incidents use the secure Gate 4 proof workspace. Generic care events cannot bypass evidence, scan or incident governance.</span></div>}
       {liveStay.extension&&<div className={styles.marketSync}><b>Extension request</b><span>Requested checkout: {formatDateTime(liveStay.extension.requested_end)}. Status: {statusLabel(liveStay.extension.status)}. The paid stay window is unchanged until a governed quote is approved.</span></div>}
      </>:<p>No canonical accepted or active Boarding stay is assigned to this host.</p>}
     </div>
     <aside className={styles.panel}><div className={styles.panelHead}><div><span>CANONICAL EVENT HISTORY</span><h2>Stay timeline</h2></div></div>{liveStay?.events.length?liveStay.events.map(item=><article className={styles.timeline} key={item.id}><b>{formatDateTime(item.created_at)}</b><div><strong>{statusLabel(item.event_type)}</strong><small>{item.actor_id}</small></div></article>):<p>No stay events yet.</p>}</aside>
    </section>
   </>}
   {!loading&&tab==="requests"&&<section className={styles.requestLayout}>
    <div className={styles.panel}><div className={styles.panelHead}><div><span>SERVER-OWNED ASSIGNMENT OFFERS</span><h2>Awaiting host response</h2></div></div>{pending.length?pending.map(stay=><button key={stay.id} className={`${styles.request} ${selected?.id===stay.id?styles.selected:""}`} onClick={()=>setSelectedId(stay.id)}><span>{stay.pet_count}</span><div><strong>{stay.package_name||stay.package_code}</strong><small>{stayWindow(stay)}<br/>{stay.pet_count} pet{stay.pet_count===1?"":"s"} · {stay.booking_id}</small></div><b>Pending</b></button>):<p>No pending Boarding requests.</p>}{recovery.length>0&&<div className={styles.marketSync}><b>{recovery.length} stay{recovery.length===1?"":"s"} in recovery</b><span>Operations owns replacement after host decline, unavailability or no-show. The original booking is preserved.</span></div>}</div>
    <aside className={styles.panel}>{selected&&selected.status==="awaiting_host_acceptance"?<><span className={styles.match}>Canonical offer</span><h2>{selected.package_name||selected.package_code}</h2><p>{stayWindow(selected)}<br/>{selected.pet_count} pet{selected.pet_count===1?"":"s"} · Booking {selected.booking_id}</p><div className={styles.careNotes}><strong>Pre-acceptance controls</strong><span>✓ Host identity is server-owned</span><span>✓ Home verification and capacity are rechecked</span><span>✓ Customer payment is sandbox-captured before confirmation</span><span>✓ Host cannot override PawSpace price</span><span>✓ Payout formula is not yet configured</span></div><dl><div><dt>Customer booking value</dt><dd>₹{Number(selected.total_amount||0).toLocaleString("en-IN")}</dd></div><div><dt>Host price override</dt><dd>Disabled</dd></div><div><dt>Payout</dt><dd>Rule pending</dd></div></dl><div className={styles.actions}><button disabled={isBusy(selected,"accept")} onClick={()=>act(selected,"accept")}>Accept & lock capacity</button><button disabled={isBusy(selected,"decline")} onClick={()=>decline(selected)}>Decline with reason</button><button disabled={isBusy(selected,"host_unavailable")} onClick={()=>unavailable(selected)}>Mark unavailable</button></div></>:<p>Select a pending canonical stay request.</p>}</aside>
   </section>}
   {!loading&&tab==="calendar"&&<section className={styles.panel}><div className={styles.panelHead}><div><span>CANONICAL STAY WINDOWS</span><h2>Upcoming capacity commitments</h2></div><button onClick={()=>refresh().catch(problem=>setError(problem instanceof Error?problem.message:"Refresh failed"))}>Refresh</button></div>{upcoming.length?upcoming.map(stay=><div className={styles.earning} key={stay.id}><b>{formatDate(stay.check_in_at)}</b><span>{stayWindow(stay)}</span><small>{stay.pet_count} pet{stay.pet_count===1?"":"s"} · {statusLabel(stay.status)}</small><strong>{stay.booking_id}</strong></div>):<p>No upcoming stays.</p>}<div className={styles.legend}><span>Capacity locks are created on host acceptance.</span><span>One-family and pet-capacity rules are server enforced.</span></div></section>}
   {!loading&&tab==="earnings"&&<><section className={styles.metrics}><article><span>Settlement status</span><strong>Rule pending</strong><small>No invented host payout</small></article><article><span>Tax status</span><strong>Config required</strong><small>GST policy not approved here</small></article><article><span>Live payout</span><strong>Disabled</strong><small>UAT only</small></article><article><span>Completed stays</span><strong>{completed.length}</strong><small>Canonical checkout count</small></article></section><section className={styles.panel}><div className={styles.panelHead}><div><span>SETTLEMENT READINESS</span><h2>Completed Boarding stays</h2></div></div>{completed.length?completed.map(stay=><div className={styles.earning} key={stay.id}><b>{stay.booking_id}</b><span>{stay.package_name||stay.package_code}</span><small>Checkout complete</small><strong>Settlement not calculated</strong></div>):<p>No completed canonical stays yet.</p>}</section></>}
   {!loading&&tab==="profile"&&<section className={styles.profileGrid}><div className={styles.panel}><div className={styles.panelHead}><div><span>GOVERNED BOARDING HOST PROFILE</span><h2>{hostName}</h2></div></div>{profile?<><h3>{profile.area}</h3><p>This workspace reads verification, species eligibility and capacity from the Boarding host profile. Commercial prices remain PawSpace catalogue-owned.</p><div className={styles.badges}><span>✓ Capacity: {profile.capacity} pets</span><span>✓ Species: {profile.species.join(", ")}</span><span>{profile.oneFamilyOnly?"✓ One family at a time":"Multiple families allowed by profile"}</span><span>{profile.medicationSupport?"✓ Medication support":"Medication support not enabled"}</span><span>✓ Home: {profile.homeVerified?"verified":"not verified"}</span><span>✓ KYC: {profile.kycStatus}</span><span>✓ Background: {profile.backgroundCheckStatus}</span><span>✓ Profile version {profile.profileVersion}</span></div><div className={styles.marketSync}><b>Commercial governance</b><span>Host-specific price offers are disabled. Customer price comes from the canonical Boarding catalogue; host payout remains rule_pending until approved.</span></div></>:<p>No active governed Boarding profile is available for this provider identity.</p>}</div><aside className={styles.panel}><span>UAT BOUNDARY</span><h2>Not live yet</h2><dl><div><dt>Payments</dt><dd>Sandbox</dd></div><div><dt>WhatsApp / push</dt><dd>Queued only</dd></div><div><dt>Host payout</dt><dd>Rule pending</dd></div><div><dt>Media upload</dt><dd>Not connected</dd></div></dl></aside></section>}
  </section>
  {toast&&<div className={styles.toast}>✓ {toast}</div>}
 </main>;
}
