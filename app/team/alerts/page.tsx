"use client";
import{useEffect,useMemo,useState}from"react";
import Link from"next/link";
import{StatCard}from"../../components/ui";
import{ReadGate,ReadRefusedNotice}from"../../components/refused-surface";
import{useVisibleStaffLinks}from"../../components/hub-workspace-links";
import type{HubWorkspaceLink}from"../../components/hub-workspace-links";

type AlertRow={id:string;alert_type:string;severity:string;status:string;title:string;body:string;team_code?:string|null;recipient_role?:string|null;recipient_email?:string|null;customer_id?:string|null;booking_id?:string|null;lead_id?:string|null;case_id?:string|null;due_at:number;created_at:number};
type Scheduler={configured:boolean;everRan:boolean;running:boolean;runCount:number;lastRunAt:number|null;lastRunStatus:string|null;cron:string;runner:string;summary:string};
type Directory={summary:{total:number;open:number;acknowledged:number;critical:number;overdue:number};alerts:AlertRow[];truth:{hardcodedTwentyMinuteRule:boolean;automaticMode:string;runnerBoundary:string;backgroundSchedulerConfigured:boolean;customerNotificationTransport:string;externalDelivery:boolean;productionReady:boolean}};
/* This page loads on reports.view, which finance and auditor hold. Neither holds bookings.manage
   (/api/unified-cases behind Cases) nor customers.view (/api/crm GET), so both header links refused
   them. Each entry carries the permission its own destination demands. */
const HEADER_LINKS:HubWorkspaceLink[]=[
 {href:"/team/cases",label:"Cases",detail:"",permission:"bookings.manage"},
 {href:"/crm",label:"CRM",detail:"",permission:"customers.view"},
];
const when=(value:number)=>new Date(value).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
async function api(body?:Record<string,unknown>){const response=await fetch("/api/staff-alerts",body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{cache:"no-store"});const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Alert request failed");return payload;}
// The page fetched this payload and then printed a literal that contradicted it. It reads the
// scheduler observation the API already carries instead.
async function directory(){const payload=await api();return{directory:payload.directory as Directory,scheduler:(payload.scheduler??null) as Scheduler|null};}
export default function AlertsPage(){const headerLinks=useVisibleStaffLinks(HEADER_LINKS);const[data,setData]=useState<Directory|null>(null),[scheduler,setScheduler]=useState<Scheduler|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[filter,setFilter]=useState("open");
 useEffect(()=>{let active=true;void directory().then(value=>{if(active){setData(value.directory);setScheduler(value.scheduler);}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));});return()=>{active=false;};},[]);
 const rows=useMemo(()=>{const all=data?.alerts||[];if(filter==="all")return all;if(filter==="critical")return all.filter(x=>x.severity==="critical"&&x.status!=="resolved");if(filter==="acknowledged")return all.filter(x=>x.status==="acknowledged");return all.filter(x=>x.status==="open");},[data,filter]);
 const act=async(action:"acknowledge"|"resolve",alertId:string)=>{setBusy(true);try{await api({action,alertId});const next=await directory();setData(next.directory);setScheduler(next.scheduler);setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const sweep=async()=>{setBusy(true);try{await api({action:"sweep"});const next=await directory();setData(next.directory);setScheduler(next.scheduler);setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}><header style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"start"}}><div><p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · MANAGER ALERT CENTER</p><h1>Leads and cases that need attention now.</h1><p>Thresholds come from approved SLA policies. The dashboard reads the governed queue; escalation execution is exposed through a protected runner boundary instead of depending on an open browser.</p></div><nav style={{display:"flex",gap:12}}>{headerLinks.map(link=><Link key={link.href} href={link.href}>{link.label}</Link>)}</nav></header>
 {/* R3-G / F6: "Open 0 · Critical 0 · Acknowledged 0 · Overdue 0" rendered from an empty state
     beside the refusal, so a denied read looked exactly like a clear SLA board. And F7: "Check SLA
     now" is a write, offered on top of a read that was refused. Both go with the data. */}
 <ReadRefusedNotice error={error} what="the manager alert centre" />
 <ReadGate error={error} loading={!data}>
 <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,margin:"20px 0"}}>{[["Open",data?.summary.open||0],["Critical",data?.summary.critical||0],["Acknowledged",data?.summary.acknowledged||0],["Overdue",data?.summary.overdue||0]].map(([label,value])=><StatCard key={String(label)} label={String(label)} value={value} />)}</section>
 <section style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>{["open","critical","acknowledged","all"].map(item=><button key={item} onClick={()=>setFilter(item)} disabled={filter===item}>{item}</button>)}<button onClick={()=>void sweep()} disabled={busy}>{busy?"Checking…":"Check SLA now"}</button></section>
 </ReadGate>
 <section style={{display:"grid",gap:10}}>{rows.map(row=><article key={row.id} style={{border:"1px solid #ddd",borderRadius:12,padding:16}}><small>{row.severity.toUpperCase()} · {row.alert_type.replaceAll("_"," ")} · {row.status}</small><h2 style={{fontSize:19,margin:"6px 0"}}>{row.title}</h2><p>{row.body}</p><p><b>Due:</b> {when(row.due_at)} · <b>Team:</b> {row.team_code||"—"} · <b>Recipient:</b> {row.recipient_email||row.recipient_role||"manager queue"}</p><p><b>Source:</b> {[row.lead_id&&`Lead ${row.lead_id}`,row.case_id&&`Case ${row.case_id}`,row.booking_id&&`Booking ${row.booking_id}`].filter(Boolean).join(" · ")||"source event"}</p><div style={{display:"flex",gap:8}}>{row.status==="open"?<button disabled={busy} onClick={()=>void act("acknowledge",row.id)}>Acknowledge</button>:null}{row.status!=="resolved"?<button disabled={busy} onClick={()=>void act("resolve",row.id)}>Resolve alert</button>:null}</div></article>)}</section>
 <footer style={{marginTop:24,lineHeight:1.6}}><b>Automatic mode:</b> governed runner boundary available. <b>Background scheduler:</b> {scheduler?scheduler.summary:data?"The alert feed was read but the scheduler state was not reported by this build, so nothing is claimed about it.":"Reading…"} <b>Customer notifications:</b> canonical chat outbox only. <b>External provider delivery:</b> disabled. <b>Production ready:</b> NO.</footer></main>}
