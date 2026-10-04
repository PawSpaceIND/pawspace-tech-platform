"use client";
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import Link from "next/link";
import {bookingPaymentHref} from '../../lib/customer-booking-safety';
import CaregiverConversation from "./caregiver-conversation";
import StayCareChoice from "./stay-care-choice";
import BookingServiceFeedback from "./booking-service-feedback";
import type {SittingCarePlan} from '../../lib/sitting-lifecycle';
import {loadSittingCustomerView,saveSittingCustomerPlan,requestCustomerSittingCancellation,type SittingCustomerView} from '../../lib/sitting-customer-view';
import {plainErrorMessage} from "../../lib/safe-json-response";
const fields=[['feeding','Food and water routine'],['medication','Medication instructions from your vet'],['emergencyContact','Emergency contact'],['vet','Vet contact'],['homeAccess','Home access instructions'],['specialInstructions','Other care instructions']] as const;
const label=(text:string)=>text.replaceAll('_',' ');
const when=(value:string|number)=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',timeZoneName:'short'}):'Time unavailable';};
/** An unpaid Sitting booking says so and links to its payment step (the Boarding manage page does the same). */
export function SittingBookingStatus({bookingId,status,routeScope="legacy"}:{bookingId:string;status:string;routeScope?:"legacy"|"v2"}){
 if(status!=='payment_pending')return <p>{label(status)}</p>;
 return <><p>Payment pending</p><p>Complete the payment to send this booking to your sitter. <Link href={bookingPaymentHref(bookingId,routeScope==='v2',true)}>Complete payment</Link></p></>;
}
export default function SittingCustomerPanel({bookingId,children,initialCarePlan,initialError,routeScope="legacy"}:{bookingId:string;initialCarePlan?:SittingCarePlan;initialError?:string;children?:(booking:SittingCustomerView)=>ReactNode;routeScope?:"legacy"|"v2"}){
 const[data,setData]=useState<SittingCustomerView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(initialError||''),[message,setMessage]=useState(''),[plan,setPlan]=useState<SittingCarePlan>({}),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const readVersion=useRef(0);
 const saveIntent=useRef({payload:'',key:''});
 const load=useCallback(()=>{const version=++readVersion.current;return loadSittingCustomerView(bookingId).then(value=>{if(version!==readVersion.current)return;setData(value);setPlan(value.carePlanStatus?value.carePlan:initialCarePlan||{});}).catch(problem=>{if(version!==readVersion.current)return;setData(null);setError(plainErrorMessage(problem,'Unable to load your sitting booking.'));}).finally(()=>{if(version===readVersion.current)setLoading(false);});},[bookingId,initialCarePlan]);
 useEffect(()=>{void load();},[load]);
 const refresh=()=>{setLoading(true);setError('');void load();};
 const save=async()=>{setBusy(true);setError('');setMessage('');const payload=JSON.stringify({bookingId,plan});if(saveIntent.current.payload!==payload)saveIntent.current={payload,key:`sitting-plan:${crypto.randomUUID()}`};try{await saveSittingCustomerPlan(bookingId,plan,saveIntent.current.key);setMessage('Care instructions saved.');await load();}catch(problem){setError(plainErrorMessage(problem,'Care instructions were not confirmed.'));}finally{setBusy(false);}};
 const cancel=async()=>{setBusy(true);setError('');setMessage('');try{const id=await requestCustomerSittingCancellation(bookingId,reason);setMessage(`Cancellation request ${id} recorded for policy review. Your booking is unchanged until a decision is recorded.`);}catch(problem){setError(plainErrorMessage(problem,'Cancellation request was not confirmed.'));}finally{setBusy(false);}};
 const closed=Boolean(data&&['completed','cancelled'].includes(data.status));
 return <section style={{display:'grid',gap:16,padding:16,overflowWrap:'anywhere'}} aria-label="Your sitting booking">
  <header><h2 style={{fontSize:24,fontWeight:700}}>Your sitting booking</h2><p>{bookingId}</p><button disabled={loading||busy} onClick={refresh} style={{minHeight:44}}>Refresh booking</button></header>
  {loading&&<p role="status">Loading saved booking and care updates…</p>}
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {data&&!loading&&<><CaregiverConversation key={bookingId} bookingId={bookingId}/><BookingServiceFeedback bookingId={bookingId} completed={data.status==="completed"}/><section><h3>Booking status</h3><SittingBookingStatus bookingId={bookingId} status={data.status} routeScope={routeScope}/><p>Booking total: {data.totalAmount==null?"Unavailable":new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(data.totalAmount)}</p><p>{when(data.scheduledStart)} – {when(data.scheduledEnd)}</p></section>
   {data.meetGreet&&<section aria-label="Meet and Greet"><h3>Meet &amp; Greet</h3><p>{data.meetGreet.format==='phone'?'Phone introduction':'In-person introduction'} · {label(data.meetGreet.status)}</p><p>Request {data.meetGreet.id} · preferred {when(data.meetGreet.preferredAt)} · quoted fee ₹{data.meetGreet.priceCharged}{data.meetGreet.priceWaived?' (waived for this stay)':''}</p><p>Arranged separately from this booking total. Request status is not proof of payment or completion.</p></section>}
   <form onSubmit={event=>{event.preventDefault();void save();}} style={{display:'grid',gap:12}}><h3>Care instructions</h3><p>{data.carePlanStatus?`Saved plan: ${label(data.carePlanStatus)}`:'No care plan has been saved yet.'}</p>
   {fields.map(([key,title])=>["feeding","medication","specialInstructions"].includes(key)?<StayCareChoice key={key} kind={key as "feeding"|"medication"|"specialInstructions"} title={title} value={plan[key]||''} disabled={busy||closed} onChange={value=>setPlan(current=>({...current,[key]:value}))}/>:<label key={key} style={{display:'grid',gap:6}}>{title}<textarea value={plan[key]||''} required={['emergencyContact','vet','homeAccess'].includes(key)} disabled={busy||closed} onChange={event=>setPlan(current=>({...current,[key]:event.target.value}))} style={{width:'100%',minHeight:72,padding:10,border:"1px solid var(--paw-muted)",borderRadius:"calc(8px * var(--paw-radius-scale))",fontSize:16}} /></label>)}
   <button disabled={busy||closed} style={{minHeight:44,background:"var(--paw-deep)",color:'white',borderRadius:"calc(8px * var(--paw-radius-scale))"}}>{busy?'Please wait…':'Save care instructions'}</button></form>
   <section><h3>Recorded care activity</h3>{data.events.length?<ol>{data.events.map(event=><li key={event.id}><b>{label(event.type)}</b><p>{when(event.at)}</p></li>)}</ol>:<p>No care activity has been recorded yet.</p>}</section>
   {!closed&&data.status!=='in_progress'&&<form onSubmit={event=>{event.preventDefault();void cancel();}} style={{display:'grid',gap:8}}><h3>Request cancellation</h3><label>Reason<textarea required value={reason} onChange={event=>setReason(event.target.value)} disabled={busy} style={{width:'100%',minHeight:72,fontSize:16,border:"1px solid var(--paw-muted)",padding:10}} /></label><p>A request starts policy review; it does not cancel the booking or issue a refund.</p><button disabled={busy||!reason.trim()} style={{minHeight:44}}>Submit cancellation request</button></form>}
   {children?.(data)}
   <p>Live location and sitter messaging are currently unavailable.</p>
  </>}
 </section>;
}
