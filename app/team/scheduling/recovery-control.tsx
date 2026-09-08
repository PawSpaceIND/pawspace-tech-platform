"use client";
import {useState} from "react";
import {Button} from "../../components/ui";
import {apiSend} from "../../../lib/api-fetch";
import styles from "../team-console.module.css";

type Props={bookingId:string;providerId:string;providerName:string;canRecover:boolean;canRetryNotifications:boolean;disabled:boolean;onBusy:(busy:boolean)=>void;onResult:(message:string)=>void;onRefresh:()=>void};
type Result={bookingId?:string;status?:string;recoveryId?:string;replacement?:{id?:string;name?:string};communications?:{failed?:number;enqueued?:number}};
export default function RecoveryControl(props:Props){
 const [open,setOpen]=useState(false),[reason,setReason]=useState(""),[action,setAction]=useState("unavailable"),[error,setError]=useState(""),[needsRefresh,setNeedsRefresh]=useState(false);
 async function submit(retry=false){
  if(props.disabled||needsRefresh||(!retry&&reason.trim().length<8))return;
  props.onBusy(true);setError("");
  try{
   const result=await apiSend<Result>("/api/provider-assignment-recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(retry?{bookingId:props.bookingId,action:"retry_notifications"}:{bookingId:props.bookingId,providerId:props.providerId,action,reason:reason.trim()})});
   if(result.bookingId!==props.bookingId)throw new Error("The result could not be confirmed. Refresh the schedule before retrying.");
   let message:string;
   if(retry){if(typeof result.communications?.failed!=="number"||typeof result.communications.enqueued!=="number")throw new Error("Notification retry could not be confirmed. Refresh before retrying.");message=result.communications.failed>0?"Some notifications still need attention. Saved notification entries are available to retry.":`Notification retry finished: ${result.communications.enqueued} queued. Delivery is not yet confirmed.`;}
   else if(result.status==="ops_escalation"&&result.recoveryId)message=`Booking ${props.bookingId}: no eligible replacement was found. Operations follow-up is required (case ${result.recoveryId}).`;
   else if(["assigned","awaiting_acceptance"].includes(result.status??"")&&result.replacement?.id&&result.replacement.name)message=result.status==="awaiting_acceptance"?`Booking ${props.bookingId}: offer sent to ${result.replacement.name}; partner acceptance is still pending.`:`Booking ${props.bookingId}: reassigned to ${result.replacement.name}.`;
   else throw new Error("The recovery result could not be confirmed. Refresh the schedule before retrying.");
   if(!retry&&Number(result.communications?.failed)>0)message+=" Notification queueing needs attention; use Retry notifications.";
   props.onResult(message);
  }catch(problem){setError(problem instanceof Error?problem.message:"Recovery could not be confirmed.");setNeedsRefresh(true);}
  finally{props.onBusy(false);}
 }
 return <div className={styles.stack}>
  {props.canRecover&&!open&&<Button size="sm" variant="secondary" disabled={props.disabled} onClick={()=>setOpen(true)}>Recover provider</Button>}
  {open&&<form onSubmit={event=>{event.preventDefault();void submit();}} aria-label={`Recover booking ${props.bookingId}`}>
   <fieldset disabled={props.disabled||needsRefresh} className={`${styles.stack} ${styles.recoveryFields}`}>
    <legend>Recover booking {props.bookingId}</legend><small>Current provider: {props.providerName}</small>
    <label className={styles.field}>Problem<select value={action} onChange={event=>setAction(event.target.value)} aria-label="Recovery problem"><option value="unavailable">Provider unavailable</option><option value="no_show">Provider did not arrive</option></select></label>
    <label className={styles.field}>Reason<textarea value={reason} onChange={event=>setReason(event.target.value)} minLength={8} required aria-label="Recovery reason" /></label>
    <small>Explain the problem in at least 8 characters. Eligibility and capacity are checked again before assignment.</small>
    <Button size="sm" type="submit" disabled={reason.trim().length<8}>Find replacement</Button>
    <Button size="sm" type="button" variant="secondary" onClick={()=>setOpen(false)}>Cancel</Button>
   </fieldset>
  </form>}
  {props.canRetryNotifications&&<Button size="sm" variant="secondary" disabled={props.disabled||needsRefresh} onClick={()=>{void submit(true);}}>Retry notifications</Button>}
  {error&&<div role="alert"><p>{error}</p><Button size="sm" variant="secondary" disabled={props.disabled} onClick={props.onRefresh}>Refresh schedule</Button></div>}
 </div>;
}
