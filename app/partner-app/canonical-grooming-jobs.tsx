"use client";

import{useEffect,useMemo,useState}from"react";
import GroomingRouteCard from"./grooming-route-card";

type Pet={id:string;name:string;species:string;breed:string;vaccinationStatus:string};
type Event={eventType:string;entityType:string;actorId:string;detail:Record<string,unknown>;occurredAt:number};
type Job={bookingId:string;workOrderId:string;providerId:string;providerName:string;providerModel:string;status:string;workOrderStatus:string;occurrenceCount:number;packageCode:string;packageName:string;zoneId:string;cityId:string;scheduledStart:string;scheduledEnd:string;totalAmount:number;currency:string;customer:{id:string;name:string;maskedPhone:string};pets:Pet[];payment:{method:string;mode:string;status:string;amount:number;amountDueNow:number};subscription:string|null;proof:{beforePhotoRef:string|null;afterPhotoRef:string|null;checklist:string[];completionNotes:string|null;updatedAt:number}|null;invoice:{invoiceNumber:string;status:string;netAmount:number;issuedAt:number}|null;events:Event[]};
type JobsResponse={source?:string;providerId?:string;jobs?:Job[];error?:string};

const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(value);
const when=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("en-IN",{day:"2-digit",month:"short",hour:"numeric",minute:"2-digit"}).format(date);};
const statusLabel=(value:string)=>value.replaceAll("_"," ");

export default function CanonicalGroomingJobs(){
  const[jobs,setJobs]=useState<Job[]>([]);
  const[selectedId,setSelectedId]=useState<string>("");
  const[error,setError]=useState("");
  const[busy,setBusy]=useState(false);
  const[refreshKey,setRefreshKey]=useState(0);
  const selected=useMemo(()=>jobs.find(job=>job.bookingId===selectedId)??jobs[0]??null,[jobs,selectedId]);

  useEffect(()=>{let cancelled=false;fetch(`/api/partner-grooming-jobs?providerId=groom_arun&v=${refreshKey}`,{cache:"no-store"}).then(async response=>{const body=await response.json() as JobsResponse;if(!response.ok)throw new Error(body.error||"Unable to load canonical jobs");return body;}).then(body=>{if(cancelled)return;const next=body.jobs??[];setJobs(next);setError("");setSelectedId(current=>current&&next.some(job=>job.bookingId===current)?current:(next[0]?.bookingId??""));}).catch(err=>{if(!cancelled)setError(err instanceof Error?err.message:"Unable to load canonical jobs");});return()=>{cancelled=true};},[refreshKey]);

  const act=async(action:"accept"|"decline"|"on_the_way"|"arrived"|"start_service"|"add_proof"|"complete")=>{if(!selected)return;setBusy(true);setError("");try{if((action==="accept"||action==="decline")&&selected.providerModel==="commission"){const response=await fetch("/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId:selected.bookingId,providerId:selected.providerId,action,reason:action==="accept"?"Accepted in Partner app":"Declined in Partner app"})});const body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"Unable to respond to provider offer");setRefreshKey(value=>value+1);return;}if(action==="decline")throw new Error("Only commission-provider offers can be declined");const input:Record<string,unknown>={bookingId:selected.bookingId,action,actorId:selected.providerId};if(action==="add_proof"){input.beforePhotoRef=`uat://proof/${selected.bookingId}/before`;input.afterPhotoRef=`uat://proof/${selected.bookingId}/after`;input.checklist=["Coat/skin check","Nails/ears/eyes completed","Customer-visible finish review"];input.completionNotes="UAT service proof captured from Partner app";}const response=await fetch("/api/grooming-lifecycle",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"Unable to update lifecycle");setRefreshKey(value=>value+1);}catch(err){setError(err instanceof Error?err.message:"Unable to update lifecycle");}finally{setBusy(false);}};

  const nextAction=selected?selected.status==="confirmed"||selected.status==="awaiting_acceptance"?"accept":selected.status==="assigned"?"on_the_way":selected.status==="on_the_way"?"arrived":selected.status==="arrived"?"start_service":selected.status==="in_service"&&!selected.proof?.beforePhotoRef?"add_proof":selected.status==="in_service"?"complete":null:null;
  const actionLabel=nextAction==="accept"?"Accept job":nextAction==="on_the_way"?"Start journey":nextAction==="arrived"?"Mark arrived":nextAction==="start_service"?"Start service":nextAction==="add_proof"?"Add UAT proof":nextAction==="complete"?"Complete job":"Closed";
  const canDecline=Boolean(selected&&selected.providerModel==="commission"&&(selected.status==="confirmed"||selected.workOrderStatus==="awaiting_acceptance"));

  return <div style={{display:"grid",gridTemplateColumns:"minmax(300px,.9fr) minmax(420px,1.1fr)",gap:18}}>
    <section style={{background:"white",border:"1px solid #eadff4",borderRadius:18,padding:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:16}}><div><small style={{fontWeight:800,color:"#7540aa",letterSpacing:1}}>CANONICAL WORK ORDERS</small><h2 style={{margin:"6px 0"}}>Grooming assignments</h2></div><button onClick={()=>setRefreshKey(value=>value+1)} style={{border:"1px solid #d8cae7",background:"white",borderRadius:10,padding:"9px 12px",fontWeight:700}}>Refresh</button></div>
      {error&&<div style={{padding:12,borderRadius:10,background:"#fff1f1",marginBottom:12}}>{error}</div>}
      {jobs.length===0&&!error&&<div style={{padding:26,textAlign:"center",color:"#746b7d"}}>No canonical Grooming work orders are assigned to groom_arun yet.</div>}
      <div style={{display:"grid",gap:10}}>{jobs.map(job=><button key={job.bookingId} onClick={()=>setSelectedId(job.bookingId)} style={{textAlign:"left",padding:14,borderRadius:12,border:selected?.bookingId===job.bookingId?"2px solid #6c2da8":"1px solid #e8dfef",background:selected?.bookingId===job.bookingId?"#faf5ff":"white"}}><div style={{display:"flex",justifyContent:"space-between",gap:10}}><strong>{when(job.scheduledStart)}</strong><em style={{fontStyle:"normal",fontSize:12,textTransform:"capitalize"}}>{statusLabel(job.status)}</em></div><b style={{display:"block",marginTop:7}}>{job.packageName}</b><small>{job.pets.map(pet=>pet.name).join(", ")} · {job.zoneId}</small><div style={{display:"flex",justifyContent:"space-between",marginTop:8}}><span>{job.customer.name}</span><strong>{money(job.totalAmount)}</strong></div></button>)}</div>
    </section>

    <section style={{background:"white",border:"1px solid #eadff4",borderRadius:18,padding:22}}>
      {!selected?<div style={{padding:30,textAlign:"center",color:"#746b7d"}}>Select a canonical work order.</div>:<>
        <div style={{display:"flex",justifyContent:"space-between",gap:14,alignItems:"flex-start"}}><div><small style={{fontWeight:800,color:"#7540aa"}}>BOOKING {selected.bookingId}</small><h2 style={{margin:"7px 0"}}>{selected.packageName}</h2><p style={{margin:0,color:"#6f6577"}}>{when(selected.scheduledStart)} → {when(selected.scheduledEnd)}</p></div><span style={{padding:"7px 10px",borderRadius:999,background:"#f2e8ff",fontWeight:800,textTransform:"capitalize"}}>{statusLabel(selected.status)}</span></div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginTop:18}}>
          {[["Customer",selected.customer.name],["Contact",selected.customer.maskedPhone],["Pets",selected.pets.map(pet=>`${pet.name}${pet.breed?` · ${pet.breed}`:""}`).join(" | ")],["Vaccination",selected.pets.map(pet=>pet.vaccinationStatus).join(", ")],["Payment",`${statusLabel(selected.payment.mode)} · ${statusLabel(selected.payment.status)}`],["Package value",money(selected.totalAmount)],["Work order",selected.workOrderId],["Provider model",statusLabel(selected.providerModel)]].map(([label,value])=><div key={label} style={{border:"1px solid #eee6f4",borderRadius:11,padding:12}}><small style={{color:"#756b7e"}}>{label}</small><b style={{display:"block",marginTop:4}}>{value}</b></div>)}
        </div>
        <div style={{marginTop:18,padding:14,borderRadius:12,background:"#faf8fc"}}><b>Service proof</b><p style={{margin:"7px 0 0",fontSize:13}}>{selected.proof?`${selected.proof.beforePhotoRef?"Before ✓":"Before —"} · ${selected.proof.afterPhotoRef?"After ✓":"After —"} · Checklist ${selected.proof.checklist.length}`:"Not captured yet"}</p>{selected.invoice&&<p style={{margin:"6px 0 0",fontSize:13}}><b>Invoice:</b> {selected.invoice.invoiceNumber} · {money(selected.invoice.netAmount)}</p>}</div>
        <GroomingRouteCard bookingId={selected.bookingId} providerId={selected.providerId} />
        <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:18}}><button disabled={busy||!nextAction} onClick={()=>nextAction&&void act(nextAction)} style={{padding:"11px 16px",border:0,borderRadius:10,background:"#4b168c",color:"white",fontWeight:800,opacity:busy||!nextAction?0.7:1}}>{busy?"Updating…":actionLabel}</button>{canDecline&&<button disabled={busy} onClick={()=>void act("decline")} style={{padding:"11px 16px",borderRadius:10,border:"1px solid #d8cae7",background:"white",fontWeight:700}}>Decline job</button>}<button onClick={()=>setRefreshKey(value=>value+1)} style={{padding:"11px 16px",borderRadius:10,border:"1px solid #d8cae7",background:"white",fontWeight:700}}>Reload timeline</button></div>
        <div style={{marginTop:20}}><small style={{fontWeight:800,color:"#7540aa"}}>CANONICAL TIMELINE</small><div style={{display:"grid",gap:8,marginTop:9}}>{selected.events.slice(0,8).map((event,index)=><div key={`${event.eventType}-${event.occurredAt}-${index}`} style={{display:"flex",justifyContent:"space-between",gap:12,borderBottom:"1px solid #f0ebf4",paddingBottom:8}}><span style={{textTransform:"capitalize"}}>{statusLabel(event.eventType)}</span><small>{new Date(event.occurredAt).toLocaleString("en-IN")}</small></div>)}</div></div>
        <p style={{fontSize:12,color:"#776d80",marginTop:16}}>Canonical UAT data only. Customer phone remains masked; proof references are synthetic until secure media storage is connected.</p>
      </>}
    </section>
  </div>;
}
