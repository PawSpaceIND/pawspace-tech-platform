"use client";
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import type {SittingCarePlan} from '../../lib/sitting-lifecycle';
import {loadSittingCustomerView,saveSittingCustomerPlan,requestCustomerSittingCancellation,type SittingCustomerView} from '../../lib/sitting-customer-view';
const fields=[['feeding','Food and water routine'],['medication','Medication instructions from your vet'],['emergencyContact','Emergency contact'],['vet','Vet contact'],['homeAccess','Home access instructions'],['specialInstructions','Other care instructions']] as const;
const label=(text:string)=>text.replaceAll('_',' ');
const when=(value:string|number)=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',timeZoneName:'short'}):'Time unavailable';};
export default function SittingCustomerPanel({bookingId,children,initialCarePlan,initialError}:{bookingId:string;initialCarePlan?:SittingCarePlan;initialError?:string;children?:(booking:SittingCustomerView)=>ReactNode}){
 const[data,setData]=useState<SittingCustomerView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(initialError||''),[message,setMessage]=useState(''),[plan,setPlan]=useState<SittingCarePlan>({}),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const readVersion=useRef(0);
 const saveIntent=useRef({payload:'',key:''});
 const load=useCallback(()=>{const version=++readVersion.current;return loadSittingCustomerView(bookingId).then(value=>{if(version!==readVersion.current)return;setData(value);setPlan(value.carePlanStatus?value.carePlan:initialCarePlan||{});}).catch(problem=>{if(version!==readVersion.current)return;setData(null);setError(problem instanceof Error?problem.message:'Unable to load your sitting booking.');}).finally(()=>{if(version===readVersion.current)setLoading(false);});},[bookingId,initialCarePlan]);
 useEffect(()=>{void load();},[load]);
 const refresh=()=>{setLoading(true);setError('');void load();};
 const save=async()=>{setBusy(true);setError('');setMessage('');const payload=JSON.stringify({bookingId,plan});if(saveIntent.current.payload!==payload)saveIntent.current={payload,key:`sitting-plan:${crypto.randomUUID()}`};try{await saveSittingCustomerPlan(bookingId,plan,saveIntent.current.key);setMessage('Care instructions saved.');await load();}catch(problem){setError(problem instanceof Error?problem.message:'Care instructions were not confirmed.');}finally{setBusy(false);}};
 const cancel=async()=>{setBusy(true);setError('');setMessage('');try{const id=await requestCustomerSittingCancellation(bookingId,reason);setMessage(`Cancellation request ${id} recorded for policy review. Your booking is unchanged until a decision is recorded.`);}catch(problem){setError(problem instanceof Error?problem.message:'Cancellation request was not confirmed.');}finally{setBusy(false);}};
 const closed=Boolean(data&&['completed','cancelled'].includes(data.status));
 return <section style={{display:'grid',gap:16,padding:16,overflowWrap:'anywhere'}} aria-label="Your sitting booking">
  <header><h2 style={{fontSize:24,fontWeight:700}}>Your sitting booking</h2><p>{bookingId}</p><button disabled={loading||busy} onClick={refresh} style={{minHeight:44}}>Refresh booking</button></header>
  {loading&&<p role="status">Loading saved booking and care updates…</p>}
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {data&&!loading&&<><section><h3>Booking status</h3><p>{label(data.status)}</p><p>Booking total: {data.totalAmount==null?"Unavailable":new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(data.totalAmount)}</p><p>{when(data.scheduledStart)} – {when(data.scheduledEnd)}</p></section>
   <form onSubmit={event=>{event.preventDefault();void save();}} style={{display:'grid',gap:12}}><h3>Care instructions</h3><p>{data.carePlanStatus?`Saved plan: ${label(data.carePlanStatus)}`:'No care plan has been saved yet.'}</p>
   {fields.map(([key,title])=><label key={key} style={{display:'grid',gap:6}}>{title}<textarea value={plan[key]||''} required={['emergencyContact','vet','homeAccess'].includes(key)} disabled={busy||closed} onChange={event=>setPlan(current=>({...current,[key]:event.target.value}))} style={{width:'100%',minHeight:72,padding:10,border:'1px solid #adbdb5',borderRadius:8,fontSize:16}} /></label>)}
   <button disabled={busy||closed} style={{minHeight:44,background:'#124d3c',color:'white',borderRadius:8}}>{busy?'Please wait…':'Save care instructions'}</button></form>
   <section><h3>Recorded care activity</h3>{data.events.length?<ol>{data.events.map(event=><li key={event.id}><b>{label(event.type)}</b><p>{when(event.at)}</p></li>)}</ol>:<p>No care activity has been recorded yet.</p>}</section>
   {!closed&&data.status!=='in_progress'&&<form onSubmit={event=>{event.preventDefault();void cancel();}} style={{display:'grid',gap:8}}><h3>Request cancellation</h3><label>Reason<textarea required value={reason} onChange={event=>setReason(event.target.value)} disabled={busy} style={{width:'100%',minHeight:72,fontSize:16,border:'1px solid #adbdb5',padding:10}} /></label><p>A request starts policy review; it does not cancel the booking or issue a refund.</p><button disabled={busy||!reason.trim()} style={{minHeight:44}}>Submit cancellation request</button></form>}
   {children?.(data)}
   <p>Live location and sitter messaging are currently unavailable.</p>
  </>}
 </section>;
}
