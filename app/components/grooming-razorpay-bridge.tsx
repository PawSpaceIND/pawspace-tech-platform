"use client";

import{useEffect,useRef,useState}from"react";
import{readTestTransaction,subscribeTestTransaction,updateTestTransaction}from"../../lib/test-transaction";

type OrderData={connected:boolean;environment?:string;bookingId?:string;orderId?:string;amount?:number;amountPaise?:number;currency?:string;keyId?:string;status?:string;reason?:string};
type PaymentStatusData={paymentStatus:string;verifiedCaptured:boolean;gatewayPaymentId?:string|null;gatewayStatus?:string|null;reconciliationStatus?:string|null;capturedAmount?:number|null;refundedAmount?:number|null};
type RazorpayInstance={open:()=>void};
type RazorpayConstructor=new(options:Record<string,unknown>)=>RazorpayInstance;
declare global{interface Window{Razorpay?:RazorpayConstructor}}

function loadCheckout(){return new Promise<void>((resolve,reject)=>{if(window.Razorpay){resolve();return;}const existing=document.querySelector<HTMLScriptElement>('script[data-pawspace-razorpay="true"]');if(existing){existing.addEventListener("load",()=>resolve(),{once:true});existing.addEventListener("error",()=>reject(new Error("Unable to load Razorpay Checkout")),{once:true});return;}const script=document.createElement("script");script.src="https://checkout.razorpay.com/v1/checkout.js";script.async=true;script.dataset.pawspaceRazorpay="true";script.onload=()=>resolve();script.onerror=()=>reject(new Error("Unable to load Razorpay Checkout"));document.head.appendChild(script);});}
async function openOrder(bookingId:string){const response=await fetch("/api/payment-order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId})});const body=await response.json() as{data?:OrderData;error?:string};if(!response.ok)throw new Error(body.error||"Unable to open payment");if(!body.data?.connected)throw new Error(body.data?.reason||"Razorpay Test Mode is not connected");if(body.data.environment!=="sandbox")throw new Error("Grooming certification checkout is locked to Razorpay Test Mode");if(!body.data.orderId||!body.data.keyId||!Number.isSafeInteger(body.data.amountPaise)||Number(body.data.amountPaise)<=0)throw new Error("Razorpay Test Mode order is incomplete");return body.data;}
async function readStatus(bookingId:string){const response=await fetch(`/api/payment-order?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"});const body=await response.json() as{data?:PaymentStatusData;error?:string};if(!response.ok||!body.data)throw new Error(body.error||"Unable to verify payment");return body.data;}

export default function GroomingRazorpayBridge(){
 const[,setTick]=useState(0),opened=useRef(new Set<string>()),pollers=useRef(new Map<string,{timer:number;deadline:number}>());
 useEffect(()=>subscribeTestTransaction(()=>setTick(value=>value+1)),[]);
 useEffect(()=>()=>{for(const poller of pollers.current.values())window.clearInterval(poller.timer);pollers.current.clear();},[]);
 const record=typeof window==="undefined"?null:readTestTransaction();
 useEffect(()=>{
  if(!record||record.service!=="Grooming"||!record.id.startsWith("PS-UAT-")||record.paymentStatus!=="payment_pending"||opened.current.has(record.id))return;
  opened.current.add(record.id);
  const bookingId=record.id;
  const startPolling=()=>{if(pollers.current.has(bookingId))return;const deadline=Date.now()+120_000;const check=async()=>{const current=pollers.current.get(bookingId);if(!current)return;if(Date.now()>=current.deadline){window.clearInterval(current.timer);pollers.current.delete(bookingId);return;}try{const status=await readStatus(bookingId);if(status.verifiedCaptured){window.clearInterval(current.timer);pollers.current.delete(bookingId);updateTestTransaction({paymentStatus:"paid",payment:`Razorpay Test Mode captured${status.gatewayPaymentId?` · ${status.gatewayPaymentId}`:""}`},"accounts","Verified Razorpay webhook capture reconciled the Grooming payment");}}catch{/* retain pending; server remains authority */}};const timer=window.setInterval(()=>void check(),1500);pollers.current.set(bookingId,{timer,deadline});void check();};
  void(async()=>{try{const order=await openOrder(bookingId);await loadCheckout();const Razorpay=window.Razorpay;if(!Razorpay)throw new Error("Razorpay Checkout did not initialize");const checkout=new Razorpay({key:order.keyId,amount:order.amountPaise,currency:order.currency||"INR",name:"PawSpace",description:"Grooming booking",order_id:order.orderId,prefill:{name:record.customerName,contact:record.primary},notes:{booking_id:bookingId},handler:()=>{startPolling();},modal:{ondismiss:()=>{startPolling();}}});checkout.open();startPolling();}catch(error){updateTestTransaction({paymentStatus:"payment_pending",payment:`Razorpay Test Mode pending · ${error instanceof Error?error.message:"Checkout unavailable"}`},"accounts","Razorpay Test Mode checkout could not start; payment remains pending");}})();
 },[record]);
 return null;
}
