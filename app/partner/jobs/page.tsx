"use client";
import{useEffect,useState}from"react";
import Link from"next/link";

type Job={bookingId:string;serviceCode:string;packageName:string;scheduledStart:string;scheduledEnd:string;petCount:number;status:string;customerFirstName:string;group:string;needsActionReason:string|null;stayId:string|null;carePlanStatus:string|null;nextSlotStart:string|null};
type Counts={needsAction:number;today:number;upcoming:number;completed:number;total:number};
type Feed={providerId:string;needsAction:Job[];today:Job[];upcoming:Job[];completed:Job[];counts:Counts};

const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#01261F",panel:"#0b2b24",line:"#123c33",orange:"#F6920A",gold:"#E6B34E",green:"#3ecf8e",red:"#ff9a9a"};
const when=(v:string)=>v?v.slice(0,16).replace("T"," "):"—";
const statusColor=(s:string)=>s==="completed"?C.green:s==="awaiting_host_acceptance"?C.orange:["cancelled","host_unavailable"].includes(s)?C.red:C.gold;

async function load(){const r=await fetch("/api/partner-job-feed",{cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Load failed");return p.data as Feed;}

export default function PartnerJobsPage(){
  const[feed,setFeed]=useState<Feed|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
  const refresh=async()=>{try{setFeed(await load());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{let active=true;void load().then(x=>{if(active){setFeed(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  // Boarding accept/decline reuses the EXISTING governed mutation path (POST /api/boarding-stays,
  // provider actions "accept"/"decline" in lib/boarding-stay-lifecycle.ts) — no new mutation route.
  async function stayAction(stayId:string,action:"accept"|"decline"){
    setBusy(true);setMsg("");
    try{
      const r=await fetch("/api/boarding-stays",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({stayId,action,idempotencyKey:crypto.randomUUID(),reason:action==="decline"?"Declined from partner job feed":undefined})});
      const body=await r.json() as{error?:string};
      if(!r.ok)throw new Error(body.error||"Action failed");
      setMsg(action==="accept"?"Stay accepted — the customer has been notified.":"Stay declined — Operations will reassign.");
      await refresh();
    }catch(e){setMsg(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }

  const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,padding:18,marginTop:14};
  const h2:React.CSSProperties={fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:C.gold,margin:"24px 0 0"};
  const btn:React.CSSProperties={padding:"8px 14px",borderRadius:9,border:"none",background:C.green,color:"#01261F",fontWeight:700,cursor:"pointer"};
  const chip=(color:string):React.CSSProperties=>({display:"inline-block",padding:"2px 9px",borderRadius:999,fontSize:12,background:"rgba(255,255,255,0.06)",color});

  const jobCard=(job:Job)=><div key={job.bookingId} style={{borderBottom:`1px solid ${C.line}`,padding:"10px 0",display:"grid",gap:6}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
      <span><b>{job.serviceCode}</b> · {job.packageName} <small style={{color:C.dim}}>for {job.customerFirstName}</small></span>
      <span style={chip(statusColor(job.status))}>{job.status.replace(/_/g," ")}</span>
    </div>
    <div style={{color:C.dim,fontSize:13,display:"flex",gap:14,flexWrap:"wrap"}}>
      <span>{when(job.scheduledStart)} → {when(job.scheduledEnd)}</span>
      <span>{job.petCount} pet{job.petCount===1?"":"s"}</span>
      {job.nextSlotStart?<span>next slot {when(job.nextSlotStart)}</span>:null}
      {job.needsActionReason==="care_plan_required"?<span style={{color:C.orange}}>care plan pending from customer</span>:null}
    </div>
    {job.serviceCode==="boarding"&&job.status==="awaiting_host_acceptance"&&job.stayId?<div style={{display:"flex",gap:8}}>
      <button disabled={busy} style={btn} onClick={()=>void stayAction(job.stayId as string,"accept")}>Accept</button>
      <button disabled={busy} style={{...btn,background:"transparent",color:C.dim,border:`1px solid ${C.line}`}} onClick={()=>void stayAction(job.stayId as string,"decline")}>Decline</button>
    </div>:null}
  </div>;

  const section=(title:string,jobs:Job[]|undefined,empty:string,accent=false)=><>
    <h2 style={h2}>{title}{jobs?.length?` (${jobs.length})`:""}</h2>
    <div style={{...card,...(accent?{borderLeft:`4px solid ${C.orange}`}:{})}}>
      {jobs?.length?jobs.map(jobCard):<p style={{color:C.dim,margin:0}}>{empty}</p>}
    </div>
  </>;

  return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif"}}>
    <div style={{maxWidth:1000,margin:"0 auto",padding:"28px 20px 60px"}}>
      <p style={{margin:0}}><Link href="/partner/workspace" style={{color:C.dim,textDecoration:"none"}}>← Partner workspace</Link></p>
      <p style={{fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12,marginTop:10}}>PAWSPACE · PARTNER JOB FEED</p>
      <h1 style={{margin:"6px 0",fontSize:28}}>Your jobs</h1>
      <p style={{margin:0,color:C.dim}}>Every confirmed customer booking assigned to you, across all services — updated as bookings happen.</p>
      {error?<p style={{color:C.red}}>{error}</p>:null}
      {msg?<p style={{color:C.gold}}>{msg}</p>:null}
      {loading&&!feed?<p style={{color:C.dim}}>Loading your jobs…</p>:null}

      {feed?<>
        {section("Needs action",feed.needsAction,"Nothing needs your action right now.",true)}
        {section("Today",feed.today,"No jobs today.")}
        {section("Upcoming",feed.upcoming,"Nothing scheduled yet.")}
        {section("Completed (last 14 days)",feed.completed,"No recently completed jobs.")}
        <footer style={{marginTop:26,color:C.dim,fontSize:12}}>You see only your own assigned jobs. Customer contact details are never shown here — calls and messages go through the PawSpace app. Sandbox / UAT — no live money.</footer>
      </>:null}
    </div>
  </main>;
}
