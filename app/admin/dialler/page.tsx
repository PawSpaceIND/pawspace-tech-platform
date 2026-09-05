"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./dialler.module.css";

type Call = { id:string; leadId:string; state:string; providerStatus?:string|null; outcome?:string|null; durationSeconds?:number|null; recordingUrl?:string|null; customerPhoneLast4:string };
type Customer = { name:string; phoneLast4:string; petSummary?:string|null; lifetimeValue:number; pets:{id:string;name:string;species:string;breed:string;age?:string|null}[]; bookingCadence:{bookingCount:number;lastServiceAt?:number|null;averageGapDays?:number|null;recentServices:string[]}; lead:{id:string;service:string;score:number;valueScore:number;recencyScore:number;opportunityStage?:string|null}; aiContext:{direction:string;channel:string;text:string;at:number}[]; nextBestAction:string; recommendedPitch:string };
const dispositions=["Interested","Booked","Callback Scheduled","No Answer","Not Interested","Wrong Number","DND / Suppress"];

export default function DiallerPage(){
 const [call,setCall]=useState<Call|null>(null),[customer,setCustomer]=useState<Customer|null>(null),[paused,setPaused]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[countdown,setCountdown]=useState<number|null>(null),[note,setNote]=useState(""),[callbackAt,setCallbackAt]=useState("");
 const timer=useRef<ReturnType<typeof setInterval>|null>(null),poll=useRef<ReturnType<typeof setInterval>|null>(null);
 const stateLabel=useMemo(()=>({connecting_agent:"Connecting Agent",dialling_customer:"Dialling Customer",in_call:"In Call",call_ended:"Call Ended"} as Record<string,string>)[call?.state||""]||"Ready",[call?.state]);
 async function start(){
  if(paused||busy)return; setBusy(true);setError("");setCountdown(null);
  try{const r=await fetch("/api/dialler/call",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const data=await r.json();if(!r.ok)throw new Error(data.error||"Unable to start call");if(data.queueEmpty){setPaused(true);setError("No eligible Score 80+ leads are available right now.");setCall(null);setCustomer(null);return}setCall(data.call);setCustomer(data.customer)}catch(e){setPaused(true);setError(e instanceof Error?e.message:"Unable to start call")}finally{setBusy(false)}
 }
 function armNext(){if(paused)return;let left=3;setCountdown(left);if(timer.current)clearInterval(timer.current);timer.current=setInterval(()=>{left-=1;setCountdown(left);if(left<=0){if(timer.current)clearInterval(timer.current);timer.current=null;void start()}},1000)}
 async function disposition(value:string){
  if(!call||busy)return;if(value==="Callback Scheduled"&&!callbackAt){setError("Choose a callback time first.");return}setBusy(true);setError("");
  try{const r=await fetch("/api/dialler/disposition",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({callId:call.id,disposition:value,note,callbackAt:value==="Callback Scheduled"?new Date(callbackAt).getTime():null})});const data=await r.json();if(!r.ok)throw new Error(data.error||"Unable to save disposition");setCall(null);setCustomer(null);setNote("");setCallbackAt("");armNext()}catch(e){setError(e instanceof Error?e.message:"Unable to save disposition")}finally{setBusy(false)}
 }
 useEffect(()=>{if(!call?.id)return; if(poll.current)clearInterval(poll.current);poll.current=setInterval(async()=>{try{const r=await fetch(`/api/dialler/call?callId=${encodeURIComponent(call.id)}`,{cache:"no-store"});if(!r.ok)return;const data=await r.json();setCall(data.call)}catch{}},1500);return()=>{if(poll.current)clearInterval(poll.current)}},[call?.id]);
 useEffect(()=>()=>{if(timer.current)clearInterval(timer.current);if(poll.current)clearInterval(poll.current)},[]);
 return <main className={styles.shell}>
  <header className={styles.header}><div><p className={styles.eyebrow}>PAWSPACE CRM · EMPLOYEE OUTBOUND</p><h1>Power Dialler</h1><p>Prioritized Score 80+ queue · 09:00–21:00 IST · Exotel agent-first bridge</p></div><button className={paused?styles.start:styles.pause} onClick={()=>{const next=!paused;setPaused(next);setCountdown(null);if(timer.current)clearInterval(timer.current);if(!next&&!call)setTimeout(()=>void start(),0)}}>{paused?"Start Dialler":"Pause Dialler"}</button></header>
  {error&&<div className={styles.alert}>{error}</div>}
  {countdown!==null&&countdown>0&&<div className={styles.countdown}>Next prioritized customer in <strong>{countdown}</strong>…</div>}
  <section className={styles.grid}>
   <article className={styles.callCard}><div className={styles.statusRow}><span className={styles.dot}/><strong>{stateLabel}</strong></div><div className={styles.phone}>{call?`•••• ${call.customerPhoneLast4}`:"No active call"}</div><div className={styles.meta}>{call?.providerStatus||"Dialler paused or waiting"}</div>{call?.durationSeconds!=null&&<div className={styles.metric}><span>Duration</span><b>{call.durationSeconds}s</b></div>}</article>
   <article className={styles.customerCard}><div className={styles.cardTitle}><span>Customer 360</span>{customer&&<b className={styles.score}>{customer.lead.score}</b>}</div>{customer?<><h2>{customer.name}</h2><p className={styles.muted}>Lead {customer.lead.id} · {customer.lead.service} · LTV ₹{Math.round(customer.lifetimeValue).toLocaleString("en-IN")}</p><div className={styles.petList}>{customer.pets.length?customer.pets.map(p=><div className={styles.pet} key={p.id}><b>{p.name}</b><span>{[p.breed,p.age].filter(Boolean).join(" · ")||p.species}</span></div>):<p className={styles.muted}>{customer.petSummary||"Pet details not captured"}</p>}</div><div className={styles.stats}><div><span>Bookings</span><b>{customer.bookingCadence.bookingCount}</b></div><div><span>Avg cadence</span><b>{customer.bookingCadence.averageGapDays?`${customer.bookingCadence.averageGapDays}d`:"—"}</b></div><div><span>Value score</span><b>{customer.lead.valueScore}</b></div></div></>:<p className={styles.empty}>Start the dialler to load the top eligible CRM record.</p>}</article>
   <article className={styles.pitchCard}><div className={styles.cardTitle}>Recommended pitch</div><h3>{customer?.nextBestAction||"Next Best Action"}</h3><p className={styles.pitch}>{customer?.recommendedPitch||"PR #515 pipeline context appears here before the call connects."}</p><div className={styles.context}><b>Recent AI / WhatsApp context</b>{customer?.aiContext?.length?customer.aiContext.slice(0,4).map((m,i)=><p key={i}><span>{m.direction}</span>{m.text}</p>):<p className={styles.muted}>No recent conversation context.</p>}</div></article>
   <article className={styles.disposition}><div className={styles.cardTitle}>Post-call disposition</div><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional call note"/><input type="datetime-local" value={callbackAt} onChange={e=>setCallbackAt(e.target.value)}/><div className={styles.actions}>{dispositions.map(d=><button key={d} disabled={!call||call.state!=="call_ended"||busy} onClick={()=>void disposition(d)}>{d}</button>)}</div><p className={styles.muted}>Auto-advance starts 3 seconds after a saved disposition. Pause Dialler stops the loop.</p></article>
  </section>
 </main>
}
