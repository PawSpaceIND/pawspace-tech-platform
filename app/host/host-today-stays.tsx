import Link from "next/link";
import type {BoardingStay,BoardingStayAction} from "../../lib/boarding-stay-client";
import {windowEnded} from "../../lib/provider-offer-copy";
import HostStayCare,{petSummary} from "./host-stay-care";
import styles from "./host.module.css";

export type HostCareEvent="meal"|"play"|"walk";
type Props={
 /** The stays that belong on Today, already in time order (todayStays). */
 stays:BoardingStay[];
 hostBase:string;
 /** The stay the host opened from their jobs (?bookingId=), shown highlighted. */
 focusBookingId?:string;
 isBusy:(stay:BoardingStay,action:BoardingStayAction)=>boolean;
 onCheckIn:(stay:BoardingStay)=>void;
 onCare:(stay:BoardingStay,eventType:HostCareEvent)=>void;
 onCheckOut:(stay:BoardingStay)=>void;
 onNotify:(message:string)=>void;
 onRefresh:()=>void;
};

function formatDateTime(value:string|number){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(date):String(value);}
function statusLabel(value:string){return value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());}

/**
 * Every stay the host has work on: each checked-in stay until checkout, and each accepted stay whose window
 * has not ended, earliest check-in first. The Today tab used to act on ONE of them (the in-progress stay,
 * else the earliest accepted one), so a host holding another stay could not check in the one actually due.
 */
export function todayStays(stays:BoardingStay[],now=Date.now()){
 return stays.filter(item=>item.status==="in_progress"||item.status==="confirmed"&&!windowEnded(item.check_out_at,item.check_in_at,now))
  .sort((a,b)=>new Date(a.check_in_at).getTime()-new Date(b.check_in_at).getTime());
}

/** One stay's Care Card with its own controls: every button acts on this stay and no other. */
export function HostTodayStay({stay,hostBase,focused,isBusy,onCheckIn,onCare,onCheckOut,onNotify,onRefresh}:Omit<Props,"stays"|"focusBookingId">&{stay:BoardingStay;focused:boolean}){
 const live=stay.status==="in_progress";
 return <section className={`${styles.todayGrid} ${focused?styles.focusedStay:""}`} aria-label={`Stay ${stay.booking_id}`} data-booking-id={stay.booking_id}>
  <div className={styles.panel}>
   <div className={styles.panelHead}><div><span>{live?"LIVE STAY":"ACCEPTED STAY"} · {stay.booking_id}</span><h2>Canonical Care Card</h2></div><button onClick={onRefresh}>↻ Refresh</button></div>
   <div className={styles.petHero}><span>{stay.pet_count}</span><div><h3>{petSummary(stay)}</h3><p>{formatDateTime(stay.check_in_at)} → {formatDateTime(stay.check_out_at)}</p></div><button onClick={()=>onNotify("Live customer messaging is not connected in Boarding UAT")}>Messaging status</button></div>
   <div className={styles.tasks}>
    <button onClick={()=>onNotify(`Care plan status: ${statusLabel(stay.care_plan_status)}. The customer's pets and care plan are shown below.`)}><i>{stay.care_plan_status==="ready"?"✓":"!"}</i><div><strong>Care plan</strong><small>{statusLabel(stay.care_plan_status)}</small></div><span>›</span></button>
    <button onClick={()=>onNotify(`Check-in status: ${statusLabel(stay.check_in_status)}. Use the quick actions below to update it.`)}><i>{stay.check_in_status==="complete"?"✓":"○"}</i><div><strong>Check-in</strong><small>{statusLabel(stay.check_in_status)}</small></div><span>›</span></button>
    <button onClick={()=>onNotify(`Extension status: ${statusLabel(stay.extension_status)}.`)}><i>{stay.extension_status==="none"?"○":"!"}</i><div><strong>Extension</strong><small>{statusLabel(stay.extension_status)}</small></div><span>›</span></button>
    <button onClick={()=>onNotify(`Check-out status: ${statusLabel(stay.check_out_status)}. Use the quick actions below to update it.`)}><i>{stay.check_out_status==="complete"?"✓":"○"}</i><div><strong>Check-out</strong><small>{statusLabel(stay.check_out_status)}</small></div><span>›</span></button>
   </div>
   <HostStayCare stay={stay}/>
   <div className={styles.quick}>
    {stay.status==="confirmed"&&<button disabled={stay.care_plan_status!=="ready"||isBusy(stay,"check_in")} onClick={()=>onCheckIn(stay)}>✓ Check in</button>}
    {live&&<><button onClick={()=>onCare(stay,"meal")}>🍲 Log meal</button><button onClick={()=>onCare(stay,"play")}>🎾 Log play</button><button onClick={()=>onCare(stay,"walk")}>🦮 Log walk</button><Link href={`${hostBase}/proof?stayId=${encodeURIComponent(stay.id)}`}>📷 Proof · medication · incident</Link><button disabled={isBusy(stay,"check_out")} onClick={()=>onCheckOut(stay)}>✓ Check out</button></>}
   </div>
   {live&&<div className={styles.marketSync}><b>Evidence workflow</b><span>Medication, photo proof and incidents use the secure Gate 4 proof workspace. Generic care events cannot bypass evidence, scan or incident governance.</span></div>}
   {stay.extension&&<div className={styles.marketSync}><b>Extension request</b><span>Requested checkout: {formatDateTime(stay.extension.requested_end)}. Status: {statusLabel(stay.extension.status)}. The paid stay window is unchanged until a governed quote is approved.</span></div>}
  </div>
  <aside className={styles.panel}><div className={styles.panelHead}><div><span>CANONICAL EVENT HISTORY · {stay.booking_id}</span><h2>Stay timeline</h2></div></div>{stay.events.length?stay.events.map(item=><article className={styles.timeline} key={item.id}><b>{formatDateTime(item.created_at)}</b><div><strong>{statusLabel(item.event_type)}</strong><small>{item.actor_id}</small></div></article>):<p>No stay events yet.</p>}</aside>
 </section>;
}

/** The Today tab's stays: each due or active stay with its own check-in, care and check-out controls. */
export default function HostTodayStays({stays,focusBookingId,...rest}:Props){
 if(!stays.length)return <section className={styles.todayGrid}><div className={styles.panel}><div className={styles.panelHead}><div><span>NO ACTIVE STAY</span><h2>No accepted stay</h2></div></div><p>No canonical accepted or active Boarding stay is assigned to this host.</p></div></section>;
 return <div className={styles.todayStays}>{stays.map(stay=><HostTodayStay key={stay.id} stay={stay} focused={Boolean(focusBookingId)&&stay.booking_id===focusBookingId} {...rest}/>)}</div>;
}
