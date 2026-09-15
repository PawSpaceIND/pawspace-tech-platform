"use client";
import { useEffect, useRef, useState } from "react";
import { CustomerCheckoutController, type CheckoutState } from "../../lib/customer-checkout-client";
import styles from "./booking-payment-page.module.css";

/* Shows paise whenever the amount is not a whole rupee, and whole rupees otherwise. The governed
 * 50/50 split (lib/stay-split-payments.ts) legitimately produces half-rupee instalments - Rs 4,893
 * splits into two Rs 2,446.50 halves - and rounding for display made this button read
 * "Pay securely Rs 2,447" while the gateway is asked for rupeesToPaiseExact(2446.5) = 244650 paise.
 * The customer must never be shown an amount that is not the amount charged. Mirrors the formatter
 * in app/mobile-app/stay-flow.tsx, which hands off to this screen. */
const money=(value:number)=>{const exact=Math.round(value*100),fractional=Number.isFinite(exact)&&exact%100!==0;return new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:fractional?2:0,maximumFractionDigits:fractional?2:0}).format(Number.isFinite(exact)?exact/100:value);};

type Props={
 serviceName:string; totalAmount:number; amountDueNow:number; mode:"prepaid"|"split"|"split_50_50"|"pay_after_service";
 bookingId?:string; busy?:boolean; autoStart?:boolean; onCreateBooking?:()=>Promise<void>|void; onVerified?:()=>Promise<void>|void; onBack?:()=>void;
};
export default function BookingPaymentPage({serviceName,totalAmount,amountDueNow,mode,bookingId,busy=false,autoStart=false,onCreateBooking,onVerified,onBack}:Props){
 const[state,setState]=useState<CheckoutState>({phase:"ready",message:"",canCheck:false});
 const controller=useRef<CustomerCheckoutController|null>(null),notified=useRef(false),autoStarted=useRef(false);
 const payAfter=mode==="pay_after_service",dueNow=payAfter?0:amountDueNow;
 useEffect(()=>{if(!bookingId){controller.current=null;return;}let active=true;controller.current=new CustomerCheckoutController(bookingId,value=>{if(active)setState(value);});return()=>{active=false;controller.current=null;};},[bookingId]);
 useEffect(()=>{if(state.phase!=="captured"||notified.current)return;notified.current=true;void onVerified?.();},[state.phase,onVerified]);
 useEffect(()=>{if(!autoStart||!bookingId||payAfter||autoStarted.current||!controller.current)return;autoStarted.current=true;void controller.current.start();},[autoStart,bookingId,payAfter]);
 useEffect(()=>{if(state.phase!=="pending")return;const timer=window.setInterval(()=>void controller.current?.start(),2500);return()=>window.clearInterval(timer);},[state.phase]);
 const working=busy||["starting","checkout","confirming"].includes(state.phase);
 async function primary(){if(!bookingId){await onCreateBooking?.();return;}if(payAfter){await onVerified?.();return;}await controller.current?.start();}
 return <section className={styles.page} aria-label={`${serviceName} payment`}>
  <header><small>PAYMENT · FINAL STEP</small><h3>Review payment</h3><p>Your service details are locked while you finish this step.</p></header>
  <article className={styles.amount}><span>Total service value<b>{money(totalAmount)}</b></span><span>Due now<b>{money(dueNow)}</b></span>{mode==="split"||mode==="split_50_50"?<span>Balance later<b>{money(Math.max(0,totalAmount-dueNow))}</b></span>:null}</article>
  {payAfter?<article className={styles.notice}><b>Pay after service</b><p>Nothing is charged now. {money(totalAmount)} becomes payable after the service is completed and verified.</p></article>:<article className={styles.notice}><b>Secure Razorpay checkout</b><p>{mode==="prepaid"?"Full payment":"The amount due now"} must be verified before PawSpace shows this booking as confirmed.</p></article>}
  {state.message&&<p role={state.phase==="error"?"alert":"status"} className={state.phase==="error"?styles.error:styles.status}>{state.message}</p>}
  <button type="button" className={styles.primary} disabled={working} onClick={()=>void primary()}>{working?"Please wait…":!bookingId?payAfter?"Accept pay-after-service & confirm booking":"Reserve slot & continue to Razorpay":payAfter?"Confirm booking":state.canCheck?"Check payment status":`Pay securely · ${money(dueNow)}`}</button>
  {onBack&&!bookingId&&<button type="button" className={styles.secondary} disabled={working} onClick={onBack}>← Back to review</button>}
  <small className={styles.foot}>{payAfter?"Your payment method acceptance is recorded before confirmation.":"The browser never self-confirms a payment. Signed gateway evidence remains authoritative."}</small>
 </section>;
}
