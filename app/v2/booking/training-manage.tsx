"use client";
import {useRef,useState} from "react";
import {requestTrainingCancellation,requestTrainingSessionReschedule} from "../../../lib/training-cancellation-client";
import type {CustomerTrainingProgramme} from "../../../lib/training-programme-client";
import {formatIndiaDateTime} from "../../../lib/india-time";
import styles from "../customer-detail.module.css";

// The server decides every request. These mirror its customer rules only so the page offers what it can accept:
// the next unlocked session before it starts, and a cancellation review while the programme is still open.
const RESCHEDULABLE=["scheduled","accepted","on_the_way","arrived"],CLOSED=["completed","completed_with_exceptions","cancelled"];
const ONLY_NEXT="Only your next upcoming session can be rescheduled, up to 24 hours before it starts.";
// Changes are free until 24 hours before a session; inside that window a missed session counts as used.
const CHANGE_WINDOW_MS=24*60*60_000,withinChangeWindow=(start:string)=>{const startsIn=Date.parse(start)-Date.now();return Number.isFinite(startsIn)&&startsIn>=0&&startsIn<CHANGE_WINDOW_MS;};
/** The outcome of a cancellation request in customer language; the stored case status is never shown raw. */
export function trainingCancellationNotice(status:string,caseId:string,duplicate:boolean,kind="programme"){
 const reference=caseId?` Reference: ${caseId}.`:"";
 if(status==="rejected")return `Your earlier cancellation request was reviewed and not approved. Contact PawSpace support if you still need to cancel.${reference}`;
 if(/^(approved|refund_|instruction_)/.test(status))return `Your cancellation has been approved. Our team will keep you updated on any refund.${reference}`;
 return `${duplicate?"Your cancellation request is already with our team.":"Your cancellation request has been sent."} PawSpace will review it and confirm any refund for unused sessions before your ${kind} changes.${reference}`;
}
type Props={bookingId:string;record:CustomerTrainingProgramme;inactive:boolean;onRescheduled:()=>void};
/** Customer requests for an open programme: a new time for the next session, or a cancellation and refund review. */
export default function TrainingManage({bookingId,record,inactive,onRescheduled}:Props){
 const[form,setForm]=useState<""|"reschedule"|"cancel">(""),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[cancelSent,setCancelSent]=useState(false);const sending=useRef(false);
 const{programme,sessions}=record,kind=programme.plan_code==="trainer-meet-greet"?"assessment":"programme";
 if(inactive||CLOSED.includes(programme.status))return null;
 const pending=sessions.find(session=>session.status==="reschedule_requested"),next=sessions.find(session=>RESCHEDULABLE.includes(session.status));
 const open=(value:"reschedule"|"cancel")=>{setForm(value);setReason("");setError("");setNotice("");};
 const submit=async(event:React.FormEvent)=>{event.preventDefault();const text=reason.trim();if(sending.current||text.length<8||!form)return;sending.current=true;setBusy(true);setError("");
  try{
   if(form==="reschedule"){if(!next)return;const result=await requestTrainingSessionReschedule({bookingId,sessionId:next.id,reason:text,scheduledStart:next.scheduled_start}),caseId=result.caseId||result.detail?.caseId;setNotice(`${result.duplicatePrevented?"Your reschedule request for this session is already with our team.":`Reschedule requested for session ${next.sequence_no}. Our team will contact you to confirm a new time.`}${caseId?` Reference: ${caseId}.`:""}`);setForm("");onRescheduled();}
   else{const result=await requestTrainingCancellation({bookingId,reason:text});setNotice(trainingCancellationNotice(String(result.status||""),String(result.caseId||result.id||""),result.duplicatePrevented===true,kind));setCancelSent(true);setForm("");}
  }catch(problem){setError(problem instanceof Error?problem.message:"We could not send your request. Refresh your booking and try again.");}
  finally{sending.current=false;setBusy(false);}
 };
 return <section className={styles.card} aria-label={`Manage your ${kind}`}><h3>{`Change or cancel your ${kind}`}</h3>
 {pending&&<p>Session {pending.sequence_no} · {formatIndiaDateTime(pending.scheduled_start)}: you asked for a new time. Our team will contact you to confirm it.</p>}
 {next?<p>Next session {next.sequence_no} · {formatIndiaDateTime(next.scheduled_start)}. {withinChangeWindow(next.scheduled_start)?"It starts within 24 hours, so it can't be changed online. Please contact PawSpace support; a missed session counts as used.":ONLY_NEXT}</p>:!pending&&<p>No session can be rescheduled right now. {ONLY_NEXT}</p>}
 {form?<form className={styles.form} aria-label={form==="reschedule"?"Request a new session time":`Request ${kind} cancellation`} onSubmit={submit}><label className={styles.field}>{form==="reschedule"?`Why do you need a new time for session ${next?.sequence_no??""}?`:`Why do you want to cancel your ${kind}?`}<textarea required minLength={8} maxLength={1000} placeholder="A few words, at least 8 characters" value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label><p className={styles.muted}>{form==="reschedule"?"PawSpace will contact you to confirm a new time.":`Cancellation requests go to PawSpace for approval. Once approved, the unused-session value is refunded after completed sessions and adjustments are reconciled. Your ${kind==="assessment"?"assessment stays":"sessions stay"} booked until then.`}</p><div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy||reason.trim().length<8}>{busy?"Sending request…":form==="reschedule"?"Send reschedule request":"Send cancellation request"}</button><button type="button" disabled={busy} onClick={()=>setForm("")}>{form==="reschedule"?"Keep current time":`Keep my ${kind}`}</button></div></form>
 :<div className={styles.actions}>{next&&!withinChangeWindow(next.scheduled_start)&&<button type="button" className={styles.primary} onClick={()=>open("reschedule")}>Request reschedule</button>}{!cancelSent&&<button type="button" onClick={()=>open("cancel")}>{`Request ${kind} cancellation / refund review`}</button>}</div>}
 {notice&&<p role="status">{notice}</p>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
