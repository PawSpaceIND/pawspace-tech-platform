"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import StayFlow from "../mobile-app/stay-flow";
import CustomerLogin from "../mobile-app/customer-login";
import styles from "../mobile-app/mobile.module.css";
import {loadCustomerAccount} from "../../lib/customer-account-client";
import type {CustomerAccountRecord} from "../../lib/customer-account";

export default function SittingPage(){
 const[account,setAccount]=useState<CustomerAccountRecord|null>(null),[attempt,setAttempt]=useState(0),[settledAttempt,setSettledAttempt]=useState(-1),[error,setError]=useState("");
 useEffect(()=>{let active=true;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);loadCustomerAccount(undefined,{signal:controller.signal}).then(record=>{if(active){setAccount(record);setError("");}}).catch(problem=>{if(active){setAccount(null);setError(controller.signal.aborted?"Account loading timed out. Please retry.":problem instanceof Error?problem.message:"Unable to load your account.");}}).finally(()=>{clearTimeout(timer);if(active)setSettledAttempt(attempt);});return()=>{active=false;clearTimeout(timer);controller.abort();};},[attempt]);
 const loading=settledAttempt!==attempt;
 return <main className={styles.stage} data-theme="emerald" data-mode="light" style={{display:"block",padding:16}}><section style={{maxWidth:620,margin:"0 auto",background:"var(--ps-surface)",borderRadius:24,padding:16}}><Link href="/mobile-app">My PawSpace</Link><h1 style={{fontSize:28,fontWeight:700,margin:"16px 0"}}>Pet Sitting</h1>{loading?<p role="status">Loading your PawSpace account…</p>:account?<StayFlow key={account.customerId} mode="sitting" customer={{customerId:account.customerId,customerName:account.name,phone:account.primaryPhone}}/>:<><p role="alert">{error}</p><button style={{minHeight:44}} onClick={()=>setAttempt(value=>value+1)}>Retry account</button><p>Sign in to choose your pets, care dates and available sitters.</p><CustomerLogin embedded onLoggedIn={()=>setAttempt(value=>value+1)}/></>}</section></main>;
}
