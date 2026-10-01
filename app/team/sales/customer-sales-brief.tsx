"use client";
import {useCallback,useEffect,useState,type FormEvent} from 'react';
import {pawspaceServices} from '../../../lib/service-control';
import type {collectCustomerSalesBrief} from '../../../lib/customer-sales-brief-source';
import type {SalesBriefOverrideCommand} from '../../../lib/customer-sales-brief-overrides';

type Brief=Awaited<ReturnType<typeof collectCustomerSalesBrief>>;
export type SalesBriefResponse={data:Brief;capabilities:{editOverrides:boolean};contactChannel:string};
type Evidence={ref:string;observedAt:number;reason:string;expiresAt?:number};
const sentence=(value:string)=>value.replaceAll('_',' ').replace(/^[a-z]/,letter=>letter.toUpperCase());
const date=(at:number)=>Number.isFinite(at)?`${new Date(at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'})} IST`:'Date unavailable';
const box={padding:14,border:'1px solid var(--staff-line)',borderRadius:'calc(10px * var(--paw-radius-scale))',background:'var(--staff-surface)',minWidth:0};
const field={width:'100%',minHeight:44,padding:8,color:'var(--staff-text)',background:'var(--staff-surface)',border:'1px solid var(--staff-line)',borderRadius:6,font:'inherit'};

export async function loadCustomerSalesBrief(customerId:string,serviceCode:string,channel:string,request:typeof fetch=fetch,signal?:AbortSignal):Promise<SalesBriefResponse>{
 const response=await request(`/api/customer-sales-brief?${new URLSearchParams({customerId,serviceCode,channel})}`,{cache:'no-store',signal});
 const body=await response.json() as SalesBriefResponse&{error?:string};
 if(!response.ok||!body.data)throw new Error(body.error||'Sales brief unavailable');
 return body;
}
export async function saveCustomerSalesBriefOverride(command:SalesBriefOverrideCommand,request:typeof fetch=fetch){
 const response=await request('/api/customer-sales-brief/overrides',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
 const body=await response.json() as {error?:string};
 if(!response.ok)throw new Error(body.error||'Override was not saved');
 return body;
}
function EvidenceList({items}:{items:Evidence[]}){return items.length?<ul>{items.map(item=><li key={item.ref} style={{marginBottom:6}}>{sentence(item.reason)}<small style={{display:'block',color:'var(--staff-muted)'}}>{date(item.observedAt)}{item.expiresAt?` · valid until ${date(item.expiresAt)}`:''} · record {item.ref}</small></li>)}</ul>:<p style={{color:'var(--staff-muted)'}}>No current evidence recorded.</p>;}

export function SalesBriefPanel({response,onSave,busy=false,error='',asOf}:{response:SalesBriefResponse;onSave?:(command:SalesBriefOverrideCommand)=>Promise<void>;busy?:boolean;error?:string;asOf?:number}){
 const brief=response.data;
 const[clock,setClock]=useState(Date.now);
 useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),60000);return()=>clearInterval(timer);},[]);
 const viewedAt=asOf??clock;
 const stale=viewedAt<brief.generatedAt||viewedAt-brief.generatedAt>5*60000;
 const readinessExpired=brief.readiness.override?brief.readiness.override.expiresAt<=viewedAt:brief.readiness.evidence.some(item=>item.expiresAt!==undefined&&item.expiresAt<=viewedAt);
 const contactFresh=viewedAt>=brief.contact.checkedAt&&viewedAt-brief.contact.checkedAt<=5*60000;
 const[dimension,setDimension]=useState<SalesBriefOverrideCommand['dimension']>('readiness'),[value,setValue]=useState(brief.readiness.value as string),[reason,setReason]=useState(brief.readiness.override?.reason??''),[days,setDays]=useState(1);
 const override=dimension==='readiness'?brief.readiness.override:dimension==='subscriptionPotential'?brief.subscriptionPotential.override:brief.crossSellPotential.override;
 const canEdit=response.capabilities.editOverrides&&Boolean(onSave);
 const changeDimension=(next:SalesBriefOverrideCommand['dimension'])=>{setDimension(next);const current=next==='readiness'?brief.readiness.override:next==='subscriptionPotential'?brief.subscriptionPotential.override:brief.crossSellPotential.override;setValue(current?.value??(next==='readiness'?brief.readiness.value:'no'));setReason(current?.reason??'');};
 async function submit(event:FormEvent){event.preventDefault();if(!onSave)return;await onSave({action:'set',customerId:brief.customerId,serviceCode:brief.serviceCode,dimension,value,reason,expiresAt:Date.now()+days*86400000});}
 async function clear(){if(onSave)await onSave({action:'clear',customerId:brief.customerId,serviceCode:brief.serviceCode,dimension,reason});}
 return <div aria-label="Customer sales brief">
  <p style={{color:'var(--staff-muted)'}}>Prepared {date(brief.generatedAt)}. These labels describe recorded evidence; they do not predict whether someone will buy.</p>
  {(stale||readinessExpired)&&<p role="status">Refresh this brief to review current intent and contact eligibility.</p>}
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%, 200px),1fr))',gap:10}}>
   <section style={box}><h4>Customer lifecycle: {sentence(brief.lifecycle.value)}</h4><p>Distinct verified purchases or completed services. Separate from an inquiry or lead stage.</p><EvidenceList items={brief.lifecycle.evidence}/></section>
   <section style={box}><h4>Current readiness: {stale||readinessExpired?'Unknown · refresh required':sentence(brief.readiness.value)}</h4><EvidenceList items={brief.readiness.evidence}/>{brief.readiness.override&&<p>Staff override: {brief.readiness.override.reason}<small style={{display:'block'}}>By {brief.readiness.override.actorId} · expires {date(brief.readiness.override.expiresAt)}</small></p>}</section>
   {([['Subscription potential',brief.subscriptionPotential],['Cross-sell potential',brief.crossSellPotential]] as const).map(([label,offer])=><section key={label} style={box}><h4>{label}</h4><p>Relevance: {stale||offer.override&&offer.override.expiresAt<=viewedAt||offer.evidence.some(item=>item.expiresAt<=viewedAt)?'Unknown · refresh required':offer.candidate===null?'Unknown':offer.candidate?'Possible':'Not indicated'} · offer eligibility: {sentence(offer.eligibility)}</p><p>Status: {sentence(offer.status)}</p><EvidenceList items={offer.evidence}/>{offer.override&&<p>Staff override: {offer.override.reason}<small style={{display:'block'}}>Expires {date(offer.override.expiresAt)}</small></p>}</section>)}
  </div>
  <section style={{...box,marginTop:10}}><h4>Contact review · {response.contactChannel}</h4><p>{contactFresh?brief.contact.allowed?'Eligible under the current recorded marketing policy':'Contact blocked or eligibility unavailable':'Contact review expired · refresh required'} · {contactFresh?sentence(brief.contact.reason):`Previous decision: ${sentence(brief.contact.reason)}`}</p><p>Checked {date(brief.contact.checkedAt)}{brief.contact.nextEligibleAt&&brief.contact.nextEligibleAt>brief.contact.checkedAt?` · next policy review time ${date(brief.contact.nextEligibleAt)}`:''}. This brief sends no calls or messages; check the policy again before contacting.</p></section>
  <section style={{...box,marginTop:10}}><h4>Recorded Grooming subscriptions</h4>{brief.subscriptionContext===null?<p>Subscription records unavailable.</p>:!brief.subscriptionContext.length?<p>No Grooming subscription records found.</p>:<ul>{brief.subscriptionContext.map(subscription=><li key={subscription.id}>{subscription.planCode} · {sentence(subscription.status)} · {subscription.active&&subscription.expiresAt<=viewedAt?'Entitlement expired · refresh required':subscription.active&&stale?'Entitlement review stale · refresh required':subscription.active&&subscription.expiresAt>viewedAt?'Active entitlement':'Not an active entitlement'}<small style={{display:'block'}}>Expires {date(subscription.expiresAt)}</small></li>)}</ul>}<p>A pending subscription purchase is separate from an active entitlement or possible renewal offer.</p></section>
  <section style={{...box,marginTop:10}}><h4>Payment evidence</h4>{brief.paymentContext===null?<p>{brief.sourceStatus.paymentHistory==='restricted'?'Financial evidence is restricted for this role.':'Payment evidence unavailable.'}</p>:!brief.paymentContext.length?<p>No scoped payment records found.</p>:<ul>{brief.paymentContext.map(payment=><li key={payment.ref}>{payment.bookingId} · {sentence(payment.paymentStatus)} · {payment.captureVerified===true?'Capture verified':payment.captureVerified===false?'No reconciled capture':'Capture verification unknown'}{payment.refundRecorded===true?' · refund recorded':''} · full payment unknown{payment.reconciledAt&&<small style={{display:'block'}}>Reconciled {date(payment.reconciledAt)}</small>}</li>)}</ul>}{Boolean(brief.claimContext?.length)&&<p>{brief.claimContext?.length} recorded call claim(s) still require a structured canonical booking/payment link. A call tag alone is not a verified sale.</p>}</section>
  {error&&<p role="alert">{error}</p>}
  {canEdit?<form onSubmit={submit} style={{...box,marginTop:10}}><h4>Review a staff override</h4><p>Overrides change readiness or possible offer relevance, with an audit and expiry. They cannot change customer history, consent, eligibility or payments.</p><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%, 180px),1fr))',gap:10}}><label>Label<select style={field} value={dimension} onChange={event=>changeDimension(event.target.value as SalesBriefOverrideCommand['dimension'])}><option value="readiness">Current readiness</option><option value="subscriptionPotential">Subscription potential</option><option value="crossSellPotential">Cross-sell potential</option></select></label><label>Reviewed value<select style={field} value={value} onChange={event=>setValue(event.target.value)}>{(dimension==='readiness'?['hot','warm','cold','unknown']:['yes','no']).map(option=><option key={option} value={option}>{sentence(option)}</option>)}</select></label><label>Valid for days<input style={field} type="number" min={1} max={30} required value={days} onChange={event=>setDays(Number(event.target.value))}/></label></div><label style={{display:'block',marginTop:10}}>Evidence and reason<textarea style={{...field,resize:'vertical'}} required minLength={8} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)}/></label><div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:10}}><button type="submit" disabled={busy}>Save reviewed override</button>{override&&<button type="button" disabled={busy||reason.trim().length<8} onClick={()=>void clear()}>Clear override with audit</button>}</div></form>:<p>Staff overrides require customer-management permission.</p>}
 </div>;
}

export default function CustomerSalesBrief({customerId}:{customerId:string}){
 const[service,setService]=useState('grooming'),[channel,setChannel]=useState('voice'),[version,setVersion]=useState(0),[state,setState]=useState<{key:string;response?:SalesBriefResponse;error?:string}>({key:''}),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState('');
 const key=`${customerId}:${service}:${channel}:${version}`;
 useEffect(()=>{const controller=new AbortController();let active=true;const timer=setTimeout(()=>controller.abort(),15000);loadCustomerSalesBrief(customerId,service,channel,fetch,controller.signal).then(response=>{if(active)setState({key,response});},cause=>{if(active)setState({key,error:controller.signal.aborted?'Sales brief took too long to load. Refresh to retry.':cause instanceof Error?cause.message:'Sales brief unavailable'});}).finally(()=>clearTimeout(timer));return()=>{active=false;clearTimeout(timer);controller.abort();};},[customerId,service,channel,version,key]);
 const save=useCallback(async(command:SalesBriefOverrideCommand)=>{setBusy(true);setSaveError('');try{await saveCustomerSalesBriefOverride(command);setVersion(current=>current+1);}catch(cause){setSaveError(cause instanceof Error?cause.message:'Override was not saved');}finally{setBusy(false);}},[]);
 return <section style={{margin:'18px 0'}} aria-label="Sales preparation"><h3>Sales preparation</h3><div style={{display:'flex',flexWrap:'wrap',gap:12}}><label>Service<select style={field} value={service} onChange={event=>{setService(event.target.value);setSaveError('');}}>{pawspaceServices.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label><label>Contact channel<select style={field} value={channel} onChange={event=>{setChannel(event.target.value);setSaveError('');}}>{['voice','whatsapp','sms','email'].map(option=><option key={option} value={option}>{sentence(option)}</option>)}</select></label><button type="button" onClick={()=>setVersion(current=>current+1)}>Refresh brief</button></div>{state.key!==key?<p role="status">Loading sales brief…</p>:state.response?<SalesBriefPanel key={key} response={state.response} onSave={save} busy={busy} error={saveError}/>:<p role="alert">{state.error||'Sales brief unavailable. Refresh to retry.'}</p>}</section>;
}
