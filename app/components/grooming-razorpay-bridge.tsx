"use client";

import{useEffect,useRef,useState}from"react";
import{openGroomingRazorpayTestCheckout}from"../../lib/razorpay-checkout-client";
import{readTestTransaction,subscribeTestTransaction,updateTestTransaction}from"../../lib/test-transaction";

export default function GroomingRazorpayBridge(){
 const[,setTick]=useState(0),opened=useRef(new Set<string>());
 useEffect(()=>subscribeTestTransaction(()=>setTick(value=>value+1)),[]);
 const record=typeof window==="undefined"?null:readTestTransaction();
 useEffect(()=>{
  if(!record||record.service!=="Grooming"||!record.id.startsWith("PS-UAT-")||record.paymentStatus!=="payment_pending"||opened.current.has(record.id))return;
  opened.current.add(record.id);
  void(async()=>{
   try{
    const result=await openGroomingRazorpayTestCheckout({bookingId:record.id,customerName:record.customerName,customerPhone:record.primary,description:"Grooming booking"});
    if(result.outcome==="captured"){
     updateTestTransaction({paymentStatus:"paid",payment:`Razorpay Test Mode captured${result.truth?.gatewayPaymentId?` · ${result.truth.gatewayPaymentId}`:""}`},"accounts","Verified Razorpay webhook capture reconciled the Grooming payment");
     return;
    }
    updateTestTransaction({paymentStatus:"payment_pending",payment:`Razorpay Test Mode pending · ${result.error||"Capture confirmation pending"}`},"accounts",result.outcome==="capture_pending"?"Checkout signature verified; waiting for the verified Razorpay webhook capture":"Razorpay Test Mode checkout ended without a verified capture; payment remains pending");
   }catch(error){
    updateTestTransaction({paymentStatus:"payment_pending",payment:`Razorpay Test Mode pending · ${error instanceof Error?error.message:"Checkout unavailable"}`},"accounts","Razorpay Test Mode checkout could not start; payment remains pending");
   }
  })();
 },[record]);
 return null;
}
