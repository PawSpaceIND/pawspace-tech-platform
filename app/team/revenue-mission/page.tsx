"use client";

import{useEffect,useState}from"react";

type Command={
 status?:string;
 mission?:{name?:string;revenueBasis?:string};
 revenue?:{target?:number;achieved?:number;gap?:number;booked?:number;collected?:number;refunded?:number;netCollected?:number};
 pipeline?:{weightedPipeline?:number;unweightedPipeline?:number;ready?:number;suppressed?:number;reviewRequired?:number};
 leadQueue?:{currentAssignments?:number;unassigned?:number;unacknowledged?:number;slaBreached?:number;managerEscalationDue?:number;reassignmentDue?:number};
 warnings?:Array<{severity:string;code:string;message:string}>;
};

const money=(value:unknown)=>`₹${Number(value||0).toLocaleString("en-IN",{maximumFractionDigits:2})}`;

export default function RevenueMissionPage(){
 const[data,setData]=useState<Command|null>(null);
 const[error,setError]=useState("");
 useEffect(()=>{let active=true;void fetch("/api/revenue-mission-command-center",{cache:"no-store"}).then(async response=>{const payload=await response.json() as Command&{error?:string};if(!response.ok)throw new Error(payload.error||"Unable to load Revenue Mission Command Center");if(active)setData(payload);}).catch(err=>{if(active)setError(err instanceof Error?err.message:"Unable to load Revenue Mission Command Center");});return()=>{active=false;};},[]);
 const revenue=data?.revenue,pipeline=data?.pipeline,queue=data?.leadQueue,warnings=data?.warnings||[];
 return <main style={{maxWidth:1100,margin:"0 auto",padding:24,fontFamily:"system-ui,sans-serif"}}>
  <p><b>REVENUE MISSION CONTROL · UAT ONLY</b></p>
  <h1>{data?.mission?.name||"Revenue Mission Command Center"}</h1>
  <p>Production ready: NO</p>
  {error&&<p>{error}</p>}
  <section><h2>Revenue truth</h2><p>Target: <b>{money(revenue?.target)}</b> · Achieved: <b>{money(revenue?.achieved)}</b> · Gap: <b>{money(revenue?.gap)}</b></p><p>Booked: {money(revenue?.booked)} · Collected: {money(revenue?.collected)} · Refunded: {money(revenue?.refunded)} · Net collected: {money(revenue?.netCollected)}</p><p>Mission basis: {data?.mission?.revenueBasis||"—"}</p></section>
  <section><h2>Pipeline — not achieved revenue</h2><p>Weighted: {money(pipeline?.weightedPipeline)} · Unweighted: {money(pipeline?.unweightedPipeline)}</p><p>Ready: {pipeline?.ready||0} · Suppressed: {pipeline?.suppressed||0} · Review required: {pipeline?.reviewRequired||0}</p></section>
  <section><h2>Lead execution</h2><p>Current: {queue?.currentAssignments||0} · Unassigned: {queue?.unassigned||0} · Unacknowledged: {queue?.unacknowledged||0}</p><p>SLA breached: {queue?.slaBreached||0} · Manager escalation due: {queue?.managerEscalationDue||0} · Reassignment due: {queue?.reassignmentDue||0}</p></section>
  <section><h2>Warnings / blockers</h2>{warnings.length?warnings.map(item=><p key={item.code}><b>{item.severity.toUpperCase()}</b> · {item.message}</p>):<p>No current command-center warnings.</p>}</section>
 </main>;
}
