"use client";
import GroomingRescheduleForm from"./grooming-reschedule-form";
import GroomingCancelForm from"./grooming-cancel-form";
import{useEffect,useState}from"react";
import{loadGroomingChangePreview,type GroomingChangePreview}from"../../../lib/grooming-booking-change-client";
import styles from"./grooming-customer-booking.module.css";
export default function GroomingChangePolicy({bookingId,customerId,onChanged}:{bookingId:string;customerId:string;onChanged:(message:string)=>void}){
 const[preview,setPreview]=useState<GroomingChangePreview|null>(null),[error,setError]=useState(""),[loadedId,setLoadedId]=useState(""),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let active=true;void loadGroomingChangePreview(bookingId).then(value=>{if(active){setPreview(value);setError("");setLoadedId(bookingId);}}).catch(problem=>{if(active){setError(problem instanceof Error?problem.message:"Unable to load booking change policy");setLoadedId(bookingId);}});return()=>{active=false;};},[bookingId,refresh]);
 const reload=()=>{setLoadedId("");setPreview(null);setError("");setRefresh(value=>value+1);};
 const money=(amount:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:preview?.currency||"INR"}).format(amount);
 return <section className={styles.card} aria-label="Booking change policy"><h2>Booking change policy</h2>{loadedId!==bookingId?<p role="status">Loading current terms…</p>:error?<><p role="alert">{error}</p><button onClick={reload}>Retry policy preview</button></>:preview?<>
  <div><h3>{preview.reschedule.allowed?"Rescheduling available":"Rescheduling unavailable"}</h3>{preview.reschedule.allowed&&<p>Policy fee: {money(preview.reschedule.feeAmount)}</p>}{preview.reschedule.allowed&&<p className={styles.note}>A new time must still pass provider availability checks.</p>}</div>
  <div><h3>{preview.cancellation.mode==="cancel"?"Cancellation eligible":preview.cancellation.mode==="review"?"Cancellation needs review":"Cancellation unavailable"}</h3>{preview.cancellation.mode==="cancel"&&preview.cancellation.refundAmount!==null?<p>Estimated refund: {money(preview.cancellation.refundAmount)}</p>:preview.cancellation.mode==="review"?<p>The team must review the request. Your booking status stays unchanged, and a refund is not guaranteed.</p>:null}
   {/* The server ALREADY explains its own number - a pay-after-service booking returns refundAmount 0
     * with "No cancellation fee: return the amount actually paid before service starts" - and this
     * screen dropped that sentence on the floor. A bare "Estimated refund: Rs0.00" next to a Rs2,298
     * booking total reads as forfeiting the money, when in fact nothing has been captured yet. The
     * reasons are rendered for every mode, so an unavailable or review outcome is explained too. */}
   {preview.cancellation.reasons.length>0&&<ul className={styles.note} aria-label="Why this refund amount">{preview.cancellation.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>}</div>
  {(preview.reschedule.allowed||preview.cancellation.mode!=="unavailable")&&<p className={styles.note}>Viewing these terms does not change your booking. Review them before confirming a request below.</p>}
  <GroomingRescheduleForm key={`reschedule:${preview.consentRevision}`} preview={preview} customerId={customerId} onChanged={onChanged} onRefresh={reload}/>
  <GroomingCancelForm key={preview.consentRevision} preview={preview} customerId={customerId} onChanged={onChanged} onRefresh={reload}/>
  <button onClick={reload}>Refresh policy preview</button>
 </>:null}</section>;
}
