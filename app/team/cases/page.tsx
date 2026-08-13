"use client";
import{useCallback,useEffect,useMemo,useState}from"react";
import Link from"next/link";
import{Badge,Button,EmptyState,PageHeader,StatCard}from"../../components/ui";
import styles from"../team-console.module.css";

type CaseRow={id:string;case_type:string;severity:string;status:string;title:string;description:string;owner_team:string;owner_email?:string|null;first_response_due_at?:number|null;resolution_due_at?:number|null;manager_escalation_due_at?:number|null;first_responded_at?:number|null;created_at:number;links?:{customerId?:string|null;bookingId?:string|null;paymentId?:string|null;leadId?:string|null;providerId?:string|null}};
type Directory={summary:{open:number;critical:number;unowned:number;firstResponseOverdue:number;resolutionOverdue:number};cases:CaseRow[];truth:{productionReady:boolean;automaticExternalNotification:boolean}};

const when=(v:unknown)=>v?new Date(Number(v)).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—";
const words=(v:unknown)=>String(v||"").replaceAll("_"," ");
const severityTone=(severity:string)=>severity==="critical"?"danger":severity==="high"?"warning":"neutral";
const statusTone=(status:string)=>["resolved","closed"].includes(status)?"success":status==="waiting"?"warning":"info";
const FILTERS=[["open","Open"],["critical","Critical"],["unowned","Unowned"],["all","All"]] as const;

async function request(body?:Record<string,unknown>){
 const response=await fetch("/api/unified-cases",body?{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{cache:"no-store"});
 const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
 if(!response.ok)throw new Error(String(payload.error||`Case Center request failed (HTTP ${response.status})`));
 return payload as Record<string,unknown>;
}

export default function CasesPage(){
 const[data,setData]=useState<Directory|null>(null);
 const[filter,setFilter]=useState("open");
 const[error,setError]=useState("");
 const[loading,setLoading]=useState(false);

 const load=useCallback(async()=>{
  setLoading(true);
  try{setData((await request()).directory as Directory);setError("");}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{const timer=setTimeout(()=>{void load();},0);return()=>clearTimeout(timer);},[load]);

 async function act(body:Record<string,unknown>){
  try{await request(body);await load();}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 }

 const rows=useMemo(()=>{
  const cases=data?.cases||[];
  if(filter==="all")return cases;
  if(filter==="critical")return cases.filter(row=>row.severity==="critical");
  if(filter==="unowned")return cases.filter(row=>!row.owner_email);
  return cases.filter(row=>!["resolved","closed"].includes(row.status));
 },[data,filter]);

 return <main className={styles.shell}>
  <PageHeader
    eyebrow="PAWSPACE · CASE & ESCALATION CENTER"
    title="One queue for issues that need ownership"
    description="Refunds, lead escalations, payment exceptions, provider problems, complaints and operational incidents converge here. The native specialist modules remain the source of money and safety truth."
    actions={<Badge tone={data?.summary.critical?"danger":"success"} dot>{data?.summary.critical||0} critical</Badge>}
  />
  <nav className={styles.nav} aria-label="Team workspaces">
   <Link href="/team">← Team Home</Link><Link href="/business">Business Hub</Link><Link href="/team/customer-experience">CX queue</Link>
  </nav>

  {error?<div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div>:null}

  <section className={styles.tiles}>
   <StatCard label="Open" value={data?.summary.open||0} />
   <StatCard label="Critical" value={data?.summary.critical||0} />
   <StatCard label="Unowned" value={data?.summary.unowned||0} />
   <StatCard label="Response overdue" value={data?.summary.firstResponseOverdue||0} />
   <StatCard label="Resolution overdue" value={data?.summary.resolutionOverdue||0} />
  </section>

  <section className={styles.controls}>
   {FILTERS.map(([value,label])=><Button key={value} size="sm" variant={filter===value?"primary":"secondary"} onClick={()=>setFilter(value)}>{label}</Button>)}
   <Button size="sm" variant="ghost" onClick={()=>{void act({action:"sync_native"});}}>Sync refunds / SLA / reconciliation</Button>
   <Button size="sm" variant="ghost" onClick={()=>{void act({action:"run_escalations"});}}>Run escalations</Button>
   <Button size="sm" variant="ghost" onClick={()=>{void load();}}>{loading?"Refreshing…":"Refresh"}</Button>
  </section>

  {rows.length===0?<EmptyState
    title={data?`Nothing in the ${filter} queue`:"Loading the case queue"}
    body={data?"Cases arrive from refunds, lead escalations, payment exceptions, provider problems and complaints. An empty queue here means none of those are currently waiting on an owner.":"Reading canonical cases…"}
  />:<div className={styles.caseList}>{rows.map(row=><article key={row.id} className={styles.caseCard}>
   <div className={styles.caseHead}>
    <div className={styles.stack}>
     <div className={styles.actions}>
      <Badge tone={severityTone(row.severity)}>{row.severity}</Badge>
      <Badge tone={statusTone(row.status)}>{words(row.status)}</Badge>
      <small>{words(row.case_type)}</small>
     </div>
     <h2>{row.title}</h2>
     <p className={styles.panelNote}>{row.description}</p>
    </div>
    <code>{row.id}</code>
   </div>
   <div className={styles.caseMeta}>
    <span><b>Owner:</b> {row.owner_email||`${row.owner_team} · unassigned`}</span>
    <span><b>Created:</b> {when(row.created_at)}</span>
    <span><b>First response due:</b> {when(row.first_response_due_at)}</span>
    <span><b>Manager escalation:</b> {when(row.manager_escalation_due_at)}</span>
    <span><b>Resolution due:</b> {when(row.resolution_due_at)}</span>
    <span><b>Links:</b> {[row.links?.bookingId&&`Booking ${row.links.bookingId}`,row.links?.leadId&&`Lead ${row.links.leadId}`,row.links?.paymentId&&`Payment ${row.links.paymentId}`,row.links?.providerId&&`Provider ${row.links.providerId}`].filter(Boolean).join(" · ")||"source-only"}</span>
   </div>
   <div className={styles.actions}>
    {!row.first_responded_at?<Button size="sm" variant="secondary" onClick={()=>{void act({action:"respond",caseId:row.id});}}>Mark responded</Button>:null}
    <Button size="sm" variant="ghost" onClick={()=>{void act({action:"progress",caseId:row.id});}}>In progress</Button>
    <Button size="sm" variant="ghost" onClick={()=>{void act({action:"wait",caseId:row.id});}}>Waiting</Button>
    {!["resolved","closed"].includes(row.status)?<Button size="sm" onClick={()=>{const note=window.prompt("Resolution note");if(note)void act({action:"resolve",caseId:row.id,resolutionCode:"resolved_by_staff",note});}}>Resolve</Button>:null}
    {row.status==="resolved"?<Button size="sm" variant="secondary" onClick={()=>{void act({action:"close",caseId:row.id});}}>Close</Button>:null}
    {["resolved","closed"].includes(row.status)?<Button size="sm" variant="ghost" onClick={()=>{const note=window.prompt("Why is this being reopened?");if(note)void act({action:"reopen",caseId:row.id,note});}}>Reopen</Button>:null}
   </div>
  </article>)}</div>}

  <footer className={styles.footnote}><b>Production ready: NO.</b> External alerts are not yet automatic; that is the next workstream.</footer>
 </main>;
}
