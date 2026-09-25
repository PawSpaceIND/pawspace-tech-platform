"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import Link from "next/link";
import styles from "./live-tracking.module.css";

type Row=Record<string,unknown>;
type Snapshot={sessions?:Row[];punctualityEvents?:Row[];recoveries?:Row[];control?:Row|null};
type Payload={data?:Snapshot;error?:string;productionReady?:boolean;gpsConnected?:boolean;telemetryMode?:string};

const text=(value:unknown,fallback="—")=>value==null||value===""?fallback:String(value);
const when=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<=0)return"—";return new Intl.DateTimeFormat("en-IN",{dateStyle:"medium",timeStyle:"short"}).format(new Date(n));};
const active=(row:Row)=>["active","started","on_the_way","arrived","in_service"].includes(String(row.status||row.session_status||"").toLowerCase());

export default function OpsLiveTracking(){
 const[data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[tick,setTick]=useState(0);
 const load=useCallback(async()=>{try{const r=await fetch("/api/location-recovery",{cache:"no-store"}),b=await r.json() as Payload;if(!r.ok||!b.data)throw new Error(b.error||"Unable to load live tracking");setData(b.data);setError("");}catch(e){setError(e instanceof Error?e.message:"Unable to load live tracking");}finally{setLoading(false);}},[]);
 useEffect(()=>{void load();const id=window.setInterval(()=>{setTick(v=>v+1);void load();},10000);return()=>window.clearInterval(id);},[load]);
 const sessions=useMemo(()=>data?.sessions??[],[data]),recoveries=useMemo(()=>data?.recoveries??[],[data]),events=useMemo(()=>data?.punctualityEvents??[],[data]);
 const liveSessions=sessions.filter(active),openRecoveries=recoveries.filter(row=>!["resolved","cancelled","closed"].includes(String(row.recovery_state||row.status||"").toLowerCase()));
 return <main className={styles.page}>
  <header className={styles.head}><div><small>PAWSPACE V2 · OPERATIONS</small><h1>Live tracking control</h1><p>Canonical provider location sessions, punctuality signals and recovery exceptions. Refreshes every 10 seconds.</p></div><div className={styles.headActions}><button onClick={()=>void load()} aria-label="Refresh live tracking">↻</button><Link href="/team/operations">Back to Operations</Link></div></header>
  <section className={styles.kpis}><article><span>Active tracking</span><b>{liveSessions.length}</b><small>provider sessions</small></article><article><span>Open exceptions</span><b>{openRecoveries.length}</b><small>recovery cases</small></article><article><span>Punctuality events</span><b>{events.length}</b><small>latest canonical events</small></article><article><span>Refresh</span><b>{tick}</b><small>10-second cadence</small></article></section>
  {error&&<section className={styles.error} role="alert">{error}</section>}
  {loading&&!data&&<section className={styles.state}>Loading live tracking…</section>}
  <section className={styles.grid}>
   <article className={styles.card}><div className={styles.cardHead}><div><small>LIVE PROVIDERS</small><h2>Active location sessions</h2></div><span>{liveSessions.length}</span></div>{!liveSessions.length?<p className={styles.empty}>No active provider tracking sessions right now.</p>:<div className={styles.rows}>{liveSessions.map((row,i)=><div className={styles.row} key={text(row.id,String(i))}><div><b>{text(row.booking_id,"Booking")}</b><small>{text(row.provider_id,"Provider")} · {text(row.service_code,"service").replaceAll("_"," ")}</small></div><div><strong>{text(row.status,"active").replaceAll("_"," ")}</strong><small>Started {when(row.starts_at||row.created_at)}</small></div></div>)}</div>}</article>
   <article className={styles.card}><div className={styles.cardHead}><div><small>EXCEPTIONS</small><h2>Recovery attention</h2></div><span>{openRecoveries.length}</span></div>{!openRecoveries.length?<p className={styles.empty}>No open location-related recovery cases.</p>:<div className={styles.rows}>{openRecoveries.map((row,i)=><div className={styles.row+" "+styles.risk} key={text(row.id,String(i))}><div><b>{text(row.booking_id,"Booking")}</b><small>{text(row.failed_provider_id,"Provider")} · {text(row.reason_code,"exception").replaceAll("_"," ")}</small></div><div><strong>{text(row.recovery_state,"open").replaceAll("_"," ")}</strong><small>{when(row.updated_at||row.opened_at)}</small></div></div>)}</div>}</article>
  </section>
  <section className={styles.card}><div className={styles.cardHead}><div><small>PUNCTUALITY</small><h2>Latest movement signals</h2></div><span>{events.length}</span></div>{!events.length?<p className={styles.empty}>No punctuality events recorded.</p>:<div className={styles.rows}>{events.slice(0,30).map((row,i)=><div className={styles.row} key={text(row.id,String(i))}><div><b>{text(row.booking_id,"Booking")}</b><small>{text(row.provider_id,"Provider")} · {text(row.event_type||row.event_code,"event").replaceAll("_"," ")}</small></div><div><strong>{text(row.state||row.severity||"recorded").replaceAll("_"," ")}</strong><small>{when(row.created_at||row.occurred_at)}</small></div></div>)}</div>}</section>
  <footer className={styles.foot}>Raw GPS history is deliberately not rendered here. Customer-facing location remains privacy-projected; financial or accountability consequences stay in their governed review flows.</footer>
 </main>;
}
