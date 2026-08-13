"use client";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,EmptyState,StatCard}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"../team-console.module.css";

type Thread=Record<string,unknown>&{id:string;customer_name?:string;customer_id?:string;status?:string;assigned_to?:string;lastMessage?:Record<string,unknown>|null;ticket?:Record<string,unknown>|null};
type Conversation={thread:Record<string,unknown>;participants:Record<string,unknown>[];messages:Array<Record<string,unknown>&{payload?:Record<string,unknown>}>;assignments:Record<string,unknown>[]};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ");
const when=(value:unknown)=>new Date(Number(value||0)).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
const tone=(status:unknown)=>String(status)==="resolved"?"success":String(status)==="pending_customer"?"warning":"info";

export default function CustomerExperiencePage(){
 const[threads,setThreads]=useState<Thread[]>([]);
 const[selected,setSelected]=useState("");
 const[conversation,setConversation]=useState<Conversation|null>(null);
 const[error,setError]=useState("");
 const[busy,setBusy]=useState(false);

 const loadThreads=useCallback(async()=>{
  const response=await fetch("/api/conversations?status=open",{cache:"no-store"});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>) as {data?:{threads:Thread[]};error?:string};
  if(!response.ok)throw new Error(payload.error||`Unable to load conversations (HTTP ${response.status})`);
  const next=payload.data?.threads||[];setThreads(next);return next;
 },[]);
 const loadConversation=useCallback(async(id:string)=>{
  if(!id)return;
  const response=await fetch(`/api/conversations?threadId=${encodeURIComponent(id)}`,{cache:"no-store"});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>) as {data?:Conversation;error?:string};
  if(!response.ok)throw new Error(payload.error||`Unable to load conversation (HTTP ${response.status})`);
  setConversation(payload.data||null);
 },[]);

 useEffect(()=>{let active=true;const timer=setTimeout(()=>{void loadThreads().then(next=>{if(active&&next[0])setSelected(String(next[0].id));}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});},0);return()=>{active=false;clearTimeout(timer);};},[loadThreads]);
 useEffect(()=>{
  if(!selected)return;
  let active=true;
  const timer=setTimeout(()=>{void loadConversation(selected).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});},0);
  return()=>{active=false;clearTimeout(timer);};
 },[selected,loadConversation]);

 async function act(action:string,payload:Record<string,unknown>){
  if(!selected)return;
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/conversations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,threadId:selected,...payload})});
   const body=await response.json().catch(()=>({}) as Record<string,unknown>) as {error?:string};
   if(!response.ok)throw new Error(body.error||`Action failed (HTTP ${response.status})`);
   await Promise.all([loadThreads(),loadConversation(selected)]);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }

 const unassigned=threads.filter(thread=>!String(thread.assigned_to||"").trim()).length;
 const withTicket=threads.filter(thread=>thread.ticket).length;
 const thread=conversation?.thread;

 return <OpsShell
    eyebrow="PawSpace team · Customer experience"
    title="Unified conversation & CX queue"
    description="Canonical customer, booking, lead and ticket-linked threads. Outbound delivery stays inside communication governance — this workspace never bypasses consent, quiet hours, retries or adapter gating."
    actions={<Badge tone={unassigned?"warning":"success"} dot>{unassigned} unassigned</Badge>}
    >

  {error?<div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div>:null}

  <section className={styles.tiles}>
   <StatCard label="Open threads" value={threads.length} />
   <StatCard label="Unassigned" value={unassigned} />
   <StatCard label="Ticket-linked" value={withTicket} />
   <StatCard label="Messages in view" value={conversation?.messages.length??0} />
  </section>

  <section className={styles.split}>
   <aside className={styles.list}>
    <div className={styles.listHead}><b>Open conversations</b><small>{threads.length} canonical</small></div>
    {threads.length===0
      ?<EmptyState title="No open canonical conversations" body="Threads appear here when a customer, booking, lead or ticket generates a message. Nothing is waiting on CX right now." />
      :threads.map(row=><button key={String(row.id)} type="button" className={styles.listItem} aria-current={selected===String(row.id)} onClick={()=>setSelected(String(row.id))}>
        <strong>{String(row.customer_name||row.customer_id||"Customer")}</strong>
        <small>{label(row.status)} · {String(row.assigned_to||"Unassigned")}</small>
        <small>{row.ticket?`${label(row.ticket.priority)} ticket · ${String(row.ticket.subject||"")}`:row.lastMessage?`${label(row.lastMessage.channel)} · ${label(row.lastMessage.status)}`:"No message yet"}</small>
      </button>)}
   </aside>

   <article className={styles.thread}>
    {!thread?<EmptyState title="Select a conversation" body="Pick a thread on the left to see its canonical message history and take ownership." />:<>
     <div className={styles.threadHead}>
      <div className={styles.stack}>
       <small>{String(thread.id)}</small>
       <h2>{String(thread.customer_name||thread.customer_id||"Customer")}</h2>
       <div className={styles.actions}><Badge tone={tone(thread.status)}>{label(thread.status)}</Badge><small>{String(thread.assigned_to||"Unassigned")}</small></div>
      </div>
      <div className={styles.actions}>
       <Button size="sm" variant="secondary" disabled={busy} onClick={()=>{void act("assign",{assignedTo:"CX Queue",reason:"Manual CX ownership"});}}>Take ownership</Button>
       <Button size="sm" variant="ghost" disabled={busy} onClick={()=>{void act("status",{status:"pending_customer",reason:"Awaiting customer response"});}}>Await customer</Button>
       <Button size="sm" disabled={busy} onClick={()=>{void act("status",{status:"resolved",reason:"CX resolution recorded"});}}>Resolve</Button>
      </div>
     </div>
     <div className={styles.threadBody}>
      {conversation.messages.length===0
        ?<EmptyState title="No canonical messages yet" body="The thread exists, but nothing has been sent or received on it." />
        :conversation.messages.map(message=><div key={String(message.id)} className={`${styles.bubble}${String(message.direction)==="outbound"?` ${styles.bubbleOut}`:""}`}>
          <small>{label(message.direction)} · {label(message.channel)} · {label(message.status)}</small>
          <p>{String(message.payload?.text||message.payload?.message||message.template_key||"Message")}</p>
          <small>{when(message.created_at)}</small>
        </div>)}
     </div>
     <footer className={styles.footnote} style={{padding:"12px 18px",marginTop:0}}>Outbound delivery is handled by PawSpace communication governance; this workspace does not bypass consent, quiet-hour, retry or adapter controls.</footer>
    </>}
   </article>
  </section>
 </OpsShell>;
}
