"use client";
import {useRef,useState} from "react";
import {Button} from "../../components/ui";
import {apiSend} from "../../../lib/api-fetch";
import styles from "../team-console.module.css";

type Candidate={providerId:string;providerName:string;providerModel:string};
type Props={groupId:string;revision:string;candidates:Candidate[];disabled:boolean;onBusy:(busy:boolean)=>void;onResult:(message:string)=>void;onRefresh:()=>void};
type Result={groupId?:string;status?:string;provider?:{id?:string;name?:string;model?:string};offer?:{expiresAt?:number}|null};
export default function AssignmentControl(props:Props){
 const [open,setOpen]=useState(false),[action,setAction]=useState("assign"),[providerId,setProviderId]=useState(""),[reason,setReason]=useState(""),[error,setError]=useState(""),[needsRefresh,setNeedsRefresh]=useState(false);
 const submitting=useRef(false);
 const selected=props.candidates.find(candidate=>candidate.providerId===providerId);
 async function submit(){
  if(submitting.current||props.disabled||needsRefresh||reason.trim().length<8||(action==="assign"&&!providerId))return;
  submitting.current=true;props.onBusy(true);setError("");
  try{
   const result=await apiSend<Result>("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({groupId:props.groupId,expectedRevision:props.revision,action,...(action==="assign"?{providerId}:{}),reason:reason.trim()})});
   if(result.groupId!==props.groupId)throw new Error("The result could not be confirmed. Refresh before trying again.");
   let message:string;
   if(action==="cancel"&&result.status==="cancelled")message=`Request ${props.groupId} cancelled.`;
   else if(action==="assign"&&result.status==="assigned"&&result.provider?.id===providerId&&result.provider.name){
    if(result.provider.model==="commission"&&typeof result.offer?.expiresAt==="number")message=`Request ${props.groupId}: offer recorded for ${result.provider.name}. Partner acceptance and customer booking confirmation are still pending.`;
    else if(result.provider.model==="full_time"&&!result.offer)message=`Request ${props.groupId}: provider reserved with ${result.provider.name}. Customer booking confirmation is still pending.`;
    else throw new Error("The provider response was incomplete. Refresh before trying again.");
   }else throw new Error("The assignment result could not be confirmed. Refresh before trying again.");
   props.onResult(message);
  }catch(problem){setError(problem instanceof Error?problem.message:"The request could not be confirmed.");setNeedsRefresh(true);}
  finally{submitting.current=false;props.onBusy(false);}
 }
 return <div className={styles.stack}>
  {!open&&<Button size="sm" variant="secondary" disabled={props.disabled} onClick={()=>setOpen(true)}>Manage request</Button>}
  {open&&<form aria-label={`Manage request ${props.groupId}`} onSubmit={event=>{event.preventDefault();void submit();}}>
   <fieldset className={`${styles.stack} ${styles.recoveryFields}`} disabled={props.disabled||needsRefresh}>
    <legend>Manage request {props.groupId}</legend>
    <label className={styles.field}>Action<select value={action} onChange={event=>setAction(event.target.value)}><option value="assign">Assign recommended provider</option><option value="cancel">Cancel request</option></select></label>
    {action==="assign"&&<><label className={styles.field}>Recommended provider<select value={providerId} onChange={event=>setProviderId(event.target.value)} required><option value="">Choose a provider</option>{props.candidates.map(candidate=><option key={candidate.providerId} value={candidate.providerId}>{candidate.providerName}</option>)}</select></label>{selected&&<small>{selected.providerModel==="commission"?"Partner acceptance is required after an offer is recorded.":"This provider is part of the staff team."}</small>}<small>These are saved recommendations. Current availability and booking rules are checked when you submit.</small></>}
    {action==="cancel"&&<small>This cancels the saved request and releases any reservation it holds.</small>}
    <label className={styles.field}>Reason<textarea value={reason} onChange={event=>setReason(event.target.value)} minLength={8} required /></label>
    <small>Explain the action in at least 8 characters.</small>
    <Button size="sm" type="submit" disabled={reason.trim().length<8||(action==="assign"&&!providerId)}>{action==="assign"?"Assign provider":"Cancel request"}</Button>
    <Button size="sm" type="button" variant="secondary" onClick={()=>setOpen(false)}>Close</Button>
   </fieldset>
  </form>}
  {error&&<div role="alert"><p>{error}</p><Button size="sm" variant="secondary" disabled={props.disabled} onClick={props.onRefresh}>Refresh schedule</Button></div>}
 </div>;
}
