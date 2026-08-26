"use client";
import{useCallback,useEffect,useMemo,useState}from"react";
import{Badge}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"./whatsapp-inbox.module.css";

type Row=Record<string,unknown>;
type Thread=Row&{id:string;customer_name?:string;customer_id?:string;primary_phone?:string;lead_id?:string;status?:string;assigned_to?:string;lastMessage?:Row|null;ticket?:Row|null};
type Conversation={thread:Row;participants:Row[];messages:Array<Row&{payload?:Row}>;assignments:Row[]};

const text=(value:unknown,fallback="—")=>String(value??"").trim()||fallback;
const pretty=(value:unknown)=>text(value).replaceAll("_"," ");
const when=(value:unknown)=>value?new Date(Number(value)).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"}):"";
const dateTime=(value:unknown)=>value?new Date(Number(value)).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—";
const initials=(name:unknown)=>text(name,"PS").split(/\s+/).map(part=>part[0]).join("").slice(0,2).toUpperCase();

export default function CustomerExperiencePage(){
 const[threads,setThreads]=useState<Thread[]>([]),[selected,setSelected]=useState(""),[conversation,setConversation]=useState<Conversation|null>(null);
 const[error,setError]=useState(""),[busy,setBusy]=useState(false),[query,setQuery]=useState(""),[filter,setFilter]=useState("all");

 const loadThreads=useCallback(async()=>{const response=await fetch("/api/conversations?status=open",{cache:"no-store"});const payload=await response.json().catch(()=>({})) as{data?:{threads:Thread[]};error?:string};if(!response.ok)throw new Error(payload.error||`Unable to load conversations (HTTP ${response.status})`);const next=payload.data?.threads||[];setThreads(next);return next;},[]);
 const loadConversation=useCallback(async(id:string)=>{if(!id)return;const response=await fetch(`/api/conversations?threadId=${encodeURIComponent(id)}`,{cache:"no-store"});const payload=await response.json().catch(()=>({})) as{data?:Conversation;error?:string};if(!response.ok)throw new Error(payload.error||`Unable to load conversation (HTTP ${response.status})`);setConversation(payload.data||null);},[]);
 useEffect(()=>{let active=true;void loadThreads().then(next=>{if(active&&!selected&&next[0])setSelected(String(next[0].id));}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});return()=>{active=false};},[loadThreads,selected]);
 useEffect(()=>{if(!selected)return;let active=true;void loadConversation(selected).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});return()=>{active=false};},[selected,loadConversation]);

 async function act(action:string,payload:Row){if(!selected)return;setBusy(true);setError("");try{const response=await fetch("/api/conversations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,threadId:selected,...payload})});const body=await response.json().catch(()=>({})) as{error?:string};if(!response.ok)throw new Error(body.error||`Action failed (HTTP ${response.status})`);await Promise.all([loadThreads(),loadConversation(selected)]);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}}

 const visible=useMemo(()=>threads.filter(row=>{const hay=`${text(row.customer_name,"")} ${text(row.customer_id,"")} ${text(row.primary_phone,"")} ${text(row.lastMessage?.channel,"")}`.toLowerCase();const matches=hay.includes(query.toLowerCase());if(!matches)return false;if(filter==="unassigned")return !text(row.assigned_to,"");if(filter==="whatsapp")return text(row.lastMessage?.channel,"")==="whatsapp";if(filter==="human")return Boolean(text(row.assigned_to,""));return true;}),[threads,query,filter]);
 const thread=conversation?.thread||null,messages=conversation?.messages||[];
 const assigned=thread?text(thread.assigned_to,""):"";
 const humanOwned=Boolean(assigned);
 const lastInbound=[...messages].reverse().find(message=>text(message.direction,"")==="inbound");
 const withinWindow=Boolean(lastInbound&&Date.now()-Number(lastInbound.created_at||0)<=24*60*60_000);
 const whatsappCount=threads.filter(row=>text(row.lastMessage?.channel,"")==="whatsapp").length;
 const unassigned=threads.filter(row=>!text(row.assigned_to,"")).length;
 const lastMessage=messages[messages.length-1];
 const customerName=text(thread?.customer_name||thread?.customer_id,"Customer");
 const phone=text(thread?.primary_phone,"Masked by role");
 const leadId=text(thread?.lead_id,"Not lead-linked");
 const ticket=thread?.ticket as Row|undefined;
 const consentState=text((lastMessage?.payload as Row|undefined)?.consentStatus,"Verified by governed channel policy");

 return <OpsShell eyebrow="PawSpace team · Customer experience" title="WhatsApp AI Shared Inbox" description="WATI-style customer operations on PawSpace canonical conversations. UAT/sandbox only; production WhatsApp delivery stays disabled until release certification." actions={<><Badge tone="info">UAT sandbox</Badge><Badge tone="warning">Production delivery disabled</Badge></>}>
  {error?<div style={{padding:12,border:"1px solid #fecaca",background:"#fff1f2",borderRadius:12,marginBottom:12}}><b>{error}</b></div>:null}
  <div className={styles.shell}>
   <aside className={styles.rail}>
    <div className={styles.brand}><div className={styles.brandMark}>PS</div><div><strong>PawSpace</strong><small>WhatsApp AI Customer Operations</small></div></div>
    <nav className={styles.nav} aria-label="WhatsApp AI navigation">
     <div className={`${styles.navItem} ${styles.navActive}`}><span>Inbox</span><span className={styles.navCount}>{threads.length}</span></div>
     <div className={styles.navItem}><span>Leads</span><span>{threads.filter(row=>row.lead_id).length}</span></div>
     <div className={styles.navItem}><span>Customers</span></div><div className={styles.navItem}><span>Templates</span></div><div className={styles.navItem}><span>AI Handoffs</span></div><div className={styles.navItem}><span>Booking Drafts</span></div><div className={styles.navItem}><span>Audit</span></div><div className={styles.navItem}><span>Settings</span></div>
    </nav>
    <div className={styles.connection}><span className={styles.dot}/>WhatsApp UAT connection<br/><b>Sandbox / governed</b><br/><small>External delivery disabled</small></div>
    <div className={styles.operator}><b>CX Operator</b><br/><small>Role-scoped access</small></div>
   </aside>

   <aside className={styles.list}>
    <div className={styles.listTop}><h2>Shared Inbox</h2><input className={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search leads or conversations..."/><div className={styles.filters}>
     {[['all','All'],['whatsapp','WhatsApp'],['unassigned','Unassigned'],['human','Human owned']].map(([key,label])=><button key={key} type="button" onClick={()=>setFilter(key)} className={`${styles.filter} ${filter===key?styles.filterActive:""}`}>{label}{key==='whatsapp'?` ${whatsappCount}`:key==='unassigned'?` ${unassigned}`:""}</button>)}
    </div></div>
    <div className={styles.rows}>{visible.length===0?<div className={styles.empty}>No conversations match this view.</div>:visible.map(row=>{const isHuman=Boolean(text(row.assigned_to,""));const channel=text(row.lastMessage?.channel,"thread");return <button key={row.id} type="button" className={`${styles.row} ${selected===row.id?styles.rowActive:""}`} onClick={()=>setSelected(row.id)}><div className={styles.rowTop}><strong>{text(row.customer_name||row.customer_id,"Customer")}</strong><small>{when(row.lastMessage?.created_at||row.updated_at)}</small></div><small>{pretty(channel)} · {text(row.lead_id,"canonical customer")}</small><small>{text((row.lastMessage?.payload as Row|undefined)?.text||row.lastMessage?.template_key,"No message preview")}</small><div style={{marginTop:7}}><span className={`${styles.pill} ${isHuman?styles.pillHuman:channel==='whatsapp'?"":styles.pillWarn}`}>{isHuman?`Human owned · ${text(row.assigned_to)}`:channel==='whatsapp'?"AI eligible":"Open"}</span></div></button>})}</div>
   </aside>

   <main className={styles.chat}>
    {!thread?<div className={styles.empty}>Select a conversation to open the canonical WhatsApp thread.</div>:<>
     <header className={styles.chatHead}><div className={styles.person}><div className={styles.avatar}>{initials(customerName)}</div><div><h2>{customerName}</h2><small>{leadId} · {humanOwned?`Owner: ${assigned}`:"AI-assisted queue"}</small></div></div><span className={styles.window}>{withinWindow?"WhatsApp service window open":"Template required"}</span></header>
     <div className={styles.aiBar}><div><b>{humanOwned?"Human takeover active":"PawSpace AI eligible"}</b><br/><span>{humanOwned?"AI is stopped until an authorized resume action is implemented.":"AI may qualify the enquiry; high-impact actions remain governed."}</span></div><button className={styles.takeover} disabled={busy||humanOwned} onClick={()=>{void act("assign",{assignedTo:"CX Queue",reason:"WhatsApp AI human takeover"})}}>Take over</button></div>
     <section className={styles.messages}>{messages.length===0?<div className={styles.empty}>No messages yet.</div>:messages.map(message=><div key={text(message.id)} className={`${styles.bubble} ${text(message.direction,"")==="outbound"?styles.bubbleOut:""}`}><small>{pretty(message.direction)} · {pretty(message.channel)} · {pretty(message.status)}</small><p>{text(message.payload?.text||message.payload?.message||message.template_key,"Message")}</p><small>{dateTime(message.created_at)}</small></div>)}</section>
     <div className={styles.notice}>AI may make mistakes. Price, availability, payment, cancellation and provider actions stay governed.</div>
     <footer className={styles.composer}><input disabled placeholder={humanOwned?"Human reply composer will use governed outbound actions":"AI/customer replies appear here from the canonical channel"}/><button className={styles.send} disabled>Send</button></footer>
    </>}
   </main>

   <aside className={styles.inspector}>
    <section className={styles.card}><div className={styles.cardHead}><strong>Lead / Customer</strong><a>Canonical</a></div><div className={styles.kv}><span>Name</span><b>{customerName}</b><span>Phone</span><b>{phone}</b><span>Lead</span><b>{leadId}</b><span>Thread</span><b>{text(thread?.id)}</b></div></section>
    <section className={styles.card}><div className={styles.cardHead}><strong>Consent Evidence</strong><a>Governed</a></div><div className={styles.kv}><span>WhatsApp</span><b>{consentState}</b><span>Purpose</span><b>Lead response / service</b><span>Marketing</span><b>No</b><span>Opt-out</span><b>Prior opt-out always wins</b></div></section>
    <section className={styles.card}><div className={styles.cardHead}><strong>Qualification</strong><a>AI summary</a></div><div className={styles.kv}><span>Customer</span><b>{customerName}</b><span>Source</span><b>{leadId}</b><span>Latest channel</span><b>{pretty(lastMessage?.channel)}</b><span>Status</span><b>{pretty(thread?.status)}</b></div></section>
    <section className={styles.card}><div className={styles.cardHead}><strong>Booking / Ticket Context</strong><a>Read-only</a></div><div className={styles.kv}><span>Ticket</span><b>{text(ticket?.id,"None")}</b><span>Priority</span><b>{pretty(ticket?.priority||"normal")}</b><span>Subject</span><b>{text(ticket?.subject,"No active ticket")}</b><span>Promise</span><b>Never invent slot/price</b></div></section>
    <section className={styles.card}><div className={styles.cardHead}><strong>Handoff Controls</strong><a>Policy</a></div><div className={styles.actions}><button className={`${styles.action} ${styles.actionPrimary}`} disabled={busy||humanOwned} onClick={()=>{void act("assign",{assignedTo:"CX Queue",reason:"WhatsApp AI human takeover"})}}>Take over</button><button className={styles.action} disabled title="Resume AI requires an explicit governed resume endpoint">Resume AI</button><button className={styles.action} disabled={busy} onClick={()=>{void act("status",{status:"pending_customer",reason:"Awaiting customer response"})}}>Await customer</button><button className={`${styles.action} ${styles.actionGreen}`} disabled={busy} onClick={()=>{void act("status",{status:"resolved",reason:"Customer Experience resolved"})}}>Resolve</button></div></section>
    <section className={styles.card}><div className={styles.cardHead}><strong>Activity / Audit Trail</strong><a>Canonical</a></div><div className={styles.audit}>{messages.slice(-5).reverse().map(message=><div className={styles.auditItem} key={`audit-${text(message.id)}`}><span className={styles.auditDot}/><span>{when(message.created_at)} · {pretty(message.channel)} {pretty(message.direction)} · {pretty(message.status)}</span></div>)}{messages.length===0?<small>No message events yet.</small>:null}</div></section>
   </aside>
  </div>
 </OpsShell>;
}
