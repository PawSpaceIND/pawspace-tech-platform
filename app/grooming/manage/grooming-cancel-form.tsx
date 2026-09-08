"use client";
import{useRef,useState}from"react";
import{changeGroomingBooking,type GroomingChangePreview}from"../../../lib/grooming-booking-change-client";
import{ApiError}from"../../../lib/api-fetch";
import styles from"./grooming-customer-booking.module.css";
export default function GroomingCancelForm({preview,customerId,onChanged,onRefresh}:{preview:GroomingChangePreview;customerId:string;onChanged:(message:string)=>void;onRefresh:()=>void}){
 const[reason,setReason]=useState(""),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[needsRefresh,setNeedsRefresh]=useState(false);const sending=useRef(false);
 if(preview.cancellation.mode==="unavailable")return null;
 const review=preview.cancellation.mode==="review";
 const submit=async(event:React.FormEvent)=>{event.preventDefault();if(sending.current||!accepted||reason.trim().length<8||needsRefresh)return;sending.current=true;setBusy(true);setError("");
  try{const result=await changeGroomingBooking({bookingId:preview.bookingId,customerId,action:"cancel",reason:reason.trim(),expectedConsentRevision:preview.consentRevision});if(result.bookingId!==preview.bookingId||result.status!=="cancelled")throw new Error("The cancellation result could not be verified. Refresh your booking before trying again.");onChanged(result.refundCaseId?`Booking cancelled. Refund request ${result.refundCaseId} is pending; this is not confirmation of a completed refund.`:"Booking cancelled. No refund has been confirmed.");}
  catch(problem){const body=problem instanceof ApiError?problem.body:null;const record=body&&typeof body==="object"?body as Record<string,unknown>:null;
   if(problem instanceof ApiError&&problem.status===409&&record&&["cancellation_requires_approval","dispute_case_opened"].includes(String(record.code))&&typeof record.caseId==="string"&&record.caseId&&typeof record.bookingStatusUnchanged==="string"&&record.refundPromised===false){onChanged(`Request recorded. Case reference: ${record.caseId}. Your booking remains ${record.bookingStatusUnchanged.replaceAll("_"," ")}. The team must review it; no refund is promised.`);}
   else{setError(problem instanceof Error?problem.message:"Unable to confirm cancellation. Refresh your booking before trying again.");setAccepted(false);setNeedsRefresh(true);}
  }finally{sending.current=false;setBusy(false);}
 };
 return <form className={styles.cancelForm} aria-label="Cancel or review booking" onSubmit={submit}><h3>{review?"Request cancellation review":"Cancel this booking"}</h3><label>Reason for your request<textarea required minLength={8} maxLength={1000} value={reason} disabled={busy||needsRefresh} onChange={event=>setReason(event.target.value)}/></label><label className={styles.consent}><input type="checkbox" checked={accepted} disabled={busy||needsRefresh} onChange={event=>setAccepted(event.target.checked)}/><span>{review?"I understand this requests a review. My booking status stays unchanged and a refund is not guaranteed.":"I have reviewed the cancellation terms and estimated refund above and want to cancel this booking."}</span></label>{error&&<p role="alert">{error}</p>}{needsRefresh?<button type="button" onClick={onRefresh}>Refresh terms before retrying</button>:<button type="submit" disabled={busy||!accepted||reason.trim().length<8}>{busy?"Submitting request…":review?"Submit review request":"Confirm cancellation"}</button>}</form>;
}
