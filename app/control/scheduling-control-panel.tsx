"use client";
import {useCallback,useEffect,useState} from "react";
import {schedulingRuleInput} from "../../lib/scheduling-rule-input";
import styles from "./scheduling-control-panel.module.css";

const services=[['grooming','Grooming'],['dog_training','Training'],['boarding','Boarding'],['pet_sitting','Pet sitting']];
type Rule={id:string;name:string;service_code?:string;city_id?:string;zone_id?:string;active:number};
const scenarios=[
 ['Grooming','Check availability, travel buffers and overlapping appointments.'],
 ['Training','Check every session against the same trainer’s availability.'],
 ['Boarding','Check capacity for every date of the stay.'],
 ['Pet sitting','Check visit conflicts and overnight capacity.'],
 ['Provider decline','Check rerouting and the no-replacement outcome.'],
 ['Ops recovery','Check authorised reassignment, a recorded reason and the audit trail.'],
 ['Concurrent requests','Check that competing requests cannot silently double-book a provider.'],
];

export default function SchedulingControlPanel({notify}:{notify:(message:string)=>void}){
 const[tab,setTab]=useState<'rules'|'custom'|'uat'|'exceptions'>('rules');
 const[rules,setRules]=useState<Rule[]|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const[error,setError]=useState(''),[notice,setNotice]=useState('');
 const[name,setName]=useState(''),[service,setService]=useState('grooming'),[zone,setZone]=useState('blr-east');
 const[field,setField]=useState('rating'),[value,setValue]=useState('4.7');
 const load=useCallback(async()=>{
   setLoading(true);
   try{
     const response=await fetch('/api/scheduling-rules',{cache:'no-store'});
     const body=await response.json();
     if(!response.ok||!Array.isArray(body.data))throw new Error();
     setRules(body.data);setError('');
   }catch{setError('We couldn’t refresh scheduling rules. Check your access and connection, then try again.');}
   finally{setLoading(false);}
 },[]);
 useEffect(()=>{void load();},[load]);

 async function save(){
   if(busy)return;
   const input=schedulingRuleInput({name,service,zone,field,value});
   if(!input){setError('Enter a rule name and a valid value for the selected constraint.');return;}
   if(!window.confirm('Activate this rule for the selected service and location? This affects future provider eligibility.'))return;
   setBusy(true);setError('');setNotice('');
   try{
     const response=await fetch('/api/scheduling-rules',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
     if(!response.ok){setError(response.status===403?'Your role cannot change scheduling rules. Ask your operations lead for help.':'The rule was not confirmed. Refresh the saved rules before trying again.');return;}
     setNotice('Rule saved and activated.');notify('Scheduling rule saved and activated.');setName('');
     await load();
   }catch{setError('We couldn’t confirm whether the rule was saved. Refresh the list and check for it before trying again.');}
   finally{setBusy(false);}
 }

 return <div className={styles.wrap}>
   <section className={styles.hero}><div><span>PAWSPACE · SCHEDULING</span><h2>The right care, at the right time</h2><p>Review saved eligibility rules or open an actual booking to manage its schedule. Provider availability and assignment remain checked by the server.</p></div></section>
   <nav className={styles.actions} aria-label="Scheduling workspaces">
     <a className={styles.workspaceLink} href="/team/operations/bookings">Open booking command center →</a>
     <a className={styles.workspaceLink} href="/team/scheduling">Open provider day board →</a>
   </nav>
   <div className={styles.tabs} aria-label="Scheduling sections">{(['rules','custom','uat','exceptions'] as const).map(key=><button key={key} aria-pressed={tab===key} className={tab===key?styles.active:''} onClick={()=>setTab(key)}>{key==='rules'?'Saved rules':key==='custom'?'Add rule':key==='uat'?'Testing checklist':'Assignments'}</button>)}</div>
   {error&&<div className={styles.note} role="alert">{error}</div>}
   {notice&&<div className={styles.note} role="status">{notice}</div>}
   {(tab==='rules'||tab==='custom')&&<section className={tab==='custom'?styles.two:undefined}>
     {tab==='custom'&&<form className={styles.panel} onSubmit={event=>{event.preventDefault();void save();}}>
       <h3>Add an eligibility rule</h3><p>Choose the service and location this rule should affect.</p>
       <label>Rule name<input required maxLength={160} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label>
       <label>Service<select value={service} onChange={e=>setService(e.target.value)} disabled={busy}>{services.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
       <label>Location<select value={zone} onChange={e=>setZone(e.target.value)} disabled={busy}><option value="blr-east">Bengaluru · East zone</option><option value="blr-south">Bengaluru · South zone</option><option value="all">All Bengaluru</option></select></label>
       <label>Constraint<select value={field} onChange={e=>{setField(e.target.value);setValue('');}} disabled={busy}><option value="rating">Minimum rating (0–5)</option><option value="qualityScore">Minimum quality score (0–100)</option><option value="capacity">Minimum pet capacity</option><option value="model">Provider model</option></select></label>
       <label>Required value{field==='model'?<select required value={value} onChange={e=>setValue(e.target.value)} disabled={busy}><option value="">Choose model</option><option value="full_time">Full time</option><option value="commission">Commission</option></select>:<input required type="number" min="0" step={field==='capacity'?'1':'any'} value={value} onChange={e=>setValue(e.target.value)} disabled={busy}/>}</label>
       <button className={styles.save} disabled={busy||loading} type="submit">{busy?'Saving…':'Save & activate rule'}</button>
     </form>}
     <section className={styles.panel} aria-busy={loading}><header><div><span>SAVED ON SERVER</span><h3>Eligibility rules</h3></div><button type="button" disabled={loading||busy} onClick={()=>void load()}>{loading?'Loading…':'Refresh'}</button></header>
       {rules===null?<p>Saved rules have not loaded yet.</p>:rules.length===0?<p>No custom rules have been saved. Core scheduling checks still apply.</p>:rules.map(rule=><article key={rule.id}><div><strong>{rule.name}</strong><p>{rule.service_code||'All services'} · {rule.city_id||'All cities'} · {rule.zone_id||'All zones'}</p></div><span>{Number(rule.active)===1?'Active':'Inactive'}</span></article>)}
     </section>
   </section>}
   {tab==='exceptions'&&<section className={styles.panel}><h3>Start with the booking that needs help</h3><p>Open the booking command center to select a recorded booking, review its history and available actions. Use the provider day board for scheduled reservations and reassignment.</p><p>There are no preselected providers or sample bookings here. Opening either workspace does not change an assignment.</p><a className={styles.workspaceLink} href="/team/operations/bookings">Find a booking →</a><a className={styles.workspaceLink} href="/team/scheduling">Review provider schedule →</a></section>}
   {tab==='uat'&&<section className={styles.panel}><h3>Scheduling test checklist</h3><p>These are scenarios to verify, not recorded pass results. Use synthetic test bookings only.</p>{scenarios.map(([title,description],i)=><article key={title} className={styles.scenario}><i>{i+1}</i><div><strong>{title}</strong><p>{description}</p></div><span>Needs verification</span></article>)}</section>}
   <section className={styles.note}><strong>Internal testing only</strong><p>Role permissions, availability and capacity checks still apply. This screen does not certify production readiness or enable payments and external messaging.</p></section>
 </div>;
}
