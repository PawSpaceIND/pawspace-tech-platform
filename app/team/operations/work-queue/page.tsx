"use client";
import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import{StatCard}from"../../../components/ui";

type Row=Record<string,unknown>;
type Task=Row&{id:string;rule:string;queue:string;priority:string;title:string;status:string;owner:string|null;due_at:number;escalated:number;booking_id:string|null;customer_id:string|null;provider_id:string|null};
type Snapshot={generatedAt:number;metrics:{total:number;open:number;escalated:number;critical:number;resolvedToday:number};queues:Record<string,{open:number;escalated:number;tasks:Task[]}>;commandCentre:Record<string,unknown>&{available:boolean;byService?:Record<string,{bookings:number;revenue:number;completed:number;cancelled:number}>}};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());
const money=(value:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value||0));
const due=(at:number)=>{const minutes=Math.round((Number(at)-Date.now())/60_000);return minutes>=0?`due in ${minutes}m`:`overdue ${-minutes}m`};

async function loadSnapshot():Promise<Snapshot>{const response=await fetch("/api/ops-work-queue",{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"Unable to load the work queue");return body.data as Snapshot;}
async function act(input:{action:string;taskId:string;note?:string;owner?:string}){const response=await fetch("/api/ops-work-queue",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error||"Work queue action failed");return body.data as Row;}

export default function OpsWorkQueuePage(){
 const[snapshot,setSnapshot]=useState<Snapshot|null>(null),[queueFilter,setQueueFilter]=useState("all"),[selectedId,setSelectedId]=useState(""),[note,setNote]=useState(""),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState("");
 function refresh(){loadSnapshot().then(data=>{setSnapshot(data);setError("");}).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load the work queue"));}
 useEffect(()=>{let active=true;loadSnapshot().then(data=>{if(active){setSnapshot(data);}}).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to load the work queue")});return()=>{active=false};},[]);
 const tasks=useMemo(()=>{if(!snapshot)return [] as Task[];const all=Object.entries(snapshot.queues).flatMap(([queue,bucket])=>queueFilter==="all"||queueFilter===queue?bucket.tasks:[]);return all.filter(task=>["open","acknowledged","in_progress"].includes(String(task.status)));},[snapshot,queueFilter]);
 const selected=tasks.find(task=>task.id===selectedId)??tasks[0];
 async function run(action:string){if(!selected)return;setBusy(action);setError("");setMessage("");try{const result=await act({action,taskId:selected.id,note});setMessage(`${label(action)} · ${label(result.status??"done")}`);setNote("");refresh();}catch(problem){setError(problem instanceof Error?problem.message:"Work queue action failed");}finally{setBusy("");}}
 const centre=snapshot?.commandCentre;
 return <main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/team/operations">← Operations home</Link><p>TEAM OS · OPERATIONS · WORK QUEUE</p><h1>Exception work queue</h1><p>Real exceptions from canonical tables become owned, SLA-tracked tasks — no WhatsApp archaeology.</p></header>
  {snapshot&&<section style={{display:"grid",gridTemplateColumns:"repeat(5,minmax(120px,1fr))",gap:12}}>
   {[["Open",snapshot.metrics.open],["Escalated",snapshot.metrics.escalated],["Critical",snapshot.metrics.critical],["Resolved today",snapshot.metrics.resolvedToday],["All tasks",snapshot.metrics.total]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as number}/>)}
  </section>}
  {centre?.available===true&&<section style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
   <h2>Business command centre · today</h2>
   <p>{String(centre.bookings)} bookings · {money(centre.revenue)} · {String(centre.completed)} completed · {String(centre.upcoming)} upcoming · {String(centre.unassigned)} unassigned · {String(centre.cancelled)} cancelled · {String(centre.refundPending)} refunds pending · {String(centre.openComplaints)} open complaints</p>
   <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>{Object.entries(centre.byService||{}).map(([service,stats])=><span key={service} style={{border:"1px solid #e9f1ee",borderRadius:10,padding:"6px 10px"}}><b>{label(service)}</b> · {stats.bookings} bookings · {money(stats.revenue)}</span>)}</div>
  </section>}
  <div>
   {["all","operations","finance","qc","sales_relocation","retention","crm_escalation"].map(item=><button key={item} disabled={queueFilter===item} onClick={()=>setQueueFilter(item)}>{label(item)}{item!=="all"&&snapshot?.queues[item]?` (${snapshot.queues[item].open})`:""}</button>)}
   <button onClick={refresh}>Refresh</button>
  </div>
  {error&&<p role="alert">{error}</p>}{message&&<p>{message}</p>}
  <section style={{display:"grid",gridTemplateColumns:"minmax(360px,.9fr) minmax(520px,1.1fr)",gap:16,alignItems:"start"}}>
   <aside style={{border:"1px solid #dcece5",borderRadius:14,overflow:"hidden"}}>
    {tasks.length===0&&<p style={{padding:16}}>No open tasks in this queue. 🎉</p>}
    {tasks.map(task=><button key={task.id} onClick={()=>setSelectedId(task.id)} style={{display:"block",width:"100%",padding:12,textAlign:"left",border:0,borderBottom:"1px solid #e9f1ee",background:selected?.id===task.id?"#f3f3f3":"white"}}>
     <strong>{Number(task.escalated)===1?"⚠️ ":""}{label(task.priority)} · {label(task.queue)}</strong><br/>
     <span>{task.title}</span><br/>
     <small>{label(task.status)} · {task.owner?`owner ${task.owner}`:"unowned"} · {due(Number(task.due_at))}</small>
    </button>)}
   </aside>
   <section style={{display:"grid",gap:12}}>
    {selected&&<>
     <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
      <small>{label(selected.rule)}</small>
      <h2 style={{margin:"4px 0"}}>{selected.title}</h2>
      <p>Status {label(selected.status)} · owner {selected.owner||"unowned"} · {due(Number(selected.due_at))}{Number(selected.escalated)===1?" · SLA ESCALATED":""}</p>
      <p><small>{selected.booking_id?`Booking ${selected.booking_id} · `:""}{selected.customer_id?`Customer ${selected.customer_id} · `:""}{selected.provider_id?`Provider ${selected.provider_id}`:""}</small></p>
     </article>
     <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
      <h2>Act</h2>
      <textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="Resolution / dismissal / progress note" style={{width:"100%",minHeight:70}}/>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
       <button disabled={busy!==""} onClick={()=>void run("claim")}>Claim</button>
       <button disabled={busy!==""} onClick={()=>void run("start")}>Start</button>
       <button disabled={busy!==""||note.trim().length<3} onClick={()=>void run("add_note")}>Add note</button>
       <button disabled={busy!==""||note.trim().length<5} onClick={()=>void run("resolve")}>Resolve</button>
       <button disabled={busy!==""||note.trim().length<5} onClick={()=>void run("dismiss")}>Dismiss</button>
      </div>
      <p><small>Resolve/dismiss require a clear note; every action lands in the task audit trail.</small></p>
     </article>
    </>}
   </section>
  </section>
  <footer><small>Detectors: unassigned work orders · refund requests · payment reconciliation exceptions · low-rating QC callbacks · new relocation enquiries · overdue food renewals · overdue lead first-response. Idempotent sweep; cron wiring pending (backgroundSchedulerConfigured:false).</small></footer>
 </main>;
}
