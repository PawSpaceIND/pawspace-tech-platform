"use client";
import Link from"next/link";
import{useCallback,useEffect,useState}from"react";

type Row=Record<string,unknown>;
type Snapshot={profiles:Row[];intents:Row[];knowledge:Row[];prompts:Row[];killSwitches:Row[];auditEvents:Row[];productionReady:boolean};
type Status={provider:{connected:boolean;providerRef:string|null;modelRef:string|null;reason:string};rollout:{stage:string;staffEnabled:boolean;customersEnabled:boolean};configurationRequired:boolean;activeProfile:{key:string;version:number}|null;activePromptPolicy:{key:string;version:number}|null;killSwitches:Array<{scopeType:string;scopeKey:string;reason:string}>;activeKnowledge:number;activeIntents:number;answersStaff:boolean;answersCustomers:boolean};
const card={background:"white",border:"1px solid #e5dcef",borderRadius:14,padding:14};
const STAGE:Record<string,string>={off:"Off · everyone gets a human",staff_only:"Staff only · internal preview",customers:"Customers · full rollout"};

/** One requirement line: what it is, whether it is met, and what to do when it is not. */
function Requirement({label,met,detail}:{label:string;met:boolean;detail:string}){
  return <li style={{display:"grid",gridTemplateColumns:"22px 1fr",gap:8,alignItems:"start",padding:"6px 0"}}>
    <span aria-hidden="true" style={{fontWeight:800,color:met?"#177245":"#b42318"}}>{met?"✓":"✗"}</span>
    <span><b>{label}</b> <small style={{display:"block",color:"#746b7d"}}>{detail}</small></span>
  </li>;
}

export default function AiConfigurationPage(){
  const[data,setData]=useState<Snapshot|null>(null),[status,setStatus]=useState<Status|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState("");
  const load=useCallback(async()=>{
    const[snapshotResponse,statusResponse]=await Promise.all([fetch("/api/ai-business-configuration",{cache:"no-store"}),fetch("/api/ai-business-configuration?mode=status",{cache:"no-store"})]);
    const snapshotBody=await snapshotResponse.json() as {data?:Snapshot;error?:string},statusBody=await statusResponse.json() as {data?:Status;error?:string};
    if(!snapshotResponse.ok)throw new Error(snapshotBody.error||"AI configuration unavailable");
    if(!statusResponse.ok)throw new Error(statusBody.error||"AI status unavailable");
    setData(snapshotBody.data||null);setStatus(statusBody.data||null);
  },[]);
  useEffect(()=>{void load().catch(e=>setError(e instanceof Error?e.message:"AI configuration unavailable"));},[load]);

  async function transition(entityType:string,entityId:string,lifecycleAction:string){setBusy(entityId);setError("");try{const response=await fetch("/api/ai-business-configuration",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"transition",entityType,entityId,lifecycleAction})}),body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"Transition failed");await load();}catch(e){setError(e instanceof Error?e.message:"Transition failed")}finally{setBusy("")}}
  async function globalKill(disabled:boolean){setBusy("global");setError("");try{const response=await fetch("/api/ai-business-configuration",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"kill_switch",scopeType:"global",scopeKey:"ai",disabled,reason:disabled?"Manual staff safety stop":"Manual staff re-enable"})}),body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"Kill switch failed");await load();}catch(e){setError(e instanceof Error?e.message:"Kill switch failed")}finally{setBusy("")}}

  // The starter grounding (assistant profile, system-policy, approved knowledge, intent catalogue)
  // already existed as lib/pawspace-ai-seed.ts behind POST /api/ai-bootstrap, but nothing in the
  // product called it — so a fresh environment had no configuration and no way to create any, since
  // the lists below only offer lifecycle buttons for versions that already exist. This is that
  // missing zero-to-one step. It goes through the normal maker/checker lifecycle, and re-running it
  // supersedes rather than overwrites (v1 retires, v2 activates).
  async function installStarterGrounding(){
    setBusy("bootstrap");setError("");setNotice("");
    try{
      const response=await fetch("/api/ai-bootstrap",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})});
      const body=await response.json() as {data?:{knowledgeCount:number;intentCount:number};error?:string};
      if(!response.ok)throw new Error(body.error||"Unable to install the starter assistant grounding");
      setNotice(`Starter grounding installed and activated: assistant profile, system-policy, ${body.data?.knowledgeCount??0} approved knowledge articles and ${body.data?.intentCount??0} intents.`);
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Unable to install the starter assistant grounding")}finally{setBusy("")}
  }

  const section=(title:string,entityType:string,rows:Row[])=><section style={{...card,marginBottom:14}}><h2 style={{marginTop:0}}>{title}</h2>{rows.length===0?<p style={{color:"#746b7d"}}>No versions configured.</p>:rows.map(row=><article key={String(row.id)} style={{borderTop:"1px solid #eee6f5",padding:"10px 0",display:"grid",gridTemplateColumns:"2fr 1fr 2fr",gap:10,alignItems:"center"}}><div><b>{String(row.profile_key||row.intent_code||row.source_key||row.policy_key||row.id)}</b><small style={{display:"block"}}>v{String(row.version)} · {String(row.status)} · {String(row.immutable_hash||"").slice(0,12)}</small></div><span>{String(row.business_owner||row.title||row.brand_voice||"versioned policy")}</span><div>{row.status==="draft"&&<button disabled={busy===row.id} onClick={()=>transition(entityType,String(row.id),"submit_review")}>Submit review</button>} {row.status==="review"&&<button disabled={busy===row.id} onClick={()=>transition(entityType,String(row.id),"approve")}>Approve</button>} {row.status==="approved"&&<button disabled={busy===row.id} onClick={()=>transition(entityType,String(row.id),"activate")}>Activate</button>} {row.status==="retired"&&<button disabled={busy===row.id} onClick={()=>transition(entityType,String(row.id),"rollback")}>Rollback</button>}</div></article>)}</section>;

  return <main style={{minHeight:"100vh",background:"#f7f4fb",padding:28,fontFamily:"Arial,sans-serif",color:"#24133f"}}><div style={{maxWidth:1300,margin:"0 auto"}}>
    <header style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
      <div><small style={{fontWeight:800,color:"#6c39a8"}}>PAWSPACE TEAM · AI BUSINESS CONFIGURATION</small><h1 style={{margin:"7px 0"}}>Assistant configuration & knowledge</h1><p style={{margin:0,color:"#746b7d"}}>Versioned, reviewed and auditable AI business configuration. Production provider activation remains separate.</p></div>
      <div><button disabled={busy==="global"} onClick={()=>globalKill(true)}>Disable AI</button> <button disabled={busy==="global"} onClick={()=>globalKill(false)}>Enable AI</button> <Link href="/team/ai" style={{marginLeft:10}}>AI review</Link> <Link href="/team/ai/rollout" style={{marginLeft:10}}>Rollout</Link></div>
    </header>
    {error&&<div role="alert" style={{padding:12,background:"#fff1f1",borderRadius:10,marginBottom:12}}>{error}</div>}
    {notice&&<div role="status" style={{padding:12,background:"#eefaf1",borderRadius:10,marginBottom:12}}>{notice}</div>}

    {status&&<section style={{...card,marginBottom:14}}>
      <h2 style={{marginTop:0}}>Is the assistant switched on?</h2>
      <p style={{margin:"0 0 8px",color:"#746b7d"}}>
        Answering staff: <b style={{color:status.answersStaff?"#177245":"#b42318"}}>{status.answersStaff?"yes":"no"}</b> ·
        answering customers: <b style={{color:status.answersCustomers?"#177245":"#b42318"}}>{status.answersCustomers?"yes":"no"}</b>.
        Every requirement below has to be met — any one of them missing sends every conversation to a human.
      </p>
      <ul style={{listStyle:"none",padding:0,margin:0}}>
        <Requirement label="Model provider connected" met={status.provider.connected} detail={status.provider.connected?`${status.provider.providerRef} · ${status.provider.modelRef}`:status.provider.reason} />
        <Requirement label="Assistant profile and system policy activated" met={!status.configurationRequired} detail={status.configurationRequired?"No active profile or prompt policy — install the starter grounding below, then refine it here.":`profile ${status.activeProfile?.key} v${status.activeProfile?.version} · policy ${status.activePromptPolicy?.key} v${status.activePromptPolicy?.version} · ${status.activeKnowledge} approved knowledge articles · ${status.activeIntents} intents`} />
        <Requirement label="Rollout audience opened" met={status.rollout.staffEnabled} detail={`${STAGE[status.rollout.stage]||status.rollout.stage} — change it on /team/ai/rollout.`} />
        <Requirement label="No kill switch thrown" met={status.killSwitches.length===0} detail={status.killSwitches.length===0?"Nothing is disabled.":status.killSwitches.map(item=>`${item.scopeType}:${item.scopeKey} — ${item.reason}`).join("; ")} />
      </ul>
      <div style={{marginTop:12,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <button disabled={busy==="bootstrap"} onClick={()=>void installStarterGrounding()} style={{padding:"10px 14px",background:"#4b168c",color:"white",border:"none",borderRadius:10,fontWeight:700,cursor:"pointer"}}>{busy==="bootstrap"?"Installing…":status.configurationRequired?"Install starter assistant grounding":"Reinstall starter grounding (new version)"}</button>
        <small style={{color:"#746b7d"}}>Creates the PawSpace assistant profile, system policy, approved knowledge and intent catalogue through the normal draft → review → approve → activate lifecycle. Re-running supersedes the current versions rather than editing them.</small>
      </div>
    </section>}

    {!data?<p>Loading…</p>:<>
      {section("Assistant profiles","profile",data.profiles)}
      {section("Intent catalogue","intent",data.intents)}
      {section("Approved knowledge registry","knowledge",data.knowledge)}
      {section("Prompt / system-policy versions","prompt",data.prompts)}
      <section style={card}><h2 style={{marginTop:0}}>Kill switches &amp; audit</h2><p>Active switches: {data.killSwitches.filter(row=>Number(row.disabled)===1).length} · Audit events: {data.auditEvents.length}</p><p style={{fontSize:12,color:"#746b7d"}}>Configuration changes require settings.manage and are separately security-audited. Active versions are immutable snapshots; changes create new versions.</p></section>
    </>}
  </div></main>;
}
