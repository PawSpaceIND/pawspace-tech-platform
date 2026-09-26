"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import {useQueryParameter} from "../../../lib/use-query-parameter";
import {loadCustomerConfirmationProjection,type CustomerConfirmationProjection} from "../../../lib/customer-checkout-client";
import {customerBookingManageHref} from "../../../lib/customer-activity";
import {customerScopedHref} from "../../../lib/v2/route-scope";
import TrainingBookingSessions from "./training-sessions";
import CustomerGroomingLiveCard from "../../mobile-app/customer-grooming-live-card";
import {customerGroomingLiveCardVisible} from "../../../lib/customer-location-disclosure";
import BookingPaymentPage from "../../mobile-app/booking-payment-page";
import {formatIndiaDateTime} from "../../../lib/india-time";
import styles from "../customer-detail.module.css";
const money=(n:number,currency:string)=>new Intl.NumberFormat("en-IN",{style:"currency",currency,maximumFractionDigits:2}).format(n);
/** Customer wording for a payment status ("captured" and "created" are gateway terms). */
const paymentLabel=(status:string)=>({captured:"paid",paid:"paid",settled:"paid",created:"not paid yet",pending:"not paid yet",partially_refunded:"partly refunded"} as Record<string,string>)[status]??status.replaceAll("_"," ");
export default function V2BookingPage(){
 const[trainingReady,setTrainingReady]=useState(false);
 const bookingId=useQueryParameter("bookingId"),[record,setRecord]=useState<CustomerConfirmationProjection|null>(null),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
 useEffect(()=>{const controller=new AbortController();queueMicrotask(()=>{if(!controller.signal.aborted){setRecord(null);setError("");setTrainingReady(false);}});if(!bookingId)return()=>controller.abort();void loadCustomerConfirmationProjection(bookingId,controller.signal).then(value=>{if(!controller.signal.aborted)setRecord(value);}).catch(problem=>{if(!controller.signal.aborted)setError(problem instanceof Error?problem.message:"Unable to load your booking.");});return()=>controller.abort();},[bookingId,attempt]);
 // Training is managed on this page (its sessions section); its payment-return page is linked only while payment is pending.
 const manage=record?customerBookingManageHref({id:record.bookingId,serviceCode:record.serviceCode,status:record.bookingStatus,scheduledStart:record.scheduledStart},"v2"):null;
 // Once a split's first instalment is captured, amountDueNow is the outstanding balance: show it as such,
 // and only offer it when it may be paid now (a Pet Taxi final balance is requested after drop-off).
 const balanceStage=record?.paymentStage==="outstanding_balance";
 const payable=record&&record.amountDueNow>0&&!["cancelled","canceled","refunded","failed","expired"].includes(record.bookingStatus)&&(!balanceStage||record.balancePayableNow!==false);
 const mode=record?.paymentMode;
 return <main className={styles.page}><div className={styles.shell}><header className={styles.topbar}><Link href="/v2/activity">← Your bookings</Link><Link href="/v2">PawSpace</Link></header>
 {!bookingId?<p role="alert">Open a booking from your Activity timeline.</p>:error?<section className={styles.card}><p role="alert">{error}</p><button onClick={()=>setAttempt(x=>x+1)}>Retry booking</button></section>:!record?<p role="status">Loading your booking…</p>:<><section className={styles.card}><h1>{record.packageName}</h1><p>{record.bookingId}</p><p>Status: {record.bookingStatus.replaceAll("_"," ")}</p><p>{formatIndiaDateTime(record.scheduledStart)} · {record.providerName||"Assignment pending"}</p><p>{record.pets?.map(pet=>pet.name).join(", ")}</p><p>Total: {money(record.totalAmount,record.currency)} · {balanceStage&&record.amountDueNow>0?`Paid ${money(record.amountPaid??Math.max(0,record.totalAmount-record.amountDueNow),record.currency)} · Balance ${money(record.amountDueNow,record.currency)}`:`Payment: ${paymentLabel(record.paymentStatus)}`}</p><div className={styles.actions}>{manage&&(manage.startsWith("/v2/booking?")?<a href="#training-sessions">Manage service</a>:<Link href={customerScopedHref("/v2",manage)}>Manage service</Link>)}<button onClick={()=>setAttempt(x=>x+1)}>Refresh status</button></div></section>
 {customerGroomingLiveCardVisible(record.serviceCode,record.bookingStatus)&&<CustomerGroomingLiveCard key={record.bookingId} bookingId={record.bookingId}/>}
 {record.serviceCode==="dog_training"&&<TrainingBookingSessions key={record.bookingId} bookingId={record.bookingId} inactive={["cancelled","refunded","failed","expired","completed"].includes(record.bookingStatus)} onReady={setTrainingReady}/>}
 {payable&&(record.serviceCode!=="dog_training"||trainingReady)&&(mode==="prepaid"||mode==="split"||mode==="split_50_50")&&<BookingPaymentPage serviceName={record.packageName} bookingId={record.bookingId} totalAmount={record.totalAmount} amountDueNow={record.amountDueNow} mode={mode} stage={balanceStage?"balance":undefined} paidAmount={record.amountPaid} balanceDueAt={record.balanceDueAt} onVerified={()=>setAttempt(x=>x+1)}/>}
 {balanceStage&&record.balancePayableNow===false&&record.amountDueNow>0&&<section className={styles.card} aria-label="Payment status"><h2>{record.serviceCode==="pet_taxi"?"Booking fee paid":"First payment received"}</h2><p>Paid so far: {money(record.amountPaid??Math.max(0,record.totalAmount-record.amountDueNow),record.currency)}</p><p>{record.serviceCode==="pet_taxi"?`The final balance of ${money(record.amountDueNow,record.currency)} is requested after drop-off, including any waiting, parking or cleaning charges. Nothing is due now.`:`The balance of ${money(record.amountDueNow,record.currency)} becomes payable later. Nothing is due now.`}</p></section>}
 {mode==="pay_after_service"&&record.paymentStatus!=="captured"&&record.paymentStatus!=="paid"&&<p>Your provider will share the payment request after service completion.</p>}</>}
 </div></main>;
}
