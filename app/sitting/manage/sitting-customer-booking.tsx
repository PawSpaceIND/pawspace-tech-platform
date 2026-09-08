"use client";
import Link from "next/link";
import {useState,type ReactNode} from "react";
import SittingCustomerPanel from "../../mobile-app/sitting-customer-panel";
import {requestCustomerSittingDateChange} from "../../../lib/sitting-customer-view";

export default function SittingCustomerBooking({bookingId,children}:{bookingId:string;children?:ReactNode}){
 if(!bookingId.trim())return <main style={{padding:24}}><h1>Manage Sitting booking</h1><p>Open a booking from your PawSpace activity.</p><Link href="/mobile-app">Back to PawSpace</Link></main>;
 return <main style={{maxWidth:980,margin:"0 auto",padding:16}}><Link href="/mobile-app">Back to PawSpace</Link><SittingCustomerPanel key={bookingId} bookingId={bookingId}>{booking=><><SittingDateChange key={booking.id} bookingId={booking.id} status={booking.status}/>{children}</>}</SittingCustomerPanel></main>;
}
function SittingDateChange({bookingId,status}:{bookingId:string;status:string}){
 const[start,setStart]=useState(""),[end,setEnd]=useState(""),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const allowed=["confirmed","assigned"].includes(status);
 async function submit(){setBusy(true);setError("");setMessage("");try{const id=await requestCustomerSittingDateChange(bookingId,start,end,reason);setMessage(`Date-change request ${id} recorded for review. Your current booking dates and price are unchanged.`);}catch(problem){setError(problem instanceof Error?problem.message:"Unable to confirm the date-change request.");}finally{setBusy(false);}}
 return <form onSubmit={event=>{event.preventDefault();void submit();}} style={{display:"grid",gap:12}}><h3>Request date change</h3><p>New dates require availability, a fresh quote and approval. Your current booking stays in place during review.</p>{!allowed&&<p>Date changes are available before check-in for confirmed or assigned bookings.</p>}<label>Requested start (your local time)<input type="datetime-local" required value={start} onChange={event=>setStart(event.target.value)} disabled={busy||!allowed} style={{display:"block",width:"100%",minHeight:44,fontSize:16}}/></label><label>Requested end (your local time)<input type="datetime-local" required value={end} onChange={event=>setEnd(event.target.value)} disabled={busy||!allowed} style={{display:"block",width:"100%",minHeight:44,fontSize:16}}/></label><label>Reason<textarea required minLength={3} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy||!allowed} style={{display:"block",width:"100%",minHeight:72,fontSize:16}}/></label>{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<button disabled={busy||!allowed||!start||!end||reason.trim().length<3} style={{minHeight:44}}>{busy?"Submitting request…":"Request date change"}</button></form>;
}
