"use client";

import Link from "next/link";
import {useEffect,useState} from "react";
import TaxiFlow from "../../mobile-app/taxi-flow";
import CustomerLogin from "../../mobile-app/customer-login";
import {loadCustomerAccount} from "../../../lib/customer-account-client";
import type {CustomerAccountRecord} from "../../../lib/customer-account";
import styles from "../stay-experience.module.css";

export default function V2BoardingTaxiExperience({sourceBookingId}:{sourceBookingId:string}){
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null);
 const[attempt,setAttempt]=useState(0),[settledAttempt,setSettledAttempt]=useState(-1),[error,setError]=useState("");
 useEffect(()=>{
  let active=true;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  loadCustomerAccount(undefined,{signal:controller.signal}).then(record=>{
   if(active){setAccount(record);setError("");}
  }).catch(problem=>{
   if(active){setAccount(null);setError(controller.signal.aborted?"Account loading timed out. Please retry.":problem instanceof Error?problem.message:"Unable to load your account.");}
  }).finally(()=>{clearTimeout(timer);if(active)setSettledAttempt(attempt);});
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[attempt]);
 const stayHref=`/v2/boarding/manage?bookingId=${encodeURIComponent(sourceBookingId)}`;
 return <main className={styles.page}><div className={styles.shell}>
  <header className={styles.nav}><Link href="/v2" className={styles.brand}>PawSpace</Link><Link href={stayHref} className={styles.back}>← Boarding booking</Link></header>
  <section className={styles.surface}><h1>Add Pet Taxi to your Boarding stay</h1><p>Choose a separate ride for your stay. Its price and payment are separate from Boarding.</p>
   {settledAttempt!==attempt?<p role="status">Loading your PawSpace family…</p>:account?<TaxiFlow key={account.customerId+":"+sourceBookingId} customer={{customerId:account.customerId,customerName:account.name,phone:account.primaryPhone}} sourceBookingId={sourceBookingId}/>:<div className={styles.login}><h2>Sign in to arrange your ride.</h2><p role="alert">{error||"Use the customer account that owns your Boarding booking."}</p><button onClick={()=>setAttempt(value=>value+1)}>Retry account</button><CustomerLogin embedded onLoggedIn={()=>setAttempt(value=>value+1)}/></div>}
  </section>
 </div></main>;
}
