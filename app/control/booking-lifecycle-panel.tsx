"use client";
import Link from "next/link";
import { useEffect,useMemo,useState } from "react";
import styles from "./booking-lifecycle-panel.module.css";

type Row={id:string;customer_id:string;customer_name:string;pet_ids_json:string;service_code:string;package_name:string;schedule_group_id:string;provider_id:string;provider_name:string;provider_model:string;scheduled_start:string;scheduled_end:string;status:string;total_amount:number;work_order_id:string;work_order_status:string;occurrence_count:number;payment_id:string;payment_status:string;amount_due_now:number;gateway:string;created_at:number;pets:Array<{id:string;name:string;species:string}>;events:Array<{id:string;event_type:string;entity_type:string;entity_id:string;occurred_at:number}>};
const labels:Record<string,string>={grooming:"Grooming",dog_training:"Training",boarding:"Boarding",pet_sitting:"Pet Sitting"};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(value);
const when=(value:string|number)=>new Date(typeof value==="number"?value:value).toLocaleString("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});

export default function BookingLifecyclePanel(){
  const [rows,setRows]=useState<Row[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[query,setQuery]=useState(""),[selected,setSelected]=useState<Row|null>(null);
  const load=async()=>{setLoading(true);setError("");try{const response=await fetch("/api/canonical-bookings",{cache:"no-store"});const body=await response.json() as {bookings?:Row[];error?:string};if(!response.ok)throw new Error(body.error??"Unable to load records");setRows(body.bookings??[]);setSelected(current=>current?(body.bookings??[]).find(item=>item.id===current.id)??null:null);}catch(reason){setError(reason instanceof Error?reason.message:"Unable to load records");}finally{setLoading(false);}};
  useEffect(()=>{let active=true;fetch("/api/canonical-bookings",{cache:"no-store"}).then(async response=>{const body=await response.json() as {bookings?:Row[];error?:string};if(!response.ok)throw new Error(body.error??"Unable to load records");if(active)setRows(body.bookings??[]);}).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"Unable to load records");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const visible=useMemo(()=>rows.filter(row=>`${row.id} ${row.customer_name} ${row.provider_name} ${row.service_code} ${row.package_name}`.toLowerCase().includes(query.toLowerCase())),[rows,query]);
  const complete=rows.filter(row=>row.work_order_id&&row.payment_id&&row.schedule_group_id).length;
  return <div className={styles.wrap}>
    <section className={styles.hero}><div><span>CANONICAL UAT DATABASE</span><h2>One booking ID. Every operating record linked.</h2><p>Customer, pets, booking, schedule group, provider work order and payment are created together. The browser ledger is only a temporary display mirror.</p><Link href="/booking-command-center" style={{display:"inline-block",marginTop:8,fontWeight:700}}>Open the full Booking Command Center for deep operational work &rarr;</Link></div><button onClick={()=>void load()} disabled={loading}>{loading?"Checking…":"Refresh records"}</button></section>
    <section className={styles.metrics}>
      <article><span>Persistent bookings</span><strong>{rows.length}</strong><small>Across all four journeys</small></article>
      <article><span>Complete record chains</span><strong>{complete}/{rows.length||0}</strong><small>Schedule + work order + payment</small></article>
      <article><span>Live money</span><strong>OFF</strong><small>UAT sandbox payments only</small></article>
      <article><span>Source of truth</span><strong>D1</strong><small>Shared across signed-in testers</small></article>
    </section>
    <section className={styles.guard}><b>UAT safeguard</b><span>A customer confirmation is returned only after an assigned schedule, provider work order and payment record all exist. Repeated requests reuse the same booking.</span></section>
    <section className={styles.panel}><header><div><span>LINKED RECORD DESK</span><h3>Customer booking lifecycle</h3></div><input aria-label="Search lifecycle records" placeholder="Search booking, customer or provider" value={query} onChange={event=>setQuery(event.target.value)}/></header>
      {error&&<p className={styles.error}>{error}</p>}
      {!loading&&!error&&!visible.length&&<div className={styles.empty}><strong>No matching persistent booking yet.</strong><p>Complete Grooming, Training, Boarding or Sitting once in the customer app. The linked record will appear here for Ops review.</p></div>}
      {visible.map(row=><button className={styles.row} key={row.id} onClick={()=>setSelected(row)}><i>{labels[row.service_code]?.slice(0,1)??"B"}</i><div><strong>{row.id}</strong><small>{row.customer_name} · {row.pets.map(p=>p.name).join(", ")}</small></div><span><b>{labels[row.service_code]??row.service_code}</b><small>{row.package_name}</small></span><span><b>{row.provider_name}</b><small>{row.provider_model.replaceAll("_"," ")} · {row.occurrence_count} reservation{row.occurrence_count===1?"":"s"}</small></span><span><b>{money(Number(row.total_amount))}</b><small>{row.payment_status} · {row.gateway}</small></span><em>Open →</em></button>)}
    </section>
    {selected&&<section className={styles.detail}><header><div><span>TRACE · {labels[selected.service_code]}</span><h3>{selected.id}</h3><p>Created {when(selected.created_at)}</p></div><button onClick={()=>setSelected(null)}>Close</button></header><div className={styles.links}>{[["Customer",selected.customer_id],["Pets",selected.pets.map(p=>p.id).join(", ")],["Schedule group",selected.schedule_group_id],["Work order",selected.work_order_id],["Provider",`${selected.provider_name} · ${selected.provider_id}`],["Payment",`${selected.payment_id} · ${selected.payment_status}`]].map(item=><article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong></article>)}</div><div className={styles.timeline}>{selected.events.map((event,index)=><article key={event.id}><i>{index+1}</i><div><strong>{event.event_type.replaceAll("_"," ")}</strong><small>{event.entity_type} · {event.entity_id} · {when(event.occurred_at)}</small></div></article>)}</div></section>}
  </div>;
}
