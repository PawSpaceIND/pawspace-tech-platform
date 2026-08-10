"use client";

import Link from"next/link";
import{useEffect,useMemo,useState}from"react";
import styles from"../../system-integration/page.module.css";

type Integration={integrationCode:string;category:string;capability:string;provider:string;owner:string;priority:string;required:boolean;environment:string;codeBoundaryStatus:string;credentialStatus:string;readinessState:string;evidenceReference:string|null;blockerReason:string|null;updatedAt:number};
type Payload={data:{items:Integration[];summary:{total:number;required:number;p0Required:number;p0ControlledLive:number;controlledLiveVerified:number};productionReady:false};blockers:Array<{integrationCode:string;capability:string;owner:string;readinessState:string;blockerReason:string}>;productionReady:false};
const pretty=(value:string)=>value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());
const readinessStates=["not_started","code_ready","sandbox_setup_required","sandbox_ready_for_test","sandbox_verified","production_setup_required","production_ready_for_controlled_test","controlled_live_verified","blocked","not_applicable"];

export default function IntegrationReadinessControl(){
 const[data,setData]=useState<Payload|null>(null),[error,setError]=useState("");
 const[editing,setEditing]=useState<string|null>(null),[form,setForm]=useState({readinessState:"",evidenceReference:"",approvalReference:"",reason:""}),[saving,setSaving]=useState(false),[formError,setFormError]=useState("");
 const load=async()=>{try{setError("");const response=await fetch("/api/integration-readiness",{cache:"no-store"}),payload=await response.json() as Payload&{error?:string};if(!response.ok)throw new Error(payload.error||"Unable to load integration readiness");setData(payload);}catch(cause){setError(cause instanceof Error?cause.message:"Unable to load integration readiness");}};
 useEffect(()=>{let active=true;void fetch("/api/integration-readiness",{cache:"no-store"}).then(async response=>{const payload=await response.json() as Payload&{error?:string};if(!response.ok)throw new Error(payload.error||"Unable to load integration readiness");if(active){setData(payload);setError("");}}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:"Unable to load integration readiness");});return()=>{active=false};},[]);
 const p0=useMemo(()=>data?.data.items.filter(item=>item.priority==="P0")??[],[data]);
 const openEdit=(item:Integration)=>{setEditing(item.integrationCode);setForm({readinessState:item.readinessState,evidenceReference:item.evidenceReference||"",approvalReference:"",reason:""});setFormError("");};
 const saveEdit=async()=>{
  if(!editing)return;
  if(!form.reason.trim()){setFormError("A governed change reason is required");return;}
  setSaving(true);setFormError("");
  try{
   const changes:Record<string,unknown>={readinessState:form.readinessState};
   if(form.evidenceReference.trim())changes.evidenceReference=form.evidenceReference.trim();
   if(form.approvalReference.trim())changes.approvalReference=form.approvalReference.trim();
   const response=await fetch("/api/integration-readiness",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({integrationCode:editing,changes,reason:form.reason.trim()})});
   const payload=await response.json() as {error?:string};
   if(!response.ok){setFormError(payload.error||"Unable to update integration readiness");return;}
   setEditing(null);await load();
  }catch(cause){setFormError(cause instanceof Error?cause.message:"Unable to update integration readiness");}
  finally{setSaving(false);}
 };
 if(!data)return <main className={styles.loading}>{error||"Loading canonical integration readiness…"}</main>;
 return <main className={styles.shell}>
  <aside className={styles.side}><Link href="/control" className={styles.brand}><b>paw</b>space <span>CONTROL</span></Link><nav><Link href="/team">⌂ Team</Link><Link href="/control">◇ Launch essentials</Link><Link className={styles.active} href="/control/integrations">◎ Integration readiness</Link><Link href="/system-integration">↗ Legacy system confirmation</Link></nav><div className={styles.boundary}><b>PRE-LIVE CONTROL</b><span>No secret values displayed</span><span>No live traffic enabled</span><span>Controlled-live proof is a separate gate</span></div></aside>
  <section className={styles.workspace}>
   <header className={styles.top}><div><span>PAWSPACE PRE-LIVE CONTROL</span><h1>Integration Readiness Register</h1><p>One governed record for code, credentials, sandbox evidence, production setup and controlled-live verification.</p></div><button onClick={()=>void load()}>Refresh evidence</button></header>
   <section className={styles.hero}><div><small>REGISTERED</small><strong>{data.data.summary.total}</strong><span>External dependencies</span><p>{data.data.summary.required} required integrations</p></div><div><small>P0 CONTROLLED LIVE</small><strong>{data.data.summary.p0ControlledLive}/{data.data.summary.p0Required}</strong><span className={data.data.summary.p0ControlledLive===data.data.summary.p0Required?styles.good:styles.blocked}>Launch dependency</span><p>Credential presence alone never satisfies this gate</p></div><div><small>PRODUCTION READY</small><strong>NO</strong><span className={styles.blocked}>Pre-live only</span><p>{data.blockers.length} P0 integration blocker{data.blockers.length===1?"":"s"}</p></div></section>
   {error&&<div className={styles.error}>{error}</div>}
   <section className={styles.panel}><header><div><span>P0 DEPENDENCIES</span><h2>Launch-blocking integrations</h2></div><em>Controlled-live evidence required</em></header><div className={styles.controls}>{p0.map(item=><article key={item.integrationCode}><i className={item.readinessState==="controlled_live_verified"?styles.passDot:styles.blockDot}></i><div><h3>{item.integrationCode} · {item.capability}</h3><p>{item.provider} · {item.owner} · {pretty(item.environment)} · credentials {pretty(item.credentialStatus)}</p></div><b>{pretty(item.readinessState)}</b></article>)}</div></section>
   <section className={styles.panel}><header><div><span>FULL REGISTER</span><h2>Integration evidence states</h2></div><em>{data.data.summary.controlledLiveVerified} controlled-live verified</em></header><div className={styles.controls}>{data.data.items.map(item=><article key={item.integrationCode}><i className={item.readinessState==="controlled_live_verified"?styles.passDot:item.readinessState==="blocked"?styles.blockDot:styles.warnDot}></i><div><h3>{item.integrationCode} · {item.capability}</h3><p>{item.category} · {item.provider} · code {pretty(item.codeBoundaryStatus)} · credentials {pretty(item.credentialStatus)}{item.blockerReason?` · ${item.blockerReason}`:""}</p>{editing===item.integrationCode&&<div style={{marginTop:8,display:"grid",gap:6}}>
    <label>New state<select value={form.readinessState} onChange={e=>setForm({...form,readinessState:e.target.value})}>{readinessStates.map(s=><option key={s} value={s}>{pretty(s)}</option>)}</select></label>
    <label>Evidence reference<input value={form.evidenceReference} onChange={e=>setForm({...form,evidenceReference:e.target.value})} placeholder="Required for sandbox_verified"/></label>
    <label>Approval reference<input value={form.approvalReference} onChange={e=>setForm({...form,approvalReference:e.target.value})} placeholder="Required for controlled_live_verified"/></label>
    <label>Change reason<input value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} placeholder="Why this state is changing"/></label>
    {formError&&<small style={{color:"crimson"}}>{formError}</small>}
    <div style={{display:"flex",gap:8}}><button disabled={saving} onClick={()=>void saveEdit()}>{saving?"Saving…":"Save governed change"}</button><button disabled={saving} onClick={()=>setEditing(null)}>Cancel</button></div>
   </div>}</div><b>{pretty(item.readinessState)}</b>{editing!==item.integrationCode&&<button onClick={()=>openEdit(item)}>Update</button>}</article>)}</div></section>
   <section className={styles.external}><div><span>GOVERNANCE RULE</span><h2>No integration becomes “ready” from an environment variable</h2><p>Sandbox and production verification require referenced evidence. Controlled-live verification additionally requires production environment, operational controls and an approval reference.</p></div><div><article><i className={styles.blockDot}></i><b>Live traffic</b><span>Disabled by this workstream</span></article><article><i className={styles.passDot}></i><b>Secret handling</b><span>References only; values never returned</span></article></div></section>
   <footer><span>Issue #14 · engineering control plane · PRODUCTION READY = FALSE</span><Link href="/control">Open Launch Essentials →</Link></footer>
  </section>
 </main>;
}
