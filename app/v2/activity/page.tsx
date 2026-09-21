"use client";
import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import type {CustomerAccountRecord} from "../../../lib/customer-account";
import {loadV2CustomerAccount,loadV2CustomerSession} from "../../../lib/v2/customer-experience-client";
import styles from "../customer-detail.module.css";
const CLOSED=new Set(["completed","cancelled","canceled","refunded","closed"]);
const label=(v:string)=>v.replaceAll("_"," ");
const money=(v:number,c:string)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:c,maximumFractionDigits:0}).format(v);
const when=(v:string)=>{const d=new Date(v);return Number.isNaN(d.getTime())?"Schedule pending":new Intl.DateTimeFormat("en-IN",{weekday:"short",day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(d);};
export default function V2ActivityPage(){
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
 useEffect(()=>{let live=true;(async()=>{try{const session=await loadV2CustomerSession();if(!session)return;const record=await loadV2CustomerAccount();if(live)setAccount(record);}catch(p){if(live)setError(p instanceof Error?p.message:"We could not load your activity.");}finally{if(live)setLoading(false);}})();return()=>{live=false};},[]);
 const bookings=useMemo(()=>[...(account?.bookings||[])].sort((a,b)=>new Date(b.scheduledStart).getTime()-new Date(a.scheduledStart).getTime()),[account]);
 const open=bookings.filter(x=>!CLOSED.has(x.status.toLowerCase())),history=bookings.filter(x=>CLOSED.has(x.status.toLowerCase()));
 // Fresh Food orders live in a separate table (food_orders), not canonical_bookings, so they never
 // showed up here or in the customer-account bookings list; a crashed confirmation (CUST-L-D21) left a
 // customer with no in-app way back to the order. [CUST-L-D22]
 const foodOrders=useMemo(()=>[...(account?.foodOrders||[])].sort((a,b)=>b.createdAt-a.createdAt),[account]);
 // [CUST-L-D04] a link into the owned booking/payment record for every service booking, not just
 // Fresh Food orders — /v2/booking reads it independently of payment-gateway configuration.
 const list=(items:typeof bookings,empty:string)=>items.length?items.map(x=><article className={styles.booking} key={x.id}><div><h3>{x.packageName}</h3><p className={styles.muted}>{when(x.scheduledStart)} · {label(x.serviceCode)}</p><span className={styles.pill}>{label(x.status)}</span><Link href={`/v2/booking?bookingId=${encodeURIComponent(x.id)}`}>View booking & payment</Link></div><div className={styles.money}>{money(x.totalAmount,x.currency)}</div></article>):<div className={styles.empty}>{empty}</div>;
 const foodList=foodOrders.length?foodOrders.map(x=><article className={styles.booking} key={x.id}><div><h3>{x.itemName}{x.quantity?` · qty ${x.quantity}`:""}</h3><p className={styles.muted}>{label(x.status)} · {label(x.deliveryStatus)}</p><Link href={`/v2/food/manage?orderId=${encodeURIComponent(x.id)}`}>Manage order</Link></div><div className={styles.money}>{money(x.totalAmount,x.currency)}</div></article>):<div className={styles.empty}>No Fresh Food orders yet.</div>;
 return <main className={styles.page}><div className={styles.shell}><header className={styles.topbar}><Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt=""/><span>PawSpace</span></Link><Link href="/v2" className={styles.back}>← Home</Link></header><section className={styles.hero}><span className={styles.eyebrow}>LIVE CARE ACTIVITY</span><h1>Every booking, one clear timeline.</h1><p>This view reads the same canonical PawSpace customer record used by checkout, partner operations and finance.</p></section>
 {error&&<div className={styles.notice} role="alert">{error}</div>}{loading?<section className={styles.card}>Loading your care activity…</section>:!account?<section className={styles.card}><h2>Sign in to see your care history.</h2><p className={styles.muted}>Return home and use secure mobile OTP sign-in.</p><Link href="/v2" className={styles.back}>Open PawSpace home</Link></section>:<div className={styles.grid}><section className={styles.card}><h2>Upcoming & active</h2><p className={styles.muted}>{open.length} booking{open.length===1?"":"s"} currently in motion.</p>{list(open,"Nothing active right now.")}</section><section className={styles.card}><h2>Care history</h2><p className={styles.muted}>Completed, cancelled and refunded bookings remain attached to your family record.</p>{list(history,"No closed bookings yet.")}</section><section className={styles.card}><h2>Fresh Food orders</h2><p className={styles.muted}>{foodOrders.length} order{foodOrders.length===1?"":"s"} on your family record.</p>{foodList}</section></div>}</div>
 <nav className={styles.dock} aria-label="PawSpace V2 navigation"><Link href="/v2"><strong>⌂</strong>Home</Link><Link href="/v2/grooming"><strong>＋</strong>Book</Link><Link href="/v2/activity" className={styles.active}><strong>◎</strong>Activity</Link><Link href="/v2/account"><strong>◉</strong>Account</Link></nav></main>;
}