"use client";
import Link from "next/link";
import GroomingChangePolicy from "./grooming-change-policy";
import {useEffect,useState} from "react";
import {loadCustomerAccount} from "../../../lib/customer-account-client";
import type {CustomerAccountRecord} from "../../../lib/customer-account";
import styles from "./grooming-customer-booking.module.css";

type Booking=CustomerAccountRecord["bookings"][number];
const formatDate=(value:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
export default function GroomingCustomerBooking({bookingId}:{bookingId:string}) {
 const [booking,setBooking]=useState<Booking|null>(null),[loadedId,setLoadedId]=useState(""),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  if(!bookingId)return;
  const controller=new AbortController();let active=true;
  void loadCustomerAccount(undefined,{signal:controller.signal}).then(account=>{
   if(active){setError("");setBooking(account.bookings.find(item=>item.id===bookingId&&item.serviceCode==="grooming")||null);setLoadedId(bookingId);}
  }).catch(problem=>{if(active){setError(problem instanceof Error?problem.message:"Unable to load your booking");setLoadedId(bookingId);}});
  return()=>{active=false;controller.abort();};
 },[bookingId,refresh]);
 const reload=()=>{setLoadedId("");setError("");setRefresh(value=>value+1);};
 const loaded=loadedId===bookingId;
 return <main className={styles.page}><div className={styles.content}>
  <Link href="/mobile-app">← Back to PawSpace</Link>
  <header><p className={styles.eyebrow}>YOUR CARE</p><h1>Your Grooming booking</h1></header>
  {!bookingId?<p>Open a Grooming booking from your Activity to view its details.</p>:!loaded?<p role="status">Loading your booking…</p>:error?<section className={styles.card}><p role="alert">{error}</p><button onClick={reload}>Try again</button><Link href="/mobile-app">Open your account</Link></section>:!booking?<section className={styles.card}><h2>Booking unavailable</h2><p>This booking is not available on your account. Check that you are signed in to the account that made the booking.</p></section>:<>
   <section className={styles.card} aria-label="Booking details"><p className={styles.status}>{booking.status.replaceAll("_"," ")}</p><h2>{booking.packageName}</h2><p className={styles.reference}>Booking reference · {booking.id}</p>
    <dl><div><dt>Starts</dt><dd>{formatDate(booking.scheduledStart)} IST</dd></div><div><dt>Ends</dt><dd>{formatDate(booking.scheduledEnd)} IST</dd></div><div><dt>Booking total</dt><dd>{new Intl.NumberFormat("en-IN",{style:"currency",currency:booking.currency}).format(booking.totalAmount)}</dd></div></dl>
    <p className={styles.note}>The booking total is not a receipt or confirmation of payment.</p>
   </section>
   <GroomingChangePolicy key={`${booking.id}:${booking.scheduledStart}:${booking.status}`} bookingId={booking.id}/>
   <button onClick={reload}>Refresh booking status</button>
  </>}
 </div></main>;
}
