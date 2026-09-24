"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CustomerCheckoutController, type CheckoutState } from "../../lib/customer-checkout-client";
import styles from "./booking-payment-page.module.css";

const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(value);

type Props={
 serviceName:string; totalAmount:number; amountDueNow:number; mode:"prepaid"|"split"|"split_50_50"|"pay_after_service";
 bookingId?:string; busy?:boolean; autoStart?:boolean; onCreateBooking?:()=>Promise<void>|void; onVerified?:()=>Promise<void>|void; onBack?:()=>void;
};
function BookingPaymentInner({serviceName,totalAmount,amountDueNow,mode,bookingId,busy=false,autoStart=false,onCreateBooking,onVerified,onBack}:Props){
 const[state,setState]=useState<CheckoutState>({phase:"ready",message:"",canCheck:false});
 const controller=useRef<CustomerCheckoutController|null>(null),notified=useRef(false),autoStarted=useRef(false);
 const payAfter=mode==="pay_after_service",dueNow=payAfter?0:amountDueNow;
 const [confirmationError,setConfirmationError]=useState(""),[finishing,setFinishing]=useState(false);
 const finishingRef=useRef(false);
 const finishConfirmation=useCallback(async()=>{
  if(finishingRef.current||notified.current)return;
  finishingRef.current=true;setFinishing(true);setConfirmationError("");
  try{await onVerified?.();notified.current=true;}
  catch(problem){setConfirmationError(problem instanceof Error?problem.message:"Payment is verified, but booking details could not be refreshed. Retry confirmation, not payment.");}
  finally{finishingRef.current=false;setFinishing(false);}
 },[onVerified]);
 useEffect(()=>{if(!bookingId){controller.current=null;return;}let active=true;controller.current=new CustomerCheckoutController(bookingId,value=>{if(active)setState(value);});return()=>{active=false;controller.current=null;};},[bookingId]);
 useEffect(()=>{if(state.phase!=="captured"||notified.current||confirmationError)return;void finishConfirmation();},[state.phase,confirmationError,finishConfirmation]);
 useEffect(()=>{if(!autoStart||!bookingId||payAfter||autoStarted.current||!controller.current)return;autoStarted.current=true;void controller.current.start();},[autoStart,bookingId,payAfter]);
 useEffect(()=>{if(state.phase!=="pending")return;const timer=window.setInterval(()=>void controller.current?.start(),2500);return()=>window.clearInterval(timer);},[state.phase]);
 const working=busy||finishing||["starting","checkout","confirming"].includes(state.phase);
 async function primary(){if(state.phase==="captured"){await finishConfirmation();return;}if(!bookingId){await onCreateBooking?.();return;}if(payAfter){await onVerified?.();return;}await controller.current?.start();}
 return <section className={styles.page} aria-label={`${serviceName} payment`}>
  <header><small>PAYMENT · FINAL STEP</small><h3>Review payment</h3><p>Your service details are locked while you finish this step.</p></header>
  <article className={styles.amount}><span>Total service value<b>{money(totalAmount)}</b></span><span>Due now<b>{money(dueNow)}</b></span>{mode==="split"||mode==="split_50_50"?<span>Balance later<b>{money(Math.max(0,totalAmount-dueNow))}</b></span>:null}</article>
  {payAfter?<article className={styles.notice}><b>Pay after service</b><p>Nothing is charged now. {money(totalAmount)} becomes payable after the service is completed and verified.</p></article>:<article className={styles.notice}><b>Secure Razorpay checkout</b><p>{mode==="prepaid"?"Full payment":"The amount due now"} must be verified before PawSpace shows this booking as confirmed.</p></article>}
  {confirmationError&&<p role="alert" className={styles.error}>{confirmationError} Payment is already verified; retrying only refreshes the booking.</p>}
  {state.message&&<p role={state.phase==="error"?"alert":"status"} className={state.phase==="error"?styles.error:styles.status}>{state.message}</p>}
  <button type="button" className={styles.primary} disabled={working} onClick={()=>void primary()}>{working?"Please wait…":state.phase==="captured"?"Retry booking confirmation":!bookingId?payAfter?"Accept pay-after-service & confirm booking":"Reserve slot & continue to Razorpay":payAfter?"Confirm booking":state.canCheck?"Check payment status":`Pay securely · ${money(dueNow)}`}</button>
  {onBack&&!bookingId&&<button type="button" className={styles.secondary} disabled={working} onClick={onBack}>← Back to review</button>}
  <small className={styles.foot}>{payAfter?"Your payment method acceptance is recorded before confirmation.":"The browser never self-confirms a payment. Signed gateway evidence remains authoritative."}</small>
 </section>;
}

export default function BookingPaymentPage(props:Props){return <BookingPaymentInner key={props.bookingId||"new-booking"} {...props}/>;}
