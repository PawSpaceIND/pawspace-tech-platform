"use client";
/*
 * Manage a canonical Dog Training programme. [R3-A2]
 *
 * MEASURED BEFORE: the Activity card for a training booking carried no manage link at all — Dog
 * Training was the only service code missing from lib/customer-activity.ts — and /training/manage
 * was a 404. The checkout screen the customer had just agreed to said "Cancellation requests go for
 * PawSpace approval. Once approved, the unused-session value is refunded", and the plan promised
 * rescheduling. /api/training-cancellation and /api/training-customer-session-change both existed;
 * nothing a customer could click reached either. The promise was made and the control was absent.
 *
 * This screen asks for both through the same governed endpoints the post-booking dashboard uses, so
 * there is one request path and one refusal to reason about. It never claims an outcome the server
 * did not return: a cancellation is a REQUEST that Finance reviews, and a reschedule is a REQUEST the
 * trainer/ops side resolves. Times are IST-labelled, because the booking flow labels them IST and a
 * bare toLocaleString renders in the reader's own timezone.
 */
import Link from"next/link";
import{useCallback,useEffect,useState}from"react";
import{resourceScreenState}from"../../../lib/resource-screen-state";
import{customerServiceTimeLabel}from"../../../lib/customer-activity";
import{loadTrainingProgramme,type CustomerTrainingProgramme,type CustomerTrainingSession}from"../../../lib/training-programme-client";
import{requestTrainingCancellation,requestTrainingSessionReschedule}from"../../../lib/training-cancellation-client";

const label=(value:unknown)=>String(value||"not set").replaceAll("_"," ");
/*
 * The states mutateTrainingSession actually accepts for "request_reschedule". Sessions after the
 * current one are materialized as 'locked' and unlock in sequence, so offering the customer a picker
 * over every non-terminal session would have produced a server refusal on most of them. The screen
 * offers what the server will take and says plainly why the rest are not listed.
 */
const RESCHEDULABLE_SESSION_STATES=new Set(["scheduled","accepted","on_the_way","arrived"]);
const TERMINAL_SESSION_STATES=new Set(["completed","cancelled","no_show"]);
const TERMINAL_PROGRAMME_STATES=new Set(["completed","completed_with_exceptions","cancelled"]);
const isReschedulable=(session:CustomerTrainingSession)=>RESCHEDULABLE_SESSION_STATES.has(String(session.status));
const card={background:"white",padding:20,borderRadius:14,marginBottom:16} as const;

export default function TrainingCustomerManagement({bookingId}:{bookingId:string}){
 const[ledger,setLedger]=useState<CustomerTrainingProgramme|null>(null);
 const[loadedId,setLoadedId]=useState("");
 const[error,setError]=useState("");
 const[message,setMessage]=useState("");
 const[busy,setBusy]=useState(false);
 const[cancelReason,setCancelReason]=useState("");
 const[sessionId,setSessionId]=useState("");
 const[rescheduleReason,setRescheduleReason]=useState("");

 const refresh=useCallback(async()=>{const value=await loadTrainingProgramme(bookingId);setLedger(value);setLoadedId(bookingId);return value;},[bookingId]);

 useEffect(()=>{if(!bookingId)return;let active=true;void loadTrainingProgramme(bookingId).then(value=>{if(active){setLedger(value);setLoadedId(bookingId);}}).catch(problem=>{if(active){setError(problem instanceof Error?problem.message:"Unable to load your Dog Training programme");setLoadedId(bookingId);}});return()=>{active=false;};},[bookingId]);

 const sessions=ledger?.sessions||[];
 const programme=ledger?.programme;
 const openSessions=sessions.filter(isReschedulable);
 const remainingSessions=sessions.filter(item=>!TERMINAL_SESSION_STATES.has(String(item.status)));
 const programmeTerminal=TERMINAL_PROGRAMME_STATES.has(String(programme?.status||""));

 async function submitReschedule(){
  const chosen=sessionId||openSessions[0]?.id||"";
  if(!chosen||rescheduleReason.trim().length<8)return;
  setBusy(true);setError("");setMessage("");
  try{
   const result=await requestTrainingSessionReschedule({bookingId,sessionId:chosen,reason:rescheduleReason});
   setMessage(`Reschedule requested for session ${chosen}: ${label(result.status)}. PawSpace confirms the new time with your trainer before it is booked.`);
   setRescheduleReason("");
   await refresh();
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to request a Dog Training reschedule");}
  finally{setBusy(false);}
 }

 async function submitCancellation(){
  if(cancelReason.trim().length<8)return;
  setBusy(true);setError("");setMessage("");
  try{
   const result=await requestTrainingCancellation({bookingId,reason:cancelReason});
   setMessage(result.status==="blocked_policy_configuration"
    ?"Cancellation request recorded. The refund cannot be calculated until PawSpace Finance publishes the cancellation policy for your city; no refund amount is being promised here."
    :`Cancellation request ${result.caseId} is ${label(result.status)}. PawSpace reviews it and refunds the unused-session value once approved; nothing is refunded automatically.`);
   setCancelReason("");
   await refresh();
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to request Dog Training cancellation");}
  finally{setBusy(false);}
 }

 const screen=resourceScreenState({id:bookingId,loaded:loadedId===bookingId,resource:ledger,error});
 if(screen!=="ready"){
  const headline=screen==="no-id"?"Manage Dog Training":screen==="loading"?"Loading your Dog Training programme…":screen==="failed"?"We could not load this Dog Training programme":"We could not find that Dog Training programme";
  const detail=screen==="no-id"?"Open this page with a canonical booking ID.":screen==="failed"?error:screen==="not-found"?`No Dog Training programme matches ${bookingId}. The link may be out of date, or it may have been booked on a different account.`:"";
  return <main style={{padding:32,fontFamily:"system-ui",display:"grid",gap:12,maxWidth:920,margin:"0 auto"}}><h1>{headline}</h1>{detail&&<p role={screen==="failed"?"alert":undefined}>{detail}</p>}<Link href="/training">Back to Dog Training</Link></main>;
 }

 return <main style={{minHeight:"100vh",background:"#f6f5fd",padding:32,fontFamily:"system-ui"}}><div style={{maxWidth:980,margin:"0 auto"}}>
  <Link href="/training">← Dog Training</Link>
  <h1>Manage your training programme</h1>
  <p>{bookingId} · {label(programme?.status)} · {programme?.plan_name||"Training plan"}</p>
  {error&&<p role="alert">{error}</p>}
  {message&&<p role="status">{message}</p>}

  <section style={card}>
   <h2>Sessions</h2>
   <p>{programme?`${programme.completed_sessions} of ${programme.total_sessions} completed · ${programme.no_show_sessions} no-show · ${programme.cancelled_sessions} cancelled`:"Reading your canonical session calendar"}</p>
   {sessions.map(item=><article key={item.id} style={{padding:"10px 0",borderTop:"1px solid #eee"}}>
    <strong>Session {item.sequence_no} · {label(item.status)}</strong>
    <div>{customerServiceTimeLabel(item.scheduled_start)} → {customerServiceTimeLabel(item.scheduled_end,{hour:"numeric",minute:"2-digit"})}</div>
    <small>Trainer {item.provider_id}</small>
   </article>)}
   {sessions.length===0&&<p>No sessions are attached to this programme yet.</p>}
  </section>

  <section style={card}>
   <h2>Request a session reschedule</h2>
   <p>PawSpace confirms a new time with your trainer. Asking here does not move the session by itself, and nothing is charged for the request.</p>
   {openSessions.length===0
    ?<p>{remainingSessions.length===0
      ?"Every session on this programme is already completed, cancelled or marked no-show, so there is nothing left to move."
      :"Only the session that is currently open can be moved — the rest unlock one at a time as the programme progresses, or are already awaiting a reschedule. Contact support if you need to move the whole plan."}</p>
    :<>
      <label htmlFor="training-session-to-move">Session to move</label>
      <select id="training-session-to-move" value={sessionId||openSessions[0]?.id||""} onChange={event=>setSessionId(event.target.value)} style={{width:"100%",padding:10,margin:"6px 0 10px"}}>
       {openSessions.map(item=><option key={item.id} value={item.id}>Session {item.sequence_no} · {customerServiceTimeLabel(item.scheduled_start)}</option>)}
      </select>
      <label htmlFor="training-reschedule-reason">Why do you need to move it?</label>
      <input id="training-reschedule-reason" value={rescheduleReason} onChange={event=>setRescheduleReason(event.target.value)} placeholder="At least 8 characters, so your trainer can act on it" style={{width:"100%",padding:10,margin:"6px 0 10px"}}/>
      <button disabled={busy||rescheduleReason.trim().length<8} onClick={()=>void submitReschedule()}>Request reschedule</button>
     </>}
  </section>

  <section style={card}>
   <h2>Request cancellation</h2>
   <p>Cancellation requests go to PawSpace for approval. Once approved, the unused-session value is refunded to the original payment method; completed sessions remain chargeable. No refund is calculated or paid from this screen.</p>
   {programmeTerminal
    ?<p>This programme is {label(programme?.status)}, so a new cancellation request cannot be opened. Contact support if something still looks wrong.</p>
    :<>
      <label htmlFor="training-cancel-reason">Why are you cancelling?</label>
      <input id="training-cancel-reason" value={cancelReason} onChange={event=>setCancelReason(event.target.value)} placeholder="At least 8 characters, so the reviewer can act on it" style={{width:"100%",padding:10,margin:"6px 0 10px"}}/>
      <button disabled={busy||cancelReason.trim().length<8} onClick={()=>void submitCancellation()}>Request cancellation review</button>
     </>}
  </section>
 </div></main>;
}
